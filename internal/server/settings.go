package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"

	"artiface/internal/buildinfo"
	"artiface/internal/config"
	"artiface/internal/sshvault"
)

// PublicConfig deliberately excludes credentials and authentication state.
type PublicConfig struct {
	Hosts           []config.Host `json:"hosts"`
	SessionHours    int           `json:"sessionHours"`
	Listen          string        `json:"listen"`
	AppOrigin       string        `json:"appOrigin,omitempty"`
	PreviewOrigin   string        `json:"previewOrigin,omitempty"`
	HideLocalSource bool          `json:"hideLocalSource,omitempty"`
}

type SettingsResponse struct {
	GitCommit       string       `json:"gitCommit"`
	BuildTime       string       `json:"buildTime,omitempty"`
	Config          PublicConfig `json:"config"`
	Revision        string       `json:"revision"`
	RestartRequired bool         `json:"restartRequired"`
	SSHLocked       bool         `json:"sshLocked"`
	SSHDisabled     bool         `json:"sshDisabled"`
	SSHConfigured   bool         `json:"sshConfigured,omitempty"`
}

func publicConfig(c config.Config) PublicConfig {
	hosts := append([]config.Host{}, c.Hosts...)
	for i := range hosts {
		hosts[i].Roots = append([]config.Root{}, hosts[i].Roots...)
	}
	return PublicConfig{Hosts: hosts, SessionHours: c.SessionHours, Listen: c.Listen,
		AppOrigin: c.AppOrigin, PreviewOrigin: c.PreviewOrigin,
		HideLocalSource: c.HideLocalSource}
}

// The revision covers editable settings, not secrets or JSON whitespace.
// Password changes can therefore be preserved without blocking an unrelated edit.
func configRevision(c config.Config) string {
	data, _ := json.Marshal(publicConfig(c))
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func (a *App) settingsResponse(cfg config.Config) SettingsResponse {
	return SettingsResponse{GitCommit: buildinfo.Commit(), BuildTime: buildinfo.BuildTime, Config: publicConfig(cfg), Revision: configRevision(cfg), SSHLocked: a.sshCredentials.Locked(), SSHDisabled: a.sshCredentials.Disabled(),
		SSHConfigured: cfg.SSHCredentials != nil,
		RestartRequired: cfg.Listen != a.cfg.Listen ||
			cfg.SessionHours != a.cfg.SessionHours || cfg.AppOrigin != a.cfg.AppOrigin ||
			cfg.PreviewOrigin != a.cfg.PreviewOrigin || !a.sshCredentials.Matches(cfg.SSHCredentials)}
}

func (a *App) settings(w http.ResponseWriter, r *http.Request) {
	_, s, ok := a.current(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	if s.userID != "" {
		respond(w, http.StatusOK, SettingsResponse{
			GitCommit: buildinfo.Commit(), BuildTime: buildinfo.BuildTime,
			Config:      PublicConfig{Hosts: []config.Host{}},
			SSHDisabled: a.sshCredentials.Disabled(),
		})
		return
	}
	a.hostsMu.RLock()
	cfg := a.cfg
	a.hostsMu.RUnlock()
	if a.configFile != "" {
		var err error
		cfg, err = config.Load(a.configFile)
		if err != nil {
			// Parsing errors can quote the private file; never forward them.
			fail(w, http.StatusInternalServerError, "Could not load settings")
			return
		}
	}
	respond(w, http.StatusOK, a.settingsResponse(cfg))
}

func (a *App) saveSettings(w http.ResponseWriter, r *http.Request) {
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		Config        *PublicConfig `json:"config"`
		Revision      string        `json:"revision"`
		AdminPassword string        `json:"adminPassword"`
	}
	if !decodeLimit(w, r, &body, (1<<20)+4096) {
		return
	}
	if body.Config == nil || body.Revision == "" {
		fail(w, http.StatusBadRequest, "Settings and a revision are required")
		return
	}
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	if _, _, ok := a.current(r); !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	current, err := config.Load(a.configFile)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Could not load settings")
		return
	}
	if body.Revision != configRevision(current) {
		setupError(w, config.ErrConflict)
		return
	}
	removed, keep := removedSSHTargets(current.Hosts, body.Config.Hosts)
	if len(removed) > 0 && !a.sshCredentials.Matches(current.SSHCredentials) {
		fail(w, http.StatusConflict, "SSH credentials changed elsewhere; restart the server before removing hosts")
		return
	}
	deleteCredentials := len(removed) > 0 && current.SSHCredentials != nil
	if deleteCredentials {
		if body.AdminPassword == "" {
			respond(w, http.StatusPreconditionRequired, map[string]any{
				"error":                  "Enter the admin password to remove saved SSH credentials.",
				"sshCredentialsRequired": true,
			})
			return
		}
		if !a.beginPasswordCheck(w) {
			return
		}
		defer func() { <-a.loginBusy }()
		if !a.checkPassword(current.PasswordHash, body.AdminPassword) {
			fail(w, http.StatusForbidden, "Incorrect admin password")
			return
		}
	}
	var cfg config.Config
	var invalid error
	persist := func(encrypted *sshvault.Envelope) error {
		var err error
		cfg, err = config.Update(a.configFile, func(c *config.Config) error {
			if body.Revision != configRevision(*c) {
				return config.ErrConflict
			}
			// Guard the checked password and envelope, including a CLI import into
			// an initially empty vault. Preserve concurrent grants/open-project edits.
			if len(removed) > 0 && (c.PasswordHash != current.PasswordHash ||
				!reflect.DeepEqual(c.SSHCredentials, current.SSHCredentials)) {
				return config.ErrConflict
			}
			p := body.Config
			c.Hosts, c.SessionHours = p.Hosts, p.SessionHours
			c.Listen = p.Listen
			c.AppOrigin, c.PreviewOrigin = p.AppOrigin, p.PreviewOrigin
			c.HideLocalSource = p.HideLocalSource
			if deleteCredentials {
				c.SSHCredentials = encrypted
			}
			c.PruneOpenProjects()
			// Preserve private/authentication state on ordinary settings edits.
			invalid = config.Validate(*c)
			return invalid
		})
		return err
	}
	if deleteCredentials {
		err = a.sshCredentials.RemoveHosts(removed, keep, body.AdminPassword, current.SSHCredentials, persist)
	} else {
		err = persist(nil)
	}
	if err != nil {
		if invalid != nil {
			fail(w, http.StatusBadRequest, invalid.Error())
		} else if errors.Is(err, config.ErrConflict) {
			setupError(w, err)
		} else if errors.Is(err, sshvault.ErrHostInUse) {
			fail(w, http.StatusUnprocessableEntity, err.Error())
		} else if errors.Is(err, sshvault.ErrHostKeyExpired) {
			fail(w, http.StatusConflict, "SSH credentials changed elsewhere; restart the server before removing hosts")
		} else {
			fail(w, http.StatusInternalServerError, "Could not save settings")
		}
		return
	}
	a.adoptSources(cfg)
	if deleteCredentials {
		if err := config.CleanupSSHCredentials(a.configFile); err != nil {
			fail(w, http.StatusInternalServerError, "Settings were saved, but old SSH credentials could not be removed. Reload settings and check the data directory permissions.")
			return
		}
	}
	respond(w, http.StatusOK, a.settingsResponse(cfg))
}

func removedSSHTargets(before, after []config.Host) (removed, keep []string) {
	retained := make(map[string]bool)
	for _, host := range after {
		if host.Kind != "local" && host.Target != "" && !retained[host.Target] {
			retained[host.Target] = true
			keep = append(keep, host.Target)
		}
	}
	deleted := make(map[string]bool)
	for _, host := range before {
		if host.Kind != "local" && host.Target != "" && !retained[host.Target] && !deleted[host.Target] {
			deleted[host.Target] = true
			removed = append(removed, host.Target)
		}
	}
	return removed, keep
}

func (a *App) validateSource(host config.Host) error {
	check := config.Default()
	check.PasswordHash = a.cfg.PasswordHash
	check.Hosts = []config.Host{host}
	if err := config.Validate(check); err != nil {
		return fmt.Errorf("%w: %s", errHostTarget, err)
	}
	return nil
}
