package server

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"sync"
	"time"

	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

type gitSource struct{ target, root string }

const gitDiffSizeMessage = "Diff previews support file versions up to 8 MiB. Open the file normally to view or download it."

type gitStatusResponse struct {
	State     string              `json:"state"`
	Branch    string              `json:"branch,omitempty"`
	Changes   []storage.GitChange `json:"changes,omitempty"`
	Message   string              `json:"message,omitempty"`
	CheckedAt time.Time           `json:"checkedAt"`
	RetryAt   time.Time           `json:"retryAt"`
}
type gitCall struct {
	done chan struct{}
	data gitStatusResponse
	err  error
}
type gitService struct {
	mu          sync.Mutex
	cache       map[gitSource]gitStatusResponse
	pending     map[gitSource]*gitCall
	slots       chan struct{}
	ctx         context.Context
	cancel      context.CancelFunc
	now         func() time.Time
	read        func(context.Context, string, string) (storage.GitStatus, error)
	readDiff    func(context.Context, string, string, string) (string, bool, error)
	readHistory func(context.Context, string, string, int) (storage.GitHistory, error)
}

func newGitService() *gitService {
	ctx, cancel := context.WithCancel(context.Background())
	return &gitService{cache: make(map[gitSource]gitStatusResponse), pending: make(map[gitSource]*gitCall),
		slots: make(chan struct{}, 2), ctx: ctx, cancel: cancel, now: time.Now,
		read: storage.ReadGitStatus, readDiff: storage.ReadGitDiff, readHistory: storage.ReadGitHistory}
}

func (g *gitService) status(parent context.Context, source gitSource, force bool) (gitStatusResponse, error) {
	if err := parent.Err(); err != nil {
		return gitStatusResponse{}, err
	}
	if g.ctx.Err() != nil {
		return gitStatusResponse{}, context.Canceled
	}
	g.mu.Lock()
	now := g.now()
	cached, exists := g.cache[source]
	if exists && now.Before(cached.RetryAt) && (!force || now.Sub(cached.CheckedAt) < 5*time.Second) {
		g.mu.Unlock()
		return cached, nil
	}
	if pending := g.pending[source]; pending != nil {
		g.mu.Unlock()
		select {
		case <-pending.done:
			return pending.data, pending.err
		case <-parent.Done():
			return gitStatusResponse{}, parent.Err()
		}
	}
	call := &gitCall{done: make(chan struct{})}
	g.pending[source] = call
	g.mu.Unlock()
	ctx, cancel := context.WithTimeout(parent, storage.GitTimeout)
	stop := context.AfterFunc(g.ctx, cancel)
	defer func() { stop(); cancel() }()
	result := gitStatusResponse{CheckedAt: now, RetryAt: now.Add(30 * time.Second)}
	var err error
	select {
	case g.slots <- struct{}{}:
		status, readErr := g.read(ctx, source.target, source.root)
		<-g.slots
		if parent.Err() != nil || g.ctx.Err() != nil {
			err = context.Canceled
		} else {
			var hostKey *sshvault.HostKeyError
			switch {
			case readErr == nil:
				result.State, result.Branch, result.Changes = "ready", status.Branch, status.Changes
			case errors.As(readErr, &hostKey), errors.Is(readErr, sshvault.ErrHostKeyExpired):
				err = readErr
			case errors.Is(readErr, storage.ErrGitNotRepo):
				result.State = "none"
				result.RetryAt = now.Add(time.Minute)
			case errors.Is(readErr, storage.ErrGitLimit), errors.Is(readErr, context.DeadlineExceeded):
				result.State = "paused"
				result.Message = "Git checks paused: this project exceeded the time or size limit."
				result.RetryAt = now.Add(10 * time.Minute)
			case errors.Is(readErr, storage.ErrGitFilters):
				result.State = "unavailable"
				result.Message = "Git previews are unavailable for repositories with custom filters or partial-clone fetching."
				result.RetryAt = now.Add(time.Minute)
			case errors.Is(readErr, sshvault.ErrLocked), errors.Is(readErr, sshvault.ErrMissing):
				result.State, result.Message = "unavailable", "SSH credentials must be saved and unlocked by an administrator."
			case errors.Is(readErr, sshvault.ErrDisabled):
				result.State, result.Message = "unavailable", sshvault.ErrDisabled.Error()
			default:
				result.State = "unavailable"
				result.Message = "Could not check Git. Git must be installed on this machine; SSH sources also need the timeout command."
				result.RetryAt = now.Add(time.Minute)
			}
		}
	default:
		result.State, result.Message = "busy", "Other Git checks are running. Browsing is still available."
		result.RetryAt = now.Add(5 * time.Second)
	}
	g.mu.Lock()
	if err == nil {
		_, retained := g.cache[source]
		if len(g.cache) >= 32 && !retained {
			var oldest gitSource
			var timestamp time.Time
			for key, entry := range g.cache {
				if timestamp.IsZero() || entry.CheckedAt.Before(timestamp) {
					oldest, timestamp = key, entry.CheckedAt
				}
			}
			delete(g.cache, oldest)
		}
		g.cache[source] = result
	}
	call.data, call.err = result, err
	delete(g.pending, source)
	close(call.done)
	g.mu.Unlock()
	return result, err
}

func (a *App) gitStatus(w http.ResponseWriter, r *http.Request) {
	loc := queryLocation(r)
	loc.Path = ""
	host, root, _, ok := a.resolve(w, r, loc)
	if !ok {
		return
	}
	source := gitSource{host.Target, root.Path}
	result, err := a.git.status(r.Context(), source, r.URL.Query().Get("refresh") == "1")
	if err != nil {
		if r.Context().Err() == nil {
			var hostKey *sshvault.HostKeyError
			if errors.As(err, &hostKey) || errors.Is(err, sshvault.ErrHostKeyExpired) {
				storageError(w, err)
			} else {
				fail(w, http.StatusServiceUnavailable, "The Git check was interrupted. Try again.")
			}
		}
		return
	}
	if !a.sameGitSource(w, r, loc, source) {
		return
	}
	respond(w, http.StatusOK, result)
}

func (a *App) sameGitSource(w http.ResponseWriter, r *http.Request, loc location, source gitSource) bool {
	host, root, _, ok := a.resolve(w, r, loc)
	if ok && source != (gitSource{host.Target, root.Path}) {
		fail(w, http.StatusConflict, "This project's source changed. Reload and try again.")
		return false
	}
	return ok
}

// Deleted paths still need an existing, contained ancestor. Resolve refuses
// escaping or broken symlinks instead of treating them as missing directories.
func (a *App) verifyGitPath(ctx context.Context, source gitSource, rel string) error {
	f, err := a.store.Open(ctx, source.target, source.root, rel)
	if err == nil {
		info, statErr := f.Stat()
		closeErr := f.Close()
		if statErr != nil {
			return statErr
		}
		if closeErr != nil {
			return closeErr
		}
		if !info.Mode().IsRegular() {
			return storage.ErrForbidden
		}
		if info.Size() > storage.MaxGitDiffFile {
			return storage.ErrGitFileSize
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	resolver, ok := a.store.(storage.Resolver)
	if !ok {
		return storage.ErrUnsupported
	}
	for directory := path.Dir(rel); ; directory = path.Dir(directory) {
		if directory == "." {
			directory = ""
		}
		_, err := resolver.Resolve(ctx, source.target, source.root, directory)
		if err == nil || !errors.Is(err, fs.ErrNotExist) || directory == "" {
			return err
		}
	}
}

func (a *App) gitDiff(w http.ResponseWriter, r *http.Request) {
	loc := queryLocation(r)
	host, root, rel, ok := a.resolve(w, r, loc)
	if !ok {
		return
	}
	if rel == "" {
		fail(w, http.StatusBadRequest, "Choose a file to compare")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), storage.GitTimeout)
	stop := context.AfterFunc(a.git.ctx, cancel)
	defer func() { stop(); cancel() }()
	select {
	case a.git.slots <- struct{}{}:
		defer func() { <-a.git.slots }()
	default:
		fail(w, http.StatusServiceUnavailable, "Other Git checks are running. Try this diff again shortly.")
		return
	}
	source := gitSource{host.Target, root.Path}
	if err := a.verifyGitPath(ctx, source, rel); err != nil {
		if errors.Is(err, storage.ErrGitFileSize) {
			fail(w, http.StatusRequestEntityTooLarge, gitDiffSizeMessage)
		} else {
			storageError(w, err)
		}
		return
	}
	patch, truncated, err := a.git.readDiff(ctx, host.Target, root.Path, rel)
	if !a.sameGitSource(w, r, loc, source) {
		return
	}
	if err != nil {
		var hostKey *sshvault.HostKeyError
		if errors.As(err, &hostKey) || errors.Is(err, sshvault.ErrHostKeyExpired) {
			storageError(w, err)
			return
		}
		if errors.Is(err, storage.ErrGitFileSize) {
			fail(w, http.StatusRequestEntityTooLarge, gitDiffSizeMessage)
			return
		}
		message := "Could not read this diff. Check that Git is available on this machine."
		if errors.Is(err, storage.ErrGitLimit) || errors.Is(err, context.DeadlineExceeded) {
			message = "This diff took too long to load. Browsing is still available."
		} else if errors.Is(err, storage.ErrGitFilters) {
			message = "Diffs requiring custom filters or partial-clone fetching are unavailable."
		}
		fail(w, http.StatusUnprocessableEntity, message)
		return
	}
	respond(w, http.StatusOK, map[string]any{"patch": patch, "truncated": truncated})
}
