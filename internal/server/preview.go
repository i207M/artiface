package server

import (
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"artiface/internal/config"
	"artiface/internal/storage"
)

const maxPreviewAssetBytes = 100 << 20

type preview struct {
	project      config.ProjectRef
	sessionID    string
	target       string
	root         string
	directory    string
	expires      time.Time
	scripts      bool
	main         string
	size         int64
	version      string
	projectLabel string
	revision     string
	canAllow     bool
	inspection   *previewScriptCheck
}

func (a *App) createPreview(w http.ResponseWriter, r *http.Request) {
	var body location
	if !decode(w, r, &body) {
		return
	}
	a.hostsMu.RLock()
	version := a.hostVersion
	a.hostsMu.RUnlock()
	host, root, rel, ok := a.resolve(w, r, body)
	if !ok {
		return
	}
	if rel == "" || rel == "." {
		fail(w, http.StatusBadRequest, "Select a file to preview")
		return
	}
	if _, ok := a.store.(storage.ScopedStore); !ok {
		fail(w, http.StatusNotImplemented, "Storage backend cannot isolate preview files")
		return
	}
	f, err := a.store.Open(r.Context(), host.Target, root.Path, rel)
	if err != nil {
		storageError(w, err)
		return
	}
	if resolved, ok := f.(storage.ResolvedFile); ok {
		rel, err = storage.ValidateRelative(resolved.ResolvedPath())
	}
	if err != nil {
		_ = f.Close()
		storageError(w, err)
		return
	}
	info, err := f.Stat()
	_ = f.Close()
	if err != nil {
		storageError(w, err)
		return
	}
	id, s, ok := a.current(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	expires := time.Now().Add(15 * time.Minute)
	if s.expires.Before(expires) {
		expires = s.expires
	}
	p := preview{project: config.ProjectRef{Host: host.ID, Root: root.ID}, sessionID: id, target: host.Target, root: root.Path, directory: path.Dir(rel), expires: expires, scripts: root.TrustedScripts}
	p.main, p.size, p.version = rel, info.Size(), fileVersion(info, root.TrustedScripts)
	if !p.scripts && p.size >= 0 && p.size <= maxPreviewAssetBytes && previewHTML(rel) {
		p.projectLabel = root.Label
		if p.projectLabel == "" {
			p.projectLabel = root.ID
		}
		machine := host.Label
		if machine == "" {
			machine = host.ID
		}
		p.projectLabel += " · " + machine
		p.revision = projectTrustRevision(host, root)
		p.canAllow = a.configFile != "" && s.userID == ""
		p.inspection = &previewScriptCheck{status: "pending"}
	}
	token := randomToken()
	// Keep authorization stable from the version check through registration.
	// Like adoptSources, acquire hostsMu before the session/capability mutex.
	a.hostsMu.RLock()
	if version != a.hostVersion {
		a.hostsMu.RUnlock()
		fail(w, http.StatusConflict, "Projects changed; reopen the preview")
		return
	}
	a.mu.Lock()
	a.pruneLocked(time.Now())
	active, exists := a.sessions[id]
	if !exists || !a.sessionValid(active) {
		a.mu.Unlock()
		a.hostsMu.RUnlock()
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	if len(a.previews) >= maxPreviews {
		// Evict the oldest capability, keeping memory bounded during long sessions.
		var oldestToken string
		var oldest time.Time
		for key, cap := range a.previews {
			if oldestToken == "" || cap.expires.Before(oldest) {
				oldestToken, oldest = key, cap.expires
			}
		}
		delete(a.previews, oldestToken)
	}
	a.previews[token] = p
	a.mu.Unlock()
	a.hostsMu.RUnlock()
	response := map[string]any{
		"url":       a.previewOrigin + "/p/" + token + "/" + url.PathEscape(path.Base(rel)),
		"expiresAt": expires,
		"scripts":   root.TrustedScripts,
		"bridge":    previewHTML(rel) && p.size >= 0 && p.size <= maxPreviewAssetBytes,
		"path":      rel,
		"version":   p.version,
	}
	if p.inspection != nil {
		response["scriptCheck"] = token
	}
	respond(w, http.StatusOK, response)
}

func (a *App) PreviewHandler() http.Handler {
	// Deliberately avoid ServeMux path-cleaning redirects, which could cross a
	// capability's directory boundary before our validation runs.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-DNS-Prefetch-Control", "off")
		w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
		if r.Host != a.previewHost || r.URL.IsAbs() {
			fail(w, http.StatusMisdirectedRequest, "Invalid preview host")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "null" && origin != a.origin && origin != a.previewOrigin {
			fail(w, http.StatusForbidden, "Origin not allowed")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			fail(w, http.StatusMethodNotAllowed, "Previews are read-only")
			return
		}
		if r.URL.Path == "/p/healthz" || r.URL.Path == "/healthz" {
			w.Header().Set("Access-Control-Allow-Origin", a.origin)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Header.Get("Sec-Fetch-Dest") == "document" {
			fail(w, http.StatusForbidden, "Open this preview inside Artiface")
			return
		}
		parts := strings.SplitN(r.URL.Path, "/", 4)
		if len(parts) != 4 || parts[1] != "p" || len(parts[2]) != 43 {
			fail(w, http.StatusNotFound, "Preview not found")
			return
		}
		asset, err := storage.ValidateRelative(parts[3])
		if err != nil || asset == "" || asset == "." {
			fail(w, http.StatusForbidden, "This asset is outside the preview directory")
			return
		}
		now := time.Now()
		a.hostsMu.RLock()
		a.mu.Lock()
		p, exists := a.previews[parts[2]]
		s, active := a.sessions[p.sessionID]
		valid := exists && active && now.Before(p.expires) && now.Before(s.expires) && a.sessionValid(s) &&
			(s.userID == "" || a.cfg.UserCanRead(s.userID, p.project))
		if !valid {
			delete(a.previews, parts[2])
		}
		a.mu.Unlock()
		a.hostsMu.RUnlock()
		if !valid {
			fail(w, http.StatusUnauthorized, "Preview expired; reopen the file in Artiface")
			return
		}
		// Only the complete main HTML representation has a navigation bridge.
		// HEAD, Range and sibling assets keep their original ServeContent behavior.
		var htmlResponse *previewHTMLResponse
		if asset == path.Base(p.main) && previewHTML(asset) && r.Method == http.MethodGet && r.Header.Get("Range") == "" {
			htmlResponse = &previewHTMLResponse{ResponseWriter: w, token: parts[2], origin: a.origin, scripts: p.scripts}
			w = htmlResponse
		}
		var inspection *previewScriptResponse
		if p.inspection != nil && asset == path.Base(p.main) && r.Method == http.MethodGet {
			inspection = &previewScriptResponse{ResponseWriter: w, check: p.inspection, attempt: p.inspection.begin(), size: p.size}
			defer inspection.finish()
			w = inspection
		}
		// The opaque sandbox origin needs CORS for local fetch()/module assets.
		// Possession of this short-lived, directory-scoped capability is the only
		// preview credential; application cookies are never accepted here.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		previewFiles := a.previewOrigin + "/p/"
		scriptPolicy, sandbox := "'none'", "sandbox"
		if p.scripts {
			// Sandboxing protects the app origin, but does not contain every
			// browser egress channel (for example WebRTC).
			// Active scripts therefore require explicit trust from the user.
			scriptPolicy, sandbox = "'unsafe-inline' "+previewFiles, "sandbox allow-scripts"
		}
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; script-src "+scriptPolicy+
				"; style-src 'unsafe-inline' "+previewFiles+
				"; img-src data: blob: "+previewFiles+
				"; font-src data: "+previewFiles+
				"; connect-src "+previewFiles+
				"; media-src data: blob: "+previewFiles+
				"; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; "+
				"frame-ancestors "+a.origin+"; "+sandbox)
		scoped, ok := a.store.(storage.ScopedStore)
		if !ok {
			fail(w, http.StatusNotImplemented, "Storage backend cannot isolate preview files")
			return
		}
		download, request, finish, err := newDownload(w, r)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Could not prepare preview")
			return
		}
		defer finish()
		if inspection != nil {
			inspection.download = download
		}
		w, r = download, request
		f, err := scoped.OpenScoped(r.Context(), p.target, p.root, p.directory, asset)
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
		if info.Size() < 0 || info.Size() > maxPreviewAssetBytes {
			fail(w, http.StatusRequestEntityTooLarge, "Preview assets are limited to 100 MiB; download this file instead")
			return
		}
		contentType := mime.TypeByExtension(strings.ToLower(path.Ext(asset)))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		if inspection != nil {
			inspection.scan = r.Header.Get("Range") == "" && info.Size() == p.size && fileVersion(info, p.scripts) == p.version
			if resolved, ok := f.(storage.ResolvedFile); ok && resolved.ResolvedPath() != p.main {
				inspection.scan = false
			}
		}
		http.ServeContent(w, r, path.Base(asset), info.ModTime(), boundedContent(f, info.Size()))
		if htmlResponse != nil {
			htmlResponse.finish()
		}
	})
}
