package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"testing"

	"artiface/internal/sshvault"
)

func credentialFixture(marker byte) *sshvault.Envelope {
	// Storage tests need structurally valid opaque ciphertext, not SSH keys.
	return &sshvault.Envelope{Version: 1, Salt: bytes.Repeat([]byte{marker}, 16), Ciphertext: bytes.Repeat([]byte{marker}, 28)}
}

func TestSeparateCredentialsPublicationAndRecovery(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "config.json")
	cfg := validConfig()
	first, second := credentialFixture(1), credentialFixture(2)
	cfg.SSHCredentials = first
	if err := Create(filename, cfg); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(filename)
	if err != nil || !reflect.DeepEqual(cfg.SSHCredentials, first) {
		t.Fatal("separate credentials did not load", err)
	}
	raw, _ := os.ReadFile(filename)
	if bytes.Contains(raw, []byte(`"sshCredentials":`)) || bytes.Contains(raw, []byte(`"ciphertext"`)) ||
		bytes.Contains(raw, []byte(`"salt"`)) || cfg.SSHCredentialsRevision == "" {
		t.Fatal("configuration contains encrypted payload instead of a revision reference")
	}
	info, err := os.Stat(SSHCredentialsPath(filename))
	if err != nil || (runtime.GOOS == "linux" && info.Mode().Perm() != 0600) {
		t.Fatal("credential sidecar was not created privately", err)
	}
	sidecar, err := readSSHFile(filename)
	if err != nil || len(sidecar.Revisions) != 1 {
		t.Fatal("unexpected initial credential revisions", err)
	}
	if err := Create(filename, validConfig()); !errors.Is(err, os.ErrExist) {
		t.Fatal("initialization replaced existing configuration", err)
	}

	// Simulate interruption after publishing new encrypted data, before the
	// configuration commits the new password and credential reference.
	if err := prepareSSHCredentials(filename, cfg.SSHCredentialsRevision, second); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(filename)
	if err != nil || !reflect.DeepEqual(loaded, cfg) {
		t.Fatal("staged credentials changed the active configuration", err)
	}
	if err := CleanupSSHCredentials(filename); err != nil {
		t.Fatal(err)
	}
	sidecar, _ = readSSHFile(filename)
	if len(sidecar.Revisions) != 1 || sidecar.Revisions[cfg.SSHCredentialsRevision] == nil {
		t.Fatal("recovery did not discard the uncommitted revision")
	}

	// Now simulate interruption after the config commits but before cleanup.
	if err := prepareSSHCredentials(filename, cfg.SSHCredentialsRevision, second); err != nil {
		t.Fatal(err)
	}
	cfg.SSHCredentialsRevision = sshCredentialRevision(second)
	cfg.SSHCredentials = second
	cfg.PasswordHash, err = HashPassword("replacement-password")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(cfg)
	if err := os.WriteFile(filename, raw, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err = Load(filename)
	if err != nil || !reflect.DeepEqual(loaded, cfg) {
		t.Fatal("committed password and credentials diverged", err)
	}
	if err := CleanupSSHCredentials(filename); err != nil {
		t.Fatal(err)
	}
	sidecar, _ = readSSHFile(filename)
	if len(sidecar.Revisions) != 1 || sidecar.Revisions[sshCredentialRevision(first)] != nil {
		t.Fatal("recovery retained the previous password's encrypted data")
	}

	before, _ := os.ReadFile(SSHCredentialsPath(filename))
	if _, err := Update(filename, func(c *Config) error { c.SessionHours++; return nil }); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(SSHCredentialsPath(filename))
	if !bytes.Equal(before, after) {
		t.Fatal("an ordinary settings edit rewrote credentials")
	}
}

func TestCredentialSidecarSafetyAndExplicitRecovery(t *testing.T) {
	for _, damage := range []string{"missing", "corrupt", "symlink", "hardlink"} {
		t.Run(damage, func(t *testing.T) {
			if runtime.GOOS != "linux" && damage == "hardlink" {
				t.Skip("Linux file security")
			}
			filename := filepath.Join(t.TempDir(), "config.json")
			cfg := validConfig()
			cfg.SSHCredentials = credentialFixture(1)
			if err := Save(filename, cfg); err != nil {
				t.Fatal(err)
			}
			path := SSHCredentialsPath(filename)
			switch damage {
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "corrupt":
				if err := os.WriteFile(path, []byte(`{"unexpected":true}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Rename(path, path+".original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path+".original", path); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(path, path+".link"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := Load(filename); err == nil || errors.Is(err, os.ErrNotExist) {
				t.Fatal("damaged credentials were accepted or mistaken for first-time setup", err)
			}
			before, _ := os.ReadFile(filename)
			if _, err := Update(filename, func(c *Config) error { c.SessionHours++; return nil }); err == nil {
				t.Fatal("normal update ignored damaged credentials")
			}
			after, _ := os.ReadFile(filename)
			if !bytes.Equal(before, after) {
				t.Fatal("failed update changed configuration")
			}
			err := ForgetSSH(filename, cfg.PasswordHash, cfg.PasswordHash)
			if damage == "missing" || damage == "corrupt" {
				if err != nil {
					t.Fatal("explicit recovery failed", err)
				}
				recovered, err := Load(filename)
				if err != nil || recovered.SSHCredentials != nil || recovered.SSHCredentialsRevision != "" ||
					!reflect.DeepEqual(recovered.Hosts, cfg.Hosts) {
					t.Fatal("recovery lost projects or retained credentials", err)
				}
				if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("recovery left credential file")
				}
			} else if err == nil {
				t.Fatal("recovery followed or replaced an unsafe credential path")
			}
		})
	}
}

func TestConcurrentCredentialReadsStayConsistent(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "config.json")
	cfg := validConfig()
	cfg.SSHCredentials = credentialFixture(1)
	if err := Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	var readers sync.WaitGroup
	done := make(chan struct{})
	for range 3 {
		readers.Go(func() {
			for {
				select {
				case <-done:
					return
				default:
				}
				snapshot, err := Load(filename)
				if errors.Is(err, ErrConflict) {
					continue
				}
				if err != nil || snapshot.SSHCredentials == nil || snapshot.SSHCredentialsRevision != sshCredentialRevision(snapshot.SSHCredentials) {
					t.Errorf("inconsistent credential snapshot: %v", err)
					return
				}
			}
		})
	}
	for i := range 24 {
		if _, err := Update(filename, func(c *Config) error { c.SSHCredentials = credentialFixture(byte(i + 2)); return nil }); err != nil {
			t.Error(err)
			break
		}
	}
	close(done)
	readers.Wait()
}

func TestCredentialStoragePreservesUnrecognizedFile(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "config.json")
	path := SSHCredentialsPath(filename)
	unrelated := []byte(`{"anotherFile":true}`)
	if err := os.WriteFile(path, unrelated, 0600); err != nil {
		t.Fatal(err)
	}
	if err := Create(filename, validConfig()); err != nil {
		t.Fatal(err)
	}
	if err := CleanupSSHCredentials(filename); err == nil {
		t.Fatal("automatic cleanup accepted an unrecognized file")
	}
	before, _ := os.ReadFile(filename)
	_, err := Update(filename, func(c *Config) error {
		c.SSHCredentials = credentialFixture(1)
		return nil
	})
	if err == nil {
		t.Fatal("credential import replaced an unrecognized file")
	}
	after, _ := os.ReadFile(filename)
	retained, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) || !bytes.Equal(unrelated, retained) {
		t.Fatal("failed import or cleanup changed existing files")
	}
}
