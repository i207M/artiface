package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"artiface/internal/config"
	"artiface/internal/sshvault"
)

type sshDeletionFixture struct {
	app              *App
	filename, prefix string
	cookie           *http.Cookie
	csrf             string
}

func newSSHDeletionFixture(t *testing.T, mode string) sshDeletionFixture {
	t.Helper()
	app, filename := newSSHHostApp(t, mode, false)
	f := sshDeletionFixture{app: app, filename: filename, prefix: "/api/"}
	if mode == "team" {
		f.prefix = "/api/admin/"
		f.cookie, f.csrf = teamSignIn(t, app, "", testPassword, true)
	} else {
		f.cookie, f.csrf = signIn(t, app)
	}
	return f
}

func (f sshDeletionFixture) load(t *testing.T) config.Config {
	t.Helper()
	cfg, err := config.Load(f.filename)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func (f sshDeletionFixture) add(t *testing.T, body map[string]any) config.Host {
	t.Helper()
	w := request(f.app, "POST", f.prefix+"ssh/hosts", body, f.cookie, f.csrf)
	var result struct{ Host config.Host }
	if w.Code != http.StatusCreated || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatalf("add host: %d %s", w.Code, w.Body)
	}
	return result.Host
}

func (f sshDeletionFixture) save(cfg config.Config, hosts []config.Host, password string) *httptest.ResponseRecorder {
	public := publicConfig(cfg)
	public.Hosts = hosts
	return request(f.app, "POST", f.prefix+"settings", map[string]any{
		"config": public, "revision": configRevision(cfg), "adminPassword": password,
	}, f.cookie, f.csrf)
}

func withoutSSHTarget(hosts []config.Host, target string) []config.Host {
	result := make([]config.Host, 0, len(hosts))
	for _, host := range hosts {
		if host.Target != target {
			result = append(result, host)
		}
	}
	return result
}

func sshDeletionDisk(t *testing.T, filename string) [][]byte {
	t.Helper()
	var result [][]byte
	for _, name := range []string{filename, config.SSHCredentialsPath(filename)} {
		data, err := os.ReadFile(name)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		result = append(result, data)
	}
	return result
}

func assertSSHDeletionResponse(t *testing.T, f sshDeletionFixture, w *httptest.ResponseRecorder) config.Config {
	t.Helper()
	saved := f.load(t)
	var result SettingsResponse
	var fields map[string]json.RawMessage
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &result) != nil ||
		json.Unmarshal(w.Body.Bytes(), &fields) != nil {
		t.Fatalf("save settings: %d %s", w.Code, w.Body)
	}
	if _, exists := fields["sshConfigured"]; !exists && saved.SSHCredentials != nil {
		t.Fatal("owner response omitted configured credentials")
	}
	if !reflect.DeepEqual(result, f.app.settingsResponse(saved)) ||
		!reflect.DeepEqual(f.app.hostSnapshot(), saved.Hosts) || !f.app.sshCredentials.Matches(saved.SSHCredentials) {
		t.Fatal("response, live sources, credentials and saved configuration diverged")
	}
	f.app.hostsMu.RLock()
	cachedMatches := reflect.DeepEqual(f.app.cfg.SSHCredentials, saved.SSHCredentials) &&
		f.app.cfg.SSHCredentialsRevision == saved.SSHCredentialsRevision
	f.app.hostsMu.RUnlock()
	if !cachedMatches {
		t.Fatal("App retained a previous encrypted credential envelope or revision")
	}
	return saved
}

func TestSettingsSSHDeletionPurgesCredentialsTrustAndReferences(t *testing.T) {
	for _, mode := range []string{"personal", "team"} {
		t.Run(mode, func(t *testing.T) {
			f := newSSHDeletionFixture(t, mode)
			address, _ := hostKeyProbeServer(t)
			host, port, _ := net.SplitHostPort(address)
			number, _ := strconv.Atoi(port)
			key, _ := sshHostKeyFixture(t, "")
			body := sshHostBody("remove")
			delete(body, "sshPassword")
			body["hostname"], body["port"], body["privateKey"] = host, number, key
			removedHost := f.add(t, body)
			keptHost := f.add(t, sshHostBody("keep"))
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err := f.app.sshCredentials.DialSFTP(ctx, "remove")
			var challenge *sshvault.HostKeyError
			if !errors.As(err, &challenge) {
				t.Fatal("fixture did not capture a host key", err)
			}
			w := request(f.app, "POST", f.prefix+"ssh/host-key/accept",
				map[string]string{"token": challenge.Token, "password": testPassword}, f.cookie, f.csrf)
			if w.Code != http.StatusNoContent {
				t.Fatalf("approve host key: %d %s", w.Code, w.Body)
			}
			projects := []config.ProjectRef{{Host: removedHost.ID, Root: "reports"}, {Host: keptHost.ID, Root: "reports"}}
			cfg, err := config.Update(f.filename, func(c *config.Config) error {
				for i := range c.Hosts {
					if c.Hosts[i].Target == "remove" || c.Hosts[i].Target == "keep" {
						c.Hosts[i].Roots = []config.Root{{ID: "reports", Label: "Reports", Path: "/reports"}}
					}
				}
				c.OpenProjects = projects
				if mode == "team" {
					c.Users[0].Projects, c.Users[0].OpenProjects = projects, projects
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			f.app.adoptSources(cfg)
			w = request(f.app, "GET", f.prefix+"settings", nil, f.cookie, "")
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"sshConfigured":true`) {
				t.Fatal("owner cannot see that credentials are configured", w.Code, w.Body)
			}
			if mode == "team" {
				reader, csrf := teamSignIn(t, f.app, "reader", testPassword, false)
				w = request(f.app, "GET", "/api/settings", nil, reader, "")
				if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "sshConfigured") {
					t.Fatal("regular user learned credential configuration", w.Code, w.Body)
				}
				for _, endpoint := range []string{"/api/settings", "/api/admin/settings"} {
					w = request(f.app, "POST", endpoint, map[string]any{
						"config": publicConfig(cfg), "revision": configRevision(cfg), "adminPassword": testPassword,
					}, reader, csrf)
					if w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
						t.Fatal("regular user could change owner settings", w.Code)
					}
				}
			}
			bundle, err := sshvault.Open(cfg.SSHCredentials, testPassword)
			if err != nil {
				t.Fatal(err)
			}
			profile := bundle.Hosts["remove"]
			if len(profile.Keys) != 1 || len(profile.ApprovedHostKey) == 0 {
				t.Fatal("fixture needs both saved identity and approved trust")
			}
			keyID, trustID := profile.Keys[0], profile.KnownHosts
			bundle.Clear()
			oldRevision := cfg.SSHCredentialsRevision
			saved := assertSSHDeletionResponse(t, f, f.save(cfg, withoutSSHTarget(cfg.Hosts, "remove"), testPassword))
			bundle, err = sshvault.Open(saved.SSHCredentials, testPassword)
			if err != nil {
				t.Fatal(err)
			}
			defer bundle.Clear()
			_, hostExists := bundle.Hosts["remove"]
			_, keyExists := bundle.Keys[keyID]
			_, trustExists := bundle.KnownHosts[trustID]
			if hostExists || keyExists || trustExists || len(bundle.Hosts) != 1 || string(bundle.Hosts["keep"].Password) != "fixture-ssh-password" {
				t.Fatal("deletion retained credentials/trust or damaged the remaining host")
			}
			if !reflect.DeepEqual(saved.OpenProjects, projects[1:]) ||
				(mode == "team" && (!reflect.DeepEqual(saved.Users[0].Projects, projects[1:]) || !reflect.DeepEqual(saved.Users[0].OpenProjects, projects[1:]))) {
				t.Fatal("deleted host's grants or open projects survived")
			}
			sidecar := sshDeletionDisk(t, f.filename)[1]
			var disk struct{ Revisions map[string]json.RawMessage }
			if json.Unmarshal(sidecar, &disk) != nil || len(disk.Revisions) != 1 ||
				disk.Revisions[saved.SSHCredentialsRevision] == nil || bytes.Contains(sidecar, []byte(oldRevision)) {
				t.Fatal("old encrypted snapshot survived deletion")
			}
			saved = assertSSHDeletionResponse(t, f, f.save(saved, withoutSSHTarget(saved.Hosts, "keep"), testPassword))
			if saved.SSHCredentials != nil || saved.SSHCredentialsRevision != "" || len(saved.OpenProjects) != 0 {
				t.Fatal("last host did not clear credentials and open projects")
			}
			if _, err := os.Stat(config.SSHCredentialsPath(f.filename)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("last host retained its encrypted sidecar", err)
			}
			f.add(t, sshHostBody("remove"))
			readded := f.load(t)
			if readded.SSHCredentials == nil || !f.app.sshCredentials.Matches(readded.SSHCredentials) {
				t.Fatal("deleted alias could not be added with fresh credentials")
			}
		})
	}
}

func TestSettingsSSHDeletionPasswordAndRevisionGuards(t *testing.T) {
	f := newSSHDeletionFixture(t, "personal")
	f.add(t, sshHostBody("remove"))
	cfg := f.load(t)
	hosts := withoutSSHTarget(cfg.Hosts, "remove")
	before := sshDeletionDisk(t, f.filename)
	// Missing password and stale settings must be handled before the password gate.
	f.app.loginBusy <- struct{}{}
	w := f.save(cfg, hosts, "")
	<-f.app.loginBusy
	var required struct {
		Error                  string `json:"error"`
		SSHCredentialsRequired bool   `json:"sshCredentialsRequired"`
	}
	if w.Code != http.StatusPreconditionRequired || json.Unmarshal(w.Body.Bytes(), &required) != nil ||
		required.Error != "Enter the admin password to remove saved SSH credentials." || !required.SSHCredentialsRequired {
		t.Fatalf("missing password: %d %s", w.Code, w.Body)
	}
	stale := cfg
	stale.SessionHours++
	f.app.loginBusy <- struct{}{}
	w = f.save(stale, hosts, "")
	<-f.app.loginBusy
	if w.Code != http.StatusConflict || strings.Contains(w.Body.String(), "sshCredentialsRequired") {
		t.Fatalf("stale settings prompted for credentials: %d %s", w.Code, w.Body)
	}
	w = f.save(cfg, hosts, "wrong")
	var failure struct{ Error string }
	if w.Code != http.StatusForbidden || json.Unmarshal(w.Body.Bytes(), &failure) != nil || failure.Error != "Incorrect admin password" {
		t.Fatalf("wrong password: %d %s", w.Code, w.Body)
	}
	f.app.loginBusy <- struct{}{}
	w = f.save(cfg, hosts, testPassword)
	<-f.app.loginBusy
	if w.Code != http.StatusTooManyRequests {
		t.Fatal("deletion bypassed the shared password gate", w.Code)
	}
	invalid := append([]config.Host{}, hosts...)
	invalid[0].Kind = "invalid"
	w = f.save(cfg, invalid, testPassword)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid settings accompanying deletion: %d %s", w.Code, w.Body)
	}
	if !reflect.DeepEqual(before, sshDeletionDisk(t, f.filename)) || !f.app.sshCredentials.Matches(cfg.SSHCredentials) {
		t.Fatal("rejected deletion mutated configuration or runtime")
	}
}

func TestSettingsSSHDeletionRetargetAndUnrelatedEdits(t *testing.T) {
	f := newSSHDeletionFixture(t, "personal")
	added := f.add(t, sshHostBody("remove"))
	cfg, err := config.Update(f.filename, func(c *config.Config) error {
		duplicate := added
		duplicate.ID = "duplicate"
		c.Hosts = append(c.Hosts, duplicate, config.Host{ID: "local", Kind: "local", Roots: []config.Root{}})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	f.app.adoptSources(cfg)
	before := sshDeletionDisk(t, f.filename)[1]
	for _, edit := range []string{"duplicate", "project", "local"} {
		hosts := publicConfig(cfg).Hosts
		switch edit {
		case "duplicate", "local":
			for i, host := range hosts {
				if host.ID == edit {
					hosts = append(hosts[:i], hosts[i+1:]...)
					break
				}
			}
		case "project":
			hosts[0].Roots = []config.Root{}
		}
		cfg = assertSSHDeletionResponse(t, f, f.save(cfg, hosts, ""))
		if !bytes.Equal(before, sshDeletionDisk(t, f.filename)[1]) {
			t.Fatalf("%s edit changed encrypted credentials", edit)
		}
	}
	hosts := publicConfig(cfg).Hosts
	for i := range hosts {
		if hosts[i].Target == "remove" {
			hosts[i].Target = "replacement"
		}
	}
	if w := f.save(cfg, hosts, ""); w.Code != http.StatusPreconditionRequired {
		t.Fatalf("raw configuration retarget bypassed password: %d %s", w.Code, w.Body)
	}
	saved := assertSSHDeletionResponse(t, f, f.save(cfg, hosts, testPassword))
	if saved.SSHCredentials != nil || saved.Hosts[len(saved.Hosts)-1].Target != "replacement" {
		t.Fatal("retarget retained the previous alias's credentials")
	}
	// Hosts without an encrypted vault can still be removed without a password.
	assertSSHDeletionResponse(t, f, f.save(saved, []config.Host{}, ""))
}

func TestSettingsSSHDeletionDisabledAndLockedPolicy(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		name := "locked"
		if disabled {
			name = "disabled"
		}
		t.Run(name, func(t *testing.T) {
			f := newSSHDeletionFixture(t, "personal")
			f.add(t, sshHostBody("remove"))
			f.add(t, sshHostBody("keep"))
			cfg := f.load(t)
			f.app.sshCredentials.Close()
			f.app.sshCredentials = sshvault.NewRuntime(cfg.SSHCredentials, disabled)
			saved := assertSSHDeletionResponse(t, f, f.save(cfg, withoutSSHTarget(cfg.Hosts, "remove"), testPassword))
			if f.app.sshCredentials.Disabled() != disabled || !f.app.sshCredentials.Locked() || saved.SSHCredentials == nil {
				t.Fatal("deletion changed locked/disabled policy")
			}
		})
	}
}

func TestSettingsSSHDeletionJumpDependency(t *testing.T) {
	f := newSSHDeletionFixture(t, "personal")
	f.add(t, sshHostBody("jump"))
	body := sshHostBody("dependent")
	body["jump"] = "jump"
	f.add(t, body)
	cfg := f.load(t)
	before := sshDeletionDisk(t, f.filename)
	w := f.save(cfg, withoutSSHTarget(cfg.Hosts, "jump"), testPassword)
	if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "jump") || !strings.Contains(w.Body.String(), "dependent") {
		t.Fatalf("dependency failure: %d %s", w.Code, w.Body)
	}
	if !reflect.DeepEqual(before, sshDeletionDisk(t, f.filename)) || !f.app.sshCredentials.Matches(cfg.SSHCredentials) {
		t.Fatal("dependency rejection partially removed credentials")
	}
	saved := assertSSHDeletionResponse(t, f, f.save(cfg, withoutSSHTarget(withoutSSHTarget(cfg.Hosts, "jump"), "dependent"), testPassword))
	if saved.SSHCredentials != nil {
		t.Fatal("deleting the jump and its dependent retained the vault")
	}
}

func TestSettingsSSHDeletionAfterExternalCredentialRecovery(t *testing.T) {
	f := newSSHDeletionFixture(t, "personal")
	f.add(t, sshHostBody("remove"))
	before := f.load(t)
	if err := config.ForgetSSH(f.filename, before.PasswordHash, before.PasswordHash); err != nil {
		t.Fatal(err)
	}
	recovered := f.load(t)
	disk := sshDeletionDisk(t, f.filename)
	if recovered.SSHCredentials != nil || f.app.sshCredentials.Matches(nil) {
		t.Fatal("fixture did not leave an old runtime after CLI recovery")
	}
	for _, password := range []string{"", testPassword} {
		w := f.save(recovered, withoutSSHTarget(recovered.Hosts, "remove"), password)
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "restart") {
			t.Fatalf("stale runtime deletion reported success after recovery: %d %s", w.Code, w.Body)
		}
		if !reflect.DeepEqual(disk, sshDeletionDisk(t, f.filename)) ||
			!f.app.sshCredentials.Matches(before.SSHCredentials) {
			t.Fatal("rejected deletion changed disk or runtime")
		}
	}
	f.app.sshCredentials.Close()
	f.app.sshCredentials = sshvault.NewRuntime(nil, false)
	assertSSHDeletionResponse(t, f, f.save(recovered, withoutSSHTarget(recovered.Hosts, "remove"), ""))
}

// Hold the config writer until the request has loaded its original config and
// entered password verification, so a CLI update deterministically wins the race.
func stageSSHDeletion(t *testing.T, f sshDeletionFixture, change func(*config.Config) error, run func() *httptest.ResponseRecorder) (func(), <-chan error, <-chan *httptest.ResponseRecorder) {
	t.Helper()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	resume := func() { once.Do(func() { close(release) }) }
	t.Cleanup(resume)
	updated := make(chan error, 1)
	go func() {
		_, err := config.Update(f.filename, func(c *config.Config) error {
			close(entered)
			<-release
			return change(c)
		})
		updated <- err
	}()
	<-entered
	response := make(chan *httptest.ResponseRecorder, 1)
	go func() { response <- run() }()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for len(f.app.loginBusy) == 0 {
		select {
		case w := <-response:
			t.Fatalf("request did not enter password verification: %d %s", w.Code, w.Body)
		case <-deadline.C:
			t.Fatal("request did not reach password verification")
		case <-ticker.C:
		}
	}
	return resume, updated, response
}

func TestSettingsSSHDeletionCLIConflictsAndPrivateUpdates(t *testing.T) {
	for _, kind := range []string{"public revision", "password", "envelope", "private state"} {
		t.Run(kind, func(t *testing.T) {
			mode := "personal"
			if kind == "private state" {
				mode = "team"
			}
			f := newSSHDeletionFixture(t, mode)
			f.add(t, sshHostBody("remove"))
			cfg := f.load(t)
			cli := cfg
			switch kind {
			case "public revision":
				cli.SessionHours++
			case "password":
				var err error
				cli.PasswordHash, err = config.HashPassword("cli-replacement-password")
				if err != nil {
					t.Fatal(err)
				}
			case "envelope":
				bundle, err := sshvault.Open(cfg.SSHCredentials, testPassword)
				if err != nil {
					t.Fatal(err)
				}
				defer bundle.Clear()
				cli.SSHCredentials, err = sshvault.Seal(bundle, testPassword)
				if err != nil {
					t.Fatal(err)
				}
			case "private state":
				cli.OpenProjects = []config.ProjectRef{{Host: "test", Root: "artifacts"}}
				cli.Users = append([]config.User{}, cfg.Users...)
				cli.Users[0].Projects, cli.Users[0].OpenProjects = cli.OpenProjects, cli.OpenProjects
			}
			resume, updated, response := stageSSHDeletion(t, f, func(c *config.Config) error {
				*c = cli
				return nil
			}, func() *httptest.ResponseRecorder {
				return f.save(cfg, withoutSSHTarget(cfg.Hosts, "remove"), testPassword)
			})
			resume()
			if err := <-updated; err != nil {
				t.Fatal(err)
			}
			afterCLI := sshDeletionDisk(t, f.filename)
			w := <-response
			if kind == "private state" {
				saved := assertSSHDeletionResponse(t, f, w)
				if !reflect.DeepEqual(saved.OpenProjects, cli.OpenProjects) || !reflect.DeepEqual(saved.Users, cli.Users) {
					t.Fatal("deletion lost concurrent grants or open-project changes")
				}
			} else {
				if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), config.ErrConflict.Error()) {
					t.Fatalf("CLI race was not rejected: %d %s", w.Code, w.Body)
				}
				if !reflect.DeepEqual(afterCLI, sshDeletionDisk(t, f.filename)) || !f.app.sshCredentials.Matches(cfg.SSHCredentials) {
					t.Fatal("rejected deletion changed the CLI configuration or live runtime")
				}
			}
			if kind == "envelope" {
				// A request starting after the import sees the new config but an old runtime.
				saved := f.load(t)
				w = f.save(saved, withoutSSHTarget(saved.Hosts, "remove"), testPassword)
				if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "restart the server") {
					t.Fatalf("stale runtime was not rejected: %d %s", w.Code, w.Body)
				}
			}
		})
	}
}

func TestSettingsSSHDeletionReportsCleanupFailureAfterCommit(t *testing.T) {
	f := newSSHDeletionFixture(t, "personal")
	f.add(t, sshHostBody("remove"))
	cfg := f.load(t)
	resume, updated, response := stageSSHDeletion(t, f, func(*config.Config) error { return nil }, func() *httptest.ResponseRecorder {
		return f.save(cfg, withoutSSHTarget(cfg.Hosts, "remove"), testPassword)
	})
	// Block source adoption after persistence, then obstruct the explicit cleanup.
	// No test hook is needed in the production persistence or runtime code.
	f.app.hostsMu.Lock()
	var once sync.Once
	unlock := func() { once.Do(f.app.hostsMu.Unlock) }
	defer unlock()
	resume()
	if err := <-updated; err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		saved := f.load(t)
		if saved.SSHCredentials == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("deletion did not commit before source adoption")
		}
		time.Sleep(time.Millisecond)
	}
	// The config rename precedes its best-effort cleanup. Waiting for runtime
	// adoption ensures both have finished before obstructing the explicit retry.
	if !f.app.sshCredentials.Matches(nil) {
		t.Fatal("runtime did not adopt the committed deletion")
	}
	sidecar := config.SSHCredentialsPath(f.filename)
	if err := os.Mkdir(sidecar, 0700); err != nil {
		t.Fatal(err)
	}
	unlock()
	w := <-response
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "Settings were saved") ||
		!strings.Contains(w.Body.String(), "Reload settings") || !strings.Contains(w.Body.String(), "permissions") {
		t.Fatalf("cleanup failure was hidden or claimed rollback: %d %s", w.Code, w.Body)
	}
	saved := f.load(t)
	if saved.SSHCredentials != nil || !f.app.sshCredentials.Matches(nil) || !reflect.DeepEqual(f.app.hostSnapshot(), saved.Hosts) {
		t.Fatal("cleanup error did not preserve the committed configuration/runtime")
	}
}
