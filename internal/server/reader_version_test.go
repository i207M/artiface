package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"artiface/internal/storage"
)

type readerVersionStore struct {
	*localStore
	stats, closes int
	statError     error
	afterStat     func()
}

func (s *readerVersionStore) Open(ctx context.Context, target, root, rel string) (storage.File, error) {
	f, err := s.localStore.Open(ctx, target, root, rel)
	if err != nil {
		return nil, err
	}
	return &readerVersionFile{File: f, store: s}, nil
}

type readerVersionFile struct {
	storage.File
	store *readerVersionStore
}

func (f *readerVersionFile) Stat() (fs.FileInfo, error) {
	f.store.stats++
	if f.store.statError != nil {
		return nil, f.store.statError
	}
	info, err := f.File.Stat()
	if err == nil && f.store.afterStat != nil {
		action := f.store.afterStat
		f.store.afterStat = nil
		action()
	}
	return info, err
}

func (f *readerVersionFile) Close() error {
	f.store.closes++
	return f.File.Close()
}

func TestReaderResponseVersions(t *testing.T) {
	for _, trusted := range []bool{false, true} {
		name := "sandboxed"
		if trusted {
			name = "trusted"
		}
		t.Run(name, func(t *testing.T) {
			app, local := newTestApp(t)
			app.cfg.Hosts[0].Roots[0].TrustedScripts = trusted
			store := &readerVersionStore{localStore: local}
			app.store = store
			cookie, csrf := signIn(t, app)
			info, err := os.Stat(filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports/index.html"))
			if err != nil {
				t.Fatal(err)
			}
			want := fileVersion(info, trusted)
			for _, endpoint := range []string{"text", "preview"} {
				opens, stats, closes := store.opens, store.stats, store.closes
				method, target := "GET", "/api/text"+fileQuery("reports/index.html")
				var body any
				if endpoint == "preview" {
					method, target = "POST", "/api/preview"
					body = location{Host: "test", Root: "artifacts", Path: "reports/index.html"}
				}
				response := request(app, method, target, body, cookie, csrf)
				var got struct {
					Version string `json:"version"`
					Scripts bool   `json:"scripts"`
				}
				if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &got) != nil || got.Version != want {
					t.Fatalf("%s version: status=%d body=%s want=%s", endpoint, response.Code, response.Body, want)
				}
				if endpoint == "preview" && got.Scripts != trusted {
					t.Fatal("preview version changed the project trust policy")
				}
				if store.opens-opens != 1 || store.stats-stats != 1 || store.closes-closes != 1 {
					t.Fatalf("%s must use one opened/statted/closed handle; got %d/%d/%d", endpoint,
						store.opens-opens, store.stats-stats, store.closes-closes)
				}
			}
		})
	}
}

func TestReaderTextVersionUsesReadHandle(t *testing.T) {
	app, local := newTestApp(t)
	store := &readerVersionStore{localStore: local}
	app.store = store
	cookie, _ := signIn(t, app)
	filename := filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports/index.html")
	original, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	store.afterStat = func() {
		replacement := filename + ".replacement"
		if err := os.WriteFile(replacement, []byte("NEW fixture version"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(replacement, filename); err != nil {
			t.Fatal(err)
		}
	}
	response := request(app, "GET", "/api/text"+fileQuery("reports/index.html"), nil, cookie, "")
	var got struct {
		Text    string `json:"text"`
		Version string `json:"version"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &got) != nil ||
		got.Text != string(original) || got.Version != fileVersion(before, false) {
		t.Fatalf("old bytes must keep the old handle's version: %d %s", response.Code, response.Body)
	}
	if store.opens != 1 || store.stats != 1 || store.closes != 1 {
		t.Fatal("text response reopened or restatted the file to assign its version")
	}
	current := request(app, "GET", "/api/file-info"+fileQuery("reports/index.html"), nil, cookie, "")
	var latest fileStat
	if current.Code != 200 || json.Unmarshal(current.Body.Bytes(), &latest) != nil || latest.Version == got.Version {
		t.Fatal("the replacement file should have a distinct current metadata version")
	}
}

func TestReaderPreviewStatFailureClosesHandle(t *testing.T) {
	app, local := newTestApp(t)
	store := &readerVersionStore{localStore: local, statError: errors.New("fixture stat failed")}
	app.store = store
	cookie, csrf := signIn(t, app)
	response := request(app, "POST", "/api/preview",
		location{Host: "test", Root: "artifacts", Path: "reports/index.html"}, cookie, csrf)
	if response.Code < 400 || store.opens != 1 || store.stats != 1 || store.closes != 1 || len(app.previews) != 0 {
		t.Fatalf("failed stat leaked a handle or minted a capability: %d %s", response.Code, response.Body)
	}
}
