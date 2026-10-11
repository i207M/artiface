package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"artiface/internal/storage"
)

func TestPreviewScriptDetector(t *testing.T) {
	for _, tc := range []struct{ html, want string }{
		{`<!doctype html><p>Static &lt;script&gt; text</p>`, "absent"},
		{`<!-- <script>alert(1)</script> --><p>Static</p>`, "absent"},
		{`<style>/* <script>x</script> */</style><textarea><b onclick="x()">x</b></textarea>`, "absent"},
		{`<plaintext><script>x</script><b onclick=x()>`, "absent"},
		{`<script type="application/json">{"tag":"<script>","handler":"onclick=x()"}</script>`, "absent"},
		{`<script type="application/ld+json">{"url":"javascript:x()"}</script><script type=importmap>{}</script>`, "absent"},
		{`<script type="text/javascript; charset=utf-8">data</script>`, "absent"},
		{`<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg><p>Static chart</p>`, "absent"},
		{`<svg><circle cx="5" cy="5" r="2"/></svg><script>chart()</script>`, "present"},
		{`<svg><g onclick="selectPoint()"><circle r="2"/></g></svg>`, "present"},
		{`<math><mi>x</mi></math><template><p>Static sample</p></template>`, "absent"},
		{`<template><script>sample()</script></template>`, "present"},
		{`<noscript><p>Please enable JavaScript.</p></noscript><script>start()</script>`, "present"},
		{`<noscript><p>Please enable JavaScript.</p></noscript><p>Static fallback</p>`, "absent"},
		{`<script>x()</script>`, "present"},
		{`<SCRIPT TYPE='module' SRC="./app.js"></SCRIPT>`, "present"},
		{`<script type=" text/JavaScript ">x()</script>`, "present"},
		{`<script language=JavaScript1.5>x()</script>`, "present"},
		{`<button ONCLICK="x('>')">Go</button>`, "present"},
		{`<a href=" &#x6a;ava&#10;script:x()">Go</a>`, "present"},
		{`<p data-note="javascript:x()">Static</p>`, "absent"},
		{`<script type=application/json>{"x":"</scripture><script>"}</script><script>x()</script>`, "present"},
		{`<script type="application/json" type="module">{}</script>`, "absent"},
		{`<script type="module" type="application/json">{}</script>`, "present"},
		{`<script type="application/json">{`, "unknown"},
		{`<p title="unfinished`, "unknown"},
		{"<\x00s\x00c\x00r\x00i\x00p\x00t\x00>", "unknown"},
	} {
		for _, chunk := range []int{1, 7, 128 << 10} {
			var detector scriptDetector
			for offset := 0; offset < len(tc.html); offset += chunk {
				detector.feed([]byte(tc.html[offset:min(offset+chunk, len(tc.html))]))
			}
			if got := detector.result(); got != tc.want {
				t.Errorf("chunk=%d %q: %s, want %s", chunk, tc.html, got, tc.want)
			}
		}
	}
}

func TestPreviewScriptDetectorBoundsAndLargeJSON(t *testing.T) {
	var detector scriptDetector
	detector.feed([]byte(`<script type="application/json">{"data":"`))
	chunk := bytes.Repeat([]byte("x"), 1024)
	for range 7900 { // 7.7 MiB of inert JSON before executable code.
		detector.feed(chunk)
		if len(detector.tag) != 0 || cap(detector.tag) > scriptTagLimit*2 {
			t.Fatal("raw JSON accumulated in the tag buffer")
		}
	}
	detector.feed([]byte(`"}</script><script type=module>run()</script>`))
	if detector.result() != "present" {
		t.Fatal("missed JavaScript after large inert JSON", detector.result())
	}
	detector = scriptDetector{}
	for range scriptScanLimit/len(chunk) + 1 {
		detector.feed(chunk)
	}
	if detector.result() != "unknown" || detector.seen != scriptScanLimit+1 {
		t.Fatal("scan limit must be bounded and inconclusive")
	}
	detector.feed([]byte(`<script>outsideScanBudget()</script>`))
	if detector.result() != "unknown" || detector.seen != scriptScanLimit+1 {
		t.Fatal("later markup bypassed the total scan limit")
	}
	detector = scriptDetector{}
	detector.feed([]byte(`<p title="`))
	for range scriptTagLimit/len(chunk) + 1 {
		detector.feed(chunk)
	}
	if detector.result() != "unknown" || len(detector.tag) > scriptTagLimit {
		t.Fatal("oversized markup must be bounded and inconclusive")
	}
}

func TestPreviewScriptDetectorAfterOversizedTags(t *testing.T) {
	large := strings.Repeat("A", 2*scriptTagLimit)
	image := `<img src="data:image/png;base64,` + large + `">`
	for _, tc := range []struct{ name, markup, want string }{
		{"embedded images before report script", strings.Repeat(image, 4) +
			`<script type="application/json">{"data":"<script>"}</script><script>updateChart()</script>`, "present"},
		{"later event handler", image + `<select onchange="updateChart()"></select>`, "present"},
		{"unquoted attribute", `<img src=data:image/png;base64,` + large + `><script type=module>run()</script>`, "present"},
		{"uncertain without later evidence", image + `<p>Static report</p>`, "unknown"},
		{"quoted markup", `<img alt='` + large + `><script>quotedText()</script>'>`, "unknown"},
		{"unfinished quote", `<img alt="` + large + `><script>stillQuoted()</script>`, "unknown"},
		{"raw style text", `<style data-label="` + large + `">p::after{content:"<script>"}</style>`, "unknown"},
		{"raw JSON text", `<script type=application/json data-label="` + large +
			`">{"text":"<script>"}</script>`, "unknown"},
		{"after raw JSON text", `<script type=application/json data-label="` + large +
			`">{"text":"<script>"}</script><script>run()</script>`, "present"},
		{"after raw textarea text", `<textarea data-label="` + large +
			`"><script>inert()</script></textarea><button onclick="run()">Go</button>`, "present"},
		{"plaintext", `<plaintext data-label="` + large + `"><script>inert()</script>`, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, chunk := range []int{1, 7, 128 << 10} {
				var detector scriptDetector
				for offset := 0; offset < len(tc.markup); offset += chunk {
					detector.feed([]byte(tc.markup[offset:min(offset+chunk, len(tc.markup))]))
					if len(detector.tag) > scriptTagLimit || cap(detector.tag) > 2*scriptTagLimit {
						t.Fatal("oversized tag grew the retained markup buffer")
					}
				}
				if got := detector.result(); got != tc.want {
					t.Errorf("chunk=%d: %s, want %s", chunk, got, tc.want)
				}
			}
		})
	}
}

type scriptPreview struct {
	URL         string `json:"url"`
	ScriptCheck string `json:"scriptCheck"`
	Version     string `json:"version"`
	Bridge      bool   `json:"bridge"`
}

func createScriptPreview(t *testing.T, app *App, cookie *http.Cookie, csrf, name string) scriptPreview {
	t.Helper()
	w := request(app, "POST", "/api/preview", location{Host: "test", Root: "artifacts", Path: name}, cookie, csrf)
	var response scriptPreview
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil {
		t.Fatalf("preview: %d %s", w.Code, w.Body)
	}
	return response
}

func scriptStatus(t *testing.T, app *App, cookie *http.Cookie, csrf, token string) string {
	t.Helper()
	w := request(app, "POST", "/api/preview/scripts", map[string]string{"token": token}, cookie, csrf)
	var response struct{ Status string }
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}
	return response.Status
}

type scriptCountingStore struct {
	*localStore
	opens, reads, bytes, maxRead int
	readError                    bool
}

func (s *scriptCountingStore) Open(ctx context.Context, target, root, rel string) (storage.File, error) {
	f, err := s.localStore.Open(ctx, target, root, rel)
	if err != nil {
		return nil, err
	}
	s.opens++
	return &scriptCountingFile{File: f, store: s}, nil
}

func (s *scriptCountingStore) OpenScoped(ctx context.Context, target, root, scope, rel string) (storage.File, error) {
	f, err := s.localStore.OpenScoped(ctx, target, root, scope, rel)
	if err != nil {
		return nil, err
	}
	s.opens++
	return &scriptCountingFile{File: f, store: s}, nil
}

type scriptCountingFile struct {
	storage.File
	store *scriptCountingStore
}

type scriptMetadataStore struct{ *metadataStore }

func (s *scriptMetadataStore) OpenScoped(ctx context.Context, target, root, scope, rel string) (storage.File, error) {
	return s.Open(ctx, target, root, rel)
}

func TestPreviewScriptsUnsupportedSizeHasNoCheck(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, csrf := signIn(t, app)
	for _, size := range []int64{maxPreviewAssetBytes - 1, maxPreviewAssetBytes, maxPreviewAssetBytes + 1, -1} {
		store := &scriptMetadataStore{&metadataStore{info: metadataInfo{size: size, mode: 0600}}}
		app.store = store
		p := createScriptPreview(t, app, cookie, csrf, "report.HTM")
		supported := size >= 0 && size <= maxPreviewAssetBytes
		if (p.ScriptCheck != "") != supported || store.reads != 0 || store.seeks != 0 || store.opens != 1 {
			t.Fatalf("size=%d check=%q reads=%d seeks=%d opens=%d", size, p.ScriptCheck, store.reads, store.seeks, store.opens)
		}
		if !supported {
			if w := previewRequest(app, p.URL); w.Code != http.StatusRequestEntityTooLarge || store.reads != 0 {
				t.Fatal("unsupported preview bypassed its existing size limit", w.Code)
			}
		}
	}
}

func (f *scriptCountingFile) Read(data []byte) (int, error) {
	f.store.reads++
	f.store.maxRead = max(f.store.maxRead, len(data))
	if f.store.readError {
		return 0, errors.New("synthetic stream failure")
	}
	n, err := f.File.Read(data)
	f.store.bytes += n
	return n, err
}

func TestPreviewScriptsObserveOnlyMainStream(t *testing.T) {
	app, local := newTestApp(t)
	store := &scriptCountingStore{localStore: local}
	app.store = store
	cookie, csrf := signIn(t, app)
	data := []byte(`<script type=application/json>{"data":"` + strings.Repeat("x", 7900*1024) + `"}</script><script>run()</script>`)
	filename := filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports", "index.html")
	if err := os.WriteFile(filename, data, 0600); err != nil {
		t.Fatal(err)
	}
	p := createScriptPreview(t, app, cookie, csrf, "reports/index.html")
	if len(p.ScriptCheck) != 43 || store.opens != 1 || store.reads != 0 {
		t.Fatal("creation must only open/stat, without reading the report", store)
	}
	for range 2 {
		if got := scriptStatus(t, app, cookie, csrf, p.ScriptCheck); got != "pending" {
			t.Fatal(got)
		}
	}
	if store.opens != 1 || store.reads != 0 {
		t.Fatal("polling opened or read storage")
	}
	asset := p.URL[:strings.LastIndex(p.URL, "/")+1] + "assets/data.json"
	previewRequest(app, asset)
	if got := scriptStatus(t, app, cookie, csrf, p.ScriptCheck); got != "pending" {
		t.Fatal("a sibling asset completed the main check", got)
	}
	opens, reads, count := store.opens, store.reads, store.bytes
	w := previewRequest(app, p.URL)
	if w.Code != 200 || !bytes.Equal(previewAuthoredBytes(t, w.Body.Bytes()), data) ||
		store.opens-opens != 1 || store.bytes-count != len(data) ||
		store.reads-reads != (len(data)+downloadBatchSize-1)/downloadBatchSize ||
		store.maxRead != downloadBatchSize {
		t.Fatalf("stream changed or reread: code=%d opens=%d reads=%d bytes=%d batch=%d", w.Code, store.opens-opens, store.reads-reads, store.bytes-count, store.maxRead)
	}
	if w.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'nonce-") ||
		!strings.HasSuffix(w.Header().Get("Content-Security-Policy"), "; sandbox allow-scripts") ||
		strings.Contains(w.Header().Get("Content-Security-Policy"), "allow-same-origin") {
		t.Fatal("preview security policy changed", w.Header())
	}
	opens, reads = store.opens, store.reads
	if got := scriptStatus(t, app, cookie, csrf, p.ScriptCheck); got != "present" {
		t.Fatal(got)
	}
	if store.opens != opens || store.reads != reads {
		t.Fatal("final status reread storage")
	}
	t.Logf("main stream: %d original bytes unchanged after bridge, 1 open, %d reads, %d-byte batches; metadata/status reads: 0", len(data), (len(data)+downloadBatchSize-1)/downloadBatchSize, store.maxRead)
}

func TestPreviewScriptsIncompleteAndChangedResponses(t *testing.T) {
	app, local := newTestApp(t)
	store := &scriptCountingStore{localStore: local}
	app.store = store
	cookie, csrf := signIn(t, app)
	for _, tc := range []struct {
		name, method, ranges, want string
		status                     int
	}{
		{"head", "HEAD", "", "pending", 200},
		{"range", "GET", "bytes=0-7", "unknown", 206},
		{"multipart", "GET", "bytes=0-2,5-7", "unknown", 206},
		{"invalid range", "GET", "bytes=99999-", "unknown", 416},
		{"conditional", "GET", "", "unknown", 304},
		{"read failure", "GET", "", "unknown", 200},
		{"open failure", "GET", "", "unknown", 404},
		{"changed", "GET", "", "unknown", 200},
		{"same size new version", "GET", "", "unknown", 200},
		{"static", "GET", "", "absent", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filename := filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports", "index.html")
			if err := os.WriteFile(filename, []byte("<p>Static report</p>"), 0600); err != nil {
				t.Fatal(err)
			}
			p := createScriptPreview(t, app, cookie, csrf, "reports/index.html")
			if tc.name == "changed" {
				if err := os.WriteFile(filename, []byte("<script>changed()</script>"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if tc.name == "same size new version" {
				next := time.Now().Add(time.Hour)
				if err := os.Chtimes(filename, next, next); err != nil {
					t.Fatal(err)
				}
			}
			if tc.name == "open failure" {
				if err := os.Remove(filename); err != nil {
					t.Fatal(err)
				}
			}
			store.readError = tc.name == "read failure"
			u, _ := url.Parse(p.URL)
			r := httptest.NewRequest(tc.method, u.RequestURI(), nil)
			r.Host = app.previewHost
			r.Header.Set("Range", tc.ranges)
			if tc.name == "conditional" {
				r.Header.Set("If-Modified-Since", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
			}
			before := store.reads
			w := httptest.NewRecorder()
			app.PreviewHandler().ServeHTTP(w, r)
			store.readError = false
			if w.Code != tc.status || scriptStatus(t, app, cookie, csrf, p.ScriptCheck) != tc.want {
				t.Fatalf("response/check: %d, want %d/%s", w.Code, tc.status, tc.want)
			}
			if (tc.method == "HEAD" || tc.status == 304 || tc.status == 416) && store.reads != before {
				t.Fatal("metadata-only response read content")
			}
		})
	}
}

func TestPreviewScriptsSessionExpiryAndConsentMetadata(t *testing.T) {
	app, _ := newTestApp(t)
	app.configFile = filepath.Join(t.TempDir(), "not-read-or-written.json")
	app.cfg.Hosts[0].Roots[0].Label = ""
	cookie, csrf := signIn(t, app)
	p := createScriptPreview(t, app, cookie, csrf, "reports/index.html")
	revision := projectTrustRevision(app.cfg.Hosts[0], app.cfg.Hosts[0].Roots[0])
	app.cfg.Hosts[0].Roots[0].Label = "New label"
	app.cfg.Hosts[0].Label = "Changed machine"
	body := map[string]string{"token": p.ScriptCheck}
	w := request(app, "POST", "/api/preview/scripts", body, cookie, csrf)
	var response struct {
		ProjectLabel, Revision string
		CanAllow               bool
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil ||
		response.ProjectLabel != "artifacts · Test" || response.Revision != revision || !response.CanAllow {
		t.Fatal("consent metadata was not bound at creation", w.Body)
	}
	other, otherCSRF := signIn(t, app)
	for _, tc := range []struct {
		cookie *http.Cookie
		csrf   string
		want   int
	}{{nil, "", 401}, {cookie, "", 403}, {cookie, "wrong", 403}, {other, otherCSRF, 403}} {
		if w := request(app, "POST", "/api/preview/scripts", body, tc.cookie, tc.csrf); w.Code != tc.want {
			t.Fatal("session/CSRF boundary", w.Code, tc.want)
		}
	}
	app.mu.Lock()
	expired := app.previews[p.ScriptCheck]
	expired.expires = time.Now().Add(-time.Minute)
	app.previews[p.ScriptCheck] = expired
	app.mu.Unlock()
	for _, token := range []string{p.ScriptCheck, randomToken()} {
		if w := request(app, "POST", "/api/preview/scripts", map[string]string{"token": token}, cookie, csrf); w.Code != 410 {
			t.Fatal("expired/missing capability must not log out", w.Code)
		}
	}
	if w := request(app, "GET", "/api/session", nil, cookie, ""); !strings.Contains(w.Body.String(), `"authenticated":true`) {
		t.Fatal("expiry invalidated the app session")
	}
	if _, err := os.Stat(app.configFile); !os.IsNotExist(err) {
		t.Fatal("inspection touched the config file", err)
	}
	p = createScriptPreview(t, app, cookie, csrf, "reports/index.html")
	check := app.previews[p.ScriptCheck].inspection
	attempt := check.begin()
	app.mu.Lock()
	delete(app.previews, p.ScriptCheck)
	app.mu.Unlock()
	check.publish(attempt, "present")
	if w := request(app, "POST", "/api/preview/scripts", map[string]string{"token": p.ScriptCheck}, cookie, csrf); w.Code != 410 {
		t.Fatal("late publication resurrected a revoked capability", w.Code)
	}
}

func TestPreviewScriptsResolvedMainBinding(t *testing.T) {
	initial, _ := newTestApp(t)
	cfg := initial.cfg
	cfg.Hosts[0].Kind, cfg.Hosts[0].Target = "local", ""
	root := cfg.Hosts[0].Roots[0].Path
	original := filepath.Join(root, "reports", "index.html")
	if err := os.Symlink("reports/index.html", filepath.Join(root, "latest")); err != nil {
		t.Fatal(err)
	}
	store := storage.NewLocal()
	app, err := New(cfg, store, initial.assets)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	cookie, csrf := signIn(t, app)
	p := createScriptPreview(t, app, cookie, csrf, "latest")
	if !strings.HasSuffix(p.URL, "/index.html") || p.ScriptCheck == "" {
		t.Fatal("eligibility did not use the opened main filename", p)
	}
	if w := previewRequest(app, p.URL); w.Code != 200 || scriptStatus(t, app, cookie, csrf, p.ScriptCheck) != "present" {
		t.Fatal("resolved main file was not inspected", w.Code)
	}
	// Rename the same inode to keep size/version unchanged, then replace its
	// old name with a contained symlink. It is no longer the bound main file.
	if err := os.Rename(original, filepath.Join(root, "reports", "other.html")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("other.html", original); err != nil {
		t.Fatal(err)
	}
	if w := previewRequest(app, p.URL); w.Code != 200 || scriptStatus(t, app, cookie, csrf, p.ScriptCheck) != "unknown" {
		t.Fatal("a different resolved file reused the result", w.Code)
	}
}

func TestPreviewScriptsEligibilityAndTeamReadOnly(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, csrf := signIn(t, app)
	for _, name := range []string{"reports/report.pdf", "reports/assets/data.json"} {
		if p := createScriptPreview(t, app, cookie, csrf, name); p.ScriptCheck != "" {
			t.Fatal("non-HTML capability offered a script check")
		}
	}
	p := createScriptPreview(t, app, cookie, csrf, "reports/index.html")
	w := request(app, "POST", "/api/preview/scripts", map[string]string{"token": p.ScriptCheck}, cookie, csrf)
	if !strings.Contains(w.Body.String(), `"canAllow":false`) {
		t.Fatal("nonpersistent config offered consent")
	}
	app.cfg.Hosts[0].Roots[0].TrustedScripts = true
	if p := createScriptPreview(t, app, cookie, csrf, "reports/index.html"); p.ScriptCheck != "" {
		t.Fatal("trusted HTML offered a script check")
	}
	team, _ := newTeamApp(t)
	alice, token := teamSignIn(t, team, "alice", testPassword, false)
	p = createScriptPreview(t, team, alice, token, "reports/index.html")
	w = request(team, "POST", "/api/preview/scripts", map[string]string{"token": p.ScriptCheck}, alice, token)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"canAllow":false`) {
		t.Fatal("team user offered consent", w.Code, w.Body)
	}
}

func TestPreviewScriptsOlderCompletionCannotReplaceNewer(t *testing.T) {
	check := &previewScriptCheck{status: "pending"}
	markup := []byte("<script>run()</script>")
	old := &previewScriptResponse{check: check, attempt: check.begin(), scan: true, code: 200, size: int64(len(markup)), ResponseWriter: httptest.NewRecorder()}
	latest := &previewScriptResponse{check: check, attempt: check.begin(), scan: true, code: 200, size: 0}
	latest.finish()
	old.Write(markup)
	old.finish()
	if check.status != "absent" {
		t.Fatal("older completion replaced the current main response")
	}
	latest = &previewScriptResponse{check: check, attempt: check.begin(), scan: true, code: 200, size: 3, ResponseWriter: &failingScriptWriter{httptest.NewRecorder()}}
	latest.Write([]byte("abc"))
	latest.finish()
	if check.status != "unknown" {
		t.Fatal("write failure claimed absence")
	}
	latest = &previewScriptResponse{check: check, attempt: check.begin(), scan: true, code: 200, size: 100, ResponseWriter: httptest.NewRecorder()}
	latest.Write(markup)
	if check.status != "present" {
		t.Fatal("positive evidence was not published during streaming")
	}
	latest.finish()
	if check.status != "present" {
		t.Fatal("truncated response lost positive evidence")
	}
}

type failingScriptWriter struct{ *httptest.ResponseRecorder }

func (w *failingScriptWriter) Write(data []byte) (int, error) {
	return 0, io.ErrClosedPipe
}
