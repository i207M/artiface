// Package sshvault stores imported SSH credentials encrypted under the admin
// password. Decrypted credentials belong to one server process, never a session.
package sshvault

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/ssh"
)

const MaxPlaintext = 512 << 10

var (
	ErrDisabled = errors.New("SSH connectivity is disabled on this server")
	ErrLocked   = errors.New("SSH credentials are locked; an administrator must sign in to unlock them")
	ErrMissing  = errors.New("SSH credentials have not been saved for this host")
	ErrDecrypt  = errors.New("could not decrypt SSH credentials with this admin password")
)

type Envelope struct {
	Version    int    `json:"version"`
	Salt       []byte `json:"salt"`
	Ciphertext []byte `json:"ciphertext"`
}

type Profile struct {
	Hostname        string   `json:"hostname"`
	User            string   `json:"user"`
	Port            int      `json:"port"`
	HostKeyAlias    string   `json:"hostKeyAlias,omitempty"`
	Keys            []string `json:"keys,omitempty"`
	Password        []byte   `json:"password,omitempty"`
	Jumps           []string `json:"jumps,omitempty"`
	KnownHosts      string   `json:"knownHosts"`
	ApprovedHostKey []byte   `json:"approvedHostKey,omitempty"`
}

type Bundle struct {
	Hosts      map[string]Profile `json:"hosts"`
	Keys       map[string][]byte  `json:"keys"`
	KnownHosts map[string]string  `json:"knownHosts"`
}

func (e *Envelope) Validate() error {
	if e == nil {
		return nil
	}
	if e.Version != 1 || len(e.Salt) != 16 || len(e.Ciphertext) < 28 || len(e.Ciphertext) > MaxPlaintext+28 {
		return errors.New("invalid encrypted SSH credentials")
	}
	return nil
}

func aead(password string, salt []byte) (cipher.AEAD, error) {
	if len(password) == 0 || len(password) > 1024 {
		return nil, ErrDecrypt
	}
	input := []byte(password)
	defer clear(input)
	key := argon2.IDKey(input, salt, 3, 64*1024, 1, 32)
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCMWithRandomNonce(block)
}

func Seal(bundle Bundle, password string) (*Envelope, error) {
	if err := bundle.Validate(); err != nil {
		return nil, err
	}
	plain, err := json.Marshal(bundle)
	if err != nil {
		return nil, err
	}
	defer clear(plain)
	if len(plain) > MaxPlaintext {
		return nil, errors.New("SSH credentials exceed the 512 KiB limit")
	}
	e := &Envelope{Version: 1, Salt: make([]byte, 16)}
	if _, err = rand.Read(e.Salt); err != nil {
		return nil, errors.New("secure randomness is unavailable")
	}
	gcm, err := aead(password, e.Salt)
	if err != nil {
		return nil, err
	}
	e.Ciphertext = gcm.Seal(nil, nil, plain, []byte("artiface:ssh-credentials:v1"))
	return e, nil
}

func Open(e *Envelope, password string) (Bundle, error) {
	if e == nil {
		return Bundle{Hosts: map[string]Profile{}, Keys: map[string][]byte{}, KnownHosts: map[string]string{}}, nil
	}
	if err := e.Validate(); err != nil {
		return Bundle{}, err
	}
	gcm, err := aead(password, e.Salt)
	if err != nil {
		return Bundle{}, err
	}
	plain, err := gcm.Open(nil, nil, e.Ciphertext, []byte("artiface:ssh-credentials:v1"))
	if err != nil {
		return Bundle{}, ErrDecrypt
	}
	defer clear(plain)
	var bundle Bundle
	decoder := json.NewDecoder(bytes.NewReader(plain))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&bundle); err != nil {
		bundle.Clear()
		return Bundle{}, errors.New("invalid SSH credential payload")
	}
	if decoder.Decode(new(any)) != io.EOF {
		bundle.Clear()
		return Bundle{}, errors.New("invalid SSH credential payload")
	}
	if err := bundle.Validate(); err != nil {
		bundle.Clear()
		return Bundle{}, err
	}
	return bundle, nil
}

func (b Bundle) Validate() error {
	if len(b.Hosts) == 0 || len(b.Hosts) > 128 || len(b.Keys) > 128 || len(b.KnownHosts) > 128 {
		return errors.New("SSH import needs 1–128 hosts and bounded key and known_hosts data")
	}
	trustBytes := 0
	for id, data := range b.KnownHosts {
		trustBytes += len(data)
		if id == "" || len(id) > 128 || trustBytes > MaxPlaintext/2 {
			return errors.New("invalid or oversized imported host-key trust data")
		}
	}
	for id, key := range b.Keys {
		if id == "" || len(id) > 128 || len(key) > 32<<10 {
			return errors.New("invalid imported private key")
		}
		if _, err := ssh.ParsePrivateKey(key); err != nil {
			return errors.New("an imported private key could not be read")
		}
	}
	for alias, host := range b.Hosts {
		if !safe(alias) || !safe(host.Hostname) || !safe(host.User) || host.Port < 1 || host.Port > 65535 ||
			len(host.Password) > 4096 || len(host.Keys) > 16 || len(host.Jumps) > 8 ||
			(host.HostKeyAlias != "" && !safe(host.HostKeyAlias)) {
			return errors.New("invalid imported SSH host")
		}
		if len(host.Keys) == 0 && len(host.Password) == 0 {
			return fmt.Errorf("%s: no private key or SSH password was imported", alias)
		}
		if _, ok := b.KnownHosts[host.KnownHosts]; !ok {
			return errors.New("an SSH host references missing host-key trust data")
		}
		if len(host.ApprovedHostKey) != 0 {
			key, err := ssh.ParsePublicKey(host.ApprovedHostKey)
			if err != nil || len(host.ApprovedHostKey) > 16<<10 {
				return errors.New("invalid approved SSH host key")
			}
			if _, certificate := key.(*ssh.Certificate); certificate {
				return errors.New("SSH host certificates must use imported certificate authorities")
			}
		}
		for _, id := range host.Keys {
			if _, ok := b.Keys[id]; !ok {
				return errors.New("an SSH host references a missing private key")
			}
		}
		if _, err := b.chain(alias); err != nil {
			return err
		}
	}
	return nil
}

// An explicit ProxyJump list overrides later hops' own jump configuration.
// Bound total hops as well as recursion, including repeated aliases in a DAG.
type namedProfile struct {
	Name string
	Profile
}

func (b Bundle) chain(alias string) ([]namedProfile, error) {
	var result []namedProfile
	seen := map[string]bool{}
	var visit func(string, bool) error
	visit = func(name string, useJumps bool) error {
		if seen[name] || len(seen) >= 9 {
			return errors.New("SSH jump hosts repeat a host or exceed 8 hops")
		}
		profile, ok := b.Hosts[name]
		if !ok {
			return ErrMissing
		}
		seen[name] = true
		if useJumps && len(profile.Jumps) > 0 {
			if err := visit(profile.Jumps[0], true); err != nil {
				return err
			}
			for _, jump := range profile.Jumps[1:] {
				if err := visit(jump, false); err != nil {
					return err
				}
			}
		}
		result = append(result, namedProfile{Name: name, Profile: profile})
		return nil
	}
	err := visit(alias, true)
	return result, err
}

func safe(value string) bool {
	return value != "" && len(value) <= 255 && !strings.HasPrefix(value, "-") &&
		!strings.ContainsAny(value, " \t\r\n\x00/\\")
}

func (p Profile) Address() string { return net.JoinHostPort(p.Hostname, strconv.Itoa(p.Port)) }

func (b Bundle) Clear() {
	for _, key := range b.Keys {
		clear(key)
	}
	for _, host := range b.Hosts {
		clear(host.Password)
	}
	clear(b.Keys)
	clear(b.Hosts)
	clear(b.KnownHosts)
}
