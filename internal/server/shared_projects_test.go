package server

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"artiface/internal/config"
)

func readSharedProjects(t *testing.T, app *App, cookie *http.Cookie) sharedProjectsResponse {
	t.Helper()
	w := request(app, "GET", "/api/workspace/projects", nil, cookie, "")
	var result sharedProjectsResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatalf("shared projects: %d %s", w.Code, w.Body)
	}
	if result.Projects == nil || strings.Contains(w.Body.String(), "passwordHash") {
		t.Fatal("invalid shared project response")
	}
	return result
}

func TestSharedProjectsMergePersistAndPreserveSettings(t *testing.T) {
	app, store, filename, _ := newSetupApp(t, "")
	cfg, err := config.Update(filename, func(cfg *config.Config) error {
		root := cfg.Hosts[0].Roots[0]
		root.ID = "second"
		cfg.Hosts[0].Roots = append(cfg.Hosts[0].Roots, root)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	app.adoptSources(cfg)
	first, second := config.ProjectRef{Host: "test", Root: "artifacts"}, config.ProjectRef{Host: "test", Root: "second"}
	cookieA, csrfA := signIn(t, app)
	cookieB, csrfB := signIn(t, app)
	settings := readSettings(t, app, cookieA)
	preview := makePreview(t, app, cookieA, csrfA)
	initial := readSharedProjects(t, app, cookieA)
	if len(initial.Projects) != 0 {
		t.Fatal("configured folders were opened without an explicit selection", initial)
	}
	if w := request(app, "POST", "/api/workspace/projects", map[string]any{"close": initial.Projects}, cookieA, csrfA); w.Code != 200 {
		t.Fatal(w.Code)
	}
	emptyConfig, err := config.Load(filename)
	if err != nil || emptyConfig.OpenProjects == nil || len(readSharedProjects(t, app, cookieA).Projects) != 0 {
		t.Fatal("an empty list did not remain empty")
	}
	var group sync.WaitGroup
	statuses := make(chan int, 2)
	for _, item := range []struct {
		project config.ProjectRef
		cookie  *http.Cookie
		csrf    string
	}{{first, cookieA, csrfA}, {second, cookieB, csrfB}} {
		group.Add(1)
		go func() {
			defer group.Done()
			statuses <- request(app, "POST", "/api/workspace/projects", map[string]any{"open": []config.ProjectRef{item.project}}, item.cookie, item.csrf).Code
		}()
	}
	group.Wait()
	close(statuses)
	for status := range statuses {
		if status != 200 {
			t.Fatal(status)
		}
	}
	shared := readSharedProjects(t, app, cookieB)
	if len(shared.Projects) != 2 || !slices.Contains(shared.Projects, first) || !slices.Contains(shared.Projects, second) ||
		shared.SourcesRevision != initial.SourcesRevision {
		t.Fatal("concurrent opens overwrote another project or changed source metadata", shared)
	}
	// Device B can write based on its older view without restoring A's closed project.
	if w := request(app, "POST", "/api/workspace/projects", map[string]any{"close": []config.ProjectRef{first}}, cookieA, csrfA); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(app, "POST", "/api/workspace/projects", map[string]any{"open": []config.ProjectRef{second}}, cookieB, csrfB); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if got := readSharedProjects(t, app, cookieB).Projects; !reflect.DeepEqual(got, []config.ProjectRef{second}) {
		t.Fatal(got)
	}
	if w := previewRequest(app, preview); w.Code != 200 {
		t.Fatal("workspace changes revoked an unrelated preview")
	}
	// The settings editor excludes workspace state and must preserve concurrent changes.
	settings.Config.Hosts[0].Label = "Renamed host"
	if w := request(app, "POST", "/api/settings", map[string]any{"config": settings.Config, "revision": settings.Revision}, cookieA, csrfA); w.Code != 200 {
		t.Fatalf("workspace changes invalidated the settings revision: %d %s", w.Code, w.Body)
	}
	saved, err := config.Load(filename)
	if err != nil || saved.PasswordHash != cfg.PasswordHash || !reflect.DeepEqual(saved.OpenProjects, []config.ProjectRef{second}) {
		t.Fatal("settings or credentials were overwritten", err)
	}
	info, _ := os.Stat(filename)
	if info.Mode().Perm() != 0600 {
		t.Fatal("shared projects weakened configuration permissions")
	}
	if w := request(app, "POST", "/api/logout", map[string]any{}, cookieA, csrfA); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if len(readSharedProjects(t, app, cookieB).Projects) != 1 {
		t.Fatal("signing out removed shared projects")
	}
	restarted, err := New(saved, store, app.assets, WithConfigFile(filename))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	cookie, _ := signIn(t, restarted)
	if got := readSharedProjects(t, restarted, cookie).Projects; !reflect.DeepEqual(got, []config.ProjectRef{second}) {
		t.Fatal("restart lost shared projects", got)
	}
}

func TestSharedProjectsAuthorizationValidationAndSourceRemoval(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	project := config.ProjectRef{Host: "test", Root: "artifacts"}
	body := map[string]any{"open": []config.ProjectRef{project}}
	for _, method := range []string{"GET", "POST"} {
		if w := request(app, method, "/api/workspace/projects", body, nil, ""); w.Code != 401 {
			t.Fatalf("anonymous %s: %d", method, w.Code)
		}
	}
	if w := request(app, "POST", "/api/workspace/projects", body, cookie, ""); w.Code != 403 {
		t.Fatal("missing CSRF token accepted")
	}
	before, _ := os.ReadFile(filename)
	for _, invalid := range []any{
		map[string]any{"unknown": true},
		map[string]any{"open": []any{map[string]string{"host": "test", "root": "artifacts", "path": "/tmp"}}},
		map[string]any{"open": []config.ProjectRef{{Host: "test", Root: "missing"}}},
		map[string]any{"close": []config.ProjectRef{{Host: "../test", Root: "artifacts"}}},
	} {
		if w := request(app, "POST", "/api/workspace/projects", invalid, cookie, csrf); w.Code != 400 {
			t.Fatalf("invalid project change accepted: %d %s", w.Code, w.Body)
		}
		after, _ := os.ReadFile(filename)
		if !slices.Equal(before, after) {
			t.Fatal("invalid request changed configuration")
		}
	}
	for _, remove := range []bool{false, true} {
		if remove {
			if w := request(app, "POST", "/api/workspace/projects", body, cookie, csrf); w.Code != 200 {
				t.Fatal(w.Code)
			}
		}
		latest := readSettings(t, app, cookie)
		if remove {
			latest.Config.Hosts[0].Roots = nil
		} else {
			latest.Config.Hosts[0].Hidden = true
		}
		if w := request(app, "POST", "/api/settings", map[string]any{"config": latest.Config, "revision": latest.Revision}, cookie, csrf); w.Code != 200 {
			t.Fatal(w.Code)
		}
		if len(readSharedProjects(t, app, cookie).Projects) != 0 {
			t.Fatal("hidden or removed source retained an open project")
		}
		if !remove {
			if w := request(app, "POST", "/api/workspace/projects", body, cookie, csrf); w.Code != 400 {
				t.Fatal("a hidden source could be reopened")
			}
			latest = readSettings(t, app, cookie)
			latest.Config.Hosts[0].Hidden = false
			if w := request(app, "POST", "/api/settings", map[string]any{"config": latest.Config, "revision": latest.Revision}, cookie, csrf); w.Code != 200 {
				t.Fatal(w.Code)
			}
			if len(readSharedProjects(t, app, cookie).Projects) != 0 {
				t.Fatal("unhiding a source reopened its old project")
			}
		}
	}
}

func TestSharedProjectReorderingPersistsAndPreservesConcurrentChanges(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cfg, err := config.Update(filename, func(cfg *config.Config) error {
		for _, id := range []string{"second", "third"} {
			root := cfg.Hosts[0].Roots[0]
			root.ID = id
			cfg.Hosts[0].Roots = append(cfg.Hosts[0].Roots, root)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	app.adoptSources(cfg)
	a := config.ProjectRef{Host: "test", Root: "artifacts"}
	b := config.ProjectRef{Host: "test", Root: "second"}
	c := config.ProjectRef{Host: "test", Root: "third"}
	cookie, csrf := signIn(t, app)
	other, otherCSRF := signIn(t, app)
	write := func(body any, cookie *http.Cookie, csrf string) {
		t.Helper()
		if w := request(app, "POST", "/api/workspace/projects", body, cookie, csrf); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	write(map[string]any{"open": []config.ProjectRef{a, b, c}}, cookie, csrf)
	revision := readSharedProjects(t, app, cookie).SourcesRevision
	write(map[string]any{"move": []projectMove{{Project: a, Target: c, Edge: "after"}}}, cookie, csrf)
	if got := readSharedProjects(t, app, other); !slices.Equal(got.Projects, []config.ProjectRef{b, c, a}) || got.SourcesRevision != revision {
		t.Fatal("order did not sync or invalidated readers", got)
	}
	saved, err := config.Load(filename)
	if err != nil || !slices.Equal(saved.OpenProjects, []config.ProjectRef{b, c, a}) {
		t.Fatal("order was not persisted", saved.OpenProjects, err)
	}
	write(map[string]any{"close": []config.ProjectRef{c}}, other, otherCSRF)
	write(map[string]any{"move": []projectMove{{Project: a, Target: c, Edge: "before"}}}, cookie, csrf)
	if got := readSharedProjects(t, app, cookie).Projects; !slices.Equal(got, []config.ProjectRef{b, a}) {
		t.Fatal("stale move resurrected a closed project", got)
	}
	write(map[string]any{"open": []config.ProjectRef{c}, "move": []projectMove{{Project: a, Target: b, Edge: "before"}}}, cookie, csrf)
	if got := readSharedProjects(t, app, cookie).Projects; !slices.Equal(got, []config.ProjectRef{a, b, c}) {
		t.Fatal("moving overwrote a concurrent open", got)
	}
	before, _ := os.ReadFile(filename)
	for _, move := range []projectMove{{Project: a, Target: b, Edge: "invalid"}, {Project: a, Target: config.ProjectRef{}, Edge: "after"}} {
		if w := request(app, "POST", "/api/workspace/projects", map[string]any{"move": []projectMove{move}}, cookie, csrf); w.Code != 400 {
			t.Fatal("invalid move accepted", w.Code)
		}
	}
	after, _ := os.ReadFile(filename)
	if !slices.Equal(before, after) {
		t.Fatal("invalid move changed the config")
	}
}

func TestSharedProjectReorderingIsAccountScoped(t *testing.T) {
	app, filename := newTeamApp(t)
	a := config.ProjectRef{Host: "test", Root: "artifacts"}
	b := config.ProjectRef{Host: "test", Root: "second"}
	cfg, err := config.Update(filename, func(cfg *config.Config) error {
		root := cfg.Hosts[0].Roots[0]
		root.ID = b.Root
		cfg.Hosts[0].Roots = append(cfg.Hosts[0].Roots, root)
		for index := range cfg.Users {
			cfg.Users[index].Projects = []config.ProjectRef{a, b}
			cfg.Users[index].OpenProjects = []config.ProjectRef{a, b}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	app.adoptSources(cfg)
	alice, csrf := teamSignIn(t, app, "alice", testPassword, false)
	bob, _ := teamSignIn(t, app, "bob", testPassword, false)
	body := map[string]any{"move": []projectMove{{Project: b, Target: a, Edge: "before"}}}
	if w := request(app, "POST", "/api/workspace/projects", body, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if !slices.Equal(readSharedProjects(t, app, alice).Projects, []config.ProjectRef{b, a}) ||
		!slices.Equal(readSharedProjects(t, app, bob).Projects, []config.ProjectRef{a, b}) {
		t.Fatal("project order leaked between accounts")
	}
}
