package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"artiface/internal/config"
	"artiface/internal/storage"
)

func newSetupApp(t *testing.T, sourceText string) (*App, *localStore, string, string) {
	t.Helper()
	initial, store := newTestApp(t)
	dir := t.TempDir()
	filename, source := filepath.Join(dir, "app.json"), filepath.Join(dir, "ssh")
	if err := os.WriteFile(source, []byte(sourceText), 0600); err != nil {
		t.Fatal(err)
	}
	aliases, err := config.DiscoverSSH(source)
	if err != nil {
		t.Fatal(err)
	}
	cfg := initial.cfg
	cfg.Hosts, _ = config.MergeTargets(cfg.Hosts, aliases)
	if err := config.Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	app, err := New(cfg, store, initial.assets, WithConfigFile(filename))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return app, store, filename, source
}

func readHosts(t *testing.T, app *App, cookie *http.Cookie) HostsResponse {
	t.Helper()
	w := request(app, "GET", "/api/hosts", nil, cookie, "")
	var response HostsResponse
	if w.Code != 200 {
		t.Fatalf("hosts: %d %s", w.Code, w.Body)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestSetupUsesSavedSourcesAndRequiresOwnerAuth(t *testing.T) {
	app, store, _, source := newSetupApp(t, "Host test-alias fresh-alias * !negated\n")
	cookie, csrf := signIn(t, app)
	hosts := readHosts(t, app, cookie)
	if !hosts.SetupEnabled || len(hosts.Hosts) != 3 ||
		hosts.Hosts[0].ID != "test" ||
		hosts.Hosts[1].Target != "fresh-alias" ||
		hosts.Hosts[1].Roots == nil || len(hosts.Hosts[1].Roots) != 0 ||
		hosts.Hosts[2].Kind != "local" {
		t.Fatalf("hosts response = %#v", hosts)
	}
	for _, endpoint := range []string{"/api/projects"} {
		if w := request(app, "POST", endpoint, map[string]string{}, nil, ""); w.Code != 401 {
			t.Fatalf("anonymous %s = %d", endpoint, w.Code)
		}
		for _, token := range []string{"", "wrong"} {
			if w := request(app, "POST", endpoint, map[string]string{}, cookie, token); w.Code != 403 {
				t.Fatalf("CSRF %s = %d", endpoint, w.Code)
			}
		}
	}
	if w := request(app, "POST", "/api/import-ssh", map[string]string{"sshConfig": "/etc/passwd"}, cookie, csrf); w.Code != 404 {
		t.Fatalf("removed import API returned %d", w.Code)
	}
	disabled, err := New(app.cfg, store, app.assets)
	if err != nil {
		t.Fatal(err)
	}
	defer disabled.Close()
	disabledCookie, disabledCSRF := signIn(t, disabled)
	disabledHosts := readHosts(t, disabled, disabledCookie)
	if disabledHosts.SetupEnabled || len(disabledHosts.Hosts) != 2 {
		t.Fatal("discovery or setup enabled without a configuration file")
	}
	for _, endpoint := range []string{"/api/projects"} {
		if w := request(disabled, "POST", endpoint, map[string]string{}, disabledCookie, disabledCSRF); w.Code != 403 {
			t.Fatalf("disabled %s = %d", endpoint, w.Code)
		}
	}
	if store.opens != 0 {
		t.Fatal("discovery or denied setup contacted storage")
	}
	if err := os.WriteFile(source, []byte("Host partial\nInclude \"unclosed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	hosts = readHosts(t, app, cookie)
	if len(hosts.Hosts) != 3 || hosts.Hosts[1].Target != "fresh-alias" {
		t.Fatal("server read changed SSH configuration at runtime")
	}
}

func TestServerNeverDiscoversHostsFromHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	app, store, filename, _ := newSetupApp(t, "")
	// A server constructed directly also ignores the user's SSH configuration.
	app, err := New(app.cfg, store, app.assets, WithConfigFile(filename))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	cookie, _ := signIn(t, app)
	if got := readHosts(t, app, cookie); len(got.Hosts) != 2 || got.Hosts[0].ID != "test" || got.Hosts[1].Kind != "local" {
		t.Fatalf("missing source = %#v", got)
	}
	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".ssh", "config"), []byte("Host from-home\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := readHosts(t, app, cookie); len(got.Hosts) != 2 || got.Hosts[0].ID != "test" || got.Hosts[1].Kind != "local" {
		t.Fatal("server read ~/.ssh instead of saved sources")
	}
}

func TestProjectPersistencePreservesExternalSettingsAndRevokesPreview(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "Host new-alias\n")
	cookie, csrf := signIn(t, app)
	previewURL := makePreview(t, app, cookie, csrf)
	discovered := readHosts(t, app, cookie).Hosts[1]
	external, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	external.PasswordHash, err = config.HashPassword("changed-password")
	if err != nil {
		t.Fatal(err)
	}
	external.Listen, external.SessionHours = "127.0.0.1:9101", 29
	external.Hosts[0].Roots[0].Path = "/changed-authorization"
	external.Hosts = append(external.Hosts, config.Host{ID: "external", Label: "External", Target: "external", Roots: []config.Root{}})
	if err := config.Save(filename, external); err != nil {
		t.Fatal(err)
	}
	body := map[string]string{"host": discovered.ID, "target": discovered.Target, "path": "/srv/results"}
	var first struct {
		Host config.Host `json:"host"`
		Root config.Root `json:"root"`
	}
	for attempt := range 2 {
		w := request(app, "POST", "/api/projects", body, cookie, csrf)
		if w.Code != 200 {
			t.Fatalf("project %d: %d %s", attempt, w.Code, w.Body)
		}
		var got struct {
			Host config.Host `json:"host"`
			Root config.Root `json:"root"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			first = got
			body["label"] = "A duplicate must not rename the existing root"
		} else if !reflect.DeepEqual(first, got) {
			t.Fatal("duplicate project changed the original host or root")
		}
	}
	if first.Host.ID != discovered.ID || first.Root.Label != "results" || len(first.Host.Roots) != 1 {
		t.Fatalf("project response = %#v", first)
	}
	if w := previewRequest(app, previewURL); w.Code != 401 {
		t.Fatalf("preview survived changed root authorization: %d", w.Code)
	}
	saved, err := config.Load(filename)
	if err != nil || len(saved.Hosts) != 3 {
		t.Fatalf("saved config: %d hosts, %v", len(saved.Hosts), err)
	}
	if !reflect.DeepEqual(saved.Hosts[0], external.Hosts[0]) || !reflect.DeepEqual(saved.Hosts[2], external.Hosts[2]) ||
		saved.Hosts[1].ID != external.Hosts[1].ID || len(saved.Hosts[1].Roots) != 1 {
		t.Fatal("project setup lost external host/root edits")
	}
	saved.Hosts = external.Hosts
	if !reflect.DeepEqual(saved, external) {
		t.Fatal("project setup lost the disk password or unrelated settings")
	}
	if app.cfg.PasswordHash == external.PasswordHash || app.cfg.Listen == external.Listen || app.cfg.SessionHours == external.SessionHours {
		t.Fatal("setup changed running password/listener/session settings")
	}
	signIn(t, app) // The original running password remains active.
	query := url.Values{"host": {first.Host.ID}, "root": {first.Root.ID}}.Encode()
	if w := request(app, "GET", "/api/list?"+query, nil, cookie, ""); w.Code != 200 {
		t.Fatalf("new root was not usable immediately: %d %s", w.Code, w.Body)
	}
}

func TestProjectRejectsInvalidPathsTargetsAndHostMismatch(t *testing.T) {
	app, store, filename, _ := newSetupApp(t, "Host new-alias\n")
	cookie, csrf := signIn(t, app)
	before, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"path", "target", "host"} {
		values := map[string][]string{
			"path":   {"", "relative", "/srv/../secret", "/srv/./results", "//srv", "/srv/", "/srv\\bad", "/bad\x00path", "/bad\npath"},
			"target": {"", "-oProxyCommand=bad", "has space", "has\nnewline"},
			"host":   {"missing", "test"},
		}[field]
		for _, value := range values {
			body := map[string]string{"target": "new-alias", "path": "/srv/results"}
			body[field] = value
			if w := request(app, "POST", "/api/projects", body, cookie, csrf); w.Code != 400 {
				t.Errorf("invalid %s %q: %d %s", field, value, w.Code, w.Body)
			}
		}
	}
	after, err := os.ReadFile(filename)
	if err != nil || string(before) != string(after) || store.opens != 0 {
		t.Fatal("invalid project changed disk config or contacted storage")
	}
	for _, target := range []string{"user@manual-host", "user@2001:db8::1"} {
		w := request(app, "POST", "/api/projects", map[string]string{"target": target, "path": "/explicit/folder", "label": "Chosen"}, cookie, csrf)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"label":"Chosen"`) {
			t.Fatalf("manual target: %d %s", w.Code, w.Body)
		}
	}
}

func TestProjectHonorsSelectedHostWithDuplicateTarget(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	cfg, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	first := cfg.Hosts[0]
	cfg.Hosts = append(cfg.Hosts, config.Host{
		ID: "second", Label: "Second", Target: first.Target, Roots: []config.Root{},
	})
	if err := config.Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	var savedRoot config.Root
	for attempt := range 2 {
		w := request(app, "POST", "/api/projects", map[string]string{
			"host": "second", "target": first.Target, "path": "/selected",
		}, cookie, csrf)
		var response struct {
			Host config.Host `json:"host"`
			Root config.Root `json:"root"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 {
			t.Fatalf("selected host setup: %d %s, %v", w.Code, w.Body, err)
		}
		if response.Host.ID != "second" || len(response.Host.Roots) != 1 {
			t.Fatalf("selected the wrong host: %#v", response)
		}
		if attempt == 0 {
			savedRoot = response.Root
		} else if response.Root != savedRoot {
			t.Fatal("duplicate setup changed the selected host's root")
		}
	}
	saved, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(saved.Hosts[0], first) || len(saved.Hosts[1].Roots) != 1 || saved.Hosts[1].Roots[0] != savedRoot {
		t.Fatalf("setup changed the wrong host: %#v", saved.Hosts)
	}
	// Without a host ID, the first configured target remains the default.
	w := request(app, "POST", "/api/projects", map[string]string{
		"target": first.Target, "path": "/manual",
	}, cookie, csrf)
	var response struct {
		Host config.Host `json:"host"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 || response.Host.ID != first.ID {
		t.Fatalf("manual target did not reuse the first host: %d %s, %v", w.Code, w.Body, err)
	}
}

func TestConcurrentProjectUpdatesPreserveSavedSources(t *testing.T) {
	app, store, filename, _ := newSetupApp(t, "Host new-alias another-alias\n")
	cookie, csrf := signIn(t, app)
	var workers sync.WaitGroup
	for i := range 12 {
		workers.Go(func() {
			// Read snapshots and resolve authorization while publishing updates.
			if w := request(app, "GET", "/api/hosts", nil, cookie, ""); w.Code != 200 {
				t.Errorf("concurrent hosts: %d", w.Code)
			}
			if w := request(app, "GET", "/api/list"+fileQuery(""), nil, cookie, ""); w.Code != 200 {
				t.Errorf("concurrent resolve: %d", w.Code)
			}
			w := request(app, "POST", "/api/projects", map[string]string{
				"target": "new-alias", "path": fmt.Sprintf("/project/%d", i%6),
			}, cookie, csrf)
			if w.Code != 200 {
				t.Errorf("project update: %d %s", w.Code, w.Body)
			}
		})
	}
	workers.Wait()
	got, err := config.Load(filename)
	if err != nil || len(got.Hosts) != 3 {
		t.Fatalf("concurrent config = %d hosts, %v", len(got.Hosts), err)
	}
	for _, host := range got.Hosts {
		if host.Target == "new-alias" && len(host.Roots) != 6 {
			t.Fatalf("concurrent roots = %d; want 6", len(host.Roots))
		}
	}
	if !reflect.DeepEqual(app.hostSnapshot(), got.Hosts) || store.opens != 0 {
		t.Fatal("memory diverged from disk or setup opened storage")
	}
	response := readHosts(t, app, cookie)
	if len(response.Hosts) != 4 || !response.SetupEnabled {
		t.Fatal("concurrent project updates lost saved sources")
	}
}

type blockedPreviewStore struct {
	*localStore
	entered, release chan struct{}
}

func (s *blockedPreviewStore) Open(ctx context.Context, target, root, rel string) (storage.File, error) {
	close(s.entered)
	<-s.release
	return s.localStore.Open(ctx, target, root, rel)
}

func TestSetupRevokesPreviewBeingCreated(t *testing.T) {
	app, store, filename, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	blocked := &blockedPreviewStore{localStore: store, entered: make(chan struct{}), release: make(chan struct{})}
	app.store = blocked
	done := make(chan int, 1)
	go func() {
		w := request(app, "POST", "/api/preview", location{Host: "test", Root: "artifacts", Path: "reports/index.html"}, cookie, csrf)
		done <- w.Code
	}()
	<-blocked.entered
	cfg, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Hosts = nil // An external edit revokes the old root.
	if err := config.Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	w := request(app, "POST", "/api/projects", map[string]string{"target": "another", "path": "/allowed"}, cookie, csrf)
	close(blocked.release)
	if w.Code != 200 {
		t.Fatalf("setup: %d %s", w.Code, w.Body)
	}
	if status := <-done; status != 409 {
		t.Fatalf("stale preview creation = %d; want conflict", status)
	}
	app.mu.Lock()
	defer app.mu.Unlock()
	if len(app.previews) != 0 {
		t.Fatal("stale preview capability was published after revocation")
	}
}
