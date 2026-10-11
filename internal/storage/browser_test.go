package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSSHFolderBrowserHomeSymlinksAndBounds(t *testing.T) {
	home, outside := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(home, "file"), "setup must not read this")
	for link, dest := range map[string]string{
		"symlink": outside, "file-link": filepath.Join(home, "file"), "broken": filepath.Join(home, "missing"),
	} {
		if err := os.Symlink(dest, filepath.Join(home, link)); err != nil {
			t.Fatal(err)
		}
	}
	fixture := &fixtureFS{home: home}
	s, state := fixtureStore(t, fixture)
	listing, err := s.BrowseFolders(context.Background(), "fixture", "")
	if err != nil || listing.Path != home || listing.Home != home || listing.Parent == nil {
		t.Fatalf("SFTP home: %+v, %v", listing, err)
	}
	names := []string{}
	for _, entry := range listing.Entries {
		names = append(names, entry.Name)
		if entry.Type != "directory" || !filepath.IsAbs(entry.Path) {
			t.Fatalf("setup exposed file metadata: %+v", entry)
		}
	}
	if !reflect.DeepEqual(names, []string{"directory", "symlink"}) {
		t.Fatal(names)
	}
	listing, err = s.BrowseFolders(context.Background(), "fixture", filepath.Join(home, "symlink"))
	if err != nil || listing.Path != outside || listing.Entries == nil {
		t.Fatalf("trusted setup symlink: %+v, %v", listing, err)
	}
	listing, err = s.BrowseFolders(context.Background(), "fixture", "/")
	if err != nil || listing.Parent != nil {
		t.Fatalf("root navigation: %+v, %v", listing, err)
	}
	s.maxEntries = 4
	if _, err := s.BrowseFolders(context.Background(), "fixture", home); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("setup directory bound: %v", err)
	}
	if fixture.opens.Load() != 0 || state.active.Load() != 0 {
		t.Fatal("setup opened file contents or leaked a connection")
	}
	started := state.started.Load()
	for _, directory := range []string{"relative", "/bad/../path", "/bad\x00path"} {
		if _, err := s.BrowseFolders(context.Background(), "fixture", directory); !errors.Is(err, ErrForbidden) {
			t.Fatal(err)
		}
	}
	if state.started.Load() != started {
		t.Fatal("invalid setup paths reached SSH")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.BrowseFolders(ctx, "fixture", home); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled setup: %v", err)
	}
}
