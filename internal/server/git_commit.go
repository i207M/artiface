package server

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"

	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

func (a *App) gitCommit(w http.ResponseWriter, r *http.Request) {
	loc := queryLocation(r)
	loc.Path = ""
	host, root, _, ok := a.resolve(w, r, loc)
	if !ok {
		return
	}
	hash := r.URL.Query().Get("commit")
	decoded, err := hex.DecodeString(hash)
	if err != nil || (len(decoded) != 20 && len(decoded) != 32) {
		fail(w, http.StatusBadRequest, "Choose a valid commit ID")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), storage.GitTimeout)
	stop := context.AfterFunc(a.git.ctx, cancel)
	defer func() { stop(); cancel() }()
	select {
	case a.git.slots <- struct{}{}:
		defer func() { <-a.git.slots }()
	default:
		fail(w, http.StatusServiceUnavailable, "Other Git checks are running. Try this commit again shortly.")
		return
	}
	source := gitSource{host.Target, root.Path}
	commit, err := a.git.readCommit(ctx, host.Target, root.Path, hash)
	if !a.sameGitSource(w, r, loc, source) {
		return
	}
	if err != nil {
		var hostKey *sshvault.HostKeyError
		if errors.As(err, &hostKey) || errors.Is(err, sshvault.ErrHostKeyExpired) {
			storageError(w, err)
			return
		}
		if errors.Is(err, storage.ErrGitCommit) {
			fail(w, http.StatusNotFound, "This commit is no longer available in this project.")
			return
		}
		message := "Could not read this commit. Check that Git is available on this machine."
		if errors.Is(err, storage.ErrGitLimit) || errors.Is(err, context.DeadlineExceeded) {
			message = "This commit exceeded its time or size limit. Try again."
		} else if errors.Is(err, storage.ErrGitFilters) {
			message = "Commit previews are unavailable for repositories with custom filters or partial-clone fetching."
		}
		fail(w, http.StatusUnprocessableEntity, message)
		return
	}
	respond(w, http.StatusOK, commit)
}
