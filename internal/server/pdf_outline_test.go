package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"artiface/internal/config"
	"artiface/internal/storage"
)

type outlineAccessStore struct {
	storage.Store
	afterOpen func(context.Context)
}

func (s outlineAccessStore) Open(ctx context.Context, target, root, rel string) (storage.File, error) {
	file, err := s.Store.Open(ctx, target, root, rel)
	if err == nil {
		s.afterOpen(ctx)
	}
	return file, err
}

func TestPDFOutlineRechecksAccessAfterSourceValidation(t *testing.T) {
	if _, err := exec.LookPath("pdftohtml"); err != nil {
		t.Skip("pdftohtml is optional for native installs")
	}
	for _, scenario := range []string{"root changed", "grant revoked", "session revoked", "caller canceled"} {
		t.Run(scenario, func(t *testing.T) {
			app, _ := newTeamApp(t)
			if !app.pdfCache.Available() {
				t.Skip("Poppler is optional for native installs")
			}
			filename := filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports", "report.pdf")
			if err := os.WriteFile(filename, compressionFixture(), 0600); err != nil {
				t.Fatal(err)
			}
			admin, adminCSRF := teamSignIn(t, app, "", testPassword, true)
			alice, csrf := teamSignIn(t, app, "alice", testPassword, false)
			w := request(app, "POST", "/api/pdf/info",
				location{Host: "test", Root: "artifacts", Path: "reports/report.pdf"}, alice, csrf)
			var info struct {
				ID string `json:"id"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &info) != nil || len(info.ID) != 32 {
				t.Fatal("prepare outline snapshot", w.Code, w.Body)
			}
			endpoint := "/api/pdf/outline" + fileQuery("reports/report.pdf") + "&document=" + info.ID
			if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 200 {
				t.Fatal("prepare cached outline", w.Code, w.Body)
			}
			wantStatus := http.StatusNotFound
			if scenario == "root changed" {
				wantStatus = http.StatusConflict
			} else if scenario == "caller canceled" {
				wantStatus = http.StatusGatewayTimeout
			}
			app.store = outlineAccessStore{Store: app.store, afterOpen: func(ctx context.Context) {
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 90*time.Second {
					t.Error("outline source access lacked the bounded request context")
				}
				switch scenario {
				case "root changed":
					app.hostsMu.Lock()
					app.cfg.Hosts[0].Roots[0].Path = t.TempDir()
					app.hostVersion++
					app.hostsMu.Unlock()
				case "grant revoked":
					accessChange(t, app, admin, adminCSRF,
						map[string]any{"user": publicUser{ID: "alice", Username: "alice", Projects: []config.ProjectRef{}}})
				case "session revoked":
					app.mu.Lock()
					delete(app.sessions, alice.Value)
					app.mu.Unlock()
				case "caller canceled":
					// Cancellation is exercised below with an already canceled
					// caller, including a cached result and a store that returns.
					if ctx.Err() != context.Canceled {
						t.Error("Store.Open did not receive caller cancellation")
					}
				}
			}}
			if scenario == "caller canceled" {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				r := httptest.NewRequest("GET", endpoint, nil).WithContext(ctx)
				r.Host = app.appHost
				r.AddCookie(alice)
				w := httptest.NewRecorder()
				app.Handler().ServeHTTP(w, r)
				if w.Code != wantStatus {
					t.Fatal("canceled outline returned cached data", w.Code, w.Body)
				}
			} else if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != wantStatus {
				t.Fatal("outline bypassed access recheck", w.Code, w.Body)
			}
		})
	}
}
