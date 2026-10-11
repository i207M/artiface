package sshvault

import (
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"reflect"

	"golang.org/x/crypto/ssh"
)

var (
	ErrHostExists  = errors.New("an SSH host with this alias already exists")
	ErrInvalidHost = errors.New("invalid SSH host")
)

// AddHost activates a web-created host only after credentials have been saved.
// It starts with no trusted server keys; connecting requires explicit approval.
func (r *Runtime) AddHost(alias string, profile Profile, key []byte, password string, expected *Envelope, persist func(*Envelope) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.disabled {
		return ErrDisabled
	}
	if r.closed {
		return os.ErrClosed
	}
	if !reflect.DeepEqual(r.envelope, expected) {
		return ErrHostKeyExpired
	}
	bundle, err := Open(expected, password)
	if err != nil {
		return err
	}
	adopted := false
	defer func() {
		if !adopted {
			bundle.Clear()
		}
	}()
	if _, exists := bundle.Hosts[alias]; exists {
		return ErrHostExists
	}
	profile.Keys = nil
	if len(key) != 0 {
		id := "web-" + rand.Text()
		bundle.Keys[id] = bytes.Clone(key)
		profile.Keys = []string{id}
	}
	profile.Password = bytes.Clone(profile.Password)
	profile.ApprovedHostKey = nil
	profile.KnownHosts = "web-" + rand.Text()
	bundle.KnownHosts[profile.KnownHosts] = ""
	bundle.Hosts[alias] = profile
	if err := bundle.Validate(); err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidHost, err)
	}
	callbacks := make(map[string]ssh.HostKeyCallback, len(bundle.KnownHosts))
	for id, data := range bundle.KnownHosts {
		callback, err := hostKeyCallback(data)
		if err != nil {
			return err
		}
		callbacks[id] = callback
	}
	envelope, err := Seal(bundle, password)
	if err != nil {
		return err
	}
	if err := persist(envelope); err != nil {
		return err
	}
	r.bundle.Clear()
	r.bundle, r.envelope, r.check, r.unlocked = bundle, envelope, callbacks, true
	clear(r.pending)
	adopted = true
	return nil
}
