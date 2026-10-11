package server

import (
	"errors"
	"net/http"
	"os"

	"artiface/internal/ignore"
)

func ignoreReadError(err error) string {
	if errors.Is(err, ignore.ErrUnsafe) {
		return "Ignore rules could not be read safely. The configuration and ignore files must be regular files without links."
	}
	if errors.Is(err, os.ErrPermission) {
		return "Ignore rules could not be read. Check the server user's access to the configuration directory and .artifaceignore."
	}
	return "Ignore rules could not be loaded. Check .artifaceignore in Settings → Ignored files."
}

func (a *App) getIgnore(w http.ResponseWriter, r *http.Request) {
	doc, err := ignore.Load(a.configFile)
	if err != nil {
		fail(w, http.StatusInternalServerError, ignoreReadError(err))
		return
	}
	respond(w, http.StatusOK, doc)
}

func (a *App) saveIgnore(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content  *string `json:"content"`
		Revision string  `json:"revision"`
	}
	// JSON may encode every content byte as a six-byte Unicode escape.
	if !decodeLimit(w, r, &body, 6*ignore.MaxContentBytes+4096) {
		return
	}
	if body.Content == nil || len(body.Revision) != 64 {
		fail(w, http.StatusBadRequest, "Content and the current revision are required")
		return
	}
	if _, err := ignore.Compile(*body.Content); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	doc, err := ignore.Save(a.configFile, *body.Content, body.Revision)
	switch {
	case errors.Is(err, ignore.ErrDisabled):
		fail(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ignore.ErrConflict):
		fail(w, http.StatusConflict, err.Error())
	case err != nil:
		fail(w, http.StatusInternalServerError, "Could not safely save the ignore file")
	default:
		respond(w, http.StatusOK, doc)
	}
}
