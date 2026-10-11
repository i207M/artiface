package sshvault

import (
	"os"
	"reflect"

	"golang.org/x/crypto/ssh"
)

// RemoveHosts updates storage before forgetting credentials or closing their
// transports. Disabled or locked runtimes stay disabled or locked after deletion.
func (r *Runtime) RemoveHosts(removed, keep []string, password string, expected *Envelope, persist func(*Envelope) error) error {
	r.mu.Lock()
	chains, err := r.removeHosts(removed, keep, password, expected, persist)
	r.mu.Unlock()
	for _, chain := range chains {
		chain.Close()
	}
	return err
}

func (r *Runtime) removeHosts(removed, keep []string, password string, expected *Envelope, persist func(*Envelope) error) ([]*clientChain, error) {
	if r.closed {
		return nil, os.ErrClosed
	}
	if !reflect.DeepEqual(r.envelope, expected) {
		return nil, ErrHostKeyExpired
	}
	bundle, err := Open(expected, password)
	if err != nil {
		return nil, err
	}
	adopted := false
	defer func() {
		if !adopted {
			bundle.Clear()
		}
	}()
	if err := bundle.RemoveHosts(removed, keep); err != nil {
		return nil, err
	}
	var envelope *Envelope
	if len(bundle.Hosts) > 0 {
		envelope, err = Seal(bundle, password)
		if err != nil {
			return nil, err
		}
	}
	var callbacks map[string]ssh.HostKeyCallback
	keepUnlocked := r.unlocked && !r.disabled
	if keepUnlocked {
		callbacks = make(map[string]ssh.HostKeyCallback, len(bundle.KnownHosts))
		for id, data := range bundle.KnownHosts {
			callback, err := hostKeyCallback(data)
			if err != nil {
				return nil, err
			}
			callbacks[id] = callback
		}
	}
	if err := persist(envelope); err != nil {
		return nil, err
	}
	var chains []*clientChain
	for chain, target := range r.active {
		if _, kept := bundle.Hosts[target]; !kept {
			chains = append(chains, chain)
		}
	}
	r.bundle.Clear()
	r.envelope, r.check = envelope, callbacks
	clear(r.pending)
	if keepUnlocked {
		r.bundle = bundle
		adopted = true
	}
	return chains, nil
}
