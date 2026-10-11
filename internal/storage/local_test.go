//go:build unix

package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestLocalContainmentRangesAndSpecialFiles(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	writeFixture(t, filepath.Join(root, "report"), "hello world")
	writeFixture(t, filepath.Join(outside, "secret"), "outside")
	if err := os.Mkdir(filepath.Join(root, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(root, "nested", "plot"), "plot")
	rootLink := filepath.Join(t.TempDir(), "configured")
	for link, dest := range map[string]string{
		rootLink:                         root,
		filepath.Join(root, "escape"):    outside,
		filepath.Join(root, "internal"):  "nested",
		filepath.Join(root, "file-link"): "report",
		filepath.Join(root, "dangling"):  "missing",
	} {
		if err := os.Symlink(dest, link); err != nil {
			t.Fatal(err)
		}
	}
	if err := unix.Mkfifo(filepath.Join(root, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	s := NewLocal()
	defer s.Close()
	entries, err := s.List(context.Background(), "", rootLink, "")
	if err != nil || len(entries) != 7 {
		t.Fatalf("listing: %#v, %v", entries, err)
	}
	types := map[string]string{}
	for _, entry := range entries {
		types[entry.Name] = entry.Type
	}
	if types["fifo"] != "other" || types["escape"] != "symlink" || types["nested"] != "directory" ||
		types["internal"] != "directory" || types["file-link"] != "file" {
		t.Fatalf("entry types: %v", types)
	}
	for _, rel := range []string{"../secret", "/etc/passwd", "escape/secret", "dangling", "nested", "", "report/child", "fifo"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		done := make(chan error, 1)
		go func() {
			f, err := s.Open(ctx, "", rootLink, rel)
			if f != nil {
				f.Close()
			}
			done <- err
		}()
		select {
		case err := <-done:
			if !errors.Is(err, ErrForbidden) {
				t.Errorf("Open(%q) = %v", rel, err)
			}
		case <-ctx.Done():
			t.Fatalf("Open(%q) blocked on a special file", rel)
		}
		cancel()
	}
	if _, err := s.List(context.Background(), "", filepath.Join(root, "fifo"), ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("FIFO configured root: %v", err)
	}
	for _, rel := range []string{"escape", "fifo", "report"} {
		if _, err := s.List(context.Background(), "", rootLink, rel); !errors.Is(err, ErrForbidden) {
			t.Errorf("List(%q) = %v", rel, err)
		}
	}
	f, err := s.Open(context.Background(), "", rootLink, "report")
	if err != nil {
		t.Fatal(err)
	}
	if n, err := f.Seek(-5, io.SeekEnd); err != nil || n != 6 {
		t.Fatalf("seek: %d, %v", n, err)
	}
	data, err := io.ReadAll(f)
	f.Close()
	if err != nil || string(data) != "world" {
		t.Fatalf("read range: %q, %v", data, err)
	}
	if _, err := s.Open(context.Background(), "", rootLink, "missing"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	if _, err := s.Open(context.Background(), "ssh", rootLink, "report"); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
}

func TestLocalSymlinkReplacementCannotEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	writeFixture(t, filepath.Join(root, "safe"), "inside")
	writeFixture(t, filepath.Join(outside, "secret"), "outside")
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Go(func() {
		for ctx.Err() == nil {
			_ = os.Symlink("safe", filepath.Join(root, "next"))
			_ = os.Rename(filepath.Join(root, "next"), filepath.Join(root, "racing"))
			_ = os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "next"))
			_ = os.Rename(filepath.Join(root, "next"), filepath.Join(root, "racing"))
			_ = unix.Mkfifo(filepath.Join(root, "next"), 0600)
			_ = os.Rename(filepath.Join(root, "next"), filepath.Join(root, "racing"))
		}
	})
	defer func() { cancel(); wg.Wait() }()
	s := NewLocal()
	defer s.Close()
	for range 200 {
		f, err := s.Open(context.Background(), "", root, "racing")
		if f != nil {
			data, readErr := io.ReadAll(f)
			f.Close()
			if readErr != nil || string(data) != "inside" {
				t.Fatalf("replacement escaped: %q, %v", data, readErr)
			}
		}
		if err != nil && !errors.Is(err, ErrForbidden) && !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("unexpected replacement error: %v", err)
		}
	}
}

func TestLocalCancellationLimitsAndFolderNavigation(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	if err := os.Mkdir(filepath.Join(root, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(root, "file"), "contents must not appear in setup")
	if err := os.Symlink("directory", filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(root, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	s := NewLocal()
	defer s.Close()
	listing, err := s.BrowseFolders(context.Background(), "", "")
	if err != nil || listing.Path != root || listing.Home != root || listing.Parent == nil {
		t.Fatalf("home: %+v, %v", listing, err)
	}
	names := []string{}
	for _, entry := range listing.Entries {
		names = append(names, entry.Name)
		if entry.Type != "directory" || !filepath.IsAbs(entry.Path) {
			t.Fatalf("setup entry: %+v", entry)
		}
	}
	if !reflect.DeepEqual(names, []string{"directory", "link"}) {
		t.Fatal(names)
	}
	listing, err = s.BrowseFolders(context.Background(), "", filepath.Join(root, "link"))
	if err != nil || listing.Path != filepath.Join(root, "directory") || listing.Entries == nil {
		t.Fatalf("symlink setup: %+v, %v", listing, err)
	}
	listing, err = s.BrowseFolders(context.Background(), "", "/")
	if err != nil || listing.Parent != nil {
		t.Fatalf("root navigation: %+v, %v", listing, err)
	}
	s.maxEntries = 3
	if _, err := s.List(context.Background(), "", root, ""); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("list bound: %v", err)
	}
	if _, err := s.BrowseFolders(context.Background(), "", root); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("setup bound: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	f, err := s.Open(ctx, "", root, "file")
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := f.Read(make([]byte, 1)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled file: %v", err)
	}
	f.Close()
	if _, err := s.List(ctx, "", root, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled list: %v", err)
	}
	s.Close()
	if _, err := s.Open(context.Background(), "", root, "file"); !errors.Is(err, fs.ErrClosed) {
		t.Fatalf("closed store: %v", err)
	}
}

func TestLocalClosedStoreAdmission(t *testing.T) {
	for _, saturated := range []bool{false, true} {
		t.Run(fmt.Sprintf("slots-full=%v", saturated), func(t *testing.T) {
			store := NewLocal()
			if saturated {
				// Keep admission unavailable so the old implementation always
				// selects cancellation instead of randomly accepting a slot.
				for range cap(store.slots) {
					store.slots <- struct{}{}
				}
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			for _, caller := range []context.Context{context.Background(), ctx} {
				if _, release, err := store.begin(caller, time.Second); !errors.Is(err, fs.ErrClosed) {
					if release != nil {
						release()
					}
					t.Fatalf("closed store admission: %v", err)
				}
			}
		})
	}
}
