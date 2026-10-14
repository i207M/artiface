package server

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"artiface/internal/config"
	"artiface/internal/sshvault"
	"artiface/internal/storage"
	"golang.org/x/crypto/ssh"
)

func TestSSHDisabledKeepsLocalProjectsAndCredentials(t *testing.T) {
	for _, mode := range []string{"personal", "team"} {
		t.Run(mode, func(t *testing.T) {
			base, _ := newTestApp(t)
			cfg := base.cfg
			cfg.Mode = mode
			local := cfg.Hosts[0]
			local.ID, local.Kind, local.Target = "local", "local", ""
			cfg.Hosts = append(cfg.Hosts, local)
			cfg.Users = []config.User{{ID: "reader", Username: "reader", PasswordHash: cfg.PasswordHash,
				Projects: []config.ProjectRef{{Host: "test", Root: "artifacts"}, {Host: "local", Root: "artifacts"}}}}
			// Structurally valid but undecryptable: disabled startup must not
			// attempt to unlock this vault during owner or admin sign-in.
			cfg.SSHCredentials = &sshvault.Envelope{Version: 1, Salt: make([]byte, 16), Ciphertext: make([]byte, 28)}
			filename := filepath.Join(t.TempDir(), "config.json")
			if err := config.Save(filename, cfg); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			runtime := sshvault.NewRuntime(cfg.SSHCredentials, true)
			store := storage.NewLocal()
			defer store.Close()
			app, err := New(cfg, store, base.assets, WithConfigFile(filename), WithSSHCredentials(runtime))
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			var owner *http.Cookie
			var ownerCSRF string
			if mode == "team" {
				owner, ownerCSRF = teamSignIn(t, app, "", testPassword, true)
			} else {
				owner, ownerCSRF = signIn(t, app)
			}
			cookie, csrf := owner, ownerCSRF
			if mode == "team" {
				cookie, csrf = teamSignIn(t, app, "reader", testPassword, false)
			}
			if !runtime.Disabled() || !runtime.Locked() {
				t.Fatal("sign-in changed the startup SSH policy")
			}
			if settings := readSettings(t, app, cookie); !settings.SSHDisabled {
				t.Fatal("settings did not report disabled SSH")
			}
			for _, endpoint := range []string{"list", "text", "file", "file-info", "git/status", "git/diff", "git/history", "git/commit", "pdf/page", "pdf/outline"} {
				query := fileQuery("reports/report.pdf")
				if strings.HasPrefix(endpoint, "pdf/") {
					query += "&document=0123456789abcdef0123456789abcdef&page=1&size=960"
				}
				w := request(app, "GET", "/api/"+endpoint+query, nil, cookie, "")
				if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "SSH connectivity is disabled") {
					t.Fatalf("disabled SSH %s: %d %s", endpoint, w.Code, w.Body)
				}
			}
			for _, endpoint := range []string{"preview", "pdf/info"} {
				w := request(app, "POST", "/api/"+endpoint, location{Host: "test", Root: "artifacts", Path: "reports/index.html"}, cookie, csrf)
				if w.Code != http.StatusServiceUnavailable {
					t.Fatalf("disabled SSH %s: %d %s", endpoint, w.Code, w.Body)
				}
			}
			prefix := "/api/"
			if mode == "team" {
				prefix = "/api/admin/"
			}
			for _, target := range []map[string]string{{"host": "test"}, {"target": "test-alias"}, {"target": "new-alias"}} {
				w := request(app, "POST", prefix+"folders", target, owner, ownerCSRF)
				if w.Code != http.StatusServiceUnavailable {
					t.Fatalf("disabled SSH folder picker: %d %s", w.Code, w.Body)
				}
			}
			for _, endpoint := range []string{"list", "file", "file-info"} {
				rel := "secret.txt"
				if endpoint == "list" {
					rel = ""
				}
				w := request(app, "GET", "/api/"+endpoint+"?host=local&root=artifacts&path="+rel, nil, cookie, "")
				if w.Code != 200 {
					t.Fatalf("local %s unavailable: %d %s", endpoint, w.Code, w.Body)
				}
			}
			w := request(app, "POST", prefix+"folders", map[string]string{"host": "local", "path": local.Roots[0].Path}, owner, ownerCSRF)
			if w.Code != 200 {
				t.Fatalf("local folder picker unavailable: %d %s", w.Code, w.Body)
			}
			after, err := os.ReadFile(filename)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("disabled SSH rewrote saved projects or credentials")
			}
		})
	}
}

func TestTeamSSHUnlockPrivacyAndPasswordRotation(t *testing.T) {
	base, store := newTestApp(t)
	cfg := base.cfg
	cfg.Mode = "team"
	local := cfg.Hosts[0]
	local.ID, local.Kind, local.Target = "local", "local", ""
	cfg.Hosts = append(cfg.Hosts, local)
	remoteRef := config.ProjectRef{Host: "test", Root: "artifacts"}
	cfg.Users = []config.User{{ID: "reader", Username: "reader", PasswordHash: cfg.PasswordHash,
		Projects: []config.ProjectRef{remoteRef, {Host: "local", Root: "artifacts"}}}}
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(private)
	bundle := sshvault.Bundle{Hosts: map[string]sshvault.Profile{"test-alias": {
		Hostname: "private-ssh.example", Port: 22, User: "private-user", Password: []byte("secret-ssh-password"), KnownHosts: "trust",
	}}, Keys: map[string][]byte{}, KnownHosts: map[string]string{"trust": "private-ssh.example " + string(ssh.MarshalAuthorizedKey(signer.PublicKey()))}}
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
	app, err := New(cfg, store, base.assets, WithConfigFile(filename))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if !app.sshCredentials.Locked() {
		t.Fatal("server began with decrypted credentials")
	}
	reader, readerCSRF := teamSignIn(t, app, "reader", testPassword, false)
	if !app.sshCredentials.Locked() {
		t.Fatal("a team password unlocked the admin vault")
	}
	if w := request(app, "GET", "/api/list"+fileQuery(""), nil, reader, ""); w.Code != http.StatusLocked {
		t.Fatalf("locked SSH returned %d", w.Code)
	}
	if w := request(app, "GET", "/api/list?host=local&root=artifacts&path=", nil, reader, ""); w.Code != 200 {
		t.Fatalf("locked SSH blocked a local project: %d", w.Code)
	}
	for _, endpoint := range []string{"/api/password", "/api/admin/password"} {
		if w := request(app, "POST", endpoint, map[string]string{"currentPassword": testPassword, "newPassword": "user-chosen-password"}, reader, readerCSRF); w.Code == 200 {
			t.Fatal("team user changed the vault password")
		}
	}
	admin, csrf := teamSignIn(t, app, "", testPassword, true)
	if app.sshCredentials.Locked() {
		t.Fatal("admin sign-in did not unlock SSH")
	}
	if w := request(app, "GET", "/api/list"+fileQuery(""), nil, reader, ""); w.Code != 200 {
		t.Fatalf("existing team session could not use unlocked SSH: %d", w.Code)
	}
	for _, endpoint := range []string{"/api/admin/settings", "/api/admin/hosts", "/api/admin/access", "/api/admin/session"} {
		w := request(app, "GET", endpoint, nil, admin, "")
		if w.Code != 200 {
			t.Fatalf("%s: %d", endpoint, w.Code)
		}
		for _, secret := range []string{"sshCredentials", "ciphertext", "passwordHash", "secret-ssh-password", "private-ssh.example", "private-user"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatalf("%s exposed SSH credentials", endpoint)
			}
		}
	}
	newPassword := "rotated-admin-password"
	w := request(app, "POST", "/api/admin/password", map[string]string{"currentPassword": testPassword, "newPassword": newPassword}, admin, csrf)
	if w.Code != 200 {
		t.Fatalf("password rotation: %d %s", w.Code, w.Body)
	}
	saved, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sshvault.Open(saved.SSHCredentials, testPassword); !errors.Is(err, sshvault.ErrDecrypt) {
		t.Fatal("old password can decrypt rotated credentials")
	}
	decoded, err := sshvault.Open(saved.SSHCredentials, newPassword)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded.Hosts["test-alias"].Password) != "secret-ssh-password" {
		t.Fatal("rotation lost SSH password")
	}
	decoded.Clear()
	if w := request(app, "GET", "/api/list"+fileQuery(""), nil, reader, ""); w.Code != 401 {
		t.Fatal("rotation left team sessions active")
	}
	data, _ := os.ReadFile(filename)
	if strings.Contains(string(data), "secret-ssh-password") || strings.Contains(string(data), newPassword) {
		t.Fatal("rotation wrote plaintext credentials")
	}
	restarted, err := New(saved, store, base.assets, WithConfigFile(filename))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if !restarted.sshCredentials.Locked() {
		t.Fatal("restart retained unlocked credentials")
	}
	teamSignIn(t, restarted, "reader", testPassword, false)
	if !restarted.sshCredentials.Locked() {
		t.Fatal("team login unlocked restarted server")
	}
	teamSignIn(t, restarted, "", newPassword, true)
	if restarted.sshCredentials.Locked() {
		t.Fatal("rotated admin password could not unlock after restart")
	}
	if restarted.settingsResponse(saved).RestartRequired {
		t.Fatal("an in-app password change incorrectly required restart")
	}
	reimported := saved
	reimported.SSHCredentials, err = sshvault.Seal(bundle, newPassword)
	if err != nil {
		t.Fatal(err)
	}
	if !restarted.settingsResponse(reimported).RestartRequired {
		t.Fatal("an external credential import did not require restart")
	}
	if err := config.Save(filename, reimported); err != nil {
		t.Fatal(err)
	}
	admin, csrf = teamSignIn(t, restarted, "", newPassword, true)
	w = request(restarted, "POST", "/api/admin/password", map[string]string{
		"currentPassword": newPassword, "newPassword": "another-admin-password",
	}, admin, csrf)
	if w.Code != 200 {
		t.Fatalf("password change after external import: %d %s", w.Code, w.Body)
	}
	latest, err := config.Load(filename)
	if err != nil || !restarted.settingsResponse(latest).RestartRequired {
		t.Fatal("password change concealed the pending credential import restart", err)
	}
}
