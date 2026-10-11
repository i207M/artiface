package server

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"artiface/internal/storage"
)

func TestDownloadBatchesAndHTTPResponses(t *testing.T) {
	t.Run("download", func(t *testing.T) { testDownloadResponses(t, false) })
	t.Run("preview", func(t *testing.T) { testDownloadResponses(t, true) })
}

func testDownloadResponses(t *testing.T, preview bool) {
	app, _ := newTestApp(t)
	cookie, csrf := signIn(t, app)
	endpoint := app.origin + "/api/file" + fileQuery("file")
	if preview {
		endpoint = makePreview(t, app, cookie, csrf)
	}
	target, err := url.Parse(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte("download contents\n"), 20000)
	size := len(data) - 19 // Simulate growth after the validated metadata.
	modified := time.Date(1999, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, method, ranges string
		status               int
		body                 []byte
	}{
		{"full", "GET", "", 200, data[:size]},
		{"range", "GET", "bytes=7-200006", 206, data[7:200007]},
		{"head", "HEAD", "", 200, nil},
		{"head range", "HEAD", "bytes=7-200006", 206, nil},
		{"multipart", "GET", "bytes=0-16,32-48", 206, nil},
		{"head multipart", "HEAD", "bytes=0-16,32-48", 206, nil},
		{"invalid range", "GET", "bytes=99999999-", 416, nil},
		{"not modified", "GET", "", 304, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &downloadTestStore{data: data, size: int64(size), files: make(chan *downloadTestFile, 1)}
			app.store = store
			r := httptest.NewRequest(tc.method, target.RequestURI(), nil)
			r.Host = target.Host
			r.AddCookie(cookie)
			if preview {
				r.Header.Set("Origin", "null")
			}
			r.Header.Set("Range", tc.ranges)
			if tc.status == 304 {
				r.Header.Set("If-Modified-Since", modified.Format(http.TimeFormat))
			}
			w := httptest.NewRecorder()
			app.Handler().ServeHTTP(w, r)
			var file *downloadTestFile
			select {
			case file = <-store.files:
			default:
				t.Fatalf("response did not reach storage: %d %s", w.Code, w.Body)
			}
			<-file.closed
			if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" ||
				w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("download response: %d %v", w.Code, w.Header())
			}
			if preview {
				scriptPolicy := "script-src 'none'"
				if tc.name == "full" {
					scriptPolicy = "script-src 'nonce-"
				}
				if store.scope != [4]string{"test-alias", app.cfg.Hosts[0].Roots[0].Path, "reports", "index.html"} ||
					w.Header().Get("Content-Disposition") != "" ||
					w.Header().Get("Access-Control-Allow-Origin") != "*" ||
					w.Header().Get("Cross-Origin-Resource-Policy") != "cross-origin" ||
					w.Header().Get("Referrer-Policy") != "no-referrer" ||
					!strings.Contains(w.Header().Get("Content-Security-Policy"), scriptPolicy) ||
					!strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors "+app.origin+"; sandbox") {
					t.Fatal("preview lost its scope or origin/security headers", w.Header())
				}
				if tc.name == "full" && !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
					t.Fatal("preview lost its asset MIME type")
				}
			} else if !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") {
				t.Fatal("download lost its attachment disposition")
			}
			if deadline, ok := file.ctx.Deadline(); !ok || time.Until(deadline) > 5*time.Minute ||
				file.ctx.Err() != context.Canceled {
				t.Fatal("download did not bound and release its storage context")
			}
			if tc.body != nil {
				matches := bytes.Equal(w.Body.Bytes(), tc.body) && w.Header().Get("Content-Length") == strconv.Itoa(len(tc.body))
				if preview && tc.name == "full" {
					matches = bytes.Equal(previewAuthoredBytes(t, w.Body.Bytes()), tc.body) && strings.Contains(w.Body.String(), previewBridgeJS) && w.Header().Get("Content-Length") == ""
				}
				if !matches || file.maxRead != 128<<10 {
					t.Fatalf("download copy: bytes=%d batch=%d headers=%v", w.Body.Len(), file.maxRead, w.Header())
				}
			}
			if tc.method == "HEAD" || tc.status == 304 {
				if w.Body.Len() != 0 || file.reads != 0 {
					t.Fatal("metadata-only response read or returned artifact bytes")
				}
			}
			switch tc.name {
			case "range", "head range":
				if w.Header().Get("Content-Range") != fmt.Sprintf("bytes 7-200006/%d", size) {
					t.Fatal("single-range metadata changed")
				}
			case "multipart":
				_, params, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
				if err != nil {
					t.Fatal(err)
				}
				parts := multipart.NewReader(bytes.NewReader(w.Body.Bytes()), params["boundary"])
				for _, start := range []int{0, 32} {
					part, err := parts.NextPart()
					if err != nil {
						t.Fatal(err)
					}
					got, err := io.ReadAll(part)
					if err != nil || !bytes.Equal(got, data[start:start+17]) ||
						part.Header.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", start, start+16, size) {
						t.Fatal("multipart download changed its ranges")
					}
				}
				if _, err := parts.NextPart(); err != io.EOF {
					t.Fatal("unexpected multipart data", err)
				}
			case "invalid range":
				if file.reads != 0 || w.Header().Get("Content-Range") != fmt.Sprintf("bytes */%d", size) ||
					!strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") {
					t.Fatal("range error read artifact bytes or lost its error headers")
				}
			}
		})
	}
}

func TestDownloadHTTPDeadlines(t *testing.T) {
	t.Run("download", func(t *testing.T) { testDownloadDeadlines(t, false) })
	t.Run("preview", func(t *testing.T) { testDownloadDeadlines(t, true) })
}

func testDownloadDeadlines(t *testing.T, preview bool) {
	for _, scenario := range []string{"progress", "slow setup", "total lifetime", "write idle", "cancel write"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				app, _ := newTestApp(t)
				cookie, csrf := signIn(t, app)
				endpoint := app.origin + "/api/file" + fileQuery("file")
				if preview {
					endpoint = makePreview(t, app, cookie, csrf)
				}
				store := &downloadTestStore{
					data: bytes.Repeat([]byte("d"), 9*(128<<10)), delay: 20 * time.Second,
					files: make(chan *downloadTestFile, 1),
				}
				if scenario == "total lifetime" {
					store.data = bytes.Repeat([]byte("d"), 20*(128<<10))
				} else if scenario == "slow setup" {
					store.data, store.delay = []byte("small download"), 0
					store.open = func(ctx context.Context) error {
						timer := time.NewTimer(3 * time.Minute)
						defer timer.Stop()
						select {
						case <-timer.C:
							return nil
						case <-ctx.Done():
							return ctx.Err()
						}
					}
				} else if scenario == "write idle" || scenario == "cancel write" {
					store.delay = 0
				}
				store.size = int64(len(store.data))
				app.store = store
				parent, cancel := context.WithCancel(context.Background())
				defer cancel()
				handled := make(chan struct{}, 2)
				conn, reader := downloadTestHTTP(t, parent, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					app.Handler().ServeHTTP(w, r)
					handled <- struct{}{}
				}))
				start := time.Now()
				response := downloadTestRequest(t, conn, reader, app, cookie, endpoint)
				file := <-store.files
				if scenario == "cancel write" {
					cancel()
				}
				if scenario == "write idle" || scenario == "cancel write" {
					// Stop consuming the body so the HTTP connection's Write blocks.
					<-handled
				}
				body, err := io.ReadAll(response.Body)
				response.Body.Close()
				<-file.closed
				want := 5 * time.Minute
				switch scenario {
				case "progress", "slow setup":
					want = 3 * time.Minute
					matches := bytes.Equal(body, store.data)
					if preview {
						matches = bytes.Equal(previewAuthoredBytes(t, body), store.data) && bytes.Contains(body, []byte(previewBridgeJS))
					}
					if err != nil || !matches {
						t.Fatalf("healthy download failed after %v: bytes=%d err=%v", time.Since(start), len(body), err)
					}
					<-handled
					// Normal cancellation must not poison the final flush or next request.
					next := downloadTestRequest(t, conn, reader, app, cookie, "/api/session")
					_, readErr := io.Copy(io.Discard, next.Body)
					next.Body.Close()
					if next.StatusCode != 200 || readErr != nil {
						t.Fatal("download left its keep-alive connection unusable", readErr)
					}
					<-handled
				case "write idle":
					want = 30 * time.Second
				case "cancel write":
					want = 0
				}
				if time.Since(start) != want ||
					scenario != "progress" && scenario != "slow setup" && (err == nil || len(body) >= len(store.data)) {
					t.Fatalf("download bound: elapsed=%v want=%v bytes=%d err=%v", time.Since(start), want, len(body), err)
				}
				if file.ctx.Err() == nil {
					t.Fatal("finished download retained its storage context")
				}
			})
		})
	}
}

func TestDownloadCancelsStorageOpen(t *testing.T) {
	t.Run("download", func(t *testing.T) { testDownloadCancelsOpen(t, false) })
	t.Run("preview", func(t *testing.T) { testDownloadCancelsOpen(t, true) })
}

func testDownloadCancelsOpen(t *testing.T, preview bool) {
	synctest.Test(t, func(t *testing.T) {
		app, _ := newTestApp(t)
		cookie, csrf := signIn(t, app)
		endpoint := app.origin + "/api/file" + fileQuery("file")
		if preview {
			endpoint = makePreview(t, app, cookie, csrf)
		}
		parent, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		opened := make(chan context.Context, 1)
		app.store = &downloadTestStore{open: func(ctx context.Context) error {
			opened <- ctx
			<-ctx.Done()
			return ctx.Err()
		}}
		handled := make(chan struct{}, 1)
		conn, _ := downloadTestHTTP(t, parent, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			app.Handler().ServeHTTP(w, r)
			handled <- struct{}{}
		}))
		r, _ := http.NewRequest("GET", endpoint, nil)
		r.AddCookie(cookie)
		if err := r.Write(conn); err != nil {
			t.Fatal(err)
		}
		ctx := <-opened
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) != time.Minute {
			t.Fatal("download extended the caller's earlier deadline")
		}
		start := time.Now()
		cancel()
		<-handled
		if ctx.Err() != context.Canceled || time.Since(start) != 0 {
			t.Fatal("request cancellation did not interrupt storage opening")
		}
	})
}

type downloadTestStore struct {
	data  []byte
	size  int64
	delay time.Duration
	files chan *downloadTestFile
	open  func(context.Context) error
	scope [4]string
}

func (*downloadTestStore) List(context.Context, string, string, string) ([]storage.Entry, error) {
	return nil, storage.ErrForbidden
}
func (*downloadTestStore) Close() error { return nil }
func (s *downloadTestStore) Open(ctx context.Context, _, _, _ string) (storage.File, error) {
	if s.open != nil {
		if err := s.open(ctx); err != nil {
			return nil, err
		}
	}
	f := &downloadTestFile{Reader: bytes.NewReader(s.data), ctx: ctx, size: s.size, delay: s.delay, closed: make(chan struct{})}
	s.files <- f
	return f, nil
}

func (s *downloadTestStore) OpenScoped(ctx context.Context, target, root, scope, rel string) (storage.File, error) {
	s.scope = [4]string{target, root, scope, rel}
	return s.Open(ctx, target, root, rel)
}

type downloadDeadlineFailure struct{ *httptest.ResponseRecorder }

func (*downloadDeadlineFailure) SetWriteDeadline(time.Time) error { return io.ErrClosedPipe }

func TestDownloadDeadlineFailureDoesNotOpenStorage(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	store := &metadataStore{}
	app.store = store
	r := httptest.NewRequest("GET", "/api/file"+fileQuery("file"), nil)
	r.Host = app.appHost
	r.AddCookie(cookie)
	w := &downloadDeadlineFailure{httptest.NewRecorder()}
	app.Handler().ServeHTTP(w, r)
	if w.Code != 500 || store.opens != 0 {
		t.Fatalf("deadline failure reached storage: status=%d opens=%d", w.Code, store.opens)
	}
}

type downloadTestFile struct {
	*bytes.Reader
	ctx            context.Context
	size           int64
	delay          time.Duration
	reads, maxRead int
	closed         chan struct{}
	once           sync.Once
}

func (f *downloadTestFile) Read(p []byte) (int, error) {
	timer := time.NewTimer(f.delay)
	defer timer.Stop()
	select {
	case <-f.ctx.Done():
		return 0, f.ctx.Err()
	case <-timer.C:
	}
	f.reads++
	f.maxRead = max(f.maxRead, len(p))
	return f.Reader.Read(p)
}
func (f *downloadTestFile) Stat() (fs.FileInfo, error) {
	return metadataInfo{size: f.size, mode: 0600, modified: time.Date(1999, 1, 1, 0, 0, 0, 0, time.UTC)}, nil
}
func (f *downloadTestFile) Close() error {
	f.once.Do(func() { close(f.closed) })
	return nil
}

type downloadTestListener struct {
	conns  chan net.Conn
	closed chan struct{}
	once   sync.Once
	addr   net.Addr
}

func (l *downloadTestListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}
func (l *downloadTestListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}
func (l *downloadTestListener) Addr() net.Addr { return l.addr }

func downloadTestHTTP(t *testing.T, ctx context.Context, handler http.Handler) (net.Conn, *bufio.Reader) {
	t.Helper()
	client, peer := net.Pipe()
	listener := &downloadTestListener{conns: make(chan net.Conn, 1), closed: make(chan struct{}), addr: peer.LocalAddr()}
	listener.conns <- peer
	server := &http.Server{
		Handler: handler, WriteTimeout: 2 * time.Minute,
		BaseContext: func(net.Listener) context.Context { return ctx },
		ErrorLog:    log.New(io.Discard, "", 0),
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() {
		client.Close()
		server.Close()
		if err := <-done; err != http.ErrServerClosed {
			t.Error(err)
		}
	})
	return client, bufio.NewReader(client)
}

func downloadTestRequest(t *testing.T, conn net.Conn, reader *bufio.Reader, app *App, cookie *http.Cookie, endpoint string) *http.Response {
	t.Helper()
	if strings.HasPrefix(endpoint, "/") {
		endpoint = app.origin + endpoint
	}
	r, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(cookie)
	if err := r.Write(conn); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(reader, r)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
