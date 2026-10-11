package sshvault

import (
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"strings"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

var ErrHostInUse = errors.New("SSH host is required by a remaining configured host")

type HostInUseError struct {
	Alias     string
	Dependent string
}

func (e *HostInUseError) Error() string {
	return fmt.Sprintf("Cannot remove SSH host %q: it is required by %q", e.Alias, e.Dependent)
}

func (e *HostInUseError) Unwrap() error { return ErrHostInUse }

// RemoveHosts prunes a caller-owned bundle to the remaining configured roots.
// Dependency checks finish before any credentials are changed or cleared.
// An empty result is allowed; the caller must remove its encrypted envelope.
func (b Bundle) RemoveHosts(removed, keep []string) error {
	deleted := make(map[string]bool, len(removed))
	for _, alias := range removed {
		deleted[alias] = true
	}
	retained := make(map[string]bool)
	var visit func(string, string) error
	visit = func(alias, dependent string) error {
		if deleted[alias] {
			return &HostInUseError{Alias: alias, Dependent: dependent}
		}
		if retained[alias] {
			return nil
		}
		profile, exists := b.Hosts[alias]
		if !exists {
			return ErrMissing
		}
		retained[alias] = true
		// Preserve every reference, including a later jump's own configuration.
		for _, jump := range profile.Jumps {
			if err := visit(jump, dependent); err != nil {
				return err
			}
		}
		return nil
	}
	for _, alias := range keep {
		// A configured target may not have imported credentials yet.
		if _, exists := b.Hosts[alias]; !exists {
			continue
		}
		if err := visit(alias, alias); err != nil {
			return err
		}
	}

	// Prepare every trust rewrite before clearing any caller-owned credentials.
	reservedTrust := make(map[string]string, len(b.KnownHosts))
	trustBytes := 0
	for id, data := range b.KnownHosts {
		trustBytes += len(data)
		if trustBytes > MaxPlaintext/2 {
			return errors.New("imported host-key trust data exceeds its limit")
		}
		reservedTrust[id] = data
	}
	trustProfiles := make(map[string][]Profile)
	for alias := range retained {
		profile := b.Hosts[alias]
		trustProfiles[profile.KnownHosts] = append(trustProfiles[profile.KnownHosts], profile)
	}
	trustIDs, filteredTrust := make(map[string]string), make(map[string]string)
	for id, profiles := range trustProfiles {
		data, exists := b.KnownHosts[id]
		if !exists {
			return ErrMissing
		}
		filtered, err := filterHostTrust(data, profiles)
		if err != nil {
			return err
		}
		nextID := id
		if filtered != data {
			// An old import's content-derived ID must never refer to new contents.
			base := fmt.Sprintf("filtered-%x", sha256.Sum256([]byte(filtered)))
			nextID = base
			for suffix := 1; ; suffix++ {
				previous, exists := reservedTrust[nextID]
				if !exists || previous == filtered {
					break
				}
				nextID = fmt.Sprintf("%s-%d", base, suffix)
			}
		}
		trustIDs[id] = nextID
		filteredTrust[nextID], reservedTrust[nextID] = filtered, filtered
	}

	usedKeys := make(map[string]bool)
	for alias, profile := range b.Hosts {
		if !retained[alias] {
			clear(profile.Password)
			delete(b.Hosts, alias)
			continue
		}
		for _, id := range profile.Keys {
			usedKeys[id] = true
		}
		profile.KnownHosts = trustIDs[profile.KnownHosts]
		b.Hosts[alias] = profile
	}
	for id, key := range b.Keys {
		if !usedKeys[id] {
			clear(key)
			delete(b.Keys, id)
		}
	}
	clear(b.KnownHosts)
	for id, data := range filteredTrust {
		b.KnownHosts[id] = data
	}
	return nil
}

func filterHostTrust(data string, profiles []Profile) (string, error) {
	if err := CheckKnownHosts(data); err != nil {
		return "", err
	}
	if data == "" {
		return "", nil
	}
	// These distinct ordinary public keys are only matcher probes, never trust.
	probeBytes, recordBytes := make(ed25519.PublicKey, ed25519.PublicKeySize), make(ed25519.PublicKey, ed25519.PublicKeySize)
	recordBytes[0] = 1
	probe, err := ssh.NewPublicKey(probeBytes)
	if err != nil {
		return "", err
	}
	recordKey, err := ssh.NewPublicKey(recordBytes)
	if err != nil {
		return "", err
	}
	keyText := string(ssh.MarshalAuthorizedKey(recordKey))
	records := strings.SplitAfter(data, "\n")
	if records[len(records)-1] == "" {
		records = records[:len(records)-1]
	}
	retained := make([]bool, len(records))
	var synthetic strings.Builder
	for index, record := range records {
		line := strings.Trim(record, " \t\r\n")
		if line == "" || strings.HasPrefix(line, "#") {
			synthetic.WriteByte('\n')
			continue
		}
		fields := strings.Fields(line)
		count := 3
		if strings.HasPrefix(fields[0], "@") {
			count = 4
		}
		if len(fields) < count {
			return "", errors.New("imported known_hosts data is invalid")
		}
		// Parse only the record header: comments may contain arbitrarily many words.
		marker, hosts, _, _, _, err := ssh.ParseKnownHosts([]byte(strings.Join(fields[:count], " ")))
		if err != nil {
			return "", errors.New("imported known_hosts data is invalid")
		}
		if marker == "revoked" {
			// The upstream verifier applies revocations globally, independent of names.
			retained[index] = true
			synthetic.WriteByte('\n')
		} else {
			// Strip CA semantics only in this matcher; keep the original output row.
			synthetic.WriteString(strings.Join(hosts, ","))
			synthetic.WriteByte(' ')
			synthetic.WriteString(keyText)
		}
	}
	if synthetic.Len() > MaxPlaintext/2 {
		return "", errors.New("host-key trust matcher exceeds its limit")
	}
	check, err := hostKeyCallback(synthetic.String())
	if err != nil {
		return "", err
	}
	remote := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 22}
	for _, profile := range profiles {
		address := profile.Address()
		if profile.HostKeyAlias != "" {
			address = profile.HostKeyAlias
			if _, _, err := net.SplitHostPort(address); err != nil {
				address = net.JoinHostPort(address, "22")
			}
		}
		var mismatch *knownhosts.KeyError
		if err := check(address, remote, probe); !errors.As(err, &mismatch) {
			return "", errors.New("could not match imported host-key trust data")
		}
		// A differs from every synthetic B, so Want contains all matching rows.
		for _, wanted := range mismatch.Want {
			if wanted.Line < 1 || wanted.Line > len(records) {
				return "", errors.New("invalid host-key trust matcher result")
			}
			retained[wanted.Line-1] = true
		}
	}
	var filtered strings.Builder
	for index, record := range records {
		if retained[index] {
			filtered.WriteString(record)
		}
	}
	return filtered.String(), nil
}
