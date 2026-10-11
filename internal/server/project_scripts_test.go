package server

import (
	"net/http"
	"strings"
	"testing"

	"artiface/internal/config"
)

func TestReportScriptGrantPreservesOtherSettingsAndRevokesOldPreviews(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	host, root := app.cfg.Hosts[0], app.cfg.Hosts[0].Roots[0]
	body := map[string]string{"host": host.ID, "root": root.ID, "revision": projectTrustRevision(host, root)}
	previous := makePreview(t, app, cookie, csrf)
	password, err := config.HashPassword("another-fixture-password")
	if err != nil {
		t.Fatal(err)
	}
	// Unrelated edits made after the prompt must survive the targeted grant.
	if _, err := config.Update(filename, func(c *config.Config) error {
		c.PasswordHash = password
		c.SessionHours = 7
		c.Hosts[0].Roots = append(c.Hosts[0].Roots, config.Root{ID: "other", Label: "Other", Path: t.TempDir()})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, denied := range []struct {
		cookie *http.Cookie
		csrf   string
		code   int
	}{{nil, "", 401}, {cookie, "", 403}} {
		if w := request(app, "POST", "/api/projects/trust", body, denied.cookie, denied.csrf); w.Code != denied.code {
			t.Fatalf("grant authorization: %d", w.Code)
		}
	}
	w := request(app, "POST", "/api/projects/trust", body, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("grant: %d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), password) || strings.Contains(w.Body.String(), "passwordHash") {
		t.Fatal("grant response exposed credentials")
	}
	cfg, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Hosts[0].Roots[0].TrustedScripts || cfg.Hosts[0].Roots[1].TrustedScripts ||
		cfg.SessionHours != 7 || cfg.PasswordHash != password {
		t.Fatal("grant changed another project or discarded unrelated settings")
	}
	if previewRequest(app, previous).Code != 401 {
		t.Fatal("grant retained the old preview capability")
	}
	policy := previewRequest(app, makePreview(t, app, cookie, csrf)).Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "sandbox allow-scripts") || strings.Contains(policy, "allow-same-origin") {
		t.Fatal("grant removed preview isolation")
	}
}

func TestReportScriptGrantRejectsChangedSourcesAndTeamUsers(t *testing.T) {
	for _, change := range []string{"path", "hidden", "removed", "host"} {
		t.Run(change, func(t *testing.T) {
			app, _, filename, _ := newSetupApp(t, "")
			cookie, csrf := signIn(t, app)
			host, root := app.cfg.Hosts[0], app.cfg.Hosts[0].Roots[0]
			body := map[string]string{"host": host.ID, "root": root.ID, "revision": projectTrustRevision(host, root)}
			if _, err := config.Update(filename, func(c *config.Config) error {
				switch change {
				case "path":
					c.Hosts[0].Roots[0].Path = t.TempDir()
				case "hidden":
					c.Hosts[0].Roots[0].Hidden = true
				case "removed":
					c.Hosts[0].Roots = nil
				case "host":
					c.Hosts[0].Target = "replacement-source"
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if w := request(app, "POST", "/api/projects/trust", body, cookie, csrf); w.Code != 409 {
				t.Fatalf("stale consent accepted: %d %s", w.Code, w.Body)
			}
			cfg, err := config.Load(filename)
			if err != nil {
				t.Fatal(err)
			}
			for _, root := range cfg.Hosts[0].Roots {
				if root.TrustedScripts {
					t.Fatal("stale prompt trusted a changed source")
				}
			}
		})
	}
	app, filename := newTeamApp(t)
	alice, csrf := teamSignIn(t, app, "alice", testPassword, false)
	host, root := app.cfg.Hosts[0], app.cfg.Hosts[0].Roots[0]
	body := map[string]string{"host": host.ID, "root": root.ID, "revision": projectTrustRevision(host, root)}
	if w := request(app, "POST", "/api/projects/trust", body, alice, csrf); w.Code != 403 {
		t.Fatalf("team user granted project trust: %d", w.Code)
	}
	admin, adminCSRF := teamSignIn(t, app, "", testPassword, true)
	if w := request(app, "POST", "/api/admin/projects/trust", body, admin, adminCSRF); w.Code != 200 {
		t.Fatalf("admin grant: %d %s", w.Code, w.Body)
	}
	cfg, err := config.Load(filename)
	if err != nil || !cfg.Hosts[0].Roots[0].TrustedScripts || cfg.Hosts[0].Roots[1].TrustedScripts {
		t.Fatal("admin grant was not scoped to its project")
	}
}
