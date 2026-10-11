package storage

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Local reads the server's filesystem through directory descriptors.
// NewLocal must be used to initialize it.
type Local struct {
	mu         sync.Mutex
	active     map[*localFile]struct{}
	ctx        context.Context
	cancel     context.CancelFunc
	slots      chan struct{}
	maxEntries int
}

func NewLocal() *Local {
	ctx, cancel := context.WithCancel(context.Background())
	return &Local{ctx: ctx, cancel: cancel, active: map[*localFile]struct{}{},
		slots: make(chan struct{}, maxConnections), maxEntries: maxDirectoryEntries}
}

func (s *Local) Close() error {
	s.mu.Lock()
	s.cancel()
	files := make([]*localFile, 0, len(s.active))
	for f := range s.active {
		files = append(files, f)
	}
	s.mu.Unlock()
	for _, f := range files {
		_ = f.Close()
	}
	return nil
}

func (s *Local) begin(parent context.Context, lifetime time.Duration) (context.Context, func(), error) {
	if s.ctx.Err() != nil {
		return nil, nil, fs.ErrClosed
	}
	ctx, cancel := context.WithTimeout(parent, lifetime)
	stop := context.AfterFunc(s.ctx, cancel)
	select {
	case s.slots <- struct{}{}:
	case <-ctx.Done():
		stop()
		cancel()
		if s.ctx.Err() != nil {
			return nil, nil, fs.ErrClosed
		}
		return nil, nil, ctx.Err()
	}
	release := func() { stop(); cancel(); <-s.slots }
	if s.ctx.Err() != nil {
		release()
		return nil, nil, fs.ErrClosed
	}
	if err := ctx.Err(); err != nil {
		release()
		return nil, nil, err
	}
	return ctx, release, nil
}

func (s *Local) retain(ctx context.Context, release func(), file *os.File, root *localRoot, resolved string) (*localFile, error) {
	f := &localFile{file: file, root: root, resolved: resolved, ctx: ctx, release: release, store: s}
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		file.Close()
		if root != nil {
			root.Close()
		}
		release()
		return nil, fs.ErrClosed
	}
	s.active[f] = struct{}{}
	s.mu.Unlock()
	context.AfterFunc(ctx, func() { _ = f.Close() })
	return f, nil
}

func validateLocalRequest(target, root, rel string) (string, string, error) {
	if target != "" {
		return "", "", ErrForbidden
	}
	root, err := validateRoot(root)
	if err != nil {
		return "", "", err
	}
	rel, err = ValidateRelative(rel)
	return root, rel, err
}

func (s *Local) open(ctx context.Context, target, root, rel string, directory bool, scope *string) (*localFile, string, error) {
	root, rel, err := validateLocalRequest(target, root, rel)
	if err != nil {
		return nil, "", err
	}
	if scope != nil {
		checked, err := ValidateRelative(*scope)
		if err != nil {
			return nil, "", err
		}
		scope = &checked
	}
	lifetime := defaultFileLifetime
	if directory {
		lifetime = defaultOperationTimeout
	}
	ctx, release, err := s.begin(ctx, lifetime)
	if err != nil {
		return nil, "", err
	}
	anchor, err := openLocalRoot(ctx, root)
	if err != nil {
		release()
		return nil, "", err
	}
	request := rel
	var scopeDir *os.File
	if scope != nil {
		var canonical string
		scopeDir, canonical, err = anchor.walk(ctx, *scope, directoryPath, nil)
		if err != nil {
			anchor.Close()
			release()
			return nil, "", err
		}
		defer scopeDir.Close()
		request = path.Join(canonical, rel)
	}
	kind := regularPath
	if directory {
		kind = directoryPath
	}
	file, resolved, err := anchor.walk(ctx, request, kind, scopeDir)
	if err != nil {
		anchor.Close()
		release()
		return nil, "", err
	}
	f, err := s.retain(ctx, release, file, anchor, resolved)
	return f, rel, err
}

func (s *Local) Open(ctx context.Context, target, root, rel string) (File, error) {
	f, _, err := s.open(ctx, target, root, rel, false, nil)
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (s *Local) OpenScoped(ctx context.Context, target, root, scope, rel string) (File, error) {
	f, _, err := s.open(ctx, target, root, rel, false, &scope)
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (s *Local) Resolve(ctx context.Context, target, root, rel string) (string, error) {
	root, rel, err := validateLocalRequest(target, root, rel)
	if err != nil {
		return "", err
	}
	ctx, release, err := s.begin(ctx, defaultOperationTimeout)
	if err != nil {
		return "", err
	}
	defer release()
	anchor, err := openLocalRoot(ctx, root)
	if err != nil {
		return "", err
	}
	defer anchor.Close()
	file, canonical, err := anchor.walk(ctx, rel, anyPath, nil)
	if err != nil {
		return "", err
	}
	defer file.Close()
	return canonical, ctx.Err()
}

func (s *Local) List(ctx context.Context, target, root, rel string) ([]Entry, error) {
	f, rel, err := s.open(ctx, target, root, rel, true, nil)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return s.entries(f, rel, false)
}

// Read directory metadata in bounded batches using the open descriptor.
// Go's File.Readdir stats entries relative to that descriptor, including across renames.
func (s *Local) entries(f *localFile, base string, foldersOnly bool) ([]Entry, error) {
	entries := []Entry{}
	count, bytes := 0, 0
	for {
		if err := f.ctx.Err(); err != nil {
			return nil, err
		}
		infos, err := f.file.Readdir(128)
		if err != nil && err != io.EOF {
			return nil, err
		}
		for _, info := range infos {
			if err := f.ctx.Err(); err != nil {
				return nil, err
			}
			count++
			name := info.Name()
			bytes += len(name)
			if count > s.maxEntries || bytes > maxDirectoryBytes {
				return nil, ErrTooLarge
			}
			if !validEntryName(name) {
				return nil, ErrForbidden
			}
			full := path.Join(base, name)
			symlink := info.Mode()&fs.ModeSymlink != 0
			var resolvedPath *string
			if foldersOnly && symlink {
				// Setup explicitly permits following directory symlinks.
				resolved, statErr := os.Stat(full)
				if statErr != nil {
					continue
				}
				info = resolved
			} else if symlink && f.root != nil {
				// Resolve from the same project anchor without acquiring another
				// connection slot; unavailable links remain non-openable entries.
				link := path.Join(f.resolved, name)
				resolved, canonical, resolveErr := f.root.walk(f.ctx, link, anyPath, nil)
				if resolveErr == nil {
					if targetInfo, err := resolved.Stat(); err == nil {
						info = targetInfo
						resolvedPath = &canonical
					}
					resolved.Close()
				}
			} else if !foldersOnly && !symlink && f.resolved != base {
				canonical := path.Join(f.resolved, name)
				resolvedPath = &canonical
			}
			if foldersOnly && !info.IsDir() {
				continue
			}
			entries = append(entries, Entry{Name: name, Path: full, Type: entryType(info.Mode()),
				Size: info.Size(), Modified: info.ModTime(), Symlink: symlink, ResolvedPath: resolvedPath})
		}
		if err == io.EOF {
			break
		}
		if len(infos) == 0 {
			break
		}
	}
	if err := f.ctx.Err(); err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, nil
}

func validEntryName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, `/\`) && validPathText(name)
}

func (s *Local) BrowseFolders(ctx context.Context, target, directory string) (FolderListing, error) {
	if target != "" {
		return FolderListing{}, ErrForbidden
	}
	if directory != "" {
		if _, err := validateRoot(directory); err != nil {
			return FolderListing{}, err
		}
	}
	ctx, release, err := s.begin(ctx, defaultOperationTimeout)
	if err != nil {
		return FolderListing{}, err
	}
	keep := false
	defer func() {
		if !keep {
			release()
		}
	}()
	home, err := os.UserHomeDir()
	if err != nil {
		return FolderListing{}, err
	}
	home, err = filepath.EvalSymlinks(home)
	if err != nil {
		return FolderListing{}, err
	}
	if _, err := validateRoot(home); err != nil {
		return FolderListing{}, err
	}
	if directory == "" {
		directory = home
	}
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		return FolderListing{}, err
	}
	if _, err := validateRoot(directory); err != nil {
		return FolderListing{}, err
	}
	file, err := openLocalPath(ctx, directory, "", true)
	if err != nil {
		return FolderListing{}, err
	}
	keep = true // retain owns file and release, even when registration fails.
	f, err := s.retain(ctx, release, file, nil, "")
	if err != nil {
		return FolderListing{}, err
	}
	defer f.Close()
	entries, err := s.entries(f, directory, true)
	return folderListing(directory, home, entries), err
}

type localFile struct {
	file     *os.File
	root     *localRoot
	resolved string
	ctx      context.Context
	release  func()
	store    *Local
	once     sync.Once
}

func (f *localFile) ResolvedPath() string { return f.resolved }

func (f *localFile) Read(p []byte) (int, error) {
	if err := f.ctx.Err(); err != nil {
		return 0, err
	}
	return f.file.Read(p)
}

func (f *localFile) Seek(offset int64, whence int) (int64, error) {
	if err := f.ctx.Err(); err != nil {
		return 0, err
	}
	return f.file.Seek(offset, whence)
}

func (f *localFile) Stat() (fs.FileInfo, error) {
	if err := f.ctx.Err(); err != nil {
		return nil, err
	}
	return f.file.Stat()
}

func (f *localFile) Close() error {
	f.once.Do(func() {
		_ = f.file.Close()
		if f.root != nil {
			_ = f.root.Close()
		}
		f.store.mu.Lock()
		delete(f.store.active, f)
		f.store.mu.Unlock()
		f.release()
	})
	return nil
}

func localError(err error) error {
	if errors.Is(err, fs.ErrPermission) {
		return ErrForbidden
	}
	return err
}
