package config

import (
	"reflect"
	"strings"
	"testing"
)

func TestLocalSourcesAndHiddenMetadata(t *testing.T) {
	cfg := validConfig()
	cfg.Hosts[0].Hidden = true
	cfg.Hosts[0].Roots[0].Hidden = true
	cfg.Hosts = append(cfg.Hosts, Host{ID: "local", Label: "Local machine", Kind: "local", Roots: []Root{}})
	filename := t.TempDir() + "/config.json"
	if err := Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	saved, err := Load(filename)
	if err != nil || !reflect.DeepEqual(cfg, saved) {
		t.Fatalf("local/hidden round trip: %#v, %v", saved, err)
	}
	cfg.Hosts[1].Target = "not-local"
	if Validate(cfg) == nil {
		t.Fatal("local source accepted an SSH target")
	}
	cfg.Hosts[1].Target, cfg.Hosts[1].Kind = "", "ssh"
	if Validate(cfg) == nil {
		t.Fatal("SSH source accepted an empty target")
	}
	cfg.Hosts[1].Kind = "unknown"
	if Validate(cfg) == nil {
		t.Fatal("unknown source kind accepted")
	}
}

func TestExplicitOrigins(t *testing.T) {
	for _, origins := range [][2]string{
		{"", "https://preview.example"},
		{"http://app.example", "https://preview.example"},
		{"https://app.example", "http://preview.example"},
		{"ftp://app.example", "ftp://preview.example"},
		{"http://0.0.0.0:8787", "http://preview.example:8787"},
		{"http://app.example:8787", "http://[::]:8787"},
		{"http://127.1:8787", "http://127.0.0.1:8788"},
		{"https://app.example/", "https://preview.example"},
		{"https://app.example:443/", "https://preview.example"},
		{"https://app.example", "https://preview.example/"},
		{"https://app.example", "https://preview.example:443/"},
		{"https://app.example/path", "https://preview.example"},
		{"https://app.example?", "https://preview.example"},
		{"https://app.example?a=b", "https://preview.example"},
		{"https://app.example#", "https://preview.example"},
		{"https://app.example#x", "https://preview.example"},
		{"https://user:secret@app.example", "https://preview.example"},
		{"https://app.example:", "https://preview.example"},
		{"https://app.example:0", "https://preview.example"},
		{"https://app.example:65536", "https://preview.example"},
		{"https://app.example:0443", "https://preview.example"},
		{"https://app.example.", "https://preview.example"},
		{"https://bad_host", "https://preview.example"},
		{"https://127.1", "https://127.0.0.1"},
		{"https://2130706433", "https://127.0.0.1"},
		{"https://0x7f000001", "https://127.0.0.1"},
		{"https://0177.0.0.1", "https://127.0.0.1"},
	} {
		cfg := validConfig()
		cfg.AppOrigin, cfg.PreviewOrigin = origins[0], origins[1]
		if err := Validate(cfg); err == nil {
			t.Errorf("accepted invalid origins %v", origins)
		}
	}
	cfg := validConfig()
	app, preview := cfg.Origins()
	if app != "http://127.0.0.1:8787" || preview != app {
		t.Fatal("default previews must share the application origin and listener")
	}
	cfg.Listen = "127.0.0.1:80"
	if err := Validate(cfg); err != nil {
		t.Fatal(err)
	}
	app, preview = cfg.Origins()
	if app != "http://127.0.0.1" || preview != app {
		t.Fatal("the inferred origin must omit the default HTTP port, as browsers do")
	}
	cfg.Listen = "127.0.0.1:8787"
	for _, origin := range []string{"http://artiface.lan:8787", "https://APP.example:443"} {
		cfg.AppOrigin, cfg.PreviewOrigin = origin, ""
		if err := Validate(cfg); err != nil {
			t.Fatal(err)
		}
		app, preview = cfg.Origins()
		if preview != app {
			t.Fatal("an omitted preview origin must inherit the application origin")
		}
		cfg.PreviewOrigin = origin
		if err := Validate(cfg); err != nil {
			t.Fatalf("explicit shared origin rejected: %v", err)
		}
	}
	cfg.AppOrigin, cfg.PreviewOrigin = "https://APP.example:443", "https://preview.example:9443"
	if err := Validate(cfg); err != nil {
		t.Fatal(err)
	}
	app, preview = cfg.Origins()
	if app != "https://app.example" || preview != cfg.PreviewOrigin {
		t.Fatalf("normalized origins = %q, %q", app, preview)
	}
	cfg.Listen = "0.0.0.0:8787"
	if err := Validate(cfg); err != nil {
		t.Fatalf("explicit origins did not allow a wildcard listener: %v", err)
	}
	cfg.AppOrigin, cfg.PreviewOrigin = "http://APP.example:80", "http://PREVIEW.example:8787"
	if err := Validate(cfg); err != nil {
		t.Fatal(err)
	}
	app, preview = cfg.Origins()
	if app != "http://app.example" || preview != "http://preview.example:8787" {
		t.Fatalf("normalized HTTP origins = %q, %q", app, preview)
	}
	cfg.AppOrigin = "http://app.example:443"
	app, _ = cfg.Origins()
	if app != cfg.AppOrigin {
		t.Fatal("HTTP origin incorrectly dropped a nondefault port")
	}
}

func TestListenerIPsRequireExplicitBrowserOrigins(t *testing.T) {
	for _, address := range []string{
		"0.0.0.0:8787",
		"192.0.2.10:8787",
		"127.0.0.2:8787",
		"[::]:8787",
		"[::1]:8787",
		"[2001:db8::10]:8787",
	} {
		t.Run(address, func(t *testing.T) {
			cfg := validConfig()
			cfg.Listen = address
			if err := Validate(cfg); err == nil || !strings.Contains(err.Error(), "appOrigin") {
				t.Fatalf("nondefault listeners need usable browser URLs: %v", err)
			}
			cfg.AppOrigin = "http://app.example:8787"
			if err := Validate(cfg); err != nil {
				t.Fatalf("configured IP bind rejected: %v", err)
			}
			app, preview := cfg.Origins()
			if app != cfg.AppOrigin || preview != app {
				t.Fatal("bind addresses changed explicit browser origins")
			}
		})
	}
}
