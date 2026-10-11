package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"artiface/internal/sshvault"

	"golang.org/x/crypto/ssh"
)

func TestCredentialImportIncludesEncryptedKeysAndJumpOverrides(t *testing.T) {
	if _, err := exec.LookPath("ssh"); err != nil {
		t.Skip("OpenSSH is required")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	directory := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(filepath.Join(directory, "conf.d"), 0700); err != nil {
		t.Fatal(err)
	}
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	block, err := ssh.MarshalPrivateKeyWithPassphrase(private, "fixture", []byte("key-passphrase"))
	if err != nil {
		t.Fatal(err)
	}
	signer, _ := ssh.NewSignerFromKey(private)
	for name, contents := range map[string][]byte{
		"config":          []byte("Include conf.d/*.conf\n"),
		"key with space":  pem.EncodeToMemory(block),
		"known host keys": append([]byte("known-target,jump.example "), ssh.MarshalAuthorizedKey(signer.PublicKey())...),
		"conf.d/hosts.conf": []byte(`Host target
    HostName target.example
    User reader
    HostKeyAlias known-target
    IdentityFile "~/.ssh/key with space"
    UserKnownHostsFile "~/.ssh/known host keys"
    GlobalKnownHostsFile none
    ProxyJump reader@jump:2222
Host jump
    HostName jump.example
    User overridden-user
    Port 22
    IdentityFile none
    UserKnownHostsFile "~/.ssh/known host keys"
    GlobalKnownHostsFile none
`),
	} {
		if err := os.WriteFile(filepath.Join(directory, name), contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	bundle, aliases, err := ReadSSHCredentials("~/.ssh/config", []string{"target"}, []string{"reader@jump:2222"}, func(kind, alias string) ([]byte, error) {
		if kind == "password" && alias == "reader@jump:2222" {
			return []byte("ssh-login-password"), nil
		}
		if kind == "passphrase" && alias == "target" {
			return []byte("key-passphrase"), nil
		}
		t.Fatalf("unexpected secret request: %s for %s", kind, alias)
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer bundle.Clear()
	if len(aliases) != 1 || aliases[0] != "target" || len(bundle.Hosts) != 2 || len(bundle.Keys) != 1 {
		t.Fatal("import lost selected aliases or private key")
	}
	jump := bundle.Hosts["reader@jump:2222"]
	if jump.Hostname != "jump.example" || jump.User != "reader" || jump.Port != 2222 || string(jump.Password) != "ssh-login-password" {
		t.Fatal("jump-host overrides or password were not imported")
	}
	target := bundle.Hosts["target"]
	if target.HostKeyAlias != "known-target" || len(target.Keys) != 1 || len(bundle.KnownHosts) == 0 {
		t.Fatal("home-relative keys or host-key alias were not imported")
	}
	// A malformed key must fail before it replaces saved credentials.
	if err := os.WriteFile(filepath.Join(directory, "key with space"), []byte("not a private key"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadSSHCredentials("~/.ssh/config", []string{"target"}, nil, nil); err == nil {
		t.Fatal("unreadable credential was silently imported")
	}
}

func sshCredentialImportFixture(t *testing.T, options string) string {
	t.Helper()
	if _, err := exec.LookPath("ssh"); err != nil {
		t.Skip("OpenSSH is required")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	directory := filepath.Join(home, ".ssh")
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(private, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	sshFixture(t, filepath.Join(directory, "identity"), string(pem.EncodeToMemory(block)))
	sshFixture(t, filepath.Join(directory, "config"), `Host fixture
    HostName fixture.invalid
    User reader
    IdentityFile ~/.ssh/identity
    GlobalKnownHostsFile none
`+options)
	return directory
}

func TestCredentialImportWithoutKnownHostsPersists(t *testing.T) {
	for _, tc := range []struct {
		name, contents string
		present        bool
	}{
		{name: "missing"},
		{name: "empty", present: true},
		{name: "whitespace", present: true, contents: " \t\n\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory := sshCredentialImportFixture(t, "")
			if tc.present {
				sshFixture(t, filepath.Join(directory, "known_hosts"), tc.contents)
			}
			bundle, aliases, err := ReadSSHCredentials(filepath.Join(directory, "config"), nil, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer bundle.Clear()
			if len(aliases) != 1 || aliases[0] != "fixture" || len(bundle.Hosts) != 1 || len(bundle.Keys) != 1 {
				t.Fatal("import lost the host or its private key")
			}
			host := bundle.Hosts["fixture"]
			if data, exists := bundle.KnownHosts[host.KnownHosts]; !exists || data != "" || len(bundle.KnownHosts) != 1 {
				t.Fatal("import must retain an explicit empty trust set")
			}

			const password = "fixture-admin-password"
			cfg := validConfig()
			cfg.PasswordHash, err = HashPassword(password)
			if err != nil {
				t.Fatal(err)
			}
			filename := filepath.Join(t.TempDir(), "config.json")
			if err := Save(filename, cfg); err != nil {
				t.Fatal(err)
			}
			if _, count, err := MergeSSHCredentials(filename, password, bundle, aliases); err != nil || count != 1 {
				t.Fatalf("persist imported credentials: count=%d, error=%v", count, err)
			}
			saved, err := Load(filename)
			if err != nil {
				t.Fatal(err)
			}
			opened, err := sshvault.Open(saved.SSHCredentials, password)
			if err != nil {
				t.Fatal(err)
			}
			defer opened.Clear()
			if !reflect.DeepEqual(opened, bundle) {
				t.Fatal("persisted envelope lost the empty trust entry or imported credentials")
			}
		})
	}
}

func TestCredentialImportRejectsUnsafeInputsWithoutKnownHosts(t *testing.T) {
	for _, tc := range []struct {
		name, options, want string
		prepare             func(*testing.T, string)
	}{
		{name: "malformed trust", want: "known_hosts data is invalid", prepare: func(t *testing.T, directory string) {
			sshFixture(t, filepath.Join(directory, "known_hosts"), "fixture.invalid ssh-ed25519 not-base64\n")
		}},
		{name: "trust directory", want: "could not safely read an SSH known_hosts file", prepare: func(t *testing.T, directory string) {
			if err := os.Mkdir(filepath.Join(directory, "known_hosts"), 0700); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "trust path token", options: "UserKnownHostsFile ~/.ssh/%C\n", want: "unsupported SSH path token"},
		{name: "trust environment path", options: "UserKnownHostsFile \"${ARTIFACE_IMPORT_FIXTURE_TRUST}\"\n", want: "unsupported SSH identity or known_hosts path"},
		{name: "command trust", want: "does not support knownhostscommand", prepare: func(t *testing.T, directory string) {
			filename := filepath.Join(directory, "config")
			data, err := os.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			sshFixture(t, filename, string(data)+"KnownHostsCommand touch \""+filepath.Join(directory, "executed")+"\"\n")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory := sshCredentialImportFixture(t, tc.options)
			if tc.prepare != nil {
				tc.prepare(t, directory)
			}
			bundle, _, err := ReadSSHCredentials(filepath.Join(directory, "config"), nil, nil, nil)
			defer bundle.Clear()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("unsafe import: got %v, want %q", err, tc.want)
			}
			if _, err := os.Stat(filepath.Join(directory, "executed")); !os.IsNotExist(err) {
				t.Fatal("import executed a trust command")
			}
		})
	}
}
