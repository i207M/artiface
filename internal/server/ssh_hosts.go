package server

import (
	"encoding/pem"
	"errors"
	"net/http"
	"reflect"

	"artiface/internal/config"
	"artiface/internal/sshvault"

	"golang.org/x/crypto/ssh"
)

func (a *App) addSSHHost(w http.ResponseWriter, r *http.Request) {
	if a.sshCredentials.Disabled() {
		storageError(w, sshvault.ErrDisabled)
		return
	}
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		Alias         string `json:"alias"`
		Hostname      string `json:"hostname"`
		User          string `json:"user"`
		Port          int    `json:"port"`
		SSHPassword   string `json:"sshPassword"`
		PrivateKey    string `json:"privateKey"`
		KeyPassphrase string `json:"keyPassphrase"`
		AdminPassword string `json:"adminPassword"`
		Jump          string `json:"jump"`
	}
	if !decodeLimit(w, r, &body, 64<<10) {
		return
	}
	if len(body.SSHPassword) > 4096 || len(body.PrivateKey) > 32<<10 || len(body.KeyPassphrase) > 4096 ||
		(body.SSHPassword == "") == (body.PrivateKey == "") || (body.PrivateKey == "" && body.KeyPassphrase != "") {
		fail(w, http.StatusBadRequest, "Provide either an SSH password (up to 4096 bytes) or a private key (up to 32 KiB)")
		return
	}
	if !a.beginPasswordCheck(w) {
		return
	}
	defer func() { <-a.loginBusy }()
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	if _, _, ok := a.current(r); !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	current, err := config.Load(a.configFile)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Could not load configuration")
		return
	}
	if !a.checkPassword(current.PasswordHash, body.AdminPassword) {
		fail(w, http.StatusForbidden, "Incorrect admin password")
		return
	}
	profile := sshvault.Profile{
		Hostname: body.Hostname, User: body.User, Port: body.Port, Password: []byte(body.SSHPassword),
	}
	body.SSHPassword = ""
	defer clear(profile.Password)
	if body.Jump != "" {
		profile.Jumps = []string{body.Jump}
	}
	var key []byte
	if body.PrivateKey != "" {
		input, passphrase := []byte(body.PrivateKey), []byte(body.KeyPassphrase)
		body.PrivateKey, body.KeyPassphrase = "", ""
		key, err = decodeSSHHostKey(input, passphrase)
		clear(input)
		clear(passphrase)
		if err != nil {
			fail(w, http.StatusBadRequest, "Could not read the SSH private key; check its format and passphrase")
			return
		}
		defer clear(key)
	}
	var saved config.Config
	var added config.Host
	err = a.sshCredentials.AddHost(body.Alias, profile, key, body.AdminPassword, current.SSHCredentials, func(encrypted *sshvault.Envelope) error {
		var err error
		saved, err = config.Update(a.configFile, func(cfg *config.Config) error {
			if cfg.PasswordHash != current.PasswordHash || !reflect.DeepEqual(cfg.SSHCredentials, current.SSHCredentials) {
				return config.ErrConflict
			}
			for _, host := range cfg.Hosts {
				if host.Target == body.Alias {
					return sshvault.ErrHostExists
				}
			}
			cfg.Hosts, _ = config.MergeTargets(cfg.Hosts, []string{body.Alias})
			added = cfg.Hosts[len(cfg.Hosts)-1]
			cfg.SSHCredentials = encrypted
			return nil
		})
		return err
	})
	if err != nil {
		switch {
		case errors.Is(err, sshvault.ErrHostExists):
			fail(w, http.StatusConflict, "An SSH host with this alias already exists")
		case errors.Is(err, sshvault.ErrHostKeyExpired), errors.Is(err, config.ErrConflict):
			fail(w, http.StatusConflict, "SSH credentials changed elsewhere; restart the server before adding hosts")
		case errors.Is(err, sshvault.ErrInvalidHost):
			fail(w, http.StatusBadRequest, "Invalid SSH host settings, credentials, or jump host")
		case errors.Is(err, sshvault.ErrDisabled):
			storageError(w, err)
		default:
			fail(w, http.StatusInternalServerError, "Could not save the SSH host; credentials were not changed")
		}
		return
	}
	a.adoptSources(saved)
	respond(w, http.StatusCreated, map[string]any{"host": added})
}

func decodeSSHHostKey(input, passphrase []byte) ([]byte, error) {
	raw, err := ssh.ParseRawPrivateKey(input)
	var encrypted *ssh.PassphraseMissingError
	if errors.As(err, &encrypted) {
		raw, err = ssh.ParseRawPrivateKeyWithPassphrase(input, passphrase)
	}
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(raw, "Artiface imported identity")
	if err != nil {
		return nil, err
	}
	defer clear(block.Bytes)
	return pem.EncodeToMemory(block), nil
}
