//go:build unix

package ignore

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

func fileFixture(t *testing.T) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(filename, []byte(`{"passwordHash":"PRIVATE PASSWORD","other":"preserve"}`), 0600); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestIgnorePersistenceDefaultsClearConflictsAndConfigIsolation(t *testing.T) {
	configFile := fileFixture(t)
	before, err := os.ReadFile(configFile)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(configFile)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := Load(configFile)
	if err != nil || initial.Content != DefaultContent || !initial.Editable ||
		initial.Path != filepath.Join(filepath.Dir(configFile), Filename) || len(initial.Revision) != 64 {
		t.Fatalf("missing ignore defaults: %+v, %v", initial, err)
	}
	if _, err := os.Stat(initial.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("GET created the ignore file")
	}
	// Creating exactly the default content still invalidates the missing revision.
	created, err := Save(configFile, initial.Content, initial.Revision)
	if err != nil || created.Revision == initial.Revision {
		t.Fatalf("creation revision: %+v, %v", created, err)
	}
	if _, err := Save(configFile, "stale", initial.Revision); !errors.Is(err, ErrConflict) {
		t.Fatal("stale creation revision accepted", err)
	}
	info, err := os.Stat(created.Path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("unsafe ignore mode: %v, %v", info, err)
	}
	cleared, err := Save(configFile, "", created.Revision)
	if err != nil || cleared.Content != "" {
		t.Fatal("clear failed", err)
	}
	loaded, err := Load(configFile)
	if err != nil || loaded != cleared {
		t.Fatalf("empty file reverted to defaults: %+v, %v", loaded, err)
	}
	nextInfo, err := os.Stat(created.Path)
	if err != nil || os.SameFile(info, nextInfo) {
		t.Fatal("save must replace the file atomically", err)
	}
	if err := os.WriteFile(created.Path, []byte("external/\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(configFile, "", cleared.Revision); !errors.Is(err, ErrConflict) {
		t.Fatal("external edit was overwritten", err)
	}
	after, err := os.ReadFile(configFile)
	afterInfo, statErr := os.Stat(configFile)
	if err != nil || statErr != nil || string(after) != string(before) || !os.SameFile(beforeInfo, afterInfo) ||
		!beforeInfo.ModTime().Equal(afterInfo.ModTime()) {
		t.Fatal("ignore editing touched the password/config")
	}
	entries, err := os.ReadDir(filepath.Dir(configFile))
	if err != nil || len(entries) != 2 {
		t.Fatal("ignore save leaked temporary files", entries, err)
	}
}

func TestIgnoreConcurrentEditorsAndDisabledPersistence(t *testing.T) {
	filename := fileFixture(t)
	initial, err := Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 8)
	var wg sync.WaitGroup
	for range cap(results) {
		wg.Go(func() {
			_, err := Save(filename, "cache/", initial.Revision)
			results <- err
		})
	}
	wg.Wait()
	close(results)
	saved := 0
	for err := range results {
		if err == nil {
			saved++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if saved != 1 {
		t.Fatal("concurrent stale editors succeeded", saved)
	}
	for _, absent := range []string{"", filepath.Join(t.TempDir(), "missing.json")} {
		doc, err := Load(absent)
		if err != nil || doc.Editable || doc.Content != DefaultContent {
			t.Fatalf("disabled defaults: %+v, %v", doc, err)
		}
		if _, err := Save(absent, "", doc.Revision); !errors.Is(err, ErrDisabled) {
			t.Fatal("editing enabled without a config", err)
		}
	}
}

func TestEnsureDefaultsCreatesOnceAndPreservesExistingRules(t *testing.T) {
	configFile := fileFixture(t)
	before, _ := os.ReadFile(configFile)
	filename := filepath.Join(filepath.Dir(configFile), Filename)
	results := make(chan error, 8)
	var workers sync.WaitGroup
	for range cap(results) {
		workers.Go(func() { results <- EnsureDefaults(configFile) })
	}
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	content, err := os.ReadFile(filename)
	if err != nil || string(content) != DefaultContent {
		t.Fatal("startup did not create default ignore rules", err)
	}
	info, err := os.Stat(filename)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("startup ignore permissions are not private", err)
	}
	for _, content := range []string{DefaultContent, "custom-cache/\n", ""} {
		if err := os.WriteFile(filename, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		beforeInfo, err := os.Stat(filename)
		if err != nil {
			t.Fatal(err)
		}
		if err := EnsureDefaults(configFile); err != nil {
			t.Fatal(err)
		}
		after, readErr := os.ReadFile(filename)
		afterInfo, statErr := os.Stat(filename)
		if readErr != nil || statErr != nil || string(after) != content ||
			!os.SameFile(beforeInfo, afterInfo) || !beforeInfo.ModTime().Equal(afterInfo.ModTime()) {
			t.Fatal("startup replaced existing ignore rules")
		}
	}
	after, _ := os.ReadFile(configFile)
	entries, err := os.ReadDir(filepath.Dir(configFile))
	if string(after) != string(before) || err != nil || len(entries) != 2 {
		t.Fatal("startup changed the config or left temporary files", err)
	}
}

func TestIgnoreRejectsLinksSpecialFilesAndConfigCollision(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "directory", "FIFO", "config collision"} {
		t.Run(kind, func(t *testing.T) {
			filename := fileFixture(t)
			before, _ := os.ReadFile(filename)
			doc, err := Load(filename)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "symlink":
				err = os.Symlink(filename, doc.Path)
			case "hardlink":
				err = os.Link(filename, doc.Path)
			case "directory":
				err = os.Mkdir(doc.Path, 0700)
			case "FIFO":
				err = unix.Mkfifo(doc.Path, 0600)
			case "config collision":
				filename = doc.Path
				err = os.WriteFile(filename, before, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Load(filename); err == nil {
				t.Fatal("unsafe file was exposed")
			}
			if _, err := Save(filename, "", doc.Revision); err == nil {
				t.Fatal("unsafe file was overwritten")
			}
			if err := EnsureDefaults(filename); err == nil {
				t.Fatal("startup accepted an unsafe ignore path")
			}
			after, err := os.ReadFile(filename)
			if err != nil || string(after) != string(before) {
				t.Fatal("configuration was damaged")
			}
		})
	}
}

func TestIgnoreCooperatingProcessLockRefusesBusySave(t *testing.T) {
	filename := fileFixture(t)
	doc, err := Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	// Separate opens have independent lock ownership, as in separate processes.
	dir, err := openDirectory(filepath.Dir(filename))
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if err := lockDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(filename, "", doc.Revision); !errors.Is(err, ErrConflict) {
		t.Fatal("busy file update was not refused", err)
	}
	if _, err := os.Stat(doc.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("conflicting save created a file", err)
	}
}
