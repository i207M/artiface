package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"artiface/internal/config"
)

type publicUser struct {
	ID       string              `json:"id"`
	Username string              `json:"username"`
	Disabled bool                `json:"disabled"`
	Projects []config.ProjectRef `json:"projects"`
}

func accessRevision(cfg config.Config) string {
	users := slices.Clone(cfg.Users)
	for i := range users {
		users[i].OpenProjects = nil
	}
	data, _ := json.Marshal(struct {
		Mode    string
		Users   []config.User
		Sources string
	}{cfg.ModeName(), users, configRevision(cfg)})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func accessResponse(cfg config.Config, mode string) any {
	users := make([]publicUser, 0, len(cfg.Users))
	for _, user := range cfg.Users {
		users = append(users, publicUser{user.ID, user.Username, user.Disabled, slices.Clone(user.Projects)})
	}
	return struct {
		Mode     string       `json:"mode"`
		Users    []publicUser `json:"users"`
		Revision string       `json:"revision"`
	}{mode, users, accessRevision(cfg)}
}

func (a *App) getAccess(w http.ResponseWriter, r *http.Request) {
	a.hostsMu.RLock()
	cfg := a.cfg
	a.hostsMu.RUnlock()
	if a.configFile != "" {
		var err error
		cfg, err = config.Load(a.configFile)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Could not load access settings")
			return
		}
	}
	respond(w, http.StatusOK, accessResponse(cfg, a.cfg.ModeName()))
}

func (a *App) saveAccess(w http.ResponseWriter, r *http.Request) {
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		Revision string `json:"revision"`
		Delete   string `json:"deleteUser"`
		User     *struct {
			publicUser
			Password string `json:"password"`
		} `json:"user"`
	}
	if !decodeLimit(w, r, &body, 128<<10) {
		return
	}
	actions := 0
	for _, present := range []bool{body.Delete != "", body.User != nil} {
		if present {
			actions++
		}
	}
	if actions != 1 || body.Revision == "" {
		fail(w, http.StatusBadRequest, "Provide one change and the current revision")
		return
	}
	newHash := ""
	if body.User != nil && body.User.Password != "" {
		if !a.beginPasswordCheck(w) {
			return
		}
		defer func() { <-a.loginBusy }()
		var err error
		newHash, err = config.HashPassword(body.User.Password)
		if err != nil {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	if _, _, ok := a.current(r); !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	var invalid error
	cfg, err := config.Update(a.configFile, func(c *config.Config) error {
		if accessRevision(*c) != body.Revision {
			return config.ErrConflict
		}
		c.Users = slices.Clone(c.Users)
		switch {
		case body.Delete != "":
			c.Users = slices.DeleteFunc(c.Users, func(user config.User) bool { return user.ID == body.Delete })
		default:
			input := body.User
			index := slices.IndexFunc(c.Users, func(user config.User) bool { return user.ID == input.ID })
			if index < 0 && input.ID != "" {
				invalid = errors.New("This user no longer exists")
				return invalid
			}
			if index < 0 {
				if newHash == "" {
					invalid = errors.New("A password is required for a new user")
					return invalid
				}
				c.Users = append(c.Users, config.User{ID: "user-" + randomToken()})
				index = len(c.Users) - 1
			}
			user := &c.Users[index]
			user.Username = strings.ToLower(strings.TrimSpace(input.Username))
			user.Disabled, user.Projects = input.Disabled, input.Projects
			if newHash != "" {
				user.PasswordHash = newHash
			}
		}
		invalid = config.Validate(*c)
		return invalid
	})
	if err != nil {
		switch {
		case invalid != nil:
			fail(w, http.StatusBadRequest, invalid.Error())
		case errors.Is(err, config.ErrConflict):
			fail(w, http.StatusConflict, "Access settings changed elsewhere. Reload and try again.")
		default:
			fail(w, http.StatusInternalServerError, "Could not save access settings")
		}
		return
	}
	a.adoptSources(cfg)
	respond(w, http.StatusOK, accessResponse(cfg, a.cfg.ModeName()))
}

// Build the user's catalog without server targets, absolute paths, discovery,
// or another user's workspace state. Grants always refer to configured roots.
func userConfig(cfg config.Config, userID string) config.Config {
	user, _ := cfg.User(userID)
	hosts := []config.Host{}
	for _, host := range cfg.Hosts {
		roots := []config.Root{}
		for _, root := range host.Roots {
			if cfg.UserCanRead(userID, config.ProjectRef{Host: host.ID, Root: root.ID}) {
				root.Path = ""
				roots = append(roots, root)
			}
		}
		if len(roots) > 0 {
			host.Target, host.Roots = "", roots
			hosts = append(hosts, host)
		}
	}
	return config.Config{Mode: "team", Hosts: hosts, OpenProjects: slices.Clone(user.OpenProjects)}
}
