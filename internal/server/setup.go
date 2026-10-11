package server

import (
	"errors"
	"net/http"
	"path"
	"reflect"

	"artiface/internal/config"
)

type HostsResponse struct {
	Hosts        []config.Host `json:"hosts"`
	SetupEnabled bool          `json:"setupEnabled"`
	Revision     string        `json:"revision,omitempty"`
}

var errHostTarget = errors.New("host, target and kind must identify the selected source")

func (a *App) hostSnapshot() []config.Host {
	a.hostsMu.RLock()
	defer a.hostsMu.RUnlock()
	return a.cfg.Hosts // Published slices and their roots are never mutated.
}

func (a *App) hostResponse() HostsResponse {
	a.hostsMu.RLock()
	configured := a.cfg.Hosts
	hideLocal := a.cfg.HideLocalSource
	a.hostsMu.RUnlock()
	merged := append([]config.Host(nil), configured...)
	if a.configFile != "" && !hideLocal {
		merged = withLocalSource(merged)
	}
	response := HostsResponse{Hosts: []config.Host{}, SetupEnabled: a.configFile != ""}
	for _, host := range merged {
		if host.Kind == "local" && host.Label == "" {
			host.Label = "localhost"
		}
		if host.Roots == nil {
			host.Roots = []config.Root{}
		}
		response.Hosts = append(response.Hosts, host)
	}
	return response
}

func (a *App) hosts(w http.ResponseWriter, r *http.Request) {
	_, s, ok := a.current(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	if s.userID != "" {
		a.hostsMu.RLock()
		cfg := userConfig(a.cfg, s.userID)
		revision := configRevision(a.cfg)
		a.hostsMu.RUnlock()
		response := HostsResponse{Hosts: append([]config.Host{}, cfg.Hosts...), Revision: revision}
		respond(w, http.StatusOK, response)
		return
	}
	respond(w, http.StatusOK, a.hostResponse())
}

// Publish sources and users while preserving the startup mode and listener.
// Revoke capabilities on access changes, including previews being created now.
func (a *App) adoptSources(cfg config.Config) {
	a.hostsMu.Lock()
	defer a.hostsMu.Unlock()
	a.cfg.OpenProjects = cfg.OpenProjects
	a.cfg.SSHCredentials = cfg.SSHCredentials
	a.cfg.SSHCredentialsRevision = cfg.SSHCredentialsRevision
	accessChanged := accessRevision(a.cfg) != accessRevision(cfg)
	sourcesChanged := !reflect.DeepEqual(a.cfg.Hosts, cfg.Hosts) || a.cfg.HideLocalSource != cfg.HideLocalSource
	a.cfg.Users = cfg.Users
	if sourcesChanged || accessChanged {
		a.mu.Lock()
		a.cfg.Hosts = cfg.Hosts
		a.cfg.HideLocalSource = cfg.HideLocalSource
		a.hostVersion++
		// Revocation is permanent: re-enabling an account must not resurrect
		// cookies issued before it was disabled.
		for id, s := range a.sessions {
			if !a.sessionValid(s) {
				delete(a.sessions, id)
			}
		}
		for token, p := range a.previews {
			s, active := a.sessions[p.sessionID]
			if sourcesChanged || !active || (s.userID != "" && !a.cfg.UserCanRead(s.userID, p.project)) {
				delete(a.previews, token)
			}
		}
		a.mu.Unlock()
	}
}

func (a *App) setupAllowed(w http.ResponseWriter) bool {
	if a.configFile == "" {
		fail(w, http.StatusForbidden, "Project setup requires a configuration file")
		return false
	}
	return true
}

func setupError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, config.ErrConflict) {
		status = http.StatusConflict
	} else if errors.Is(err, errHostTarget) {
		status = http.StatusBadRequest
	}
	fail(w, status, err.Error())
}

func (a *App) addProject(w http.ResponseWriter, r *http.Request) {
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		sourceSelection
		Path  string `json:"path"`
		Label string `json:"label"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Label == "" {
		body.Label = path.Base(body.Path)
	}
	root := config.Root{ID: "project", Label: body.Label, Path: body.Path}
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	var selected config.Host
	cfg, err := config.Update(a.configFile, func(cfg *config.Config) error {
		var err error
		selected, err = selectSource(cfg.Hosts, body.sourceSelection)
		if err != nil {
			return err
		}
		candidate := selected
		candidate.Roots = []config.Root{root}
		if err := a.validateSource(candidate); err != nil {
			return err
		}
		persistSource(cfg, selected)
		for i := range cfg.Hosts {
			host := &cfg.Hosts[i]
			if host.ID != selected.ID {
				continue
			}
			used := map[string]bool{}
			for _, existing := range host.Roots {
				if existing.Path == body.Path {
					selected, root = *host, existing
					return nil
				}
				used[existing.ID] = true
			}
			root.ID = config.UniqueID("root", root.Path, used)
			host.Roots = append(host.Roots, root)
			selected = *host
			return nil
		}
		return errors.New("could not select project host")
	})
	if err != nil {
		setupError(w, err)
		return
	}
	a.adoptSources(cfg)
	respond(w, http.StatusOK, map[string]any{"host": selected, "root": root})
}
