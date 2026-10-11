//go:build unix

package storage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type countingResolverStore struct {
	Store
	directories map[string]int
}

type countingListingSession struct {
	listingSession
	directories map[string]int
}

func (s *countingResolverStore) beginListing(ctx context.Context, target, root string) (listingSession, error) {
	source, ok := s.Store.(listingSessionStore)
	if !ok {
		return nil, nil
	}
	session, err := source.beginListing(ctx, target, root)
	if err != nil || session == nil {
		return session, err
	}
	return &countingListingSession{listingSession: session, directories: s.directories}, nil
}

func (s *countingListingSession) List(ctx context.Context, target, root, rel string) ([]Entry, error) {
	canonical, err := s.Resolve(ctx, target, root, rel)
	if err != nil {
		return nil, err
	}
	s.directories[canonical]++
	return s.listingSession.List(ctx, target, root, rel)
}

func (s *countingResolverStore) Resolve(ctx context.Context, target, root, rel string) (string, error) {
	return s.Store.(Resolver).Resolve(ctx, target, root, rel)
}

func (s *countingResolverStore) List(ctx context.Context, target, root, rel string) ([]Entry, error) {
	canonical, err := s.Resolve(ctx, target, root, rel)
	if err != nil {
		return nil, err
	}
	s.directories[canonical]++
	return s.Store.List(ctx, target, root, rel)
}

func TestRecursiveContainedLinksDeduplicateDirectoriesAndDoNotReadContents(t *testing.T) {
	for _, backend := range []string{"local", "SFTP"} {
		t.Run(backend, func(t *testing.T) {
			fx := newLinkFixture(t)
			// Selecting this contained alias below proves links are followed.
			if err := os.Symlink("shared", filepath.Join(fx.root, "visible")); err != nil {
				t.Fatal(err)
			}
			var store Store
			var fixture *fixtureFS
			var state *fixtureState
			target := ""
			if backend == "local" {
				store = NewLocal()
			} else {
				fixture = &fixtureFS{}
				store, state = fixtureStore(t, fixture)
				target = "fixture"
			}
			defer store.Close()
			counted := &countingResolverStore{Store: store, directories: map[string]int{}}
			result, err := ListRecursive(context.Background(), counted, target, fx.alias, "", false, nil)
			if err != nil || result.Truncated {
				t.Fatalf("link walk: %+v, %v", result, err)
			}
			for dir, calls := range counted.directories {
				if calls != 1 {
					t.Fatalf("canonical directory %q listed %d times", dir, calls)
				}
			}
			if len(counted.directories) != 4 {
				t.Fatal("contained directories were omitted or aliases/loops traversed", counted.directories)
			}
			seen := map[string]bool{}
			for _, entry := range result.Entries {
				if entry.Type != "file" || strings.HasPrefix(entry.Path, "escape/") || strings.Contains(entry.Path, "/up/") {
					t.Fatal("recursive result included a special file or traversed a cycle/escape", entry)
				}
				seen[entry.Path] = true
			}
			for _, expected := range []string{"reports/index.html", "reports/assets/plot.png", "shared/secret", "file-link"} {
				if !seen[expected] {
					t.Error("expected regular file or contained link missing", expected)
				}
			}
			// Starting from an alias must preserve display paths and terminate
			// the reports/assets/up -> reports cycle at the canonical boundary.
			counted.directories = map[string]int{}
			result, err = ListRecursive(context.Background(), counted, target, fx.alias, "directory", false, nil)
			if err != nil || result.Truncated || counted.directories["reports"] != 1 || counted.directories["reports/assets"] != 1 {
				t.Fatalf("selected alias traversal: %+v, %v; %v", result, err, counted.directories)
			}
			for _, entry := range result.Entries {
				if !strings.HasPrefix(entry.Path, "directory/") {
					t.Fatal("selected alias lost its requested path", entry)
				}
			}
			counted.directories = map[string]int{}
			result, err = ListRecursive(context.Background(), counted, target, fx.alias, "visible", false, nil)
			if err != nil || len(result.Entries) != 1 || result.Entries[0].Path != "visible/secret" {
				t.Fatalf("contained directory link was not followed: %+v, %v", result, err)
			}
			if fixture != nil && (fixture.opens.Load() != 0 || fixture.reads.Load() != 0) {
				t.Fatal("recursive SFTP metadata walk read file contents")
			}
			if state != nil && (state.started.Load() != 2 || state.active.Load() != 1 ||
				len(store.(*SSH).active) != 0) {
				t.Fatal("symlink walks did not discard the failed connection and reuse the healthy one")
			}
		})
	}
}
