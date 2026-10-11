package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"artiface/internal/config"
	"artiface/internal/ignore"
	"artiface/internal/storage"
)

func TestBrowseFallsBackWhenIgnoreFileCannotBeReadSafely(t *testing.T) {
	for _, problem := range []string{"symlink", "hardlink"} {
		t.Run(problem, func(t *testing.T) {
			app, _, filename, _ := newSetupApp(t, "")
			cfg, err := config.Load(filename)
			if err != nil {
				t.Fatal(err)
			}
			cfg.Hosts[0].Kind, cfg.Hosts[0].Target = "local", ""
			if err := config.Save(filename, cfg); err != nil {
				t.Fatal(err)
			}
			app.adoptSources(cfg)
			store := storage.NewLocal()
			defer store.Close()
			app.store = store
			cache := filepath.Join(cfg.Hosts[0].Roots[0].Path, "__pycache__")
			if err := os.Mkdir(cache, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(cache, "cached.pyc"), []byte("cache"), 0600); err != nil {
				t.Fatal(err)
			}
			cookie, csrf := signIn(t, app)
			doc := readIgnore(t, app, cookie)
			before, _ := os.ReadFile(filename)
			switch problem {
			case "symlink":
				err = os.Symlink(filename, doc.Path)
			case "hardlink":
				err = os.Link(filename, doc.Path)
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, suffix := range []string{"", "&recursive=1&showHidden=1"} {
				w := request(app, "GET", "/api/list"+fileQuery("")+suffix, nil, cookie, "")
				var listing storage.Listing
				if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &listing) != nil ||
					!strings.Contains(listing.Warning, "Using default ignore rules") {
					t.Fatalf("unsafe ignore blocked Browse or omitted warning: %d %s", w.Code, w.Body)
				}
				found := false
				for _, entry := range listing.Entries {
					found = found || entry.Path == "secret.txt"
					if strings.HasPrefix(entry.Path, "__pycache__") {
						t.Fatal("fallback lost default cache filtering")
					}
				}
				if !found || strings.Contains(w.Body.String(), cfg.PasswordHash) {
					t.Fatal("fallback hid valid project files or exposed configuration")
				}
			}
			for _, method := range []string{"GET", "POST"} {
				w := request(app, method, "/api/ignore",
					map[string]string{"content": "", "revision": doc.Revision}, cookie, csrf)
				if w.Code != 500 || strings.Contains(w.Body.String(), cfg.PasswordHash) {
					t.Fatal("unsafe ignore editor exposed or replaced the configuration")
				}
			}
			after, _ := os.ReadFile(filename)
			if !bytes.Equal(before, after) {
				t.Fatal("ignore fallback changed the configuration")
			}
			err = os.Remove(doc.Path)
			if err != nil {
				t.Fatal(err)
			}
			readIgnore(t, app, cookie)
			w := request(app, "GET", "/api/list"+fileQuery(""), nil, cookie, "")
			var listing storage.Listing
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &listing) != nil || listing.Warning != "" {
				t.Fatal("fixing the ignore path did not clear the warning without restart")
			}
		})
	}
}

func readIgnore(t *testing.T, app *App, cookie *http.Cookie) ignore.Document {
	t.Helper()
	w := request(app, "GET", "/api/ignore", nil, cookie, "")
	var doc ignore.Document
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &doc) != nil {
		t.Fatalf("GET ignore: %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("ignore content can be cached")
	}
	return doc
}

func TestIgnoreAPIAuthenticationCSRFRevisionAndFixedPath(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	doc := readIgnore(t, app, cookie)
	if !doc.Editable || doc.Content != ignore.DefaultContent ||
		doc.Path != filepath.Join(filepath.Dir(filename), ignore.Filename) ||
		strings.Contains(doc.Content, app.cfg.PasswordHash) {
		t.Fatalf("incorrect public document: %+v", doc)
	}
	body := map[string]string{"content": "", "revision": doc.Revision}
	for _, tc := range []struct {
		method string
		cookie *http.Cookie
		csrf   string
		want   int
	}{{"GET", nil, "", 401}, {"POST", nil, "", 401}, {"POST", cookie, "", 403}, {"POST", cookie, "wrong", 403}} {
		if w := request(app, tc.method, "/api/ignore", body, tc.cookie, tc.csrf); w.Code != tc.want {
			t.Fatalf("ignore auth guard: %d %s", w.Code, w.Body)
		}
	}
	for _, body := range []any{
		map[string]string{"content": "", "revision": doc.Revision, "path": filename},
		map[string]string{"revision": doc.Revision},
		map[string]string{"content": ""},
		map[string]string{"content": "!cache/", "revision": doc.Revision},
		map[string]string{"content": strings.Repeat("a", ignore.MaxContentBytes+1), "revision": doc.Revision},
	} {
		if w := request(app, "POST", "/api/ignore", body, cookie, csrf); w.Code != 400 {
			t.Fatalf("unsafe/malformed request accepted: %d %s", w.Code, w.Body)
		}
	}
	for _, origin := range []string{"", "null", "https://evil.example"} {
		r := httptest.NewRequest("POST", "/api/ignore", strings.NewReader(`{"content":""}`))
		r.Host = app.appHost
		r.AddCookie(cookie)
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", csrf)
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("foreign/missing Origin reached save", w.Code)
		}
	}
	if _, err := os.Stat(doc.Path); !os.IsNotExist(err) {
		t.Fatal("rejected request created an ignore file")
	}
	if w := request(app, "POST", "/api/ignore", body, cookie, csrf); w.Code != 200 {
		t.Fatalf("clear ignore: %d %s", w.Code, w.Body)
	}
	if got := readIgnore(t, app, cookie); got.Content != "" || got.Revision == doc.Revision {
		t.Fatal("cleared content did not persist", got)
	}
	if w := request(app, "POST", "/api/ignore", body, cookie, csrf); w.Code != 409 {
		t.Fatalf("stale edit accepted: %d %s", w.Code, w.Body)
	}
	// A browser cannot choose a different path through query parameters either.
	if got := request(app, "GET", "/api/ignore?path="+filename, nil, cookie, ""); got.Code != 200 ||
		strings.Contains(got.Body.String(), app.cfg.PasswordHash) {
		t.Fatal("ignore query exposed config contents", got.Body)
	}
	disabled, _ := newTestApp(t)
	dc, token := signIn(t, disabled)
	d := readIgnore(t, disabled, dc)
	if d.Editable || d.Path != "" || d.Content != ignore.DefaultContent {
		t.Fatal("ignore defaults without config", d)
	}
	if w := request(disabled, "POST", "/api/ignore", map[string]string{"content": "", "revision": d.Revision}, dc, token); w.Code != 403 {
		t.Fatal("ignore editing enabled without config", w.Code)
	}
}

func TestIgnoreOnlyAffectsBrowseAndFlatHiddenSemantics(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cfg, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Hosts[0].Kind, cfg.Hosts[0].Target = "local", ""
	if err := config.Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	app.adoptSources(cfg)
	store := storage.NewLocal()
	defer store.Close()
	app.store = store
	root := cfg.Hosts[0].Roots[0].Path
	if err := os.Symlink("reports", filepath.Join(root, "latest")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"node_modules/pkg.js", "__pycache__/thing.pyc", ".git/objects/data", ".hidden/.nested/secret",
		".hidden/visible.txt", ".dotfile", "build/report.html", "dist/image.png",
	} {
		full := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	cookie, csrf := signIn(t, app)
	list := func(rel, extra string) storage.Listing {
		t.Helper()
		w := request(app, "GET", "/api/list"+fileQuery(rel)+extra, nil, cookie, "")
		var got storage.Listing
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || got.Truncated {
			t.Fatalf("list: %d %s", w.Code, w.Body)
		}
		return got
	}
	paths := func(listing storage.Listing) map[string]bool {
		got := map[string]bool{}
		for _, entry := range listing.Entries {
			got[entry.Path] = true
		}
		return got
	}
	hier := paths(list("", "&showHidden=0"))
	if !hier[".hidden"] || !hier[".dotfile"] || hier["node_modules"] || hier["__pycache__"] || hier[".git"] {
		t.Fatal("hierarchical listing changed hidden preference behavior or ignored defaults", hier)
	}
	flat := paths(list("", "&recursive=1&showHidden=0"))
	if !flat["build/report.html"] || !flat["dist/image.png"] || flat[".dotfile"] || flat[".hidden/visible.txt"] ||
		flat["node_modules/pkg.js"] || flat["reports"] {
		t.Fatal("flat defaults/hidden/files-only behavior", flat)
	}
	allHidden := paths(list("", "&recursive=1&showHidden=1"))
	if !allHidden[".dotfile"] || !allHidden[".hidden/visible.txt"] || !allHidden[".hidden/.nested/secret"] || allHidden[".git/objects/data"] {
		t.Fatal("showHidden bypassed ignore or did not traverse dot dirs", allHidden)
	}
	chosen := list(".hidden", "&recursive=1&showHidden=0")
	if len(chosen.Entries) != 1 || chosen.Entries[0].Path != ".hidden/visible.txt" {
		t.Fatal("explicit hidden directory suppressed its nonhidden children", chosen)
	}
	previewURL := makePreview(t, app, cookie, csrf)
	settings := readSettings(t, app, cookie)
	before, _ := os.ReadFile(filename)
	beforeInfo, _ := os.Stat(filename)
	doc := readIgnore(t, app, cookie)
	w := request(app, "POST", "/api/ignore", map[string]string{
		"content": "reports/\nsecret.txt\n", "revision": doc.Revision,
	}, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("save display rules: %d %s", w.Code, w.Body)
	}
	if listed := paths(list("", "")); listed["reports"] || listed["secret.txt"] {
		t.Fatal("custom rules were not applied immediately", listed)
	}
	if listed := list("reports", "&recursive=1"); len(listed.Entries) != 0 {
		t.Fatal("project-root ancestor rule was lost when starting below it", listed)
	}
	if listed := list("reports", ""); len(listed.Entries) != 0 {
		t.Fatal("hierarchical descendant lost its ignored ancestor", listed)
	}
	if listed := list("latest", ""); len(listed.Entries) != 0 {
		t.Fatal("directory alias bypassed ignore rules for its canonical children", listed)
	}
	for _, endpoint := range []string{"/api/text", "/api/file", "/api/file-info"} {
		if w := request(app, "GET", endpoint+fileQuery("reports/index.html"), nil, cookie, ""); w.Code != 200 {
			t.Fatalf("ignore changed direct file access %s: %d %s", endpoint, w.Code, w.Body)
		}
	}
	if w := previewRequest(app, previewURL); w.Code != 200 {
		t.Fatal("ignore save revoked preview", w.Code)
	}
	makePreview(t, app, cookie, csrf)
	w = request(app, "POST", "/api/folders", map[string]string{"host": "test", "path": root}, cookie, csrf)
	var folders storage.FolderListing
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &folders) != nil {
		t.Fatalf("folder chooser: %d %s", w.Code, w.Body)
	}
	found := false
	for _, entry := range folders.Entries {
		found = found || entry.Name == "reports"
	}
	if !found {
		t.Fatal("ignore rules hid Add Folder choices")
	}
	after, _ := os.ReadFile(filename)
	afterInfo, _ := os.Stat(filename)
	if string(before) != string(after) || !os.SameFile(beforeInfo, afterInfo) || readSettings(t, app, cookie).Revision != settings.Revision {
		t.Fatal("ignore save changed configuration/password/settings revision")
	}
	doc = readIgnore(t, app, cookie)
	if w := request(app, "POST", "/api/ignore", map[string]string{"content": "", "revision": doc.Revision}, cookie, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if all := paths(list("", "&recursive=1&showHidden=1")); !all["node_modules/pkg.js"] || !all[".git/objects/data"] {
		t.Fatal("empty file did not disable ignore rules", all)
	}
}
