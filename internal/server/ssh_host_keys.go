package server

import (
	"errors"
	"net/http"
	"reflect"

	"artiface/internal/config"
	"artiface/internal/sshvault"
)

func (a *App) sshHostKey(w http.ResponseWriter, r *http.Request) {
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &body) {
		return
	}
	prompt, err := a.sshCredentials.HostKeyPrompt(body.Token)
	if err != nil {
		storageError(w, err)
		return
	}
	respond(w, http.StatusOK, prompt)
}

func (a *App) acceptSSHHostKey(w http.ResponseWriter, r *http.Request) {
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decodeLimit(w, r, &body, 8192) || !a.beginPasswordCheck(w) {
		return
	}
	defer func() { <-a.loginBusy }()
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	if _, _, ok := a.current(r); !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	if _, err := a.sshCredentials.HostKeyPrompt(body.Token); err != nil {
		storageError(w, err)
		return
	}
	current, err := config.Load(a.configFile)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Could not load configuration")
		return
	}
	if !a.checkPassword(current.PasswordHash, body.Password) {
		fail(w, http.StatusForbidden, "Incorrect admin password")
		return
	}
	err = a.sshCredentials.AcceptHostKey(body.Token, body.Password, current.SSHCredentials, func(encrypted *sshvault.Envelope) error {
		_, err := config.Update(a.configFile, func(cfg *config.Config) error {
			if cfg.PasswordHash != current.PasswordHash || !reflect.DeepEqual(cfg.SSHCredentials, current.SSHCredentials) {
				return config.ErrConflict
			}
			cfg.SSHCredentials = encrypted
			return nil
		})
		return err
	})
	if err != nil {
		if errors.Is(err, sshvault.ErrHostKeyExpired) || errors.Is(err, config.ErrConflict) {
			fail(w, http.StatusConflict, "SSH credentials changed or this confirmation expired; retry the connection")
		} else {
			fail(w, http.StatusInternalServerError, "Could not save the SSH host key; trust was not changed")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
