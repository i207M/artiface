package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"artiface/internal/config"
	"artiface/internal/sshvault"
	"golang.org/x/crypto/ssh"
)

func sshImportFixture(t *testing.T) (filename, source string) {
	t.Helper()
	if _, err := exec.LookPath("ssh"); err != nil {
		t.Skip("OpenSSH is required for credential import")
	}
	dir := t.TempDir()
	filename, source = filepath.Join(dir, "app.json"), filepath.Join(dir, "ssh-config")
	keyFile, knownFile := filepath.Join(dir, "identity"), filepath.Join(dir, "known_hosts")
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := ssh.MarshalPrivateKey(private, "fixture")
	key := pem.EncodeToMemory(block)
	signer, _ := ssh.NewSignerFromKey(private)
	for name, content := range map[string][]byte{
		keyFile:   key,
		knownFile: append([]byte("fixture.example "), ssh.MarshalAuthorizedKey(signer.PublicKey())...),
		source:    []byte("Host alpha beta\n HostName fixture.example\n User reader\n IdentityFile " + keyFile + "\n UserKnownHostsFile " + knownFile + "\n"),
	} {
		if err := os.WriteFile(name, content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return filename, source
}

func TestEncryptedSSHImportAndPasswordRecovery(t *testing.T) {
	filename, source := sshImportFixture(t)
	var output bytes.Buffer
	for attempt := range 2 {
		t.Setenv("ARTIFACE_PASSWORD", "admin-fixture-password")
		if err := run([]string{"import-ssh", "--config", filename, "--ssh-config", source}, nil, &output, &output); err != nil {
			t.Fatal(err)
		}
		cfg, err := config.Load(filename)
		if err != nil || len(cfg.Hosts) != 3 || cfg.Hosts[0].Kind != "local" || cfg.SSHCredentials == nil {
			t.Fatal("import did not create encrypted sources", err)
		}
		bundle, err := sshvault.Open(cfg.SSHCredentials, "admin-fixture-password")
		if err != nil {
			t.Fatal(err)
		}
		if len(bundle.Hosts) != 2 || len(bundle.Keys) != 1 {
			t.Fatal("identities were not shared across aliases")
		}
		bundle.Clear()
		if attempt == 0 {
			_, err = config.Update(filename, func(cfg *config.Config) error {
				cfg.Hosts[1].Roots = []config.Root{{ID: "notes", Label: "Notes", Path: "/notes"}}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		} else if len(cfg.Hosts[1].Roots) != 1 {
			t.Fatal("repeat import discarded a saved project")
		}
		data, _ := os.ReadFile(filename)
		if bytes.Contains(data, []byte("PRIVATE KEY")) || bytes.Contains(data, []byte("fixture.example")) || bytes.Contains(data, []byte("admin-fixture-password")) ||
			bytes.Contains(data, []byte(`"sshCredentials":`)) || bytes.Contains(data, []byte(`"ciphertext"`)) {
			t.Fatal("config leaked imported credentials")
		}
		if info, err := os.Stat(config.SSHCredentialsPath(filename)); err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("credential sidecar is missing or not private", err)
		}
	}
	if strings.Contains(output.String(), "admin-fixture-password") || strings.Contains(output.String(), "PRIVATE KEY") {
		t.Fatal("command output leaked credentials")
	}
	before, _ := os.ReadFile(filename)
	t.Setenv("ARTIFACE_PASSWORD", "wrong-password")
	if err := run([]string{"import-ssh", "--config", filename, "--ssh-config", source}, nil, &output, &output); err == nil {
		t.Fatal("import accepted wrong admin password")
	}
	after, _ := os.ReadFile(filename)
	if !bytes.Equal(before, after) {
		t.Fatal("failed import modified configuration")
	}
	t.Setenv("ARTIFACE_CURRENT_PASSWORD", "admin-fixture-password")
	t.Setenv("ARTIFACE_PASSWORD", "changed-admin-password")
	if err := run([]string{"password", "--config", filename}, nil, &output, &output); err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.Load(filename)
	if _, err := sshvault.Open(cfg.SSHCredentials, "admin-fixture-password"); err == nil {
		t.Fatal("old password still decrypted credentials")
	}
	bundle, err := sshvault.Open(cfg.SSHCredentials, "changed-admin-password")
	if err != nil {
		t.Fatal(err)
	}
	bundle.Clear()
	before, _ = os.ReadFile(filename)
	t.Setenv("ARTIFACE_PASSWORD", "reset-without-current")
	if err := run([]string{"password", "--config", filename}, nil, &output, &output); err == nil {
		t.Fatal("recovery silently discarded encrypted credentials")
	}
	after, _ = os.ReadFile(filename)
	if !bytes.Equal(before, after) {
		t.Fatal("failed recovery modified configuration")
	}
	t.Setenv("ARTIFACE_PASSWORD", "recovered-password")
	if err := run([]string{"password", "--config", filename, "--forget-ssh"}, nil, &output, &output); err != nil {
		t.Fatal(err)
	}
	reset, _ := config.Load(filename)
	if reset.SSHCredentials != nil || !reflect.DeepEqual(reset.Hosts, cfg.Hosts) || !config.VerifyPassword(reset.PasswordHash, "recovered-password") {
		t.Fatal("explicit credential recovery lost sources or failed")
	}
	if _, err := os.Lstat(config.SSHCredentialsPath(filename)); !os.IsNotExist(err) {
		t.Fatal("explicit recovery left the encrypted credential file")
	}
}

func TestSSHImportRejectsExecutableConfigWithoutLaunchingSSH(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "executed")
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	source := filepath.Join(dir, "config")
	for _, directive := range []string{"Match exec", "ProxyCommand", "KnownHostsCommand", "HostKeyAlgorithms", "Ciphers"} {
		if err := os.WriteFile(source, []byte("Host demo\n"+directive+" touch "+marker+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := config.ReadSSHCredentials(source, nil, nil, nil); err == nil {
			t.Fatal("executable configuration accepted")
		}
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatal("SSH configuration executed during import")
		}
	}
}
