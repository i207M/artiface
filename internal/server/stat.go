package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"path"

	"artiface/internal/storage"
)

type fileStat struct {
	storage.Entry
	Version        string `json:"version"`
	TrustedScripts bool   `json:"trustedScripts"`
}

func fileVersion(info fs.FileInfo, trustedScripts bool) string {
	modified := info.ModTime().UTC()
	// This is a metadata change token, not a digest of the file's contents.
	digest := sha256.Sum256(fmt.Appendf(nil, "%d:%d:%d:%d:%t",
		info.Size(), modified.Unix(), modified.Nanosecond(), uint32(info.Mode()), trustedScripts))
	return hex.EncodeToString(digest[:])
}

// stat only inspects metadata on a scoped file handle.
// Close before responding so polling never retains a file or exclusive SSH lease.
func (a *App) stat(w http.ResponseWriter, r *http.Request) {
	host, root, rel, ok := a.resolve(w, r, queryLocation(r))
	if !ok {
		return
	}
	f, err := a.store.Open(r.Context(), host.Target, root.Path, rel)
	if err != nil {
		storageError(w, err)
		return
	}
	info, statErr := f.Stat()
	closeErr := f.Close()
	if statErr != nil {
		storageError(w, statErr)
		return
	}
	if closeErr != nil {
		storageError(w, closeErr)
		return
	}
	if !info.Mode().IsRegular() {
		storageError(w, storage.ErrForbidden)
		return
	}
	modified := info.ModTime().UTC()
	respond(w, http.StatusOK, fileStat{
		Entry: storage.Entry{
			Name: path.Base(rel), Path: rel, Type: "file",
			Size: info.Size(), Modified: modified,
		},
		Version:        fileVersion(info, root.TrustedScripts),
		TrustedScripts: root.TrustedScripts,
	})
}
