package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"artiface/internal/config"
	"artiface/internal/storage"
)

func readSettings(t *testing.T, app *App, cookie *http.Cookie) SettingsResponse {
	t.Helper()
	w := request(app, "GET", "/api/settings", nil, cookie, "")
	var result SettingsResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatalf("settings: %d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "passwordHash") || strings.Contains(w.Body.String(), "$argon2") {
		t.Fatal("settings disclosed password material")
	}
	return result
}

func TestSettingsRevisionSecretsAndLiveAuthorization(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	for _, endpoint := range []string{"/api/settings", "/api/folders"} {
		if w := request(app, "POST", endpoint, map[string]any{}, nil, ""); w.Code != 401 {
			t.Fatalf("anonymous %s: %d", endpoint, w.Code)
		}
		if w := request(app, "POST", endpoint, map[string]any{}, cookie, ""); w.Code != 403 {
			t.Fatalf("CSRF %s: %d", endpoint, w.Code)
		}
	}
	if w := request(app, "GET", "/api/settings", nil, nil, ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	initial := readSettings(t, app, cookie)
	if initial.Config.Hosts == nil || len(initial.Revision) != 64 || initial.RestartRequired {
		t.Fatal(initial)
	}
	// A concurrent password reset must survive a safe configuration save.
	disk, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	disk.PasswordHash, err = config.HashPassword("changed-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := config.Save(filename, disk); err != nil {
		t.Fatal(err)
	}
	initial.Config.Hosts[0].Hidden = true
	initial.Config.Hosts[0].Roots[0].Hidden = true
	initial.Config.Hosts[0].Label = strings.Repeat("a", 5000) // Settings exceed the ordinary 4 KiB request cap.
	write := func(value SettingsResponse) *httptest.ResponseRecorder {
		return request(app, "POST", "/api/settings", map[string]any{"config": value.Config, "revision": value.Revision}, cookie, csrf)
	}
	w := write(initial)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	saved, err := config.Load(filename)
	if err != nil || saved.PasswordHash != disk.PasswordHash {
		t.Fatal("safe save lost the current password", err)
	}
	hosts := readHosts(t, app, cookie)
	if len(hosts.Hosts) != 2 || !hosts.Hosts[0].Hidden || !hosts.Hosts[0].Roots[0].Hidden {
		t.Fatal("hidden metadata disappeared")
	}
	if w := request(app, "GET", "/api/text"+fileQuery("reports/index.html"), nil, cookie, ""); w.Code != 200 {
		t.Fatalf("hidden flag changed authorization: %d %s", w.Code, w.Body)
	}
	if w := write(initial); w.Code != 409 {
		t.Fatalf("stale revision = %d", w.Code)
	}
	latest := readSettings(t, app, cookie)
	previewURL := makePreview(t, app, cookie, csrf)
	latest.Config.Hosts[0].Roots = []config.Root{}
	latest.Config.SessionHours++
	latest.Config.Listen = "0.0.0.0:9101"
	latest.Config.AppOrigin, latest.Config.PreviewOrigin = "https://app.example", "https://preview.example"
	w = write(latest)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"restartRequired":true`) {
		t.Fatalf("restart save: %d %s", w.Code, w.Body)
	}
	if w := previewRequest(app, previewURL); w.Code != 401 {
		t.Fatal("removed root retained preview capability")
	}
	if w := request(app, "GET", "/api/file"+fileQuery("reports/index.html"), nil, cookie, ""); w.Code != 404 {
		t.Fatal("removed root remained authorized")
	}
	if app.origin != "http://127.0.0.1:8787" || app.cfg.Listen != "127.0.0.1:8787" || app.cfg.SessionHours != 12 {
		t.Fatal("restart settings changed live")
	}
	saved, err = config.Load(filename)
	if err != nil || saved.PasswordHash != disk.PasswordHash {
		t.Fatal("restart edit lost secret", err)
	}
	latest = readSettings(t, app, cookie)
	before, _ := os.ReadFile(filename)
	latest.Config.Listen = "not-an-ip:8000"
	if w := write(latest); w.Code != 400 {
		t.Fatalf("invalid settings = %d %s", w.Code, w.Body)
	}
	if w := request(app, "POST", "/api/settings", map[string]any{
		"config": map[string]any{"passwordHash": "must never accept", "hosts": []any{}}, "revision": latest.Revision,
	}, cookie, csrf); w.Code != 400 {
		t.Fatalf("secret field = %d", w.Code)
	}
	after, _ := os.ReadFile(filename)
	if string(before) != string(after) {
		t.Fatal("invalid save modified settings")
	}
}

type folderFixtureStore struct {
	*localStore
	calls             int
	target, directory string
}

func (s *folderFixtureStore) BrowseFolders(ctx context.Context, target, directory string) (storage.FolderListing, error) {
	s.calls++
	s.target, s.directory = target, directory
	return storage.FolderListing{Path: "/home/fixture", Home: "/home/fixture", Entries: []storage.Entry{}}, ctx.Err()
}

func TestFolderSelectionValidationAndCapabilities(t *testing.T) {
	app, filesOnly, _, _ := newSetupApp(t, "Host discovered\n")
	cookie, csrf := signIn(t, app)
	if w := request(app, "POST", "/api/folders", map[string]string{"host": "test"}, cookie, csrf); w.Code != 501 {
		t.Fatalf("store without folder browsing: %d %s", w.Code, w.Body)
	}
	store := &folderFixtureStore{localStore: filesOnly}
	app.store = store
	for _, body := range []map[string]string{
		{"host": "test"},
		{"target": "discovered", "kind": "ssh", "path": "/"},
		{"target": "manual@machine", "path": "/home"},
	} {
		if w := request(app, "POST", "/api/folders", body, cookie, csrf); w.Code != 200 {
			t.Fatalf("valid folders: %d %s", w.Code, w.Body)
		}
	}
	calls := store.calls
	for _, body := range []map[string]string{
		{}, {"host": "missing"}, {"host": "test", "kind": "local"},
		{"host": "test", "target": "wrong"}, {"target": ""}, {"target": "-option"},
		{"target": "bad target"}, {"target": "ok", "kind": "other"},
		{"kind": "local", "target": "not-empty"},
	} {
		if w := request(app, "POST", "/api/folders", body, cookie, csrf); w.Code != 400 {
			t.Fatalf("invalid folders %v: %d %s", body, w.Code, w.Body)
		}
	}
	for _, auth := range []struct {
		cookie *http.Cookie
		csrf   string
		want   int
	}{{nil, "", 401}, {cookie, "", 403}} {
		if w := request(app, "POST", "/api/folders", map[string]string{"host": "test"}, auth.cookie, auth.csrf); w.Code != auth.want {
			t.Fatal(w.Code)
		}
	}
	if store.calls != calls || filesOnly.opens != 0 {
		t.Fatal("denied chooser reached storage or opened file contents")
	}
	disabled, err := New(app.cfg, store, app.assets)
	if err != nil {
		t.Fatal(err)
	}
	defer disabled.Close()
	c, token := signIn(t, disabled)
	if w := request(disabled, "POST", "/api/folders", map[string]string{"host": "test"}, c, token); w.Code != 403 {
		t.Fatal("folder setup enabled without config")
	}
}

func TestVirtualLocalSourceCollisionsAndPersistence(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "Host fresh\n")
	cookie, csrf := signIn(t, app)
	cfg, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Hosts[0].ID = "local" // An SSH source already owns the obvious local ID.
	if err := config.Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	app.adoptSources(cfg)
	a, b := readHosts(t, app, cookie), readHosts(t, app, cookie)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("virtual source changed between requests")
	}
	var virtual config.Host
	for _, host := range a.Hosts {
		if host.Kind == "local" {
			virtual = host
		}
	}
	if virtual.ID == "" || virtual.ID == "local" || virtual.Label != "localhost" || virtual.Target != "" || virtual.Roots == nil {
		t.Fatalf("virtual local: %+v", virtual)
	}
	w := request(app, "POST", "/api/projects", map[string]string{"host": virtual.ID, "kind": "local", "path": "/chosen/local"}, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("local project: %d %s", w.Code, w.Body)
	}
	disk, err := config.Load(filename)
	if err != nil || len(disk.Hosts) != 3 || disk.Hosts[2].ID != virtual.ID || disk.Hosts[2].Kind != "local" {
		t.Fatalf("persisted local: %+v, %v", disk, err)
	}
	if len(disk.Hosts[2].Roots) != 1 || disk.Hosts[2].Roots[0].Path != "/chosen/local" {
		t.Fatalf("selected local folder was not saved: %+v", disk.Hosts[2])
	}
	if !reflect.DeepEqual(disk.Hosts[0], cfg.Hosts[0]) {
		t.Fatal("local selection changed SSH IDs/roots")
	}
	// An independent app can add a local project without selecting a host first.
	other, _, otherFile, _ := newSetupApp(t, "")
	c, token := signIn(t, other)
	w = request(other, "POST", "/api/projects", map[string]string{"kind": "local", "target": "", "path": "/new/local"}, c, token)
	if w.Code != 200 {
		t.Fatalf("direct local project: %d %s", w.Code, w.Body)
	}
	disk, err = config.Load(otherFile)
	if err != nil || len(disk.Hosts) != 2 || disk.Hosts[1].Target != "" || disk.Hosts[1].Roots[0].Path != "/new/local" {
		t.Fatalf("direct saved local: %+v, %v", disk, err)
	}
}

func TestLocalFolderNavigationDoesNotChangeConfigurationOrPreviews(t *testing.T) {
	app, remote, filename, _ := newSetupApp(t, "")
	home := filepath.Join(t.TempDir(), "home")
	chosen := filepath.Join(home, "chosen")
	if err := os.MkdirAll(chosen, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	store := &storage.Dispatch{Local: storage.NewLocal(), SSH: remote}
	defer store.Close()
	app.store = store
	cookie, csrf := signIn(t, app)
	previewURL := makePreview(t, app, cookie, csrf)
	settings := readSettings(t, app, cookie)
	hosts := readHosts(t, app, cookie)
	var localID string
	for _, host := range hosts.Hosts {
		if host.Kind == "local" {
			localID = host.ID
		}
	}
	if localID == "" {
		t.Fatal("missing virtual local source")
	}
	before, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{"", home, chosen, filepath.Dir(home)} {
		w := request(app, "POST", "/api/folders", map[string]string{"host": localID, "kind": "local", "path": directory}, cookie, csrf)
		if w.Code != 200 {
			t.Fatalf("browse %q: %d %s", directory, w.Code, w.Body)
		}
		after, err := os.ReadFile(filename)
		if err != nil || string(after) != string(before) {
			t.Fatalf("folder navigation changed configuration bytes: %v", err)
		}
		afterInfo, err := os.Stat(filename)
		if err != nil || !os.SameFile(beforeInfo, afterInfo) || !beforeInfo.ModTime().Equal(afterInfo.ModTime()) {
			t.Fatalf("folder navigation touched configuration: %v", err)
		}
		if got := readSettings(t, app, cookie); got.Revision != settings.Revision {
			t.Fatal("folder navigation changed settings revision")
		}
		if got := readHosts(t, app, cookie); !reflect.DeepEqual(hosts, got) {
			t.Fatal("folder navigation persisted the virtual local source")
		}
		if w := previewRequest(app, previewURL); w.Code != 200 {
			t.Fatalf("folder navigation revoked existing preview: %d %s", w.Code, w.Body)
		}
	}
	w := request(app, "POST", "/api/projects", map[string]string{"host": localID, "kind": "local", "path": chosen}, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("select local folder: %d %s", w.Code, w.Body)
	}
	saved, err := config.Load(filename)
	if err != nil || len(saved.Hosts) != 2 {
		t.Fatalf("selected source not saved: %+v, %v", saved.Hosts, err)
	}
	local := saved.Hosts[1]
	if local.ID != localID || local.Kind != "local" || local.Target != "" || len(local.Roots) != 1 || local.Roots[0].Path != chosen {
		t.Fatalf("saved local project: %+v", local)
	}
	if !reflect.DeepEqual(saved.Hosts[:1], settings.Config.Hosts) {
		t.Fatal("selecting local folder changed existing SSH sources")
	}
	if got := readSettings(t, app, cookie); got.Revision == settings.Revision {
		t.Fatal("adding a project did not change settings revision")
	}
	query := url.Values{"host": {local.ID}, "root": {local.Roots[0].ID}}.Encode()
	if w := request(app, "GET", "/api/list?"+query, nil, cookie, ""); w.Code != 200 {
		t.Fatalf("selected local project unavailable: %d %s", w.Code, w.Body)
	}
}

func TestLocalHTTPFilesRangesAndFolderMetadata(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	root := app.cfg.Hosts[0].Roots[0].Path
	t.Setenv("HOME", root)
	cfg, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Hosts[0].Kind, cfg.Hosts[0].Target = "local", ""
	if err := config.Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	app.adoptSources(cfg)
	store := storage.New()
	defer store.Close()
	app.store = store
	cookie, csrf := signIn(t, app)
	w := request(app, "POST", "/api/folders", map[string]string{"host": "test"}, cookie, csrf)
	var listing storage.FolderListing
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &listing) != nil {
		t.Fatalf("local chooser: %d %s", w.Code, w.Body)
	}
	if listing.Path != root || len(listing.Entries) != 1 || listing.Entries[0].Type != "directory" || !filepath.IsAbs(listing.Entries[0].Path) {
		t.Fatalf("chooser exposed files: %+v", listing)
	}
	r := httptest.NewRequest("GET", "/api/file"+fileQuery("reports/report.pdf"), nil)
	r.Host = app.appHost
	r.AddCookie(cookie)
	r.Header.Set("Range", "bytes=0-3")
	w = httptest.NewRecorder()
	app.Handler().ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "%PDF" {
		t.Fatalf("local range: %d %s", w.Code, w.Body)
	}
	w = request(app, "GET", "/api/file-info"+fileQuery("reports/report.pdf"), nil, cookie, "")
	var metadata fileStat
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &metadata) != nil ||
		metadata.Name != "report.pdf" || metadata.Size <= 0 || metadata.Version == "" {
		t.Fatalf("local metadata: %d %s", w.Code, w.Body)
	}
	preview := makePreview(t, app, cookie, csrf)
	if w := previewRequest(app, preview); w.Code != 200 {
		t.Fatalf("local preview: %d %s", w.Code, w.Body)
	}
	// Setup can navigate outside project roots, but the ordinary file API cannot.
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, "allowed-choice"), 0700); err != nil {
		t.Fatal(err)
	}
	w = request(app, "POST", "/api/folders", map[string]string{"host": "test", "path": outside}, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("setup navigation: %d %s", w.Code, w.Body)
	}
	if w := request(app, "GET", "/api/file"+fileQuery(outside), nil, cookie, ""); w.Code != 403 {
		t.Fatal("setup enlarged file authorization")
	}
	for link, target := range map[string]string{
		filepath.Join(root, "escape"):    outside,
		filepath.Join(root, "file-link"): filepath.Join(root, "reports", "report.pdf"),
	} {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	if w := request(app, "GET", "/api/file-info"+fileQuery("file-link"), nil, cookie, ""); w.Code != 200 {
		t.Fatalf("contained local file link was not followed: %d %s", w.Code, w.Body)
	}
	for _, rel := range []string{outside, "escape/allowed-choice", "reports", ""} {
		if w := request(app, "GET", "/api/file-info"+fileQuery(rel), nil, cookie, ""); w.Code != 403 {
			t.Fatalf("local metadata bypassed content boundary for %q: %d %s", rel, w.Code, w.Body)
		}
	}
}

func TestConfiguredOriginHostsCookiesAndPreview(t *testing.T) {
	for _, scheme := range []string{"http", "https"} {
		t.Run(scheme, func(t *testing.T) {
			secure := scheme == "https"
			port, otherScheme := "80", "https"
			if secure {
				port, otherScheme = "443", "http"
			}
			base, store := newTestApp(t)
			cfg := base.cfg
			cfg.Listen = "0.0.0.0:8787"
			cfg.AppOrigin, cfg.PreviewOrigin = scheme+"://APP.example:"+port, scheme+"://PREVIEW.example:"+port
			app, err := New(cfg, store, base.assets)
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			if app.origin != scheme+"://app.example" || app.appHost != "app.example" ||
				app.previewOrigin != scheme+"://preview.example" || app.previewHost != "preview.example" {
				t.Fatal("explicit default-port origins did not normalize for Host/Origin checks")
			}
			r := httptest.NewRequest("GET", "/api/session", nil)
			r.Host = "app.example"
			r.Header.Set("Origin", app.origin)
			canonical := httptest.NewRecorder()
			app.Handler().ServeHTTP(canonical, r)
			if canonical.Code != 200 {
				t.Fatalf("canonical browser Host/Origin rejected: %d %s", canonical.Code, canonical.Body)
			}
			cookie, csrf := signIn(t, app)
			if cookie.Secure != secure || cookie.Domain != "" {
				t.Fatal("session cookie must be host-only with Secure matching the browser scheme")
			}
			previewURL := makePreview(t, app, cookie, csrf)
			if !strings.HasPrefix(previewURL, app.previewOrigin+"/p/") {
				t.Fatal(previewURL)
			}
			w := previewRequest(app, previewURL)
			if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors "+app.origin) {
				t.Fatalf("configured preview: %d %s", w.Code, w.Body)
			}
			for _, host := range []string{cfg.Listen, "evil.example"} {
				r := httptest.NewRequest("GET", "/api/session", nil)
				r.Host = host
				r.Header.Set("X-Forwarded-Host", "app.example")
				r.Header.Set("X-Forwarded-Proto", scheme)
				w := httptest.NewRecorder()
				app.Handler().ServeHTTP(w, r)
				if w.Code != 421 {
					t.Fatalf("forwarded host accepted: %d", w.Code)
				}
			}
			for _, origin := range []string{otherScheme + "://app.example", scheme + "://evil.example", app.origin + ":" + port, app.origin + "/", "null"} {
				r := httptest.NewRequest("GET", "/api/session", nil)
				r.Host = app.appHost
				r.Header.Set("Origin", origin)
				w := httptest.NewRecorder()
				app.Handler().ServeHTTP(w, r)
				if w.Code != 403 {
					t.Fatalf("foreign app origin: %d", w.Code)
				}
				if origin == "null" {
					continue // Opaque sandbox origins are valid only on the preview handler.
				}
				u, _ := url.Parse(previewURL)
				r = httptest.NewRequest("GET", u.RequestURI(), nil)
				r.Host = app.previewHost
				r.Header.Set("Origin", origin)
				w = httptest.NewRecorder()
				app.PreviewHandler().ServeHTTP(w, r)
				if w.Code != 403 {
					t.Fatalf("foreign preview origin: %d", w.Code)
				}
			}
			w = request(app, "POST", "/api/logout", map[string]string{}, cookie, csrf)
			if w.Code != 200 || w.Result().Cookies()[0].Secure != secure {
				t.Fatal("logout cookie has the wrong Secure attribute")
			}
			if w := previewRequest(app, previewURL); w.Code != 401 {
				t.Fatal("preview remained valid after logout")
			}
		})
	}
}
