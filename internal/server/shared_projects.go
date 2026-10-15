package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"slices"

	"artiface/internal/config"
)

type sharedProjectsResponse struct {
	Projects        []config.ProjectRef `json:"projects"`
	SourcesRevision string              `json:"sourcesRevision"`
}

type projectMove struct {
	Project config.ProjectRef `json:"project"`
	Target  config.ProjectRef `json:"target"`
	Edge    string            `json:"edge"`
}

func sharedProjects(cfg config.Config) sharedProjectsResponse {
	cfg.PruneOpenProjects()
	return sharedProjectsResponse{Projects: cfg.OpenProjects, SourcesRevision: configRevision(cfg)}
}

func userSharedProjects(cfg config.Config, userID string) sharedProjectsResponse {
	if userID == "" {
		return sharedProjects(cfg)
	}
	response := sharedProjects(userConfig(cfg, userID))
	// Include source identity without disclosing connection targets or paths.
	// Moving an assigned root must invalidate a reader's cached document.
	revision := sha256.Sum256([]byte(configRevision(cfg) + response.SourcesRevision))
	response.SourcesRevision = hex.EncodeToString(revision[:])
	return response
}

func (a *App) getSharedProjects(w http.ResponseWriter, r *http.Request) {
	_, s, ok := a.current(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	a.hostsMu.RLock()
	cfg := a.cfg
	a.hostsMu.RUnlock()
	if a.configFile != "" {
		var err error
		cfg, err = config.Load(a.configFile)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Could not load shared projects")
			return
		}
	}
	respond(w, http.StatusOK, userSharedProjects(cfg, s.userID))
}

func (a *App) updateSharedProjects(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Open  []config.ProjectRef `json:"open"`
		Close []config.ProjectRef `json:"close"`
		Move  []projectMove       `json:"move"`
	}
	if !decodeLimit(w, r, &body, 128<<10) {
		return
	}
	if len(body.Open)+len(body.Close)+len(body.Move) > config.MaxOpenProjects {
		fail(w, http.StatusBadRequest, "Too many project changes")
		return
	}
	for _, project := range append(slices.Clone(body.Open), body.Close...) {
		if !project.Valid() {
			fail(w, http.StatusBadRequest, "A valid host and root are required")
			return
		}
	}
	for _, move := range body.Move {
		if !move.Project.Valid() || !move.Target.Valid() || (move.Edge != "before" && move.Edge != "after") {
			fail(w, http.StatusBadRequest, "A valid project, target, and before/after edge are required")
			return
		}
	}
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	_, s, ok := a.current(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	var invalid error
	change := func(cfg *config.Config) error {
		view := *cfg
		if s.userID != "" {
			view = userConfig(*cfg, s.userID)
		}
		// Merge operations into the latest saved list, never a client's stale snapshot.
		view.PruneOpenProjects()
		for _, project := range body.Close {
			view.OpenProjects = slices.DeleteFunc(view.OpenProjects, func(item config.ProjectRef) bool { return item == project })
		}
		for _, project := range body.Open {
			if !view.ProjectVisible(project) {
				invalid = errors.New("This project is no longer available")
				return invalid
			}
			if !slices.Contains(view.OpenProjects, project) {
				view.OpenProjects = append(view.OpenProjects, project)
			}
		}
		for _, move := range body.Move {
			source, target := slices.Index(view.OpenProjects, move.Project), slices.Index(view.OpenProjects, move.Target)
			// A stale move must not reopen a project closed on another device.
			if source < 0 || target < 0 || source == target {
				continue
			}
			view.OpenProjects = slices.Delete(view.OpenProjects, source, source+1)
			target = slices.Index(view.OpenProjects, move.Target)
			if move.Edge == "after" {
				target++
			}
			view.OpenProjects = slices.Insert(view.OpenProjects, target, move.Project)
		}
		if s.userID != "" {
			cfg.Users = slices.Clone(cfg.Users)
			for i := range cfg.Users {
				if cfg.Users[i].ID == s.userID {
					cfg.Users[i].OpenProjects = view.OpenProjects
				}
			}
		} else {
			cfg.OpenProjects = view.OpenProjects
		}
		invalid = config.Validate(*cfg)
		return invalid
	}
	a.hostsMu.RLock()
	cfg := a.cfg
	a.hostsMu.RUnlock()
	var err error
	if a.configFile != "" {
		cfg, err = config.Update(a.configFile, change)
	} else {
		err = change(&cfg)
	}
	if err != nil {
		switch {
		case invalid != nil:
			fail(w, http.StatusBadRequest, invalid.Error())
		case errors.Is(err, config.ErrConflict):
			fail(w, http.StatusConflict, "Configuration changed; retry saving projects")
		default:
			fail(w, http.StatusInternalServerError, "Could not save shared projects")
		}
		return
	}
	a.hostsMu.Lock()
	a.cfg.OpenProjects = cfg.OpenProjects
	a.cfg.Users = cfg.Users
	a.hostsMu.Unlock()
	// A workspace change must not revoke previews or touch settings/password state.
	respond(w, http.StatusOK, userSharedProjects(cfg, s.userID))
}
