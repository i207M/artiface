package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"artiface/internal/sshvault"
)

const maxSSHFileBytes = 2 << 20

// A sidecar normally has one revision. During publication it also retains the
// revision referenced by the old config, making either config snapshot usable.
type sshFile struct {
	Revisions map[string]*sshvault.Envelope `json:"revisions"`
}

func SSHCredentialsPath(filename string) string {
	return strings.TrimSuffix(filename, filepath.Ext(filename)) + ".ssh.json"
}

func sshCredentialRevision(envelope *sshvault.Envelope) string {
	if envelope == nil {
		return ""
	}
	data, _ := json.Marshal(envelope)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func validSSHRevision(revision string) bool {
	if len(revision) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(revision)
	return err == nil && hex.EncodeToString(decoded) == revision
}

func readSSHFile(filename string) (sshFile, error) {
	if err := checkSSHFileTarget(filename); err != nil {
		return sshFile{}, err
	}
	file, err := openConfigFile(SSHCredentialsPath(filename))
	if err != nil {
		return sshFile{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !singleFileLink(info) {
		return sshFile{}, errors.New("SSH credential file must be a regular file without links")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxSSHFileBytes+1))
	if err != nil || len(data) > maxSSHFileBytes {
		return sshFile{}, errors.New("SSH credential file is unreadable or exceeds its size limit")
	}
	var result sshFile
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF ||
		len(result.Revisions) == 0 || len(result.Revisions) > 2 {
		return sshFile{}, errors.New("invalid SSH credential file")
	}
	for revision, envelope := range result.Revisions {
		if envelope == nil || envelope.Validate() != nil || !validSSHRevision(revision) ||
			sshCredentialRevision(envelope) != revision {
			return sshFile{}, errors.New("invalid SSH credential revision")
		}
	}
	return result, nil
}

func loadSSHCredentials(filename, revision string) (*sshvault.Envelope, error) {
	if revision == "" {
		return nil, nil
	}
	file, err := readSSHFile(filename)
	if err != nil {
		// A missing sidecar is not a missing configuration: callers must not
		// accidentally enter first-time password setup for an existing app.
		return nil, fmt.Errorf("could not load SSH credentials from %s: %v", SSHCredentialsPath(filename), err)
	}
	envelope, ok := file.Revisions[revision]
	if !ok {
		return nil, errors.New("SSH credential file does not contain the configured revision")
	}
	return envelope, nil
}

func checkSSHFileTarget(filename string) error {
	info, err := os.Lstat(SSHCredentialsPath(filename))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !singleFileLink(info) {
		return errors.New("SSH credential file must be a regular file without links")
	}
	return nil
}

func writeSSHFile(filename string, file sshFile) error {
	if err := checkSSHFileTarget(filename); err != nil {
		return err
	}
	if _, err := readSSHFile(filename); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil || len(data)+1 > maxSSHFileBytes {
		return errors.New("SSH credential file exceeds its size limit")
	}
	dir := filepath.Dir(filename)
	temporary, err := os.CreateTemp(dir, ".artiface-ssh-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	defer temporary.Close()
	if err = temporary.Chmod(0o600); err == nil {
		_, err = temporary.Write(append(data, '\n'))
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), SSHCredentialsPath(filename)); err != nil {
		return err
	}
	// Make the new encrypted revision durable before publishing its reference.
	return syncConfigDirectory(dir)
}

func prepareSSHCredentials(filename, previous string, envelope *sshvault.Envelope) error {
	revision := sshCredentialRevision(envelope)
	if revision == previous {
		return nil
	}
	if revision == "" {
		return checkSSHFileTarget(filename)
	}
	revisions := map[string]*sshvault.Envelope{revision: envelope}
	if previous != "" {
		old, err := loadSSHCredentials(filename, previous)
		if err != nil {
			return err
		}
		revisions[previous] = old
	}
	return writeSSHFile(filename, sshFile{Revisions: revisions})
}

func pruneSSHCredentials(filename, revision string) error {
	if revision == "" {
		if _, err := readSSHFile(filename); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		return removeSSHCredentials(filename)
	}
	file, err := readSSHFile(filename)
	if err != nil {
		return err
	}
	envelope, exists := file.Revisions[revision]
	if !exists {
		return errors.New("SSH credential file does not contain the configured revision")
	}
	if len(file.Revisions) == 1 {
		return nil
	}
	return writeSSHFile(filename, sshFile{Revisions: map[string]*sshvault.Envelope{revision: envelope}})
}

func removeSSHCredentials(filename string) error {
	if err := checkSSHFileTarget(filename); err != nil {
		return err
	}
	if err := os.Remove(SSHCredentialsPath(filename)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return syncConfigDirectory(filepath.Dir(filename))
}

// CleanupSSHCredentials retires a staged or previous revision left by an
// interrupted update, using the configuration as the publication authority.
func CleanupSSHCredentials(filename string) error {
	updateMu.Lock()
	defer updateMu.Unlock()
	unlock, err := lockConfigUpdate(filename)
	if err != nil {
		return err
	}
	defer unlock()
	cfg, err := LoadSettings(filename)
	if err != nil {
		return err
	}
	return pruneSSHCredentials(filename, cfg.SSHCredentialsRevision)
}

// ForgetSSH supports explicit password recovery even with a missing or damaged
// encrypted file. Unknown configuration fields still fail normal validation.
func ForgetSSH(filename, expectedHash, newHash string) error {
	updateMu.Lock()
	defer updateMu.Unlock()
	unlock, err := lockConfigUpdate(filename)
	if err != nil {
		return err
	}
	defer unlock()
	data, err := readConfig(filename)
	if err != nil {
		return err
	}
	cfg, err := parseConfig(data)
	if err != nil {
		return err
	}
	if cfg.PasswordHash != expectedHash {
		return ErrConflict
	}
	cfg.PasswordHash = newHash
	if err := save(filename, &cfg, data, false); err != nil {
		return err
	}
	// Explicit recovery may remove damaged encrypted JSON; automatic cleanup
	// must only remove files it recognizes as our credential store.
	return removeSSHCredentials(filename)
}
