// Package server serves the authenticated app and sandboxed report routes.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"artiface/internal/config"
	"artiface/internal/pdfpreview"
	"artiface/internal/sshvault"
	"artiface/internal/storage"
)

const (
	cookieName   = "artiface_session"
	maxTextBytes = 1 << 20
	maxSessions  = 16
	maxPreviews  = 256
)

type App struct {
	cfg            config.Config
	hostsMu        sync.RWMutex // protects source config and hostVersion; other settings are immutable
	setupMu        sync.Mutex   // serializes persistence and publication
	configFile     string
	hostVersion    uint64
	store          storage.Store
	assets         fs.FS
	origin         string
	appHost        string
	previewOrigin  string
	previewHost    string
	mu             sync.Mutex
	passwordHash   string // Current authentication hash; protected by mu.
	sessions       map[string]session
	previews       map[string]preview
	loginBusy      chan struct{}
	failures       int
	resetAt        time.Time
	pdfCache       *pdfpreview.Cache
	git            *gitService
	sshCredentials *sshvault.Runtime
}

type Option func(*App)

func WithSSHCredentials(runtime *sshvault.Runtime) Option {
	return func(a *App) {
		a.sshCredentials = runtime
		reader := storage.GitReader{Remote: runtime.Run}
		a.git.read, a.git.readDiff, a.git.readHistory = reader.Status, reader.Diff, reader.History
	}
}

// WithConfigFile enables authenticated project and settings management.
func WithConfigFile(filename string) Option {
	return func(a *App) { a.configFile = filename }
}

func New(cfg config.Config, store storage.Store, assets fs.FS, options ...Option) (*App, error) {
	if err := config.Validate(cfg); err != nil {
		return nil, err
	}
	if store == nil || assets == nil {
		return nil, errors.New("storage and frontend assets are required")
	}
	origin, previewOrigin := cfg.Origins()
	appURL, _ := url.Parse(origin)
	previewURL, _ := url.Parse(previewOrigin)
	cfg.Hosts = append([]config.Host{}, cfg.Hosts...)
	cfg.OpenProjects = slices.Clone(cfg.OpenProjects)
	cfg.Users = slices.Clone(cfg.Users)
	for i := range cfg.Users {
		cfg.Users[i].Projects = slices.Clone(cfg.Users[i].Projects)
		cfg.Users[i].OpenProjects = slices.Clone(cfg.Users[i].OpenProjects)
	}
	for i := range cfg.Hosts {
		cfg.Hosts[i].Roots = append([]config.Root{}, cfg.Hosts[i].Roots...)
	}
	app := &App{
		cfg: cfg, store: store, assets: assets,
		origin: origin, appHost: appURL.Host, previewHost: previewURL.Host,
		previewOrigin: previewOrigin, passwordHash: cfg.PasswordHash,
		sessions: make(map[string]session), previews: make(map[string]preview),
		loginBusy:      make(chan struct{}, 1),
		pdfCache:       pdfpreview.New(),
		git:            newGitService(),
		sshCredentials: sshvault.NewRuntime(cfg.SSHCredentials, false),
	}
	for _, option := range options {
		option(app)
	}
	return app, nil
}

func (a *App) Close() {
	a.mu.Lock()
	clear(a.sessions)
	clear(a.previews)
	a.mu.Unlock()
	a.pdfCache.Close()
	a.git.cancel()
	a.sshCredentials.Close()
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/session", a.sessionStatus)
	mux.HandleFunc("POST /api/login", a.login)
	mux.Handle("POST /api/logout", a.auth(http.HandlerFunc(a.logout)))
	mux.Handle("POST /api/password", a.manage(a.changePassword))
	mux.Handle("GET /api/hosts", a.auth(http.HandlerFunc(a.hosts)))
	mux.Handle("POST /api/projects", a.manage(a.addProject))
	mux.Handle("POST /api/projects/trust", a.manage(a.allowProjectScripts))
	mux.Handle("GET /api/workspace/projects", a.auth(http.HandlerFunc(a.getSharedProjects)))
	mux.Handle("POST /api/workspace/projects", a.auth(http.HandlerFunc(a.updateSharedProjects)))
	mux.Handle("POST /api/folders", a.manage(a.folders))
	mux.Handle("GET /api/settings", a.auth(http.HandlerFunc(a.settings)))
	mux.Handle("POST /api/settings", a.manage(a.saveSettings))
	mux.Handle("POST /api/ssh/host-key", a.manage(a.sshHostKey))
	mux.Handle("POST /api/ssh/host-key/accept", a.manage(a.acceptSSHHostKey))
	mux.Handle("POST /api/ssh/hosts", a.manage(a.addSSHHost))
	mux.Handle("GET /api/ignore", a.manage(a.getIgnore))
	mux.Handle("POST /api/ignore", a.manage(a.saveIgnore))
	mux.Handle("GET /api/list", a.auth(http.HandlerFunc(a.list)))
	mux.Handle("GET /api/git/status", a.auth(http.HandlerFunc(a.gitStatus)))
	mux.Handle("GET /api/git/diff", a.auth(http.HandlerFunc(a.gitDiff)))
	mux.Handle("GET /api/git/history", a.auth(http.HandlerFunc(a.gitHistory)))
	mux.Handle("GET /api/file-info", a.auth(http.HandlerFunc(a.stat)))
	mux.Handle("GET /api/text", a.auth(http.HandlerFunc(a.text)))
	mux.Handle("GET /api/file", a.auth(http.HandlerFunc(a.file)))
	mux.Handle("POST /api/preview", a.auth(http.HandlerFunc(a.createPreview)))
	mux.Handle("POST /api/preview/scripts", a.auth(http.HandlerFunc(a.previewScripts)))
	mux.Handle("POST /api/pdf/info", a.auth(http.HandlerFunc(a.compressedPDFInfo)))
	mux.Handle("GET /api/pdf/page", a.auth(http.HandlerFunc(a.compressedPDFPage)))
	mux.Handle("GET /api/pdf/outline", a.auth(http.HandlerFunc(a.compressedPDFOutline)))
	mux.HandleFunc("GET /api/admin/session", a.sessionStatus)
	mux.HandleFunc("POST /api/admin/login", a.login)
	for pattern, handler := range map[string]http.HandlerFunc{
		"POST /api/admin/logout":              a.logout,
		"POST /api/admin/password":            a.changePassword,
		"GET /api/admin/access":               a.getAccess,
		"POST /api/admin/access":              a.saveAccess,
		"GET /api/admin/hosts":                a.hosts,
		"POST /api/admin/projects":            a.addProject,
		"POST /api/admin/projects/trust":      a.allowProjectScripts,
		"POST /api/admin/folders":             a.folders,
		"GET /api/admin/settings":             a.settings,
		"POST /api/admin/settings":            a.saveSettings,
		"POST /api/admin/ssh/host-key":        a.sshHostKey,
		"POST /api/admin/ssh/host-key/accept": a.acceptSSHHostKey,
		"POST /api/admin/ssh/hosts":           a.addSSHHost,
		"GET /api/admin/ignore":               a.getIgnore,
		"POST /api/admin/ignore":              a.saveIgnore,
	} {
		mux.Handle(pattern, a.manage(handler))
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, "API endpoint not found")
	})
	mux.HandleFunc("/", a.static)
	previews := a.PreviewHandler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == a.previewHost && (a.previewHost != a.appHost ||
			r.URL.Path == "/p" || strings.HasPrefix(r.URL.Path, "/p/") || r.URL.Path == "/healthz") {
			previews.ServeHTTP(w, r)
			return
		}
		a.appHeaders(w)
		if r.Host != a.appHost || r.URL.IsAbs() {
			fail(w, http.StatusMisdirectedRequest, "Use "+a.origin)
			return
		}
		// Avoid ServeMux redirects from approved script/worker paths into /p/.
		// CSP source paths are not checked again after a redirect.
		if path.Clean(r.URL.Path) != r.URL.Path && r.URL.Path != "/admin/" {
			http.NotFound(w, r)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != a.origin {
			fail(w, http.StatusForbidden, "Origin not allowed")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			site := r.Header.Get("Sec-Fetch-Site")
			if site != "" && site != "same-origin" && site != "none" {
				fail(w, http.StatusForbidden, "Cross-origin API requests are not allowed")
				return
			}
			if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Origin") != a.origin {
				fail(w, http.StatusForbidden, "A same-origin request is required")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *App) appHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("X-Frame-Options", "DENY")
	assets := a.origin + "/assets/"
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src "+assets+"; "+
		"style-src "+assets+" 'unsafe-inline'; img-src 'self' data: blob: "+a.previewOrigin+"; "+
		"font-src 'self' data:; connect-src 'self' "+a.previewOrigin+"; worker-src "+assets+" "+a.origin+"/sw.js blob:; "+
		"frame-src "+a.previewOrigin+"/p/; object-src 'none'; base-uri 'none'; "+
		"frame-ancestors 'none'; form-action 'self'")
}

func (a *App) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		fail(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" || name == "admin" || name == "admin/" {
		name = "index.html"
	}
	if !fs.ValidPath(name) || strings.HasPrefix(name, ".") || strings.Contains(name, "/.") {
		http.NotFound(w, r)
		return
	}
	f, err := a.assets.Open(name)
	if err != nil {
		if name == "index.html" {
			http.Error(w, "Frontend is not built. Run npm ci --prefix web && npm run build --prefix web, then rebuild Artiface.", http.StatusServiceUnavailable)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	reader, ok := f.(io.ReadSeeker)
	if !ok {
		http.Error(w, "Frontend asset cannot be served", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	w.Header().Set("Vary", "Accept-Encoding")
	// Ranges address the original bytes; private files never pass through here.
	if r.Header.Get("Range") == "" && acceptsGzip(r.Header.Get("Accept-Encoding")) {
		if compressed, err := a.assets.Open(name + ".gz"); err == nil {
			defer compressed.Close()
			if compressedInfo, err := compressed.Stat(); err == nil && !compressedInfo.IsDir() {
				if compressedReader, ok := compressed.(io.ReadSeeker); ok {
					reader = compressedReader
					w.Header().Set("Content-Encoding", "gzip")
					w.Header().Set("Content-Length", strconv.FormatInt(compressedInfo.Size(), 10))
				}
			}
		}
	}
	http.ServeContent(w, r, name, info.ModTime(), reader)
}

func acceptsGzip(header string) bool {
	wildcard := false
	for _, item := range strings.Split(header, ",") {
		encoding, params, err := mime.ParseMediaType(strings.TrimSpace(item))
		if err != nil || encoding != "gzip" && encoding != "*" {
			continue
		}
		quality := 1.0
		if value, ok := params["q"]; ok {
			quality, err = strconv.ParseFloat(value, 64)
		}
		allowed := err == nil && quality > 0 && quality <= 1
		if encoding == "gzip" {
			return allowed
		}
		wildcard = allowed
	}
	return wildcard
}

func respond(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fail(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}

func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	return decodeLimit(w, r, out, 4096)
}

func decodeLimit(w http.ResponseWriter, r *http.Request, out any, limit int64) bool {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		fail(w, http.StatusUnsupportedMediaType, "Expected application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		fail(w, http.StatusBadRequest, "Invalid request body")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		fail(w, http.StatusBadRequest, "Expected one JSON object")
		return false
	}
	return true
}

func storageError(w http.ResponseWriter, err error) {
	var hostKey *sshvault.HostKeyError
	if errors.As(err, &hostKey) {
		respond(w, http.StatusConflict, map[string]any{
			"error":      hostKey.Error(),
			"sshHostKey": map[string]string{"token": hostKey.Token},
		})
		return
	}
	switch {
	case errors.Is(err, sshvault.ErrHostKeyExpired):
		fail(w, http.StatusConflict, err.Error())
	case errors.Is(err, sshvault.ErrDisabled):
		fail(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, sshvault.ErrLocked):
		fail(w, http.StatusLocked, "SSH credentials are locked. Ask the administrator to sign in at /admin/ to unlock SSH after this server restart.")
	case errors.Is(err, sshvault.ErrMissing):
		fail(w, http.StatusUnprocessableEntity, "SSH credentials are missing for this host. Add the host in Sources settings or use the command-line import guide there.")
	case errors.Is(err, storage.ErrForbidden), errors.Is(err, fs.ErrPermission):
		fail(w, http.StatusForbidden, "This path is not allowed")
	case errors.Is(err, storage.ErrTooLarge):
		fail(w, http.StatusRequestEntityTooLarge, "Directory is too large to browse; choose a smaller project root")
	case errors.Is(err, fs.ErrNotExist):
		fail(w, http.StatusNotFound, "File or directory not found")
	case errors.Is(err, storage.ErrUnsupported):
		fail(w, http.StatusNotImplemented, "Folder browsing is unavailable with this storage backend")
	default:
		fail(w, http.StatusBadGateway, fmt.Sprintf("File access failed: %s", err))
	}
}
