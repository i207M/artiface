package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"artiface/internal/config"
	"artiface/internal/storage"
)

const testPassword = "test42"

type localStore struct {
	opens int
}

func (s *localStore) List(context.Context, string, string, string) ([]storage.Entry, error) {
	return []storage.Entry{}, nil
}

func (s *localStore) Open(_ context.Context, _ string, root, rel string) (storage.File, error) {
	s.opens++
	return os.Open(filepath.Join(root, filepath.FromSlash(rel)))
}

func (s *localStore) OpenScoped(ctx context.Context, target, root, scope, rel string) (storage.File, error) {
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	base, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(scope)))
	if err != nil {
		return nil, err
	}
	full, err := filepath.EvalSymlinks(filepath.Join(base, filepath.FromSlash(rel)))
	if err != nil {
		return nil, err
	}
	for _, boundary := range []string{root, base} {
		relative, err := filepath.Rel(boundary, full)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return nil, storage.ErrForbidden
		}
	}
	return s.Open(ctx, target, base, rel)
}

func (s *localStore) Close() error { return nil }

func newTestApp(t *testing.T) (*App, *localStore) {
	t.Helper()
	root := t.TempDir()
	for name, content := range map[string]string{
		"reports/index.html":       "<!doctype html><script>fetch('./assets/data.json')</script>",
		"reports/assets/data.json": `{"answer":42}`,
		"reports/report.pdf":       "%PDF-1.7\nrange request fixture",
		"secret.txt":               "outside the report directory",
	} {
		dest := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dest, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	hash, err := config.HashPassword(testPassword)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.PasswordHash = hash
	cfg.Hosts = []config.Host{{
		ID: "test", Label: "Test", Target: "test-alias",
		Roots: []config.Root{{ID: "artifacts", Label: "Artifacts", Path: root}},
	}}
	store := &localStore{}
	app, err := New(cfg, store, fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>Artiface</title>")},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return app, store
}

func request(app *App, method, target string, body any, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, target, bytes.NewReader(data))
	r.Host = app.appHost
	if method != http.MethodGet && method != http.MethodHead {
		r.Header.Set("Origin", app.origin)
		r.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	app.Handler().ServeHTTP(w, r)
	return w
}

func signIn(t *testing.T, app *App) (*http.Cookie, string) {
	t.Helper()
	w := request(app, "POST", "/api/login", map[string]string{"password": testPassword}, nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	var result struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || result.CSRFToken == "" {
		t.Fatal("login must issue a session and CSRF token")
	}
	cookie := cookies[0]
	if !cookie.HttpOnly || cookie.Domain != "" || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge <= 0 {
		t.Fatalf("unsafe session cookie: %+v", cookie)
	}
	return cookie, result.CSRFToken
}

func fileQuery(name string) string {
	return "?" + url.Values{"host": {"test"}, "root": {"artifacts"}, "path": {name}}.Encode()
}

func makePreview(t *testing.T, app *App, cookie *http.Cookie, csrf string) string {
	t.Helper()
	body := map[string]any{"host": "test", "root": "artifacts", "path": "reports/index.html"}
	w := request(app, "POST", "/api/preview", body, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("create preview: %d %s", w.Code, w.Body)
	}
	var result struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.URL
}

func previewRequest(app *App, target string) *httptest.ResponseRecorder {
	u, _ := url.Parse(target)
	r := httptest.NewRequest("GET", u.RequestURI(), nil)
	r.Host = app.previewHost
	r.Header.Set("Origin", "null")
	w := httptest.NewRecorder()
	app.PreviewHandler().ServeHTTP(w, r)
	return w
}

func TestSessionBoundary(t *testing.T) {
	app, store := newTestApp(t)
	for _, endpoint := range []string{"/api/hosts", "/api/list", "/api/text", "/api/file"} {
		w := request(app, "GET", endpoint+fileQuery("reports/index.html"), nil, nil, "")
		if w.Code != 401 {
			t.Errorf("%s without authentication: %d", endpoint, w.Code)
		}
	}
	if w := request(app, "POST", "/api/preview", location{}, nil, ""); w.Code != 401 {
		t.Fatalf("anonymous preview: %d", w.Code)
	}
	if store.opens != 0 {
		t.Fatal("unauthenticated requests reached storage")
	}
	cookie, csrf := signIn(t, app)
	if w := request(app, "POST", "/api/logout", nil, cookie, "wrong"); w.Code != 403 {
		t.Fatalf("logout without valid CSRF token: %d", w.Code)
	}
	if w := request(app, "GET", "/api/hosts", nil, cookie, ""); w.Code != 200 {
		t.Fatalf("authenticated hosts: %d", w.Code)
	}
	if w := request(app, "POST", "/api/logout", nil, cookie, csrf); w.Code != 200 {
		t.Fatalf("logout: %d", w.Code)
	}
	if w := request(app, "GET", "/api/hosts", nil, cookie, ""); w.Code != 401 {
		t.Fatalf("logged-out cookie remained valid: %d", w.Code)
	}
}

func TestLocalhostRequestGuards(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	for _, tc := range []struct {
		name, method, target, host, origin, site string
		want                                     int
	}{
		{"rebound host", "GET", "/api/hosts", "attacker.example:8787", "", "", 421},
		{"unconfigured hostname", "GET", "/api/hosts", "localhost:8787", "", "", 421},
		{"foreign origin", "GET", "/api/hosts", app.cfg.Listen, "https://attacker.example", "", 403},
		{"opaque report", "GET", "/api/hosts", app.cfg.Listen, "null", "", 403},
		{"cross-site fetch", "GET", "/api/hosts", app.cfg.Listen, "", "cross-site", 403},
		{"same-site other port", "GET", "/api/hosts", app.cfg.Listen, "", "same-site", 403},
		{"origin-free login", "POST", "/api/login", app.cfg.Listen, "", "", 403},
		{"external deep link", "GET", "/", app.cfg.Listen, "", "cross-site", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.target, strings.NewReader(`{"password":"irrelevant"}`))
			r.Host = tc.host
			r.AddCookie(cookie)
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Sec-Fetch-Site", tc.site)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			app.Handler().ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d: %s", w.Code, w.Body)
			}
		})
	}
}

func TestLoginThrottlingAndExpiredSession(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	for i := 0; i < 5; i++ {
		if w := request(app, "POST", "/api/login", map[string]string{"password": "wrong"}, nil, ""); w.Code != 401 {
			t.Fatalf("failed login %d: %d", i, w.Code)
		}
	}
	w := request(app, "POST", "/api/login", map[string]string{"password": testPassword}, nil, "")
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("login attempts were not throttled")
	}
	app.mu.Lock()
	s := app.sessions[cookie.Value]
	s.expires = time.Now().Add(-time.Second)
	app.sessions[cookie.Value] = s
	app.mu.Unlock()
	if w := request(app, "GET", "/api/hosts", nil, cookie, ""); w.Code != 401 {
		t.Fatal("expired session was accepted")
	}
}

func TestUntrustedFileResponsesAndRanges(t *testing.T) {
	app, store := newTestApp(t)
	cookie, _ := signIn(t, app)
	w := request(app, "GET", "/api/file"+fileQuery("reports/index.html"), nil, cookie, "")
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/octet-stream" ||
		!strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") ||
		w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("HTML download could render on app origin: %d %v", w.Code, w.Header())
	}
	r := httptest.NewRequest("GET", "/api/file"+fileQuery("reports/report.pdf"), nil)
	r.Host = app.cfg.Listen
	r.AddCookie(cookie)
	r.Header.Set("Range", "bytes=0-4")
	w = httptest.NewRecorder()
	app.Handler().ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "%PDF-" || w.Header().Get("Content-Range") == "" {
		t.Fatalf("PDF range failed: %d %q %v", w.Code, w.Body, w.Header())
	}
	before := store.opens
	for _, rel := range []string{"../secret.txt", "reports/../../secret.txt", "/etc/passwd", "reports\\..\\secret.txt"} {
		w := request(app, "GET", "/api/file"+fileQuery(rel), nil, cookie, "")
		if w.Code != 403 {
			t.Errorf("path %q: %d", rel, w.Code)
		}
	}
	if store.opens != before {
		t.Fatal("disallowed path reached storage")
	}
}

func TestPreviewScopeIsolationAndRevocation(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, csrf := signIn(t, app)
	previewURL := makePreview(t, app, cookie, csrf)
	base := previewURL[:strings.LastIndex(previewURL, "/")+1]
	w := previewRequest(app, previewURL)
	csp := w.Header().Get("Content-Security-Policy")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "<script>") {
		t.Fatalf("interactive HTML missing: %d %s", w.Code, w.Body)
	}
	if !strings.Contains(csp, "script-src 'nonce-") || strings.Contains(csp, "script-src 'unsafe-inline'") || !strings.Contains(csp, "sandbox allow-scripts") || strings.Contains(csp, "allow-same-origin") ||
		!strings.Contains(csp, "frame-ancestors "+app.origin) || w.Header().Get("Set-Cookie") != "" {
		t.Fatalf("unsafe preview policy: %v", w.Header())
	}
	w = request(app, "POST", "/api/preview", map[string]any{
		"host": "test", "root": "artifacts", "path": "reports/index.html", "scripts": true,
	}, cookie, csrf)
	if w.Code != http.StatusBadRequest {
		t.Fatal("unknown preview field was accepted")
	}
	app.cfg.Hosts[0].Roots[0].TrustedScripts = true
	activeURL := makePreview(t, app, cookie, csrf)
	activeCSP := previewRequest(app, activeURL).Header().Get("Content-Security-Policy")
	if !strings.Contains(activeCSP, "sandbox allow-scripts") || strings.Contains(activeCSP, "allow-same-origin") {
		t.Fatalf("project-trusted scripts must remain isolated: %s", activeCSP)
	}
	w = previewRequest(app, base+"assets/data.json")
	if w.Code != 200 || w.Body.String() != `{"answer":42}` || w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("sandboxed relative fetch failed: %d %s", w.Code, w.Body)
	}
	for _, bad := range []string{"../secret.txt", "assets/../../secret.txt", "%2e%2e/secret.txt", "/etc/passwd"} {
		w := previewRequest(app, base+bad)
		if w.Code != 403 {
			t.Errorf("preview escape %q: %d %s", bad, w.Code, w.Body)
		}
	}
	u, _ := url.Parse(previewURL)
	r := httptest.NewRequest("GET", u.RequestURI(), nil)
	r.Host = app.previewHost
	r.Header.Set("Sec-Fetch-Dest", "document")
	w = httptest.NewRecorder()
	app.PreviewHandler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("active report can open outside the protected application frame")
	}
	request(app, "POST", "/api/logout", nil, cookie, csrf)
	if w := previewRequest(app, previewURL); w.Code != 401 {
		t.Fatal("preview remained usable after logout")
	}
	if w := previewRequest(app, activeURL); w.Code != 401 {
		t.Fatal("active preview remained usable after logout")
	}
	if w := previewRequest(app, app.previewOrigin+"/p/"+randomToken()+"/index.html"); w.Code != 401 {
		t.Fatal("unknown capability accepted")
	}
}

func TestPreviewExpiryAndSessionReplacement(t *testing.T) {
	for _, reason := range []string{"capability expired", "parent session expired", "parent session replaced"} {
		t.Run(reason, func(t *testing.T) {
			app, _ := newTestApp(t)
			cookie, csrf := signIn(t, app)
			previewURL := makePreview(t, app, cookie, csrf)
			u, _ := url.Parse(previewURL)
			token := strings.Split(u.Path, "/")[2]
			switch reason {
			case "capability expired":
				app.mu.Lock()
				p := app.previews[token]
				p.expires = time.Now().Add(-time.Second)
				app.previews[token] = p
				app.mu.Unlock()
			case "parent session expired":
				app.mu.Lock()
				s := app.sessions[cookie.Value]
				s.expires = time.Now().Add(-time.Second)
				app.sessions[cookie.Value] = s
				app.mu.Unlock()
			case "parent session replaced":
				w := request(app, "POST", "/api/login", map[string]string{"password": testPassword}, cookie, "")
				if w.Code != 200 {
					t.Fatalf("session replacement: %d", w.Code)
				}
			}
			if w := previewRequest(app, previewURL); w.Code != 401 {
				t.Fatalf("preview remained valid after %s: %d", reason, w.Code)
			}
		})
	}
}

type growingStore struct{ localStore }

func (*growingStore) Open(context.Context, string, string, string) (storage.File, error) {
	return &growingFile{}, nil
}

func (s *growingStore) OpenScoped(ctx context.Context, target, root, scope, rel string) (storage.File, error) {
	return s.Open(ctx, target, root, rel)
}

// Stat reports a file within the preview limit, but a subsequent SeekEnd sees
// new data appended by an agent. No large allocation is needed for this test.
type growingFile struct{ position int64 }

func (*growingFile) Stat() (fs.FileInfo, error) { return sizeInfo{}, nil }
func (*growingFile) Close() error               { return nil }
func (f *growingFile) Read(p []byte) (int, error) {
	if f.position >= 101<<20 {
		return 0, io.EOF
	}
	n := int(min(int64(len(p)), (101<<20)-f.position))
	clear(p[:n])
	f.position += int64(n)
	return n, nil
}
func (f *growingFile) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
		f.position = offset
	case io.SeekCurrent:
		f.position += offset
	case io.SeekEnd:
		f.position = (101 << 20) + offset
	}
	return f.position, nil
}

type sizeInfo struct{}

func (sizeInfo) Name() string       { return "growing.html" }
func (sizeInfo) Size() int64        { return (100 << 20) - 1 }
func (sizeInfo) Mode() fs.FileMode  { return 0600 }
func (sizeInfo) ModTime() time.Time { return time.Time{} }
func (sizeInfo) IsDir() bool        { return false }
func (sizeInfo) Sys() any           { return nil }

func TestGrowingFileCannotBypassValidatedSize(t *testing.T) {
	app, _ := newTestApp(t)
	app.store = &growingStore{}
	cookie, csrf := signIn(t, app)
	previewURL := makePreview(t, app, cookie, csrf)
	u, _ := url.Parse(previewURL)
	r := httptest.NewRequest("HEAD", u.RequestURI(), nil)
	r.Host = app.previewHost
	w := httptest.NewRecorder()
	app.PreviewHandler().ServeHTTP(w, r)
	if w.Code != 200 || w.Header().Get("Content-Length") != strconv.FormatInt(sizeInfo{}.Size(), 10) {
		t.Fatalf("preview used a size larger than the validated limit: %d %v", w.Code, w.Header())
	}
	// Reads must be bounded as well as the size advertised for HEAD.
	r = httptest.NewRequest("GET", u.RequestURI(), nil)
	r.Host = app.previewHost
	r.Header.Set("Range", fmtRange(sizeInfo{}.Size()-3, sizeInfo{}.Size()+5))
	w = httptest.NewRecorder()
	app.PreviewHandler().ServeHTTP(w, r)
	if w.Code != 206 || w.Body.Len() != 3 {
		t.Fatalf("range escaped the validated file length: %d, %d bytes", w.Code, w.Body.Len())
	}
}

func fmtRange(start, end int64) string {
	return "bytes=" + strconv.FormatInt(start, 10) + "-" + strconv.FormatInt(end, 10)
}

func TestBoundedTextAndMissingFrontendAssets(t *testing.T) {
	app, _ := newTestApp(t)
	root := app.cfg.Hosts[0].Roots[0].Path
	data := append(bytes.Repeat([]byte("a"), maxTextBytes-1), []byte("€tail")...)
	if err := os.WriteFile(filepath.Join(root, "large.md"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "binary"), []byte{1, 0, 3}, 0600); err != nil {
		t.Fatal(err)
	}
	cookie, _ := signIn(t, app)
	w := request(app, "GET", "/api/text"+fileQuery("large.md"), nil, cookie, "")
	var result struct {
		Text      string `json:"text"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || !result.Truncated || len(result.Text) != maxTextBytes-1 {
		t.Fatalf("bounded UTF-8 text preview failed: %d %d", w.Code, len(result.Text))
	}
	if w := request(app, "GET", "/api/text"+fileQuery("binary"), nil, cookie, ""); w.Code != 415 {
		t.Fatal("binary file was treated as text")
	}
	if w := request(app, "GET", "/assets/missing-worker.js", nil, nil, ""); w.Code != 404 {
		t.Fatal("missing worker returned the application HTML")
	}
}
