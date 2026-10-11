package sshvault

import (
	"bytes"
	"crypto/rand"
	"errors"
	"net"
	"os"
	"reflect"
	"slices"
	"sort"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

var ErrHostKeyExpired = errors.New("SSH host key confirmation expired or credentials changed; retry the connection")

// HostKeyError identifies a failed handshake, not permission to authenticate.
// The exact observed key stays on the server until an administrator approves it.
type HostKeyError struct {
	Token string
}

func (e *HostKeyError) Error() string {
	return "SSH host key needs confirmation by the personal owner or team administrator"
}

type HostKeyPrompt struct {
	Token                string   `json:"token"`
	Target               string   `json:"target"`
	Host                 string   `json:"host"`
	Address              string   `json:"address"`
	KeyType              string   `json:"keyType"`
	Fingerprint          string   `json:"fingerprint"`
	Changed              bool     `json:"changed"`
	PreviousFingerprints []string `json:"previousFingerprints"`
}

type pendingHostKey struct {
	prompt   HostKeyPrompt
	key      []byte
	envelope *Envelope
	expires  time.Time
}

func (r *Runtime) confirmHostKey(target string, profile namedProfile, envelope *Envelope, check ssh.HostKeyCallback) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		if !r.Matches(envelope) {
			return ErrHostKeyExpired
		}
		err := check(hostname, remote, key)
		var mismatch *knownhosts.KeyError
		if err != nil && !errors.As(err, &mismatch) {
			// Revocation, invalid certificates, and malformed trust data
			// cannot be overridden by accepting a fingerprint.
			return err
		}
		if certificate, ok := key.(*ssh.Certificate); ok {
			if err == nil && len(profile.ApprovedHostKey) != 0 && !bytes.Equal(profile.ApprovedHostKey, certificate.Key.Marshal()) {
				return errors.New("SSH host certificate does not match the approved host key")
			}
			return err
		}
		var previous []string
		if len(profile.ApprovedHostKey) != 0 {
			if bytes.Equal(profile.ApprovedHostKey, key.Marshal()) {
				return nil
			}
			old, parseErr := ssh.ParsePublicKey(profile.ApprovedHostKey)
			if parseErr != nil {
				return errors.New("invalid approved SSH host key")
			}
			previous = []string{ssh.FingerprintSHA256(old)}
		} else if err == nil {
			return nil
		} else {
			for _, old := range mismatch.Want {
				previous = append(previous, ssh.FingerprintSHA256(old.Key))
			}
		}
		sort.Strings(previous)
		return r.rememberHostKey(target, profile, envelope, key, slices.Compact(previous))
	}
}

func (r *Runtime) rememberHostKey(target string, profile namedProfile, envelope *Envelope, key ssh.PublicKey, previous []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return os.ErrClosed
	}
	if !reflect.DeepEqual(r.envelope, envelope) {
		return ErrHostKeyExpired
	}
	now := time.Now()
	fingerprint := ssh.FingerprintSHA256(key)
	for token, pending := range r.pending {
		if !now.Before(pending.expires) {
			delete(r.pending, token)
		} else if pending.prompt.Target == target && pending.prompt.Host == profile.Name && pending.prompt.Fingerprint == fingerprint {
			return &HostKeyError{Token: token}
		}
	}
	if len(r.pending) >= 128 || len(key.Marshal()) > 16<<10 {
		return errors.New("too many pending SSH host keys; retry later")
	}
	token := rand.Text()
	prompt := HostKeyPrompt{
		Token: token, Target: target, Host: profile.Name, Address: profile.Address(),
		KeyType: key.Type(), Fingerprint: fingerprint, Changed: len(previous) > 0,
		PreviousFingerprints: append([]string{}, previous...),
	}
	r.pending[token] = pendingHostKey{prompt: prompt, key: bytes.Clone(key.Marshal()), envelope: envelope, expires: now.Add(5 * time.Minute)}
	return &HostKeyError{Token: token}
}

func (r *Runtime) pendingHostKey(token string) (pendingHostKey, error) {
	if r.disabled {
		return pendingHostKey{}, ErrDisabled
	}
	if r.closed {
		return pendingHostKey{}, os.ErrClosed
	}
	pending, ok := r.pending[token]
	if !ok || !time.Now().Before(pending.expires) || !reflect.DeepEqual(pending.envelope, r.envelope) {
		return pendingHostKey{}, ErrHostKeyExpired
	}
	return pending, nil
}

func (r *Runtime) HostKeyPrompt(token string) (HostKeyPrompt, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	pending, err := r.pendingHostKey(token)
	prompt := pending.prompt
	prompt.PreviousFingerprints = append([]string{}, prompt.PreviousFingerprints...)
	return prompt, err
}

// AcceptHostKey publishes trust only after the caller durably saves it.
// The password is used once to re-encrypt; neither it nor its derived key is retained.
func (r *Runtime) AcceptHostKey(token, password string, expected *Envelope, persist func(*Envelope) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	pending, err := r.pendingHostKey(token)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(expected, r.envelope) {
		return ErrHostKeyExpired
	}
	bundle, err := Open(r.envelope, password)
	if err != nil {
		return err
	}
	adopted := false
	defer func() {
		if !adopted {
			bundle.Clear()
		}
	}()
	profile, ok := bundle.Hosts[pending.prompt.Host]
	if !ok {
		return ErrHostKeyExpired
	}
	profile.ApprovedHostKey = bytes.Clone(pending.key)
	bundle.Hosts[pending.prompt.Host] = profile
	envelope, err := Seal(bundle, password)
	if err != nil {
		return err
	}
	if err := persist(envelope); err != nil {
		return err
	}
	r.bundle.Clear()
	r.bundle, r.envelope = bundle, envelope
	r.unlocked = true
	clear(r.pending)
	adopted = true
	return nil
}
