package storage

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"time"
)

type Listing struct {
	Entries   []Entry `json:"entries"`
	Path      string  `json:"path"`
	Truncated bool    `json:"truncated,omitempty"`
	Warning   string  `json:"warning,omitempty"`
}

// PathFilter returns true for display-only exclusions.
// It receives project-relative displayed paths and, when different, resolved paths.
type PathFilter func(rel string, directory bool) (bool, error)

type recursiveLimits struct {
	results, directories, examined, bytes, depth int
	timeout                                      time.Duration
}

var defaultRecursiveLimits = recursiveLimits{
	results: 10_000, directories: 512, examined: 100_000, bytes: 16 << 20,
	depth: 128, timeout: 20 * time.Second,
}

// ListRecursive walks from rel without ever substituting a derived trusted root.
// Every directory is resolved before listing to deduplicate contained aliases.
// Regular file links are included; unavailable links and special files are not.
func ListRecursive(ctx context.Context, store Store, target, root, rel string, showHidden bool, filter PathFilter) (Listing, error) {
	return listRecursive(ctx, store, target, root, rel, showHidden, filter, defaultRecursiveLimits)
}

func (l *Listing) partial(message string) {
	l.Truncated = true
	// Keep warnings bounded even when every visited subdirectory is unreadable.
	if l.Warning == "" {
		l.Warning = message
	} else if !strings.Contains(l.Warning, message) && len(l.Warning)+len(message) < 2048 {
		l.Warning += " " + message
	}
}

func listRecursive(ctx context.Context, store Store, target, root, rel string, showHidden bool, filter PathFilter, limits recursiveLimits) (Listing, error) {
	rel, err := ValidateRelative(rel)
	if err != nil {
		return Listing{}, err
	}
	result := Listing{Entries: []Entry{}, Path: rel}
	ctx, cancel := context.WithTimeout(ctx, limits.timeout)
	defer cancel()
	type pending struct {
		rel   string
		depth int
	}
	queue := []pending{{rel: rel}}
	seen := map[string]bool{}
	directories, examined, bytes := 0, 0, 0
	var lister directoryLister = store
	resolver, resolves := store.(Resolver)
	if source, ok := store.(listingSessionStore); ok {
		if ctx.Err() != nil {
			result.partial("Recursive Browse stopped because its time limit or request cancellation was reached.")
			return result, nil
		}
		session, err := source.beginListing(ctx, target, root)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				result.partial("Recursive Browse stopped because its time limit or request cancellation was reached.")
				return result, nil
			}
			return result, err
		}
		if session != nil {
			defer session.Close()
			lister, resolver, resolves = session, session, true
		}
	}
	for len(queue) != 0 {
		if err := ctx.Err(); err != nil {
			result.partial("Recursive Browse stopped because its time limit or request cancellation was reached.")
			break
		}
		if directories >= limits.directories {
			result.partial("Recursive Browse reached its directory limit; choose a smaller folder.")
			break
		}
		next := queue[0]
		queue = queue[1:]
		directories++
		canonical := next.rel
		var err error
		if resolves {
			canonical, err = resolver.Resolve(ctx, target, root, next.rel)
			if err == nil {
				checked, checkErr := ValidateRelative(canonical)
				if checkErr != nil || canonical != checked {
					err = ErrForbidden
				}
			}
		}
		if err == nil && seen[canonical] {
			continue
		}
		if err == nil {
			seen[canonical] = true
			if filter != nil {
				ignored, filterErr := filter(next.rel, true)
				if filterErr == nil && !ignored && canonical != next.rel {
					ignored, filterErr = filter(canonical, true)
				}
				if filterErr != nil {
					result.partial("Browse stopped at its ignore pattern matching limit.")
					break
				}
				if ignored {
					continue
				}
			}
		}
		var entries []Entry
		if err == nil {
			entries, err = lister.List(ctx, target, root, next.rel)
		}
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				result.partial("Recursive Browse stopped because its time limit or request cancellation was reached.")
				break
			}
			if errors.Is(err, ErrTooLarge) {
				if errors.Is(err, errListingSessionEnded) {
					result.partial("Recursive Browse reached its listing limit; choose a smaller folder.")
					break
				}
				result.partial("A directory exceeded its listing limit and was omitted; choose a smaller folder.")
				continue
			}
			if next.depth == 0 {
				return result, err
			}
			if errors.Is(err, errListingSessionEnded) {
				result.partial("Recursive Browse stopped because its storage connection failed.")
				break
			}
			if errors.Is(err, ErrForbidden) || errors.Is(err, fs.ErrPermission) {
				result.partial("Some subdirectories could not be read because access was denied.")
			} else {
				result.partial("Some subdirectories could not be read or changed during browsing.")
			}
			continue
		}
		// Prefer actual directories over aliases within each level.
		// Do not mutate slices owned or reused by a Store implementation.
		entries = append([]Entry(nil), entries...)
		sort.Slice(entries, func(i, j int) bool {
			if entries[i].Symlink != entries[j].Symlink {
				return !entries[i].Symlink
			}
			return entries[i].Name < entries[j].Name
		})
		for _, entry := range entries {
			if ctx.Err() != nil {
				result.partial("Recursive Browse stopped because its time limit or request cancellation was reached.")
				return result, nil
			}
			examined++
			bytes += len(entry.Path) + len(entry.Name)
			if entry.ResolvedPath != nil {
				bytes += len(*entry.ResolvedPath)
			}
			if examined > limits.examined || bytes > limits.bytes {
				result.partial("Recursive Browse reached its scan limit; choose a smaller folder.")
				return result, nil
			}
			if !validEntryName(entry.Name) || entry.Path != path.Join(next.rel, entry.Name) {
				return result, fmt.Errorf("%w: invalid directory entry", ErrForbidden)
			}
			if !showHidden && strings.HasPrefix(entry.Name, ".") {
				continue
			}
			if entry.Type != "directory" && entry.Type != "file" {
				continue
			}
			resolved := path.Join(canonical, entry.Name)
			if entry.ResolvedPath != nil {
				resolved = *entry.ResolvedPath
				if checked, err := ValidateRelative(resolved); err != nil || resolved != checked {
					return result, ErrForbidden
				}
			}
			if filter != nil {
				ignored, err := filter(entry.Path, entry.Type == "directory")
				if err == nil && !ignored && resolved != entry.Path {
					ignored, err = filter(resolved, entry.Type == "directory")
				}
				if err != nil {
					result.partial("Browse stopped at its ignore pattern matching limit.")
					return result, nil
				}
				if ignored {
					continue
				}
			}
			if entry.Type == "directory" {
				if !resolves && entry.Symlink {
					result.partial("Directory links were omitted because this storage backend cannot resolve them safely.")
					continue
				}
				if seen[resolved] {
					continue
				}
				if next.depth >= limits.depth {
					result.partial("Recursive Browse reached its directory depth limit.")
					continue
				}
				if len(queue)+directories >= limits.directories {
					result.partial("Recursive Browse reached its directory limit; choose a smaller folder.")
					continue
				}
				queue = append(queue, pending{rel: entry.Path, depth: next.depth + 1})
				continue
			}
			if len(result.Entries) >= limits.results {
				result.partial("Recursive Browse reached its file limit; choose a smaller folder.")
				return result, nil
			}
			result.Entries = append(result.Entries, entry)
		}
	}
	return result, nil
}
