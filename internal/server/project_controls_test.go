package server

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"artiface/internal/config"
	"artiface/internal/storage"
)

func savePublicSettings(t *testing.T, app *App, cookie *http.Cookie, csrf string, current SettingsResponse) {
	t.Helper()
	w := request(app, "POST", "/api/settings", map[string]any{"config": current.Config, "revision": current.Revision}, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("save settings: %d %s", w.Code, w.Body)
	}
}

func TestPreviewWorksThroughApplicationListener(t *testing.T) {
	initial, store := newTestApp(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg := initial.cfg
	cfg.Listen = listener.Addr().String()
	app, err := New(cfg, store, initial.assets)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	httpServer := httptest.NewUnstartedServer(app.Handler())
	httpServer.Listener.Close()
	httpServer.Listener = listener
	httpServer.Start()
	defer httpServer.Close()
	cookie, csrf := signIn(t, app)
	previewURL := makePreview(t, app, cookie, csrf)
	parsed, _ := url.Parse(previewURL)
	if parsed.Host != app.appHost || app.appHost != app.previewHost || !strings.HasPrefix(parsed.Path, "/p/") {
		t.Fatal("preview must share the app origin under /p/")
	}
	response, err := http.Get(previewURL)
	if err != nil {
		t.Fatal("preview could not connect through the app listener", err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || !strings.Contains(string(body), "<script>") {
		t.Fatalf("preview through app listener: %d %s, %v", response.StatusCode, body, err)
	}
	if response.Header.Get("X-Frame-Options") == "DENY" || response.Header.Get("Set-Cookie") != "" ||
		!strings.Contains(response.Header.Get("Content-Security-Policy"), "script-src 'nonce-") {
		t.Fatal("preview inherited app headers or lost its isolated policy")
	}
	health, _ := http.NewRequest("HEAD", app.previewOrigin+"/p/healthz", nil)
	health.Header.Set("Origin", app.origin)
	response, err = http.DefaultClient.Do(health)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 || response.Header.Get("Access-Control-Allow-Origin") != app.origin ||
		response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("preview connection probe is not reachable from the app")
	}
	// Sharing an origin does not authorize a request to the application API.
	response, err = http.Get(app.previewOrigin + "/api/hosts")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("anonymous request reached the application API")
	}
}

func TestSharedPreviewCannotBecomeApplicationCode(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, csrf := signIn(t, app)
	previewURL := makePreview(t, app, cookie, csrf)
	u, _ := url.Parse(previewURL)
	response := request(app, "GET", "/", nil, cookie, "")
	policy := response.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "script-src "+app.origin+"/assets/;") ||
		!strings.Contains(policy, "worker-src "+app.origin+"/assets/ "+app.origin+"/sw.js blob:;") {
		t.Fatal("app scripts and workers must exclude user-controlled preview files")
	}
	// CSP ignores source paths after a redirect, so an assets URL must not
	// redirect into a valid preview capability.
	response = request(app, "GET", "/assets/%2f.."+u.Path, nil, cookie, "")
	if response.Code != 404 || response.Header().Get("Location") != "" {
		t.Fatal("application asset path redirected into the preview namespace")
	}
	response = request(app, "GET", "/p/"+randomToken()+"/index.html", nil, cookie, "")
	if response.Code != 401 {
		t.Fatal("an app session cookie authorized a preview without a valid capability")
	}
	app.cfg.Hosts[0].Roots[0].TrustedScripts = true
	policy = previewRequest(app, makePreview(t, app, cookie, csrf)).Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "connect-src "+app.origin+"/p/;") ||
		!strings.Contains(policy, "sandbox allow-scripts") || strings.Contains(policy, "allow-same-origin") {
		t.Fatal("trusted preview must stay opaque and restrict fetches to preview routes")
	}
}

func TestProjectTrustIsAuthoritativeAndRevokesPreviews(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	previous := ""
	version := ""
	for _, trusted := range []bool{false, true, false} {
		current := readSettings(t, app, cookie)
		current.Config.Hosts[0].Roots[0].TrustedScripts = trusted
		savePublicSettings(t, app, cookie, csrf, current)
		if previous != "" && previewRequest(app, previous).Code != 401 {
			t.Fatal("changing project trust retained a previous capability")
		}
		w := request(app, "POST", "/api/preview", map[string]any{
			"host": "test", "root": "artifacts", "path": "reports/index.html",
		}, cookie, csrf)
		var result struct {
			URL     string `json:"url"`
			Scripts bool   `json:"scripts"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Scripts != trusted {
			t.Fatalf("project trust was not authoritative: %d %s", w.Code, w.Body)
		}
		policy := previewRequest(app, result.URL).Header().Get("Content-Security-Policy")
		if strings.Contains(policy, "script-src 'unsafe-inline'") != trusted ||
			strings.Contains(policy, "script-src 'nonce-") == trusted ||
			!strings.Contains(policy, "sandbox allow-scripts") || strings.Contains(policy, "allow-same-origin") {
			t.Fatal("preview policy did not follow project trust")
		}
		w = request(app, "GET", "/api/file-info"+fileQuery("reports/index.html"), nil, cookie, "")
		var metadata fileStat
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &metadata) != nil || metadata.TrustedScripts != trusted ||
			(version != "" && metadata.Version == version) {
			t.Fatal("file polling did not observe project trust changes")
		}
		previous, version = result.URL, metadata.Version
	}
	saved, err := config.Load(filename)
	if err != nil || saved.Hosts[0].Roots[0].TrustedScripts {
		t.Fatal("revoked project trust was not saved")
	}
}

func TestRemovedSourcesStayRemovedAndCanBeRestored(t *testing.T) {
	app, store, filename, source := newSetupApp(t, "Host test-alias discovered\n")
	cookie, csrf := signIn(t, app)
	original, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	previewURL := makePreview(t, app, cookie, csrf)
	current := readSettings(t, app, cookie)
	current.Config.Hosts = []config.Host{}
	current.Config.HideLocalSource = true
	savePublicSettings(t, app, cookie, csrf, current)
	if hosts := readHosts(t, app, cookie); len(hosts.Hosts) != 0 {
		t.Fatal("removed hosts were automatically rediscovered")
	}
	if previewRequest(app, previewURL).Code != 401 || request(app, "GET", "/api/file"+fileQuery("reports/index.html"), nil, cookie, "").Code != 404 {
		t.Fatal("removing a host retained its file access")
	}
	if _, err := os.Stat(filepath.Join(original.Hosts[0].Roots[0].Path, "reports/index.html")); err != nil {
		t.Fatal("removing configuration changed source files", err)
	}
	saved, err := config.Load(filename)
	if err != nil || saved.PasswordHash != original.PasswordHash {
		t.Fatal("removing a source changed the password")
	}
	restarted, err := New(saved, store, app.assets, WithConfigFile(filename))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	cookie, csrf = signIn(t, restarted)
	if hosts := readHosts(t, restarted, cookie); len(hosts.Hosts) != 0 {
		t.Fatal("removed hosts returned after restart")
	}
	// Source restoration is a deliberate configuration edit; CLI credential
	// reimport is covered separately and never restores deleted project roots.
	aliases, err := config.DiscoverSSH(source)
	if err != nil {
		t.Fatal(err)
	}
	current = readSettings(t, restarted, cookie)
	current.Config.Hosts, _ = config.MergeTargets(current.Config.Hosts, aliases)
	savePublicSettings(t, restarted, cookie, csrf, current)
	if hosts := readHosts(t, restarted, cookie); len(hosts.Hosts) != 2 {
		t.Fatal("import did not restore precisely the SSH hosts")
	}
	current = readSettings(t, restarted, cookie)
	current.Config.HideLocalSource = false
	savePublicSettings(t, restarted, cookie, csrf, current)
	hosts := readHosts(t, restarted, cookie)
	if len(hosts.Hosts) != 3 || hosts.Hosts[2].Kind != "local" || hosts.Hosts[2].Label != "localhost" {
		t.Fatal("localhost could not be restored")
	}
}

func TestPreviewRequiresScopedStorage(t *testing.T) {
	app, _ := newTestApp(t)
	store := &metadataStore{}
	app.store = store
	cookie, csrf := signIn(t, app)
	w := request(app, "POST", "/api/preview", map[string]string{"host": "test", "root": "artifacts", "path": "reports/index.html"}, cookie, csrf)
	if w.Code != 501 || store.opens != 0 {
		t.Fatal("preview used a storage backend without scope enforcement")
	}
}

func TestLocalSymlinkPreviewRetainsDirectoryBoundary(t *testing.T) {
	initial, _ := newTestApp(t)
	cfg := initial.cfg
	cfg.Hosts[0].Kind, cfg.Hosts[0].Target = "local", ""
	root := cfg.Hosts[0].Roots[0].Path
	for link, target := range map[string]string{
		"latest":                    "reports/index.html",
		"reports/assets/alias.json": "data.json",
		"reports/escape":            "../secret.txt",
	} {
		if err := os.Symlink(target, filepath.Join(root, filepath.FromSlash(link))); err != nil {
			t.Fatal(err)
		}
	}
	store := storage.NewLocal()
	defer store.Close()
	app, err := New(cfg, store, initial.assets)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	cookie, csrf := signIn(t, app)
	w := request(app, "POST", "/api/preview", map[string]string{"host": "test", "root": "artifacts", "path": "latest"}, cookie, csrf)
	var result struct {
		URL  string `json:"url"`
		Path string `json:"path"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Path != "reports/index.html" {
		t.Fatalf("symlinked report did not resolve to its real asset directory: %d %s", w.Code, w.Body)
	}
	base := result.URL[:strings.LastIndex(result.URL, "/")+1]
	if w := previewRequest(app, base+"assets/alias.json"); w.Code != 200 || w.Body.String() != `{"answer":42}` {
		t.Fatalf("contained asset link failed: %d %s", w.Code, w.Body)
	}
	if w := previewRequest(app, base+"escape"); w.Code != 403 {
		t.Fatalf("symlink escaped preview scope: %d", w.Code)
	}
	if w := request(app, "GET", "/api/file"+fileQuery("reports/escape"), nil, cookie, ""); w.Code != 200 {
		t.Fatal("the same link should be accessible through authenticated project browsing")
	}
}
