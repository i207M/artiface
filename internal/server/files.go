package server

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"path"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"artiface/internal/config"
	"artiface/internal/ignore"
	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

type location struct {
	Host string `json:"host"`
	Root string `json:"root"`
	Path string `json:"path"`
}

func queryLocation(r *http.Request) location {
	q := r.URL.Query()
	return location{Host: q.Get("host"), Root: q.Get("root"), Path: q.Get("path")}
}

func (a *App) sshAvailable(w http.ResponseWriter, target string) bool {
	if target == "" {
		return true
	}
	if a.sshCredentials.Disabled() {
		storageError(w, sshvault.ErrDisabled)
		return false
	}
	if a.sshCredentials.Locked() {
		storageError(w, sshvault.ErrLocked)
		return false
	}
	return true
}

func (a *App) resolve(w http.ResponseWriter, r *http.Request, loc location) (config.Host, config.Root, string, bool) {
	_, s, authenticated := a.current(r)
	a.hostsMu.RLock()
	defer a.hostsMu.RUnlock()
	if !authenticated || !a.sessionValid(s) || (s.userID != "" && !a.cfg.UserCanRead(s.userID, config.ProjectRef{Host: loc.Host, Root: loc.Root})) {
		fail(w, http.StatusNotFound, "Unknown host or project")
		return config.Host{}, config.Root{}, "", false
	}
	rel, err := storage.ValidateRelative(loc.Path)
	if err != nil {
		fail(w, http.StatusForbidden, "This path is not allowed")
		return config.Host{}, config.Root{}, "", false
	}
	for _, host := range a.cfg.Hosts {
		if host.ID != loc.Host {
			continue
		}
		for _, root := range host.Roots {
			if root.ID == loc.Root {
				if !a.sshAvailable(w, host.Target) {
					return config.Host{}, config.Root{}, "", false
				}
				return host, root, rel, true
			}
		}
	}
	fail(w, http.StatusNotFound, "Unknown host or project")
	return config.Host{}, config.Root{}, "", false
}

func (a *App) list(w http.ResponseWriter, r *http.Request) {
	host, root, rel, ok := a.resolve(w, r, queryLocation(r))
	if !ok {
		return
	}
	doc, err := ignore.Load(a.configFile)
	ignoreWarning := ""
	if err != nil {
		doc.Content = ignore.DefaultContent
		ignoreWarning = "Using default ignore rules. " + ignoreReadError(err)
	}
	matcher, err := ignore.Compile(doc.Content)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Invalid ignore rules; edit the ignore file in Settings")
		return
	}
	budget := ignore.NewBudget()
	filter := func(rel string, directory bool) (bool, error) {
		return matcher.Ignored(rel, directory, budget)
	}
	if r.URL.Query().Get("recursive") == "1" {
		listing, err := storage.ListRecursive(r.Context(), a.store, host.Target, root.Path, rel,
			r.URL.Query().Get("showHidden") == "1", filter)
		if err != nil {
			storageError(w, err)
			return
		}
		sort.Slice(listing.Entries, func(i, j int) bool { return listing.Entries[i].Path < listing.Entries[j].Path })
		listing.Warning = strings.TrimSpace(ignoreWarning + " " + listing.Warning)
		respond(w, http.StatusOK, listing)
		return
	}
	entries, err := a.store.List(r.Context(), host.Target, root.Path, rel)
	if err != nil {
		storageError(w, err)
		return
	}
	listing := storage.Listing{Path: rel, Entries: []storage.Entry{}, Warning: ignoreWarning}
	for _, entry := range entries {
		ignored, err := filter(entry.Path, entry.Type == "directory")
		if err == nil && !ignored && entry.ResolvedPath != nil {
			ignored, err = filter(*entry.ResolvedPath, entry.Type == "directory")
		}
		if err != nil || r.Context().Err() != nil {
			listing.Truncated = true
			listing.Warning = strings.TrimSpace(listing.Warning + " Browse stopped at its ignore pattern matching limit or request cancellation.")
			break
		}
		if !ignored {
			listing.Entries = append(listing.Entries, entry)
		}
	}
	entries = listing.Entries
	sort.Slice(entries, func(i, j int) bool {
		if (entries[i].Type == "directory") != (entries[j].Type == "directory") {
			return entries[i].Type == "directory"
		}
		return entries[i].Name < entries[j].Name
	})
	respond(w, http.StatusOK, listing)
}

func (a *App) text(w http.ResponseWriter, r *http.Request) {
	host, root, rel, ok := a.resolve(w, r, queryLocation(r))
	if !ok {
		return
	}
	f, err := a.store.Open(r.Context(), host.Target, root.Path, rel)
	if err != nil {
		storageError(w, err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		storageError(w, err)
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, maxTextBytes+1))
	if err != nil {
		storageError(w, err)
		return
	}
	truncated := len(data) > maxTextBytes
	if truncated {
		data = data[:maxTextBytes]
		// A bounded text read can end in the middle of one UTF-8 character.
		for len(data) > maxTextBytes-utf8.UTFMax && len(data) > 0 && !utf8.Valid(data) {
			data = data[:len(data)-1]
		}
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		fail(w, http.StatusUnsupportedMediaType, "This file is binary or is not UTF-8; download it to open locally")
		return
	}
	respond(w, http.StatusOK, map[string]any{
		"text": string(data), "truncated": truncated, "size": info.Size(),
		"version": fileVersion(info, root.TrustedScripts),
	})
}

func (a *App) file(w http.ResponseWriter, r *http.Request) {
	host, root, rel, ok := a.resolve(w, r, queryLocation(r))
	if !ok {
		return
	}
	download, request, finish, err := newDownload(w, r)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Could not prepare download")
		return
	}
	defer finish()
	w, r = download, request
	f, err := a.store.Open(r.Context(), host.Target, root.Path, rel)
	if err != nil {
		storageError(w, err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		storageError(w, err)
		return
	}
	// Never interpret a remote HTML/SVG/source file as a document on the app origin.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(rel)}))
	http.ServeContent(w, r, path.Base(rel), info.ModTime(), boundedContent(f, info.Size()))
}

// Keep ServeContent's size calculation and reads tied to the validated Stat,
// even if an agent is appending to the remote file at the same time.
func boundedContent(f io.ReadSeeker, size int64) *io.SectionReader {
	return io.NewSectionReader(&seekerReaderAt{reader: f}, 0, size)
}

type seekerReaderAt struct {
	mu     sync.Mutex
	reader io.ReadSeeker
}

func (s *seekerReaderAt) ReadAt(p []byte, offset int64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.reader.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}
	n, err := io.ReadFull(s.reader, p)
	if err == io.ErrUnexpectedEOF {
		err = io.EOF
	}
	return n, err
}
