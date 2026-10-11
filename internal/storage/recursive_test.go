package storage

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"
	"testing"
	"time"
)

type treeStore struct {
	directories map[string][]Entry
	failures    map[string]error
	calls       []string
	block       string
}

func (s *treeStore) List(ctx context.Context, _, _, rel string) ([]Entry, error) {
	s.calls = append(s.calls, rel)
	if rel == s.block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return s.directories[rel], s.failures[rel]
}
func (s *treeStore) Open(context.Context, string, string, string) (File, error) {
	panic("recursive listing must not open file contents")
}
func (*treeStore) Close() error { return nil }

func treeEntry(rel, kind string) Entry {
	return Entry{Path: rel, Name: path.Base(rel), Type: kind}
}

func TestRecursiveBoundsAndHonestPartialResults(t *testing.T) {
	for _, which := range []string{"files", "directories", "examined", "bytes", "depth", "timeout", "cancellation", "permission", "oversized", "filter"} {
		t.Run(which, func(t *testing.T) {
			s := &treeStore{directories: map[string][]Entry{
				"":         {treeEntry("a.txt", "file"), treeEntry("dir", "directory"), treeEntry("z.txt", "file")},
				"dir":      {treeEntry("dir/b.txt", "file"), treeEntry("dir/deep", "directory")},
				"dir/deep": {treeEntry("dir/deep/c.txt", "file")},
			}, failures: map[string]error{}, block: "never"}
			limits := defaultRecursiveLimits
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var filter PathFilter
			switch which {
			case "files":
				limits.results = 1
			case "directories":
				limits.directories = 1
			case "examined":
				limits.examined = 1
			case "bytes":
				limits.bytes = 12
			case "depth":
				limits.depth = 1
			case "timeout":
				limits.timeout = 10 * time.Millisecond
				s.block = "dir"
			case "cancellation":
				cancel()
			case "permission":
				s.failures["dir"] = fs.ErrPermission
			case "oversized":
				s.failures["dir"] = ErrTooLarge
			case "filter":
				filter = func(string, bool) (bool, error) { return false, errors.New("work limit") }
			}
			result, err := listRecursive(ctx, s, "target", "/project", "", false, filter, limits)
			if err != nil || !result.Truncated || result.Warning == "" {
				t.Fatalf("partial listing was not reported: %+v, %v", result, err)
			}
			if which == "files" && len(result.Entries) != 1 ||
				which == "directories" && len(s.calls) != 1 ||
				which == "cancellation" && len(s.calls) != 0 ||
				which == "depth" && len(s.calls) > 2 {
				t.Fatal("work continued past its bound", result, s.calls)
			}
			if which == "permission" && (!strings.Contains(result.Warning, "denied") || len(result.Entries) != 2) {
				t.Fatal("unreadable subdirectory lost accessible results or hid its error", result)
			}
		})
	}
	// Failure at the selected directory is an actual request error, not success.
	s := &treeStore{failures: map[string]error{"": fs.ErrPermission}, block: "never"}
	if _, err := ListRecursive(context.Background(), s, "target", "/project", "", false, nil); !errors.Is(err, fs.ErrPermission) {
		t.Fatal("selected-directory permission error was swallowed", err)
	}
}

func TestRecursiveSkipsIgnoredAndHiddenWorkWithinSelectedFolder(t *testing.T) {
	s := &treeStore{block: "never", directories: map[string][]Entry{
		".chosen": {treeEntry(".chosen/.hidden", "directory"), treeEntry(".chosen/.file", "file"),
			treeEntry(".chosen/cache", "directory"), treeEntry(".chosen/visible", "directory"), treeEntry(".chosen/file", "file")},
		".chosen/visible": {treeEntry(".chosen/visible/result", "file")},
		".chosen/.hidden": {treeEntry(".chosen/.hidden/result", "file")},
	}}
	filter := func(rel string, _ bool) (bool, error) { return strings.HasSuffix(rel, "/cache"), nil }
	result, err := ListRecursive(context.Background(), s, "", "/project", ".chosen", false, filter)
	if err != nil || result.Truncated || len(result.Entries) != 2 || fmt.Sprint(s.calls) != "[.chosen .chosen/visible]" {
		t.Fatalf("hidden/ignored descent or selected hidden folder: %+v, %v; calls %v", result, err, s.calls)
	}
	s.calls = nil
	result, err = ListRecursive(context.Background(), s, "", "/project", ".chosen", true, filter)
	if err != nil || result.Truncated || len(result.Entries) != 4 || len(s.calls) != 3 {
		t.Fatalf("showHidden did not include hidden descendants: %+v, %v", result, err)
	}
}
