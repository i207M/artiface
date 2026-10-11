package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"artiface/internal/pdfpreview"
	"artiface/internal/storage"
)

type pdfRetrySource struct {
	*bytes.Reader
	ctx              context.Context
	info             fs.FileInfo
	entered, release chan struct{}
	failure          error
	readOnce         sync.Once
	closeOnce        sync.Once
	closed           chan struct{}
}

func (f *pdfRetrySource) Read(p []byte) (int, error) {
	if f.entered != nil {
		f.readOnce.Do(func() { close(f.entered) })
		select {
		case <-f.ctx.Done():
			return 0, f.ctx.Err()
		case <-f.release:
		}
	}
	if f.failure != nil {
		return 0, f.failure
	}
	return f.Reader.Read(p)
}

func (f *pdfRetrySource) Stat() (fs.FileInfo, error) { return f.info, nil }
func (f *pdfRetrySource) Close() error {
	f.closeOnce.Do(func() {
		close(f.closed)
	})
	return nil
}

type pdfRetryStore struct {
	storage.Store
	opens atomic.Int32
	open  func(context.Context, int) storage.File
}

func (s *pdfRetryStore) Open(ctx context.Context, _, _, _ string) (storage.File, error) {
	return s.open(ctx, int(s.opens.Add(1))), nil
}

func TestPDFInfoRetriesOnlySharedCancellationOnce(t *testing.T) {
	for _, scenario := range []string{"success", "second cancellation", "storage error", "decode error", "caller canceled"} {
		t.Run(scenario, func(t *testing.T) {
			app, baseStore := newTestApp(t)
			if !app.pdfCache.Available() {
				t.Skip("Poppler is optional for native installs")
			}
			cookie, csrf := signIn(t, app)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			wait := func(ch <-chan struct{}) {
				t.Helper()
				select {
				case <-ch:
				case <-ctx.Done():
					t.Fatal("PDF retry fixture timed out")
				}
			}
			data := compressionFixture()
			stat := metadataInfo{size: int64(len(data)), mode: 0600, modified: time.Unix(1, 0)}
			host, root := app.cfg.Hosts[0], app.cfg.Hosts[0].Roots[0]
			loc := location{Host: host.ID, Root: root.ID, Path: "report.pdf"}
			key := pdfSourceKey(host, root, loc.Path, fileVersion(stat, root.TrustedScripts))
			startLeader := func() (*pdfRetrySource, context.CancelFunc, <-chan error) {
				leader, stop := context.WithCancel(ctx)
				t.Cleanup(stop)
				source := &pdfRetrySource{Reader: bytes.NewReader(data), ctx: leader, info: stat,
					entered: make(chan struct{}), release: make(chan struct{}), closed: make(chan struct{})}
				if scenario == "storage error" {
					source.failure = fs.ErrPermission
				} else if scenario == "decode error" {
					source.Reader = bytes.NewReader(bytes.Repeat([]byte("x"), len(data)))
				}
				result := make(chan error, 1)
				go func() {
					defer source.Close()
					_, err := app.pdfCache.Document(leader, key, source, stat, false)
					result <- err
				}()
				wait(source.entered)
				return source, stop, result
			}
			first, cancelLeader, leaderResult := startLeader()
			opened := make(chan *pdfRetrySource, 2)
			retrying, resumeRetry := make(chan struct{}), make(chan struct{})
			store := &pdfRetryStore{Store: baseStore}
			var firstDeadline time.Time
			store.open = func(requestCtx context.Context, attempt int) storage.File {
				deadline, ok := requestCtx.Deadline()
				if !ok {
					t.Error("PDF request has no deadline")
				}
				if attempt == 1 {
					firstDeadline = deadline
				} else if deadline != firstDeadline {
					t.Error("retry reset the request deadline")
				}
				if attempt == 2 && scenario == "second cancellation" {
					close(retrying)
					select {
					case <-resumeRetry:
					case <-requestCtx.Done():
					}
				}
				body, current := data, stat
				if attempt == 2 && scenario == "success" {
					body = append(bytes.Clone(data), []byte("\n% changed before retry\n")...)
					current.size, current.modified = int64(len(body)), time.Unix(2, 0)
				}
				file := &pdfRetrySource{Reader: bytes.NewReader(body), ctx: requestCtx, info: current, closed: make(chan struct{})}
				opened <- file
				return file
			}
			app.store = store
			body, _ := json.Marshal(loc)
			caller, cancelCaller := context.WithCancel(context.Background())
			defer cancelCaller()
			r := httptest.NewRequest("POST", "/api/pdf/info", bytes.NewReader(body)).WithContext(caller)
			r.Host = app.appHost
			r.Header.Set("Origin", app.origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", csrf)
			r.AddCookie(cookie)
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { app.Handler().ServeHTTP(w, r); close(done) }()
			var firstOpen *pdfRetrySource
			select {
			case firstOpen = <-opened:
			case <-ctx.Done():
				t.Fatal("PDF handler did not open its source")
			}
			wait(firstOpen.closed) // The request has joined the existing preparation.
			wantStatus, wantOpens, wantLeader := 504, int32(1), error(context.Canceled)
			switch scenario {
			case "success", "second cancellation":
				cancelLeader()
				wantOpens = 2
				if scenario == "success" {
					wantStatus = 200
				} else {
					wait(retrying)
					second, cancelSecond, secondResult := startLeader()
					close(resumeRetry)
					select {
					case secondOpen := <-opened:
						wait(secondOpen.closed)
					case <-ctx.Done():
						t.Fatal("retry did not reopen the source")
					}
					cancelSecond()
					if err := <-secondResult; !errors.Is(err, context.Canceled) {
						t.Fatal("second shared preparation did not cancel", err)
					}
					wait(second.closed)
				}
			case "storage error":
				close(first.release)
				wantStatus, wantLeader = 422, fs.ErrPermission
			case "decode error":
				close(first.release)
				wantStatus, wantLeader = 422, pdfpreview.ErrInvalid
			case "caller canceled":
				cancelCaller()
				cancelLeader()
			}
			wait(done)
			if w.Code != wantStatus || store.opens.Load() != wantOpens {
				t.Fatalf("retry policy: status=%d opens=%d; want %d/%d", w.Code, store.opens.Load(), wantStatus, wantOpens)
			}
			if err := <-leaderResult; !errors.Is(err, wantLeader) {
				t.Fatal("unexpected leader result", err)
			}
			if scenario == "success" {
				var result struct {
					Version string `json:"version"`
					Size    int64  `json:"size"`
				}
				second := <-opened
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil ||
					result.Size != second.info.Size() || result.Version != fileVersion(second.info, root.TrustedScripts) {
					t.Fatal("retry reused the original source's metadata", err)
				}
				wait(second.closed)
			}
		})
	}
}
