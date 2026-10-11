package server

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"artiface/internal/config"
	"artiface/internal/sshvault"

	"golang.org/x/crypto/ssh"
)

func newSSHHostApp(t *testing.T, mode string, disabled bool) (*App, string) {
	t.Helper()
	base, store := newTestApp(t)
	cfg := base.cfg
	cfg.Mode = mode
	if mode == "team" {
		cfg.Users = []config.User{{ID: "reader", Username: "reader", PasswordHash: cfg.PasswordHash}}
	}
	filename := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	app, err := New(cfg, store, base.assets, WithConfigFile(filename), WithSSHCredentials(sshvault.NewRuntime(nil, disabled)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return app, filename
}

func sshHostBody(alias string) map[string]any {
	return map[string]any{
		"alias": alias, "hostname": "fixture.invalid", "user": "reader", "port": 2222,
		"sshPassword": "fixture-ssh-password", "adminPassword": testPassword,
	}
}

func sshHostKeyFixture(t *testing.T, passphrase string) (string, ssh.PublicKey) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var block *pem.Block
	if passphrase == "" {
		block, err = ssh.MarshalPrivateKey(private, "fixture")
	} else {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(private, "fixture", []byte(passphrase))
	}
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(block)), signer.PublicKey()
}

func noSSHHostSecrets(t *testing.T, response *httptest.ResponseRecorder, body map[string]any) {
	t.Helper()
	for _, field := range []string{"sshPassword", "privateKey", "keyPassphrase", "adminPassword"} {
		if secret, ok := body[field].(string); ok && secret != "" && strings.Contains(response.Body.String(), secret) {
			t.Fatalf("response exposed %s", field)
		}
	}
}

func TestAddSSHHostPasswordPersistsAndActivatesForOwners(t *testing.T) {
	for _, mode := range []string{"personal", "team"} {
		t.Run(mode, func(t *testing.T) {
			app, filename := newSSHHostApp(t, mode, false)
			var cookie *http.Cookie
			var csrf string
			endpoint := "/api/ssh/hosts"
			if mode == "team" {
				cookie, csrf = teamSignIn(t, app, "", testPassword, true)
				endpoint = "/api/admin/ssh/hosts"
			} else {
				cookie, csrf = signIn(t, app)
			}
			body := sshHostBody("web-host")
			body["sshPassword"] = strings.Repeat("p", 4096)
			w := request(app, "POST", endpoint, body, cookie, csrf)
			noSSHHostSecrets(t, w, body)
			var response struct {
				Host config.Host `json:"host"`
			}
			if w.Code != http.StatusCreated || json.Unmarshal(w.Body.Bytes(), &response) != nil {
				t.Fatalf("create host: status %d", w.Code)
			}
			host := response.Host
			if host.ID == "" || host.Target != "web-host" || host.Roots == nil || len(host.Roots) != 0 {
				t.Fatal("host was not published before adding projects")
			}
			saved, err := config.Load(filename)
			if err != nil {
				t.Fatal(err)
			}
			if len(saved.Hosts) != 2 || !reflect.DeepEqual(saved.Hosts[1], host) ||
				!reflect.DeepEqual(app.hostSnapshot(), saved.Hosts) || !app.sshCredentials.Matches(saved.SSHCredentials) || app.sshCredentials.Locked() {
				t.Fatal("saved sources and live credentials diverged")
			}
			bundle, err := sshvault.Open(saved.SSHCredentials, testPassword)
			if err != nil {
				t.Fatal(err)
			}
			defer bundle.Clear()
			profile := bundle.Hosts["web-host"]
			if profile.Hostname != "fixture.invalid" || profile.User != "reader" || profile.Port != 2222 ||
				string(profile.Password) != body["sshPassword"] || len(profile.Keys) != 0 || len(profile.ApprovedHostKey) != 0 {
				t.Fatal("saved credentials or initial trust changed")
			}
			if trust, exists := bundle.KnownHosts[profile.KnownHosts]; !exists || trust != "" {
				t.Fatal("new host did not start with an explicit empty trust set")
			}
			for _, path := range []string{filename, config.SSHCredentialsPath(filename)} {
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if bytes.Contains(data, []byte(body["sshPassword"].(string))) {
					t.Fatal("SSH password persisted outside encryption")
				}
			}
		})
	}
}

func TestAddSSHHostPrivateKeysAndImportedJump(t *testing.T) {
	app, filename := newSSHHostApp(t, "personal", false)
	cookie, csrf := signIn(t, app)
	if w := request(app, "POST", "/api/ssh/hosts", sshHostBody("jump"), cookie, csrf); w.Code != http.StatusCreated {
		t.Fatalf("create jump host: status %d", w.Code)
	}
	for _, tc := range []struct{ name, passphrase string }{{"plain-key", ""}, {"encrypted-key", "fixture-key-passphrase"}} {
		t.Run(tc.name, func(t *testing.T) {
			key, public := sshHostKeyFixture(t, tc.passphrase)
			body := sshHostBody(tc.name)
			delete(body, "sshPassword")
			body["privateKey"], body["keyPassphrase"], body["jump"] = key, tc.passphrase, "jump"
			w := request(app, "POST", "/api/ssh/hosts", body, cookie, csrf)
			noSSHHostSecrets(t, w, body)
			if w.Code != http.StatusCreated {
				t.Fatalf("create key host: status %d", w.Code)
			}
			saved, err := config.Load(filename)
			if err != nil {
				t.Fatal(err)
			}
			bundle, err := sshvault.Open(saved.SSHCredentials, testPassword)
			if err != nil {
				t.Fatal(err)
			}
			defer bundle.Clear()
			profile := bundle.Hosts[tc.name]
			if len(profile.Keys) != 1 || len(profile.Password) != 0 || !reflect.DeepEqual(profile.Jumps, []string{"jump"}) ||
				string(bundle.Hosts["jump"].Password) != "fixture-ssh-password" {
				t.Fatal("key import lost its jump or existing credentials")
			}
			signer, err := ssh.ParsePrivateKey(bundle.Keys[profile.Keys[0]])
			if err != nil || !bytes.Equal(signer.PublicKey().Marshal(), public.Marshal()) {
				t.Fatal("private key was not normalized inside the encrypted bundle")
			}
			raw, err := os.ReadFile(config.SSHCredentialsPath(filename))
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(raw, []byte("PRIVATE KEY")) || bytes.Contains(raw, []byte("fixture-key-passphrase")) {
				t.Fatal("private key or passphrase was stored in plaintext")
			}
			if !app.sshCredentials.Matches(saved.SSHCredentials) || app.sshCredentials.Locked() {
				t.Fatal("new key credentials were not activated")
			}
		})
	}
}

func TestAddSSHHostRejectsInvalidCredentialsWithoutMutation(t *testing.T) {
	app, filename := newSSHHostApp(t, "personal", false)
	cookie, csrf := signIn(t, app)
	key, _ := sshHostKeyFixture(t, "")
	encrypted, _ := sshHostKeyFixture(t, "fixture-key-passphrase")
	// Supplying no credentials must not fall back to the process's SSH home or agent.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SSH_AUTH_SOCK", filepath.Join(home, "agent"))
	if err := os.Mkdir(filepath.Join(home, ".ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".ssh", "id_ed25519"), []byte(key), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		values map[string]any
		status int
	}{
		{"no authentication", map[string]any{"sshPassword": ""}, 400},
		{"two authentication methods", map[string]any{"privateKey": key}, 400},
		{"malformed private key", map[string]any{"sshPassword": "", "privateKey": "fixture-private-key-secret"}, 400},
		{"key path is not key data", map[string]any{"sshPassword": "", "privateKey": filepath.Join(home, ".ssh", "id_ed25519")}, 400},
		{"encrypted key needs passphrase", map[string]any{"sshPassword": "", "privateKey": encrypted}, 400},
		{"wrong key passphrase", map[string]any{"sshPassword": "", "privateKey": encrypted, "keyPassphrase": "incorrect-key-passphrase"}, 400},
		{"password bound", map[string]any{"sshPassword": strings.Repeat("x", 4097)}, 400},
		{"key bound", map[string]any{"sshPassword": "", "privateKey": strings.Repeat("x", (32<<10)+1)}, 400},
		{"passphrase bound", map[string]any{"sshPassword": "", "privateKey": encrypted, "keyPassphrase": strings.Repeat("x", 4097)}, 400},
		{"request bound", map[string]any{"sshPassword": strings.Repeat("x", 64<<10)}, 400},
		{"alias option", map[string]any{"alias": "-oProxyCommand=bad"}, 400},
		{"alias path", map[string]any{"alias": "../host"}, 400},
		{"hostname whitespace", map[string]any{"hostname": "host invalid"}, 400},
		{"empty user", map[string]any{"user": ""}, 400},
		{"invalid user", map[string]any{"user": "reader\ncommand"}, 400},
		{"missing port", map[string]any{"port": 0}, 400},
		{"port bound", map[string]any{"port": 65536}, 400},
		{"missing jump", map[string]any{"jump": "absent"}, 400},
		{"configured but unimported jump", map[string]any{"jump": "test-alias"}, 400},
		{"jump cycle", map[string]any{"jump": "web-host"}, 400},
		{"client supplied trust", map[string]any{"knownHosts": "trust-me"}, 400},
		{"missing admin password", map[string]any{"adminPassword": ""}, 403},
		{"wrong admin password", map[string]any{"adminPassword": "incorrect-admin-password"}, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := sshHostBody("web-host")
			for field, value := range tc.values {
				body[field] = value
			}
			w := request(app, "POST", "/api/ssh/hosts", body, cookie, csrf)
			noSSHHostSecrets(t, w, body)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d", w.Code, tc.status)
			}
			after, err := os.ReadFile(filename)
			if err != nil || !bytes.Equal(before, after) || !app.sshCredentials.Matches(nil) || len(app.hostSnapshot()) != 1 {
				t.Fatal("rejected request changed sources or credentials")
			}
			if _, err := os.Stat(config.SSHCredentialsPath(filename)); !os.IsNotExist(err) {
				t.Fatal("rejected request published an encrypted vault")
			}
		})
	}
}

func TestAddSSHHostPermissionsDisabledAndPasswordThrottle(t *testing.T) {
	for _, mode := range []string{"personal", "team"} {
		t.Run(mode, func(t *testing.T) {
			app, filename := newSSHHostApp(t, mode, false)
			body := sshHostBody("web-host")
			var owner *http.Cookie
			var csrf string
			endpoint := "/api/ssh/hosts"
			if mode == "team" {
				user, token := teamSignIn(t, app, "reader", testPassword, false)
				if w := request(app, "POST", endpoint, body, user, token); w.Code != 403 {
					t.Fatalf("team user could add a host: %d", w.Code)
				}
				if w := request(app, "POST", "/api/admin/ssh/hosts", body, user, token); w.Code != 401 {
					t.Fatalf("workspace cookie reached admin host setup: %d", w.Code)
				}
				owner, csrf = teamSignIn(t, app, "", testPassword, true)
				if w := request(app, "POST", endpoint, body, owner, csrf); w.Code != 401 {
					t.Fatalf("admin cookie crossed into workspace route: %d", w.Code)
				}
				endpoint = "/api/admin/ssh/hosts"
			} else {
				owner, csrf = signIn(t, app)
			}
			for _, token := range []string{"", "invalid"} {
				if w := request(app, "POST", endpoint, body, owner, token); w.Code != 403 {
					t.Fatalf("missing CSRF protection: %d", w.Code)
				}
			}
			if w := request(app, "POST", endpoint, body, nil, ""); w.Code != 401 {
				t.Fatalf("anonymous host setup: %d", w.Code)
			}
			app.loginBusy <- struct{}{}
			busy := request(app, "POST", endpoint, body, owner, csrf)
			<-app.loginBusy
			if busy.Code != 429 {
				t.Fatalf("password work slot was bypassed: %d", busy.Code)
			}
			body["adminPassword"] = "incorrect-admin-password"
			for range 5 {
				if w := request(app, "POST", endpoint, body, owner, csrf); w.Code != 403 {
					t.Fatalf("bad password: %d", w.Code)
				}
			}
			body["adminPassword"] = testPassword
			if w := request(app, "POST", endpoint, body, owner, csrf); w.Code != 429 {
				t.Fatalf("password failure throttle was bypassed: %d", w.Code)
			}
			saved, err := config.Load(filename)
			if err != nil || saved.SSHCredentials != nil || len(saved.Hosts) != 1 || !app.sshCredentials.Matches(nil) {
				t.Fatal("denied setup changed credentials or sources")
			}

			disabled, disabledFile := newSSHHostApp(t, mode, true)
			if mode == "team" {
				owner, csrf = teamSignIn(t, disabled, "", testPassword, true)
			} else {
				owner, csrf = signIn(t, disabled)
			}
			if w := request(disabled, "POST", endpoint, body, owner, csrf); w.Code != 503 {
				t.Fatalf("disabled SSH accepted setup: %d", w.Code)
			}
			saved, err = config.Load(disabledFile)
			if err != nil || saved.SSHCredentials != nil || len(saved.Hosts) != 1 {
				t.Fatal("disabled setup wrote credentials or sources")
			}
		})
	}
}

func TestAddSSHHostConflictsAndPersistenceFailureDoNotActivate(t *testing.T) {
	t.Run("configured target", func(t *testing.T) {
		app, filename := newSSHHostApp(t, "personal", false)
		cookie, csrf := signIn(t, app)
		if w := request(app, "POST", "/api/ssh/hosts", sshHostBody("test-alias"), cookie, csrf); w.Code != 409 {
			t.Fatalf("configured target overwritten: %d", w.Code)
		}
		saved, err := config.Load(filename)
		if err != nil || saved.SSHCredentials != nil || len(saved.Hosts) != 1 || !app.sshCredentials.Matches(nil) {
			t.Fatal("duplicate target activated or persisted credentials")
		}
	})
	t.Run("existing credential", func(t *testing.T) {
		app, filename := newSSHHostApp(t, "personal", false)
		cookie, csrf := signIn(t, app)
		body := sshHostBody("web-host")
		if w := request(app, "POST", "/api/ssh/hosts", body, cookie, csrf); w.Code != 201 {
			t.Fatalf("initial host: %d", w.Code)
		}
		before, err := config.Load(filename)
		if err != nil {
			t.Fatal(err)
		}
		body["sshPassword"] = "replacement-must-not-be-saved"
		if w := request(app, "POST", "/api/ssh/hosts", body, cookie, csrf); w.Code != 409 {
			t.Fatalf("duplicate alias overwritten: %d", w.Code)
		}
		after, err := config.Load(filename)
		if err != nil || !reflect.DeepEqual(before, after) || !app.sshCredentials.Matches(before.SSHCredentials) {
			t.Fatal("duplicate alias changed sources or credentials")
		}
	})
	t.Run("external import", func(t *testing.T) {
		app, filename := newSSHHostApp(t, "personal", false)
		cookie, csrf := signIn(t, app)
		saved, err := config.Load(filename)
		if err != nil {
			t.Fatal(err)
		}
		bundle := sshvault.Bundle{Hosts: map[string]sshvault.Profile{
			"external": {Hostname: "external.invalid", User: "reader", Port: 22, Password: []byte("external-password"), KnownHosts: "empty"},
		}, Keys: map[string][]byte{}, KnownHosts: map[string]string{"empty": ""}}
		defer bundle.Clear()
		saved.SSHCredentials, err = sshvault.Seal(bundle, testPassword)
		if err != nil {
			t.Fatal(err)
		}
		if err := config.Save(filename, saved); err != nil {
			t.Fatal(err)
		}
		saved, err = config.Load(filename)
		if err != nil {
			t.Fatal(err)
		}
		if w := request(app, "POST", "/api/ssh/hosts", sshHostBody("web-host"), cookie, csrf); w.Code != 409 {
			t.Fatalf("external import was silently replaced: %d", w.Code)
		}
		after, err := config.Load(filename)
		if err != nil || !reflect.DeepEqual(after, saved) || !app.sshCredentials.Matches(nil) {
			t.Fatal("conflict changed disk or runtime credentials")
		}
	})
	t.Run("cannot persist", func(t *testing.T) {
		if runtime.GOOS != "linux" || os.Geteuid() == 0 {
			t.Skip("requires unprivileged Linux file permissions")
		}
		app, filename := newSSHHostApp(t, "personal", false)
		cookie, csrf := signIn(t, app)
		directory := filepath.Dir(filename)
		if err := os.Chmod(directory, 0500); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(directory, 0700)
		if w := request(app, "POST", "/api/ssh/hosts", sshHostBody("web-host"), cookie, csrf); w.Code != 500 {
			t.Fatalf("persistence error status %d", w.Code)
		}
		saved, err := config.Load(filename)
		if err != nil || saved.SSHCredentials != nil || len(app.hostSnapshot()) != 1 || !app.sshCredentials.Matches(nil) {
			t.Fatal("failed persistence activated credentials or sources")
		}
	})
}

func TestAddSSHHostRechecksSessionAfterWaiting(t *testing.T) {
	app, filename := newSSHHostApp(t, "personal", false)
	cookie, csrf := signIn(t, app)
	app.setupMu.Lock()
	done := make(chan int, 1)
	go func() {
		done <- request(app, "POST", "/api/ssh/hosts", sshHostBody("web-host"), cookie, csrf).Code
	}()
	deadline := time.Now().Add(5 * time.Second)
	for len(app.loginBusy) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	waiting := len(app.loginBusy) != 0
	app.mu.Lock()
	delete(app.sessions, cookie.Value)
	app.mu.Unlock()
	app.setupMu.Unlock()
	if status := <-done; !waiting || status != 401 {
		t.Fatalf("expired waiting session: waiting=%v, status=%d", waiting, status)
	}
	saved, err := config.Load(filename)
	if err != nil || saved.SSHCredentials != nil || len(saved.Hosts) != 1 || !app.sshCredentials.Matches(nil) {
		t.Fatal("expired session persisted or activated credentials")
	}
}
