package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"time"

	"artiface/internal/config"
	"artiface/internal/pdfpreview"
	"artiface/internal/storage"
)

func pdfSourceKey(host config.Host, root config.Root, rel, version string) string {
	data, _ := json.Marshal([]string{host.Kind, host.Target, root.Path, rel, version})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func pdfError(w http.ResponseWriter, err error) {
	status, message := http.StatusUnprocessableEntity, pdfpreview.ErrInvalid.Error()
	switch {
	case errors.Is(err, pdfpreview.ErrUnavailable), errors.Is(err, pdfpreview.ErrOutlineUnavailable):
		status, message = http.StatusNotImplemented, err.Error()
	case errors.Is(err, pdfpreview.ErrTooLarge):
		status, message = http.StatusRequestEntityTooLarge, err.Error()
	case errors.Is(err, pdfpreview.ErrChanged), errors.Is(err, pdfpreview.ErrExpired):
		status, message = http.StatusConflict, err.Error()
	case errors.Is(err, pdfpreview.ErrBusy):
		status, message = http.StatusServiceUnavailable, err.Error()
		w.Header().Set("Retry-After", "2")
	case errors.Is(err, pdfpreview.ErrPage):
		status, message = http.StatusBadRequest, err.Error()
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled), errors.Is(err, pdfpreview.ErrSharedCanceled):
		status, message = http.StatusGatewayTimeout, "PDF compression took too long or was interrupted; retry or use Original mode"
	}
	fail(w, status, message)
}

// Recheck the session, project grant, and source identity after slow copies or
// rendering. Cached images never authorize access by themselves.
func (a *App) pdfStillAllowed(w http.ResponseWriter, r *http.Request, loc location, host config.Host, root config.Root, version uint64) bool {
	currentHost, currentRoot, _, ok := a.resolve(w, r, loc)
	if !ok {
		return false
	}
	a.hostsMu.RLock()
	unchanged := a.hostVersion == version
	a.hostsMu.RUnlock()
	if !unchanged || currentHost.Kind != host.Kind || currentHost.Target != host.Target || currentRoot != root {
		fail(w, http.StatusConflict, "Projects changed; refresh the PDF")
		return false
	}
	return true
}

func (a *App) compressedPDFInfo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		location
		Refresh bool `json:"refresh"`
	}
	if !decode(w, r, &body) {
		return
	}
	a.hostsMu.RLock()
	sourceVersion := a.hostVersion
	a.hostsMu.RUnlock()
	host, root, rel, ok := a.resolve(w, r, body.location)
	if !ok {
		return
	}
	if !a.pdfCache.Available() {
		pdfError(w, pdfpreview.ErrUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	for attempt := 0; attempt < 2; attempt++ {
		if attempt != 0 && !a.pdfStillAllowed(w, r, body.location, host, root, sourceVersion) {
			return
		}
		file, err := a.store.Open(ctx, host.Target, root.Path, rel)
		if err != nil {
			storageError(w, err)
			return
		}
		stat, err := file.Stat()
		if err != nil || !stat.Mode().IsRegular() {
			_ = file.Close()
			if err == nil {
				err = storage.ErrForbidden
			}
			storageError(w, err)
			return
		}
		version := fileVersion(stat, root.TrustedScripts)
		info, err := func() (pdfpreview.Info, error) {
			defer file.Close()
			return a.pdfCache.Document(ctx, pdfSourceKey(host, root, rel, version), file, stat, body.Refresh)
		}()
		// A canceled shared loader must not cancel a live request. Reopen and
		// revalidate once, within the same deadline and cache/auth boundaries.
		if attempt == 0 && errors.Is(err, pdfpreview.ErrSharedCanceled) && ctx.Err() == nil {
			continue
		}
		if err != nil {
			pdfError(w, err)
			return
		}
		if !a.pdfStillAllowed(w, r, body.location, host, root, sourceVersion) {
			return
		}
		respond(w, http.StatusOK, struct {
			pdfpreview.Info
			Version string `json:"version"`
			Size    int64  `json:"size"`
		}{info, version, stat.Size()})
		return
	}
}

func (a *App) compressedPDFPage(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	number, pageErr := strconv.Atoi(query.Get("page"))
	size, sizeErr := strconv.Atoi(query.Get("size"))
	id := query.Get("document")
	if pageErr != nil || sizeErr != nil || len(id) != 32 || number < 1 || number > 10000 || !pdfpreview.ValidSize(size) {
		pdfError(w, pdfpreview.ErrPage)
		return
	}
	loc := queryLocation(r)
	a.hostsMu.RLock()
	sourceVersion := a.hostVersion
	a.hostsMu.RUnlock()
	host, root, rel, ok := a.resolve(w, r, loc)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	file, err := a.store.Open(ctx, host.Target, root.Path, rel)
	if err != nil {
		storageError(w, err)
		return
	}
	stat, err := file.Stat()
	_ = file.Close()
	if err != nil || !stat.Mode().IsRegular() {
		if err == nil {
			err = fs.ErrPermission
		}
		storageError(w, err)
		return
	}
	version := fileVersion(stat, root.TrustedScripts)
	page, err := a.pdfCache.Page(ctx, pdfSourceKey(host, root, rel, version), id, number, size)
	if err != nil {
		pdfError(w, err)
		return
	}
	if !a.pdfStillAllowed(w, r, loc, host, root, sourceVersion) {
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-PDF-Width", strconv.FormatFloat(page.Width, 'f', 3, 64))
	w.Header().Set("X-PDF-Height", strconv.FormatFloat(page.Height, 'f', 3, 64))
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	http.ServeContent(w, r, "page.jpg", time.Time{}, bytes.NewReader(page.JPEG))
}

func (a *App) compressedPDFOutline(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("document")
	if len(id) != 32 {
		pdfError(w, pdfpreview.ErrExpired)
		return
	}
	loc := queryLocation(r)
	a.hostsMu.RLock()
	sourceVersion := a.hostVersion
	a.hostsMu.RUnlock()
	host, root, rel, ok := a.resolve(w, r, loc)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	file, err := a.store.Open(ctx, host.Target, root.Path, rel)
	if err != nil {
		storageError(w, err)
		return
	}
	stat, err := file.Stat()
	_ = file.Close()
	if err != nil || !stat.Mode().IsRegular() {
		if err == nil {
			err = fs.ErrPermission
		}
		storageError(w, err)
		return
	}
	version := fileVersion(stat, root.TrustedScripts)
	outline, err := a.pdfCache.Outline(ctx, pdfSourceKey(host, root, rel, version), id)
	if err != nil {
		pdfError(w, err)
		return
	}
	if !a.pdfStillAllowed(w, r, loc, host, root, sourceVersion) {
		return
	}
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	respond(w, http.StatusOK, outline)
}
