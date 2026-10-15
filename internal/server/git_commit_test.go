package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

func TestGitCommitAccessValidationAndSourceChanges(t *testing.T) {
	app, _ := newTeamApp(t)
	alice, _ := teamSignIn(t, app, "alice", testPassword, false)
	bob, _ := teamSignIn(t, app, "bob", testPassword, false)
	hash := strings.Repeat("a", 40)
	base := "/api/git/commit?host=test&root=artifacts&commit="
	calls := 0
	app.git.readCommit = func(context.Context, string, string, string) (storage.GitCommitDetails, error) {
		calls++
		return storage.GitCommitDetails{Hash: hash, Committer: "Committer", Files: []storage.GitCommitFile{{Path: "report.txt", Status: "M"}}}, nil
	}
	for _, cookie := range []*http.Cookie{nil, bob} {
		if w := request(app, "GET", base+hash, nil, cookie, ""); w.Code != 401 && w.Code != 404 {
			t.Fatal("commit access bypassed project grants", w.Code)
		}
	}
	for _, invalid := range []string{"", "HEAD", "--all", "abcd", strings.Repeat("z", 40), hash + "%5E1"} {
		if w := request(app, "GET", base+invalid, nil, alice, ""); w.Code != 400 {
			t.Fatal("invalid commit accepted", invalid, w.Code)
		}
	}
	if calls != 0 {
		t.Fatal("unauthorized or invalid request ran Git")
	}
	if w := request(app, "GET", base+hash, nil, alice, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "report.txt") || !strings.Contains(w.Body.String(), "Committer") {
		t.Fatal("commit response failed", w.Code, w.Body.String())
	}
	app.git.readCommit = func(context.Context, string, string, string) (storage.GitCommitDetails, error) {
		app.hostsMu.Lock()
		app.cfg.Hosts[0].Roots[0].Path += "-moved"
		app.hostsMu.Unlock()
		return storage.GitCommitDetails{Message: "Stale commit content"}, nil
	}
	if w := request(app, "GET", base+hash, nil, alice, ""); w.Code != 409 || strings.Contains(w.Body.String(), "Stale commit content") {
		t.Fatal("source replacement exposed stale commit", w.Code, w.Body.String())
	}
}

func TestGitCommitUnavailableHostKeysAndConcurrency(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	endpoint := "/api/git/commit?host=test&root=artifacts&commit=" + strings.Repeat("a", 40)
	app.git.readCommit = func(context.Context, string, string, string) (storage.GitCommitDetails, error) {
		return storage.GitCommitDetails{}, storage.ErrGitCommit
	}
	if w := request(app, "GET", endpoint, nil, cookie, ""); w.Code != 404 {
		t.Fatal("missing commit did not return not found", w.Code)
	}
	app.git.readCommit = func(context.Context, string, string, string) (storage.GitCommitDetails, error) {
		return storage.GitCommitDetails{}, &sshvault.HostKeyError{Token: "commit-token"}
	}
	if w := request(app, "GET", endpoint, nil, cookie, ""); w.Code != 409 || !strings.Contains(w.Body.String(), "commit-token") {
		t.Fatal("commit lost host-key confirmation", w.Code, w.Body.String())
	}
	app.git.slots <- struct{}{}
	app.git.slots <- struct{}{}
	defer func() { <-app.git.slots; <-app.git.slots }()
	if w := request(app, "GET", endpoint, nil, cookie, ""); w.Code != 503 {
		t.Fatal("commit bypassed concurrency limit", w.Code)
	}
}

func TestHistoricalDiffValidationAndSourceChanges(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	hash := strings.Repeat("a", 40)
	base := "/api/git/diff?host=test&root=artifacts&path=gone.txt&commit="
	calls := 0
	app.git.readCommitDiff = func(_ context.Context, _, _, path, commit string) (string, bool, error) {
		calls++
		if path != "gone.txt" || commit != hash {
			t.Fatal("wrong historical diff identity", path, commit)
		}
		return "-old committed content", false, nil
	}
	for _, invalid := range []string{"HEAD", "not-a-commit", hash + "%5E1"} {
		if w := request(app, "GET", base+invalid, nil, cookie, ""); w.Code != 400 {
			t.Fatal("invalid revision accepted", w.Code)
		}
	}
	if calls != 0 {
		t.Fatal("invalid revision reached Git")
	}
	if w := request(app, "GET", base+hash, nil, cookie, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "old committed content") {
		t.Fatal("historical file incorrectly required a working-tree file", w.Code, w.Body.String())
	}
	app.git.readCommitDiff = func(context.Context, string, string, string, string) (string, bool, error) {
		app.hostsMu.Lock()
		app.cfg.Hosts[0].Roots[0].Path += "-moved"
		app.hostsMu.Unlock()
		return "stale historical diff", false, nil
	}
	if w := request(app, "GET", base+hash, nil, cookie, ""); w.Code != 409 || strings.Contains(w.Body.String(), "stale historical diff") {
		t.Fatal("source change leaked a historical diff", w.Code, w.Body.String())
	}
}
