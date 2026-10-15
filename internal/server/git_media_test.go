package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

func TestGitMediaDiffVersionsAndAccess(t *testing.T) {
	app, _ := newTeamApp(t)
	store := app.store.(*localStore)
	alice, _ := teamSignIn(t, app, "alice", testPassword, false)
	bob, _ := teamSignIn(t, app, "bob", testPassword, false)
	hash := strings.Repeat("a", 40)
	endpoint := "/api/git/diff" + fileQuery("removed.svg") + "&commit=" + hash
	calls := 0
	app.git.readDiffFiles = func(_ context.Context, _, _, name, commit string) (storage.GitFileVersions, error) {
		calls++
		if name != "removed.svg" || commit != hash {
			t.Fatal("wrong media identity", name, commit)
		}
		return storage.GitFileVersions{Before: &storage.GitFileVersion{Data: []byte("<svg><script>unsafe()</script></svg>")}}, nil
	}
	for _, cookie := range []*http.Cookie{nil, bob} {
		if w := request(app, "GET", endpoint, nil, cookie, ""); w.Code != 401 && w.Code != 404 {
			t.Fatal("unauthorized binary diff", w.Code)
		}
	}
	if w := request(app, "GET", strings.Replace(endpoint, hash, "HEAD", 1), nil, alice, ""); w.Code != 400 {
		t.Fatal("invalid revision was accepted", w.Code)
	}
	if calls != 0 {
		t.Fatal("invalid or unauthorized media request ran Git")
	}
	opens := store.opens
	w := request(app, "GET", endpoint, nil, alice, "")
	var result struct {
		Media struct {
			Type string `json:"type"`
			storage.GitFileVersions
		} `json:"media"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Media.Type != "image/svg+xml" ||
		result.Media.Before == nil || result.Media.After != nil || !strings.Contains(string(result.Media.Before.Data), "unsafe()") ||
		!strings.Contains(w.Header().Get("Content-Type"), "application/json") || w.Header().Get("Cache-Control") != "no-store" ||
		strings.Contains(w.Body.String(), "<script>") || store.opens != opens {
		t.Fatal("historical media was lost, read from disk, or served unsafely", w.Code, w.Body.String())
	}
	for _, item := range []struct {
		err  error
		code int
	}{{storage.ErrGitFileSize, 413}, {storage.ErrGitCommit, 404}, {storage.ErrGitFilters, 422}, {&sshvault.HostKeyError{Token: "media-token"}, 409}} {
		app.git.readDiffFiles = func(context.Context, string, string, string, string) (storage.GitFileVersions, error) {
			return storage.GitFileVersions{}, item.err
		}
		if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != item.code {
			t.Fatal("incorrect media error", item.err, w.Code, w.Body.String())
		}
	}
	app.git.readDiffFiles = func(context.Context, string, string, string, string) (storage.GitFileVersions, error) {
		app.hostsMu.Lock()
		app.cfg.Hosts[0].Roots[0].Path += "-moved"
		app.hostsMu.Unlock()
		return storage.GitFileVersions{After: &storage.GitFileVersion{Data: []byte("stale")}}, nil
	}
	if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 409 {
		t.Fatal("source replacement leaked a binary version", w.Code)
	}
}

func TestGitMediaWorkingFileAndBounds(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	app.git.readDiffFiles = func(context.Context, string, string, string, string) (storage.GitFileVersions, error) {
		return storage.GitFileVersions{Before: &storage.GitFileVersion{Data: []byte("old PDF")}}, nil
	}
	w := request(app, "GET", "/api/git/diff"+fileQuery("reports/report.pdf"), nil, cookie, "")
	var result struct {
		Media storage.GitFileVersions `json:"media"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Media.After == nil ||
		!strings.HasPrefix(string(result.Media.After.Data), "%PDF-1.7") {
		t.Fatal("working-tree PDF was not read through storage", w.Code, w.Body.String())
	}
	source := gitSource{app.cfg.Hosts[0].Target, app.cfg.Hosts[0].Roots[0].Path}
	if err := os.WriteFile(filepath.Join(source.root, "large.pdf"), []byte(strings.Repeat("x", storage.MaxGitDiffFile+1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := app.gitWorkingFile(context.Background(), source, "large.pdf"); !errors.Is(err, storage.ErrGitFileSize) {
		t.Fatal("working file bypassed size limit", err)
	}
	if version, err := app.gitWorkingFile(context.Background(), source, "deleted.pdf"); err != nil || version != nil {
		t.Fatal("deleted working file did not produce an absent version", version, err)
	}
	app.store = &growingStore{}
	if _, err := app.gitWorkingFile(context.Background(), source, "growing.pdf"); !errors.Is(err, storage.ErrGitFileSize) {
		t.Fatal("growing file bypassed size limit", err)
	}
}
