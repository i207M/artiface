package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

func TestGitHistoryGrantsPaginationAndSourceChanges(t *testing.T) {
	app, _ := newTeamApp(t)
	alice, _ := teamSignIn(t, app, "alice", testPassword, false)
	bob, _ := teamSignIn(t, app, "bob", testPassword, false)
	revision := strings.Repeat("a", 64)
	calls := 0
	app.git.readHistory = func(_ context.Context, _, _ string, offset int) (storage.GitHistory, error) {
		calls++
		return storage.GitHistory{Revision: revision, Commits: []storage.GitCommit{{Message: "Project commit"}}}, nil
	}
	endpoint := "/api/git/history?host=test&root=artifacts"
	for _, cookie := range []*http.Cookie{nil, bob} {
		w := request(app, "GET", endpoint, nil, cookie, "")
		if w.Code != 401 && w.Code != 404 {
			t.Fatal("history bypassed project access", w.Code)
		}
	}
	for _, query := range []string{"&offset=-1", "&offset=100001", "&offset=abc", "&offset=100", "&offset=100&revision=invalid"} {
		if w := request(app, "GET", endpoint+query, nil, alice, ""); w.Code != 400 {
			t.Fatal("invalid pagination accepted", query, w.Code)
		}
	}
	if calls != 0 {
		t.Fatal("unauthorized/invalid history ran Git")
	}
	if w := request(app, "GET", endpoint+"&offset=100&revision="+revision, nil, alice, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "Project commit") {
		t.Fatal("history page failed", w.Code, w.Body.String())
	}
	if w := request(app, "GET", endpoint+"&offset=100&revision="+strings.Repeat("b", 64), nil, alice, ""); w.Code != 409 || strings.Contains(w.Body.String(), "Project commit") {
		t.Fatal("mixed history revisions", w.Code, w.Body.String())
	}
	app.git.readHistory = func(context.Context, string, string, int) (storage.GitHistory, error) {
		app.hostsMu.Lock()
		app.cfg.Hosts[0].Roots[0].Path += "-moved"
		app.hostsMu.Unlock()
		return storage.GitHistory{Commits: []storage.GitCommit{{Message: "Stale source commit"}}}, nil
	}
	if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 409 || strings.Contains(w.Body.String(), "Stale source commit") {
		t.Fatal("source changed during history read", w.Code, w.Body.String())
	}
}

func TestGitHistoryHostKeysAndConcurrency(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	endpoint := "/api/git/history?host=test&root=artifacts"
	app.git.readHistory = func(context.Context, string, string, int) (storage.GitHistory, error) {
		return storage.GitHistory{}, &sshvault.HostKeyError{Token: "history-token"}
	}
	if w := request(app, "GET", endpoint, nil, cookie, ""); w.Code != 409 || !strings.Contains(w.Body.String(), "history-token") {
		t.Fatal("history lost host-key confirmation", w.Code, w.Body.String())
	}
	app.git.slots <- struct{}{}
	app.git.slots <- struct{}{}
	defer func() { <-app.git.slots; <-app.git.slots }()
	if w := request(app, "GET", endpoint, nil, cookie, ""); w.Code != 503 {
		t.Fatal("history bypassed concurrency limit", w.Code)
	}
}
