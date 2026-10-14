package server

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"

	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

func (a *App) gitHistory(w http.ResponseWriter, r *http.Request) {
	loc := queryLocation(r)
	loc.Path = ""
	host, root, _, ok := a.resolve(w, r, loc)
	if !ok {
		return
	}
	offset := 0
	if value := r.URL.Query().Get("offset"); value != "" {
		var err error
		offset, err = strconv.Atoi(value)
		if err != nil || offset < 0 || offset > 100000 {
			fail(w, http.StatusBadRequest, "Invalid history offset")
			return
		}
	}
	revision := r.URL.Query().Get("revision")
	if offset > 0 || revision != "" {
		decoded, err := hex.DecodeString(revision)
		if err != nil || len(decoded) != 32 {
			fail(w, http.StatusBadRequest, "Invalid history revision")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), storage.GitTimeout)
	stop := context.AfterFunc(a.git.ctx, cancel)
	defer func() { stop(); cancel() }()
	select {
	case a.git.slots <- struct{}{}:
		defer func() { <-a.git.slots }()
	default:
		fail(w, http.StatusServiceUnavailable, "Other Git checks are running. Try history again shortly.")
		return
	}
	source := gitSource{host.Target, root.Path}
	history, err := a.git.readHistory(ctx, host.Target, root.Path, offset)
	if !a.sameGitSource(w, r, loc, source) {
		return
	}
	if err != nil {
		var hostKey *sshvault.HostKeyError
		if errors.As(err, &hostKey) || errors.Is(err, sshvault.ErrHostKeyExpired) {
			storageError(w, err)
			return
		}
		message := "Could not read Git history. Check that Git is available on this machine."
		switch {
		case errors.Is(err, storage.ErrGitNotRepo):
			message = "This project is not in a Git repository."
		case errors.Is(err, storage.ErrGitLimit), errors.Is(err, context.DeadlineExceeded):
			message = "Git history exceeded its time or size limit. Try again."
		case errors.Is(err, storage.ErrGitFilters):
			message = "Git history is unavailable for repositories with custom filters or partial-clone fetching."
		}
		fail(w, http.StatusUnprocessableEntity, message)
		return
	}
	if revision != "" && history.Revision != revision {
		fail(w, http.StatusConflict, "Branches changed while loading history. Refresh history to continue.")
		return
	}
	respond(w, http.StatusOK, history)
}
