package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"artiface/internal/storage"
)

func previewAuthoredBytes(t *testing.T, body []byte) []byte {
	t.Helper()
	start := bytes.Index(body, []byte("</script>"))
	end := regexp.MustCompile(`<meta name="artiface-preview-complete" content="[A-Za-z0-9_-]{43}">$`).FindIndex(body)
	if start < 0 || end == nil || start+len("</script>") > end[0] {
		t.Fatal("preview did not contain a bridge and completion marker")
	}
	return body[start+len("</script>") : end[0]]
}

func TestPreviewBridgePolicyAndOriginalBytes(t *testing.T) {
	app, local := newTestApp(t)
	store := &scriptCountingStore{localStore: local}
	app.store = store
	cookie, csrf := signIn(t, app)
	// Markup that must never be interpolated into the bridge's script context.
	report := []byte("<!doctype html><html style='background: navy'><body>" +
		`<a href="&quot;&lt;/script&gt;&lt;script&gt;evil()">link</a><script>run()</script></body></html>`)
	file := filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports", "index.html")
	if err := os.WriteFile(file, report, 0600); err != nil {
		t.Fatal(err)
	}
	var lastNonce string
	var p scriptPreview
	for _, trusted := range []bool{false, false, true} {
		app.cfg.Hosts[0].Roots[0].TrustedScripts = trusted
		if p.URL == "" || trusted {
			p = createScriptPreview(t, app, cookie, csrf, "reports/index.html")
		}
		if !p.Bridge || (p.ScriptCheck == "") != trusted {
			t.Fatal("incorrect bridge/inspection metadata", p)
		}
		before := store.bytes
		w := previewRequest(app, p.URL)
		body := w.Body.String()
		authored := previewAuthoredBytes(t, w.Body.Bytes())
		prefix := body[:strings.Index(body, "</script>")+len("</script>")]
		if w.Code != 200 || !strings.HasPrefix(prefix, "<!doctype html>") ||
			!strings.Contains(prefix, previewBridgeJS) || strings.Count(prefix, "</script>") != 1 ||
			!bytes.Equal(authored, report) || store.bytes-before != len(report) ||
			w.Header().Get("Content-Length") != "" || !w.Flushed ||
			w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("bridge/raw stream mismatch: code=%d headers=%v bytes=%d", w.Code, w.Header(), store.bytes-before)
		}
		policy := w.Header().Get("Content-Security-Policy")
		if !strings.HasSuffix(policy, "; sandbox allow-scripts") || strings.Contains(policy, "allow-same-origin") {
			t.Fatal("bridge escaped opaque sandbox", policy)
		}
		if trusted {
			if !strings.Contains(policy, "script-src 'unsafe-inline' "+app.previewOrigin+"/p/;") ||
				strings.Contains(policy, "nonce-") || strings.Contains(prefix, "nonce=") {
				t.Fatal("trusted reports lost inline script capability", policy)
			}
		} else {
			match := regexp.MustCompile(`script-src 'nonce-([A-Za-z0-9_-]{43})';`).FindStringSubmatch(policy)
			if len(match) != 2 || match[1] == lastNonce ||
				!strings.Contains(prefix, `nonce="`+match[1]+`"`) {
				t.Fatal("untrusted reports did not receive a fresh bridge-only nonce", policy)
			}
			lastNonce = match[1]
		}
	}
	original, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(original, report) {
		t.Fatal("preview modified the stored document", err)
	}
}

func TestPreviewBridgeRawRequests(t *testing.T) {
	app, local := newTestApp(t)
	store := &scriptCountingStore{localStore: local}
	app.store = store
	cookie, csrf := signIn(t, app)
	p := createScriptPreview(t, app, cookie, csrf, "reports/index.html")
	for _, tc := range []struct {
		method, asset, ranges string
	}{
		{"HEAD", "index.html", ""},
		{"GET", "index.html", "bytes=0-7"},
		{"GET", "index.html", "bytes=0-2,5-7"},
		{"GET", "assets/data.json", ""},
		{"GET", "sibling.html", ""},
	} {
		t.Run(tc.method+"/"+tc.asset+"/"+tc.ranges, func(t *testing.T) {
			if tc.asset == "sibling.html" {
				name := filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports", tc.asset)
				if err := os.WriteFile(name, []byte("<p>sibling</p>"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			u, _ := url.Parse(p.URL[:strings.LastIndex(p.URL, "/")+1] + tc.asset)
			r := httptest.NewRequest(tc.method, u.RequestURI(), nil)
			r.Host = app.previewHost
			r.Header.Set("Range", tc.ranges)
			w := httptest.NewRecorder()
			before := store.reads
			app.PreviewHandler().ServeHTTP(w, r)
			if w.Code != 200 && w.Code != 206 {
				t.Fatal(w.Code, w.Body)
			}
			if strings.Contains(w.Body.String(), previewBridgeJS) ||
				!strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'none'") ||
				w.Header().Get("Content-Length") == "" {
				t.Fatal("raw request was transformed", w.Header())
			}
			if tc.method == "HEAD" && (store.reads != before || w.Body.Len() != 0) {
				t.Fatal("HEAD read or wrote document bytes")
			}
		})
	}
	for _, name := range []string{"reports/report.pdf", "reports/assets/data.json"} {
		if p := createScriptPreview(t, app, cookie, csrf, name); p.Bridge {
			t.Fatal("non-HTML advertised a bridge")
		}
	}
}

func TestPreviewBridgeEscapesConfiguration(t *testing.T) {
	w := httptest.NewRecorder()
	w.Header().Set("Content-Security-Policy", "script-src 'none'; sandbox")
	bridge := &previewHTMLResponse{
		ResponseWriter: w, token: "</script><script>evil()</script>",
		origin: "https://example.invalid/\"</script>\u2028",
	}
	bridge.WriteHeader(http.StatusOK)
	if strings.Count(w.Body.String(), "</script>") != 1 ||
		strings.Contains(w.Body.String(), "<script>evil()") ||
		!strings.Contains(w.Body.String(), `\u003c/script\u003e`) {
		t.Fatal("configuration could escape the inline script")
	}
}

func TestPreviewBridgeErrorsHaveNoReadinessScript(t *testing.T) {
	for _, code := range []int{http.StatusNotModified, http.StatusForbidden, http.StatusNotFound,
		http.StatusPreconditionFailed, http.StatusRequestedRangeNotSatisfiable, http.StatusInternalServerError} {
		w := httptest.NewRecorder()
		w.Header().Set("Content-Security-Policy", "script-src 'none'; sandbox")
		w.Header().Set("Content-Length", "5")
		bridge := &previewHTMLResponse{ResponseWriter: w, token: "test", origin: "http://example.test"}
		bridge.WriteHeader(code)
		bridge.Write([]byte("error"))
		if w.Code != code || w.Body.String() != "error" ||
			w.Header().Get("Content-Security-Policy") != "script-src 'none'; sandbox" ||
			w.Header().Get("Content-Length") != "5" || w.Flushed {
			t.Fatal("non-success response acquired a bridge or changed headers", code, w.Header())
		}
	}
}

func TestPreviewBridgeHTTPStreamingAndFraming(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		app, _ := newTestApp(t)
		cookie, csrf := signIn(t, app)
		p := createScriptPreview(t, app, cookie, csrf, "reports/index.html")
		for _, data := range [][]byte{nil, bytes.Repeat([]byte("static report\n"), 20000)} {
			// Do not read past the stat size even if the artifact grows.
			size := len(data)
			store := &downloadTestStore{
				data: append(data, []byte("extra bytes after stat")...), size: int64(size),
				delay: time.Second, files: make(chan *downloadTestFile, 1),
			}
			app.store = store
			conn, reader := downloadTestHTTP(t, context.Background(), app.Handler())
			start := time.Now()
			response := downloadTestRequest(t, conn, reader, app, cookie, p.URL)
			file := <-store.files
			// Flushed headers and bridge must arrive before the delayed first read.
			if time.Since(start) != 0 || response.StatusCode != 200 || response.ContentLength != -1 ||
				len(response.TransferEncoding) != 1 || response.TransferEncoding[0] != "chunked" {
				t.Fatal("bridge waited for storage or retained raw response framing", response, time.Since(start))
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			conn.Close()
			<-file.closed
			authored := previewAuthoredBytes(t, body)
			prefix := body[:bytes.Index(body, []byte("</script>"))+len("</script>")]
			if err != nil || !bytes.Contains(prefix, []byte(previewBridgeJS)) ||
				!bytes.HasSuffix(prefix, []byte("</script>")) ||
				!bytes.Equal(authored, data) ||
				file.reads != (size+downloadBatchSize-1)/downloadBatchSize {
				t.Fatalf("stream reread or changed the bounded original: size=%d reads=%d err=%v", size, file.reads, err)
			}
			if size > 0 && file.maxRead != downloadBatchSize {
				t.Fatal("transformation changed the download batch bound", file.maxRead)
			}
		}
	})
}

// Pause the second read so polling can prove it observes the first chunk while
// the main request is still active, then abort without losing positive evidence.
type bridgeStreamStore struct {
	*localStore
	entered, release chan struct{}
}

func (s *bridgeStreamStore) OpenScoped(ctx context.Context, target, root, scope, rel string) (storage.File, error) {
	f, err := s.localStore.OpenScoped(ctx, target, root, scope, rel)
	if err != nil {
		return nil, err
	}
	return &bridgeStreamFile{File: f, store: s}, nil
}

type bridgeStreamFile struct {
	storage.File
	store *bridgeStreamStore
	reads int
}

func (f *bridgeStreamFile) Read(p []byte) (int, error) {
	f.reads++
	if f.reads > 1 {
		close(f.store.entered)
		<-f.store.release
		return 0, io.ErrUnexpectedEOF
	}
	return f.File.Read(p)
}

func TestPreviewScriptsPresentBeforeStreamEnds(t *testing.T) {
	app, local := newTestApp(t)
	store := &bridgeStreamStore{localStore: local, entered: make(chan struct{}), release: make(chan struct{})}
	app.store = store
	cookie, csrf := signIn(t, app)
	file := filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports", "index.html")
	report := "<script>run()</script>" + strings.Repeat("x", downloadBatchSize*2)
	if err := os.WriteFile(file, []byte(report), 0600); err != nil {
		t.Fatal(err)
	}
	p := createScriptPreview(t, app, cookie, csrf, "reports/index.html")
	done := make(chan struct{})
	var response *httptest.ResponseRecorder
	var release sync.Once
	defer release.Do(func() { close(store.release) })
	go func() {
		defer close(done)
		response = previewRequest(app, p.URL)
	}()
	<-store.entered
	if got := scriptStatus(t, app, cookie, csrf, p.ScriptCheck); got != "present" {
		t.Fatal("polling waited for iframe completion", got)
	}
	release.Do(func() { close(store.release) })
	<-done
	if got := scriptStatus(t, app, cookie, csrf, p.ScriptCheck); got != "present" {
		t.Fatal("aborted download erased positive evidence", got)
	}
	if strings.Contains(response.Body.String(), `<meta name="artiface-preview-complete"`) {
		t.Fatal("a truncated report was marked complete")
	}
}

func TestPreviewScriptsPartialWriteEvidence(t *testing.T) {
	check := &previewScriptCheck{status: "pending"}
	markup := []byte("<script>run()</script>")
	w := &previewScriptResponse{
		ResponseWriter: &partialBridgeWriter{httptest.NewRecorder()}, check: check,
		attempt: check.begin(), scan: true, size: int64(len(markup)),
	}
	w.Write(markup)
	w.finish()
	if check.status != "present" {
		t.Fatal("accepted script tag with write error lost evidence", check.status)
	}
}

type partialBridgeWriter struct{ *httptest.ResponseRecorder }

func (w *partialBridgeWriter) Write(data []byte) (int, error) {
	n, _ := w.ResponseRecorder.Write(data[:len("<script>")])
	return n, io.ErrClosedPipe
}
