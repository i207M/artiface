package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"artiface/internal/config"
	"artiface/internal/sshvault"
	"artiface/internal/storage"

	"golang.org/x/crypto/ssh"
)

func hostKeyProbeServer(t *testing.T) (string, ssh.PublicKey) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	options := &ssh.ServerConfig{NoClientAuth: true}
	options.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	workers.Go(func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Go(func() {
				defer conn.Close()
				server, _, _, err := ssh.NewServerConn(conn, options)
				if err == nil {
					server.Close()
				}
			})
		}
	})
	t.Cleanup(func() { listener.Close(); workers.Wait() })
	return listener.Addr().String(), signer.PublicKey()
}

func TestSSHHostKeyApprovalAccessPersistenceAndStaleImports(t *testing.T) {
	for _, mode := range []string{"personal", "team"} {
		t.Run(mode, func(t *testing.T) {
			base, _ := newTestApp(t)
			cfg := base.cfg
			cfg.Mode = mode
			cfg.Users = []config.User{{ID: "reader", Username: "reader", PasswordHash: cfg.PasswordHash,
				Projects: []config.ProjectRef{{Host: "test", Root: "artifacts"}}}}
			address, key := hostKeyProbeServer(t)
			host, port, _ := net.SplitHostPort(address)
			number, _ := strconv.Atoi(port)
			bundle := sshvault.Bundle{
				Hosts: map[string]sshvault.Profile{"test-alias": {
					Hostname: host, Port: number, User: "reader", Password: []byte("private-ssh-password"), KnownHosts: "trust",
				}},
				Keys: map[string][]byte{}, KnownHosts: map[string]string{"trust": ""},
			}
			defer bundle.Clear()
			var err error
			cfg.SSHCredentials, err = sshvault.Seal(bundle, testPassword)
			if err != nil {
				t.Fatal(err)
			}
			filename := filepath.Join(t.TempDir(), "config.json")
			if err := config.Save(filename, cfg); err != nil {
				t.Fatal(err)
			}
			runtime := sshvault.NewRuntime(cfg.SSHCredentials, false)
			store := storage.NewWithSSH(runtime.DialSFTP)
			defer store.Close()
			app, err := New(cfg, store, base.assets, WithConfigFile(filename), WithSSHCredentials(runtime))
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			prefix := "/api/"
			var owner *http.Cookie
			var csrf string
			if mode == "team" {
				prefix = "/api/admin/"
				owner, csrf = teamSignIn(t, app, "", testPassword, true)
			} else {
				owner, csrf = signIn(t, app)
			}
			_, failure := app.sshCredentials.DialSFTP(context.Background(), "test-alias")
			var challenge *sshvault.HostKeyError
			if !errors.As(failure, &challenge) {
				t.Fatal("fixture failed to capture an unknown host key", failure)
			}
			if mode == "personal" {
				w := request(app, "GET", "/api/list"+fileQuery(""), nil, owner, "")
				var result struct {
					SSHHostKey struct{ Token string } `json:"sshHostKey"`
				}
				if json.Unmarshal(w.Body.Bytes(), &result) != nil || w.Code != http.StatusConflict || result.SSHHostKey.Token != challenge.Token {
					t.Fatal("file failure did not carry the confirmation token", w.Code, w.Body.String())
				}
				w = request(app, "GET", "/api/git/status"+fileQuery(""), nil, owner, "")
				if json.Unmarshal(w.Body.Bytes(), &result) != nil || w.Code != http.StatusConflict || result.SSHHostKey.Token != challenge.Token {
					t.Fatal("Git failure did not carry the confirmation token", w.Code, w.Body.String())
				}
				if len(app.git.cache) != 0 {
					t.Fatal("Git cached an unapproved host-key failure")
				}
			}
			body := map[string]string{"token": challenge.Token}
			accept := map[string]string{"token": challenge.Token, "password": testPassword}
			for _, endpoint := range []string{"ssh/host-key", "ssh/host-key/accept"} {
				if w := request(app, "POST", prefix+endpoint, accept, nil, ""); w.Code != http.StatusUnauthorized {
					t.Fatal("anonymous host-key access accepted")
				}
				if w := request(app, "POST", prefix+endpoint, accept, owner, "wrong-csrf"); w.Code != http.StatusForbidden {
					t.Fatal("host-key operation did not enforce CSRF")
				}
			}
			if mode == "team" {
				reader, readerCSRF := teamSignIn(t, app, "reader", testPassword, false)
				for _, endpoint := range []string{"/api/ssh/host-key", "/api/ssh/host-key/accept", "/api/admin/ssh/host-key", "/api/admin/ssh/host-key/accept"} {
					if w := request(app, "POST", endpoint, accept, reader, readerCSRF); w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
						t.Fatal("team user could inspect or approve a host key", w.Code)
					}
				}
			}
			w := request(app, "POST", prefix+"ssh/host-key", body, owner, csrf)
			var prompt sshvault.HostKeyPrompt
			if json.Unmarshal(w.Body.Bytes(), &prompt) != nil || w.Code != http.StatusOK ||
				prompt.Fingerprint != ssh.FingerprintSHA256(key) || prompt.Address != address {
				t.Fatal("admin did not receive the observed fingerprint", w.Code, w.Body.String())
			}
			before, _ := os.ReadFile(config.SSHCredentialsPath(filename))
			w = request(app, "POST", prefix+"ssh/host-key/accept", map[string]string{"token": challenge.Token, "password": "incorrect-password"}, owner, csrf)
			after, _ := os.ReadFile(config.SSHCredentialsPath(filename))
			if w.Code != http.StatusForbidden || !bytes.Equal(before, after) {
				t.Fatal("wrong password changed persisted trust")
			}
			w = request(app, "POST", prefix+"ssh/host-key/accept", accept, owner, csrf)
			if w.Code != http.StatusNoContent {
				t.Fatal("owner approval failed", w.Code, w.Body.String())
			}
			saved, err := config.Load(filename)
			if err != nil {
				t.Fatal(err)
			}
			opened, err := sshvault.Open(saved.SSHCredentials, testPassword)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(opened.Hosts["test-alias"].ApprovedHostKey, key.Marshal()) {
				t.Fatal("approval did not persist the exact offered key")
			}
			opened.Clear()
			if !app.sshCredentials.Matches(saved.SSHCredentials) {
				t.Fatal("successful approval left runtime behind disk")
			}
			if w := request(app, "POST", prefix+"ssh/host-key/accept", accept, owner, csrf); w.Code != http.StatusConflict {
				t.Fatal("accepted token was replayable", w.Code)
			}

			// A command-line import may happen between showing and accepting a
			// fingerprint. It must not be overwritten by that old confirmation.
			cfg.SSHCredentials, err = sshvault.Seal(bundle, testPassword)
			if err != nil {
				t.Fatal(err)
			}
			other := sshvault.NewRuntime(cfg.SSHCredentials, false)
			defer other.Close()
			app.sshCredentials.Close()
			app.sshCredentials = other
			if err := other.Unlock(testPassword); err != nil {
				t.Fatal(err)
			}
			_, failure = other.DialSFTP(context.Background(), "test-alias")
			if !errors.As(failure, &challenge) {
				t.Fatal(failure)
			}
			before, _ = os.ReadFile(config.SSHCredentialsPath(filename))
			w = request(app, "POST", prefix+"ssh/host-key/accept", map[string]string{"token": challenge.Token, "password": testPassword}, owner, csrf)
			after, _ = os.ReadFile(config.SSHCredentialsPath(filename))
			if w.Code != http.StatusConflict || !bytes.Equal(before, after) {
				t.Fatal("stale runtime overwrote a newer encrypted file", w.Code)
			}
		})
	}
}
