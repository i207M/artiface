package server

import (
	"encoding/json"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"

	"artiface/internal/config"
)

func newTeamApp(t *testing.T) (*App, string) {
	t.Helper()
	initial, store, filename, _ := newSetupApp(t, "Host undisclosed-server\n")
	cfg, err := config.Update(filename, func(c *config.Config) error {
		c.Mode = "team"
		c.Hosts[0].Roots = append(c.Hosts[0].Roots, config.Root{ID: "private", Label: "Private", Path: t.TempDir()})
		c.Users = []config.User{
			{ID: "alice", Username: "alice", PasswordHash: c.PasswordHash, Projects: []config.ProjectRef{{Host: "test", Root: "artifacts"}}},
			{ID: "bob", Username: "bob", PasswordHash: c.PasswordHash, Projects: []config.ProjectRef{{Host: "test", Root: "private"}}},
			{ID: "empty", Username: "empty", PasswordHash: c.PasswordHash, Projects: []config.ProjectRef{}},
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	app, err := New(cfg, store, initial.assets, WithConfigFile(filename))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return app, filename
}

func teamSignIn(t *testing.T, app *App, username, password string, admin bool) (*http.Cookie, string) {
	t.Helper()
	endpoint := "/api/login"
	if admin {
		endpoint = "/api/admin/login"
	}
	w := request(app, "POST", endpoint, map[string]string{"username": username, "password": password}, nil, "")
	var result struct {
		CSRF string `json:"csrfToken"`
		Role string `json:"role"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.CSRF == "" {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	cookie := w.Result().Cookies()[0]
	if admin && (cookie.Name != "artiface_admin" || cookie.Path != "/api/admin/" || result.Role != "admin") {
		t.Fatal("admin session is not separate")
	}
	if !admin && result.Role != "user" {
		t.Fatal("expected a team user")
	}
	return cookie, result.CSRF
}

func accessChange(t *testing.T, app *App, cookie *http.Cookie, csrf string, change map[string]any) {
	t.Helper()
	latest := request(app, "GET", "/api/admin/access", nil, cookie, "")
	var response struct {
		Revision string `json:"revision"`
	}
	if latest.Code != 200 || json.Unmarshal(latest.Body.Bytes(), &response) != nil {
		t.Fatalf("access settings: %d %s", latest.Code, latest.Body)
	}
	change["revision"] = response.Revision
	w := request(app, "POST", "/api/admin/access", change, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("save access: %d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "passwordHash") || strings.Contains(w.Body.String(), testPassword) {
		t.Fatal("access response exposed credentials")
	}
}

func TestTeamAuthorizationAndSeparateSessions(t *testing.T) {
	app, _ := newTeamApp(t)
	admin, adminCSRF := teamSignIn(t, app, "", testPassword, true)
	alice, csrf := teamSignIn(t, app, "ALICE", testPassword, false)
	bob, bobCSRF := teamSignIn(t, app, "bob", testPassword, false)
	empty, _ := teamSignIn(t, app, "empty", testPassword, false)
	for _, endpoint := range []string{"/admin", "/admin/"} {
		if w := request(app, "GET", endpoint, nil, nil, ""); w.Code != 200 {
			t.Fatalf("admin shell: %d", w.Code)
		}
	}
	for _, username := range []string{"", "missing"} {
		w := request(app, "POST", "/api/login", map[string]string{"username": username, "password": testPassword}, nil, "")
		if w.Code != 401 {
			t.Fatal("admin password entered the user workspace without an account")
		}
	}
	for _, endpoint := range []string{"/api/admin/access", "/api/admin/settings", "/api/admin/hosts"} {
		if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 401 {
			t.Fatal("user cookie authenticated an admin endpoint", endpoint, w.Code)
		}
		forged := *alice
		forged.Name = admin.Name
		if w := request(app, "GET", endpoint, nil, &forged, ""); w.Code != 401 {
			t.Fatal("renamed cookie elevated a user")
		}
	}
	forgedAdmin := *admin
	forgedAdmin.Name = cookieName
	if w := request(app, "GET", "/api/hosts", nil, &forgedAdmin, ""); w.Code != 401 {
		t.Fatal("admin session authenticated a user API")
	}
	for _, endpoint := range []string{"/api/projects", "/api/folders", "/api/settings", "/api/ignore", "/api/password"} {
		if w := request(app, "POST", endpoint, map[string]any{}, alice, csrf); w.Code != 403 {
			t.Fatal("user accessed management", endpoint, w.Code)
		}
	}
	if w := request(app, "GET", "/api/ignore", nil, alice, ""); w.Code != 403 {
		t.Fatal("ignore rules exposed to user")
	}
	hosts := readHosts(t, app, alice)
	if hosts.SetupEnabled || len(hosts.Hosts) != 1 || len(hosts.Hosts[0].Roots) != 1 ||
		hosts.Hosts[0].Roots[0].ID != "artifacts" || hosts.Hosts[0].Target != "" || hosts.Hosts[0].Roots[0].Path != "" {
		t.Fatal("catalog leaked sources or connection details", hosts)
	}
	if len(readHosts(t, app, empty).Hosts) != 0 || len(readSharedProjects(t, app, empty).Projects) != 0 {
		t.Fatal("new user received implicit access")
	}
	if w := request(app, "GET", "/api/settings", nil, alice, ""); strings.Contains(w.Body.String(), "test-alias") || strings.Contains(w.Body.String(), "Private") {
		t.Fatal("settings leaked configuration")
	}
	for _, endpoint := range []string{"list", "text", "file-info", "file"} {
		target := "/api/" + endpoint + "?host=test&root=artifacts&path=reports/index.html"
		for _, method := range []string{"GET", "HEAD"} {
			if w := request(app, method, target, nil, bob, ""); w.Code != 404 {
				t.Fatal("unassigned file accessible", method, endpoint, w.Code)
			}
		}
	}
	loc := map[string]string{"host": "test", "root": "artifacts", "path": "reports/index.html"}
	if w := request(app, "POST", "/api/preview", loc, bob, bobCSRF); w.Code != 404 {
		t.Fatal("unassigned preview minted", w.Code)
	}
	if w := request(app, "POST", "/api/preview", loc, alice, ""); w.Code != 403 {
		t.Fatal("preview allowed without CSRF")
	}
	if w := request(app, "POST", "/api/pdf/info", loc, bob, bobCSRF); w.Code != 404 {
		t.Fatal("unassigned PDF could be compressed", w.Code)
	}
	if w := request(app, "POST", "/api/pdf/info", loc, alice, ""); w.Code != 403 {
		t.Fatal("PDF preparation allowed without CSRF")
	}
	if w := request(app, "GET", "/api/pdf/page?host=test&root=artifacts&path=reports/report.pdf&document=0123456789abcdef0123456789abcdef&page=1&size=960", nil, bob, ""); w.Code != 404 {
		t.Fatal("unassigned compressed page was accessible", w.Code)
	}
	if w := request(app, "GET", "/api/file?host=test&root=artifacts&path=secret.txt", nil, alice, ""); w.Code != 200 {
		t.Fatal("assigned project could not be read", w.Code)
	}
	preview := makePreview(t, app, alice, csrf)
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": publicUser{ID: "bob", Username: "bob", Disabled: true, Projects: []config.ProjectRef{{Host: "test", Root: "private"}}}})
	if w := previewRequest(app, preview); w.Code != 200 {
		t.Fatal("another account's change revoked an unrelated preview")
	}
	if w := previewRequest(app, preview); w.Code != 200 {
		t.Fatal("assigned preview failed", w.Code)
	}
	if w := request(app, "POST", "/api/admin/logout", map[string]any{}, admin, adminCSRF); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := previewRequest(app, preview); w.Code != 200 {
		t.Fatal("admin logout ended a separate user session")
	}
}

func TestTeamWorkspaceRevocationAndPersistence(t *testing.T) {
	app, filename := newTeamApp(t)
	admin, adminCSRF := teamSignIn(t, app, "", testPassword, true)
	alice, csrf := teamSignIn(t, app, "alice", testPassword, false)
	secondDevice, _ := teamSignIn(t, app, "alice", testPassword, false)
	bob, bobCSRF := teamSignIn(t, app, "bob", testPassword, false)
	first := config.ProjectRef{Host: "test", Root: "artifacts"}
	private := config.ProjectRef{Host: "test", Root: "private"}
	for _, item := range []struct {
		project config.ProjectRef
		cookie  *http.Cookie
		csrf    string
	}{{first, alice, csrf}, {private, bob, bobCSRF}} {
		if w := request(app, "POST", "/api/workspace/projects", map[string]any{"open": []config.ProjectRef{item.project}}, item.cookie, item.csrf); w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	preview := makePreview(t, app, alice, csrf)
	if w := request(app, "POST", "/api/workspace/projects", map[string]any{"close": []config.ProjectRef{first}}, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if len(readSharedProjects(t, app, secondDevice).Projects) != 0 || !slices.Equal(readSharedProjects(t, app, bob).Projects, []config.ProjectRef{private}) {
		t.Fatal("workspace updates crossed user boundaries or did not sync to the same user")
	}
	if w := previewRequest(app, preview); w.Code != 200 {
		t.Fatal("closing workspace project revoked preview")
	}
	if w := request(app, "POST", "/api/workspace/projects", map[string]any{"open": []config.ProjectRef{private}}, alice, csrf); w.Code != 400 {
		t.Fatal("unassigned project opened")
	}
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": publicUser{ID: "alice", Username: "alice", Projects: []config.ProjectRef{}}})
	if w := previewRequest(app, preview); w.Code != 401 {
		t.Fatal("preview survived revoked project access")
	}
	if w := request(app, "GET", "/api/file?host=test&root=artifacts&path=secret.txt", nil, alice, ""); w.Code != 404 {
		t.Fatal("revoked file access survived")
	}
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": publicUser{ID: "alice", Username: "alice", Projects: []config.ProjectRef{first}}})
	if w := previewRequest(app, preview); w.Code != 401 {
		t.Fatal("restoring access resurrected a revoked preview")
	}
	preview = makePreview(t, app, alice, csrf)
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": map[string]any{"id": "alice", "username": "alice", "password": "new123", "projects": []config.ProjectRef{first}}})
	if w := previewRequest(app, preview); w.Code != 401 {
		t.Fatal("preview survived password reset")
	}
	if w := request(app, "GET", "/api/hosts", nil, secondDevice, ""); w.Code != 401 {
		t.Fatal("other user session survived password reset")
	}
	alice, _ = teamSignIn(t, app, "alice", "new123", false)
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": publicUser{ID: "alice", Username: "alice", Disabled: true, Projects: []config.ProjectRef{first}}})
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": publicUser{ID: "alice", Username: "alice", Projects: []config.ProjectRef{first}}})
	if w := request(app, "GET", "/api/hosts", nil, alice, ""); w.Code != 401 {
		t.Fatal("re-enabling account resurrected a disabled session")
	}
	alice, _ = teamSignIn(t, app, "alice", "new123", false)
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": publicUser{ID: "alice", Username: "alice", Disabled: true, Projects: []config.ProjectRef{first}}})
	if w := request(app, "GET", "/api/hosts", nil, alice, ""); w.Code != 401 {
		t.Fatal("disabled session survived")
	}
	if w := request(app, "POST", "/api/login", map[string]string{"username": "alice", "password": "new123"}, nil, ""); w.Code != 401 {
		t.Fatal("disabled account signed in")
	}
	accessChange(t, app, admin, adminCSRF, map[string]any{"deleteUser": "bob"})
	if w := request(app, "GET", "/api/hosts", nil, bob, ""); w.Code != 401 {
		t.Fatal("deleted session survived")
	}
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": map[string]any{"username": "New_User", "password": "six123", "projects": []config.ProjectRef{private}}})
	saved, err := config.Load(filename)
	if err != nil || saved.Mode != "team" || saved.PasswordHash != app.passwordHash {
		t.Fatal("mode/admin credentials changed", err)
	}
	if info, _ := os.Stat(filename); info.Mode().Perm() != 0600 {
		t.Fatal("private configuration permissions changed")
	}
	if user, _ := saved.User("alice"); user.OpenProjects == nil {
		t.Fatal("explicitly closed projects were not persisted")
	}
	restarted, err := New(saved, app.store, app.assets, WithConfigFile(filename))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	newUser, newCSRF := teamSignIn(t, restarted, "new_user", "six123", false)
	if got := readSharedProjects(t, restarted, newUser).Projects; len(got) != 0 {
		t.Fatal("a grant opened a project without selection")
	}
	if w := request(restarted, "POST", "/api/workspace/projects", map[string]any{"open": []config.ProjectRef{private}}, newUser, newCSRF); w.Code != 200 {
		t.Fatal("saved grant did not survive restart", w.Code)
	}
}

func TestTeamAdminValidationAndStartupMode(t *testing.T) {
	app, filename := newTeamApp(t)
	admin, csrf := teamSignIn(t, app, "", testPassword, true)
	before, _ := os.ReadFile(filename)
	for _, body := range []any{
		map[string]any{"revision": accessRevision(app.cfg), "mode": "personal"},
		map[string]any{"revision": accessRevision(app.cfg), "user": map[string]any{"id": "alice", "username": "alice", "passwordHash": "injected"}},
		map[string]any{"revision": accessRevision(app.cfg), "user": publicUser{ID: "alice", Username: "bob"}},
		map[string]any{"revision": accessRevision(app.cfg), "user": publicUser{ID: "alice", Username: "alice", Projects: []config.ProjectRef{{Host: "test", Root: "missing"}}}},
		map[string]any{"revision": accessRevision(app.cfg), "user": map[string]any{"username": "short", "password": "12345"}},
	} {
		if w := request(app, "POST", "/api/admin/access", body, admin, csrf); w.Code != 400 {
			t.Fatal("invalid access change accepted", w.Code, w.Body)
		}
		after, _ := os.ReadFile(filename)
		if !slices.Equal(before, after) {
			t.Fatal("invalid request changed configuration")
		}
	}
	if w := request(app, "POST", "/api/admin/access", map[string]any{"revision": accessRevision(app.cfg), "deleteUser": "alice"}, admin, ""); w.Code != 403 {
		t.Fatal("admin edit accepted without CSRF")
	}
	if w := request(app, "POST", "/api/admin/access", map[string]any{"revision": "stale", "deleteUser": "alice"}, admin, csrf); w.Code != 409 {
		t.Fatal("stale admin edit overwrote current settings")
	}
	// A manual edit is visible only after restart, even when a later UI write
	// republishes users and sources from that file.
	cfg, err := config.Update(filename, func(c *config.Config) error { c.Mode = "personal"; return nil })
	if err != nil {
		t.Fatal(err)
	}
	app.adoptSources(cfg)
	if app.cfg.ModeName() != "team" {
		t.Fatal("mode changed without a server restart")
	}
	settings := request(app, "GET", "/api/admin/settings", nil, admin, "")
	var data SettingsResponse
	if json.Unmarshal(settings.Body.Bytes(), &data) != nil {
		t.Fatal("settings response")
	}
	data.Config.Hosts[0].Roots = data.Config.Hosts[0].Roots[:1]
	if w := request(app, "POST", "/api/admin/settings", map[string]any{"config": data.Config, "revision": data.Revision}, admin, csrf); w.Code != 200 {
		t.Fatal("could not remove project with grants", w.Code, w.Body)
	}
	saved, err := config.Load(filename)
	bob, _ := saved.User("bob")
	if err != nil || len(bob.Projects) != 0 {
		t.Fatal("deleting project left stale grants", err)
	}
}
