package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

func TestGitCacheLimitsPauseAndRetry(t *testing.T) {
	g := newGitService()
	defer g.cancel()
	now := time.Now()
	g.now = func() time.Time { return now }
	var calls int
	var failure error
	g.read = func(context.Context, string, string) (storage.GitStatus, error) {
		calls++
		return storage.GitStatus{Branch: "main"}, failure
	}
	source := gitSource{"fixture", "/project"}
	check := func(force bool, state string) gitStatusResponse {
		t.Helper()
		result, err := g.status(context.Background(), source, force)
		if err != nil || result.State != state {
			t.Fatalf("status: %#v, %v", result, err)
		}
		return result
	}
	check(false, "ready")
	check(false, "ready")
	check(true, "ready") // Rapid explicit retries are bounded as well.
	if calls != 1 {
		t.Fatalf("cache missed: %d", calls)
	}
	now = now.Add(6 * time.Second)
	check(true, "ready")
	if calls != 2 {
		t.Fatal("explicit retry did not refresh")
	}
	now = now.Add(time.Minute)
	failure = storage.ErrGitLimit
	paused := check(false, "paused")
	if paused.RetryAt.Sub(now) != 10*time.Minute {
		t.Fatal("large checks were not paused")
	}
	now = now.Add(time.Minute)
	check(false, "paused")
	if calls != 3 {
		t.Fatal("paused project ran again automatically")
	}
	failure = nil
	check(true, "ready")
	if calls != 4 {
		t.Fatal("explicit retry did not resume a paused project")
	}
	g.slots <- struct{}{}
	g.slots <- struct{}{}
	now = now.Add(time.Minute)
	check(false, "busy")
	if calls != 4 {
		t.Fatal("Git exceeded its concurrency cap")
	}
	<-g.slots
	<-g.slots
	for i := 0; i < 40; i++ {
		_, _ = g.status(context.Background(), gitSource{"fixture", string(rune('a' + i))}, false)
	}
	if len(g.cache) > 32 {
		t.Fatal("Git cache grew without bound")
	}
}

func TestGitDiffHostKeyFailureAfterSuccessfulPathCheck(t *testing.T) {
	app, store := newTestApp(t)
	cookie, _ := signIn(t, app)
	for _, failure := range []error{&sshvault.HostKeyError{Token: "fixture-token"}, sshvault.ErrHostKeyExpired} {
		app.git.readDiff = func(context.Context, string, string, string) (string, bool, error) {
			return "", false, fmt.Errorf("SSH Git connection: %w", failure)
		}
		before := store.opens
		w := request(app, "GET", "/api/git/diff"+fileQuery("reports/index.html"), nil, cookie, "")
		if store.opens <= before || w.Code != http.StatusConflict {
			t.Fatal("host-key failure after path verification became a generic diff error", w.Code, w.Body.String())
		}
		var challenge *sshvault.HostKeyError
		if errors.As(failure, &challenge) && !strings.Contains(w.Body.String(), `"token":"fixture-token"`) {
			t.Fatal("diff response lost the confirmation token")
		}
	}
}

func TestGitCoalescingAndCancellation(t *testing.T) {
	g := newGitService()
	defer g.cancel()
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	g.read = func(ctx context.Context, _, _ string) (storage.GitStatus, error) {
		calls.Add(1)
		close(started)
		select {
		case <-ctx.Done():
			return storage.GitStatus{}, ctx.Err()
		case <-release:
			return storage.GitStatus{Branch: "main"}, nil
		}
	}
	source := gitSource{"fixture", "/project"}
	g.cache[source] = gitStatusResponse{State: "ready", RetryAt: time.Now().Add(-time.Minute)}
	first := make(chan error, 1)
	go func() {
		_, err := g.status(context.Background(), source, false)
		first <- err
	}()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.status(ctx, source, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting request did not cancel: %v", err)
	}
	// Other projects can evict an expired entry while its refresh is in flight.
	g.mu.Lock()
	delete(g.cache, source)
	for i := 0; i < 32; i++ {
		g.cache[gitSource{"fixture", string(rune('a' + i))}] = gitStatusResponse{State: "ready"}
	}
	g.mu.Unlock()
	close(release)
	if err := <-first; err != nil || calls.Load() != 1 || len(g.slots) != 0 {
		t.Fatalf("independent read interrupted or duplicated: %v, %d", err, calls.Load())
	}
	if len(g.cache) > 32 {
		t.Fatal("an in-flight refresh bypassed the cache bound after eviction")
	}
	g.cancel()
	_, err := g.status(context.Background(), gitSource{"fixture", "/another"}, false)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("closed service accepted work: %v", err)
	}
}

func TestGitRoutesEnforceGrantsAndRecheckCachedAccess(t *testing.T) {
	app, _ := newTeamApp(t)
	alice, _ := teamSignIn(t, app, "alice", testPassword, false)
	bob, _ := teamSignIn(t, app, "bob", testPassword, false)
	calls := 0
	app.git.read = func(context.Context, string, string) (storage.GitStatus, error) {
		calls++
		return storage.GitStatus{Branch: "main", Changes: []storage.GitChange{{Path: "reports/index.html", Worktree: "M", Index: "."}}}, nil
	}
	endpoint := "/api/git/status?host=test&root=artifacts"
	for _, cookie := range []*http.Cookie{nil, bob} {
		w := request(app, "GET", endpoint, nil, cookie, "")
		if w.Code != http.StatusUnauthorized && w.Code != http.StatusNotFound {
			t.Fatalf("unauthorized Git status: %d", w.Code)
		}
	}
	if calls != 0 {
		t.Fatal("unauthorized caller ran Git")
	}
	for i := 0; i < 2; i++ {
		w := request(app, "GET", endpoint, nil, alice, "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), "reports/index.html") || strings.Contains(w.Body.String(), "test-alias") {
			t.Fatalf("Git status: %d %s", w.Code, w.Body)
		}
	}
	if calls != 1 {
		t.Fatal("HTTP Git reads did not share cached results")
	}
	app.hostsMu.Lock()
	for i := range app.cfg.Users {
		if app.cfg.Users[i].ID == "alice" {
			app.cfg.Users[i].Projects = nil
		}
	}
	app.hostsMu.Unlock()
	if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 404 || strings.Contains(w.Body.String(), "index.html") {
		t.Fatalf("cached Git status survived grant revocation: %d %s", w.Code, w.Body)
	}
}

func TestGitDiffContainsPathsAndRejectsChangedSources(t *testing.T) {
	app, _ := newTestApp(t)
	store := storage.NewLocal()
	t.Cleanup(func() { _ = store.Close() })
	app.store = store
	app.cfg.Hosts[0].Target, app.cfg.Hosts[0].Kind = "", "local"
	cookie, _ := signIn(t, app)
	root := app.cfg.Hosts[0].Roots[0].Path
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	calls := 0
	app.git.readDiff = func(context.Context, string, string, string) (string, bool, error) {
		calls++
		return "-before\n+after\n", false, nil
	}
	base := "/api/git/diff?host=test&root=artifacts&path="
	for _, path := range []string{"../secret.txt", "escape/secret.txt", "escape/deleted.txt", "reports"} {
		w := request(app, "GET", base+path, nil, cookie, "")
		if w.Code == 200 {
			t.Fatalf("unsafe diff path accepted: %s", path)
		}
	}
	large, err := os.Create(filepath.Join(root, "large.dat"))
	if err != nil {
		t.Fatal(err)
	}
	if err := large.Truncate(storage.MaxGitDiffFile + 1); err != nil {
		t.Fatal(err)
	}
	_ = large.Close()
	if w := request(app, "GET", base+"large.dat", nil, cookie, ""); w.Code != 413 {
		t.Fatalf("large file preflight: %d %s", w.Code, w.Body)
	}
	if calls != 0 {
		t.Fatal("invalid or oversized path reached Git")
	}
	for _, path := range []string{"reports/index.html", "gone/deleted.txt"} {
		w := request(app, "GET", base+path, nil, cookie, "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), "after") {
			t.Fatalf("valid/deleted path: %d %s", w.Code, w.Body)
		}
	}
	app.git.readDiff = func(context.Context, string, string, string) (string, bool, error) {
		app.hostsMu.Lock()
		app.cfg.Hosts[0].Roots[0].Path = outside
		app.hostsMu.Unlock()
		return "old source content", false, nil
	}
	w := request(app, "GET", base+"reports/index.html", nil, cookie, "")
	if w.Code != 409 || strings.Contains(w.Body.String(), "old source content") {
		t.Fatalf("old source diff escaped revalidation: %d %s", w.Code, w.Body)
	}
}
