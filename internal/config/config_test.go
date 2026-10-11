package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

var testHash = "$argon2id$v=19$m=19456,t=2,p=1$" + strings.Repeat("A", 22) + "$" + strings.Repeat("A", 43)

func validConfig() Config {
	cfg := Default()
	cfg.PasswordHash = testHash
	cfg.Hosts = []Host{{
		ID: "work", Label: "Work", Target: "user@host",
		Roots: []Root{{ID: "project", Label: "Project", Path: "/srv/artifacts"}},
	}}
	return cfg
}

func TestSaveLoadPrivateAtomicConfiguration(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "private", "config.json")
	cfg := validConfig()
	if err := Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "linux" && info.Mode().Perm() != 0o600 {
		t.Fatalf("configuration permissions = %o, want 600", info.Mode().Perm())
	}
	got, err := Load(filename)
	if err != nil || !reflect.DeepEqual(got, cfg) {
		t.Fatalf("Load() = %#v, %v; want saved configuration", got, err)
	}
	cfg.SessionHours = 24
	if err := Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	replacement, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(info, replacement) {
		t.Fatal("Save mutated the existing file instead of atomically replacing it")
	}
	got, err = Load(filename)
	if err != nil || got.SessionHours != 24 {
		t.Fatalf("Load after update = %#v, %v", got, err)
	}
	cfg.Listen = "not-an-ip:8787"
	if err := Save(filename, cfg); err == nil {
		t.Fatal("Save accepted an invalid configuration")
	}
	got, err = Load(filename)
	if err != nil || got.SessionHours != 24 {
		t.Fatal("failed Save changed the existing configuration")
	}
}

func TestLoadRejectsUnsafePaths(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux file security rules")
	}
	filename := filepath.Join(t.TempDir(), "config.json")
	if err := Save(filename, validConfig()); err != nil {
		t.Fatal(err)
	}
	link := filename + ".link"
	if err := os.Symlink(filename, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(link); err == nil {
		t.Fatal("Load accepted a symlink")
	}
	if _, err := Load(filepath.Dir(filename)); err == nil {
		t.Fatal("Load accepted a directory")
	}
}

func TestLoadDefaultsAndStrictJSON(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "config.json")
	minimal, err := json.Marshal(map[string]string{"passwordHash": testHash})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, minimal, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Load(filename)
	want := Default()
	want.PasswordHash = testHash
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("Load omitted defaults = %#v, %v", got, err)
	}
	for _, data := range []string{
		string(minimal) + "{}",
		`{"passwordHash":"` + testHash + `","unknown":true}`,
		`null`,
		strings.Repeat(" ", maxConfigBytes+1),
	} {
		if err := os.WriteFile(filename, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(filename); err == nil {
			t.Fatal("Load accepted an invalid JSON document")
		}
	}
}

func TestValidateListenersPathsAndIdentifiers(t *testing.T) {
	tests := []struct {
		name   string
		change func(*Config)
	}{
		{"hostname", func(c *Config) { c.Listen = "localhost:8787" }},
		{"invalid ip", func(c *Config) { c.Listen = "999.0.0.1:8787" }},
		{"unbracketed ipv6", func(c *Config) { c.Listen = "::1:8787" }},
		{"bracketed ipv4", func(c *Config) { c.Listen = "[127.0.0.1]:8787" }},
		{"zero port", func(c *Config) { c.Listen = "127.0.0.1:0" }},
		{"overflow port", func(c *Config) { c.Listen = "127.0.0.1:65536" }},
		{"named port", func(c *Config) { c.Listen = "127.0.0.1:http" }},
		{"signed port", func(c *Config) { c.Listen = "127.0.0.1:+8787" }},
		{"zero-padded port", func(c *Config) { c.Listen = "127.0.0.1:08787" }},
		{"relative root", func(c *Config) { c.Hosts[0].Roots[0].Path = "artifacts" }},
		{"traversal root", func(c *Config) { c.Hosts[0].Roots[0].Path = "/srv/../etc" }},
		{"dot root", func(c *Config) { c.Hosts[0].Roots[0].Path = "/srv/./artifacts" }},
		{"double slash root", func(c *Config) { c.Hosts[0].Roots[0].Path = "//srv/artifacts" }},
		{"trailing slash root", func(c *Config) { c.Hosts[0].Roots[0].Path = "/srv/artifacts/" }},
		{"NUL root", func(c *Config) { c.Hosts[0].Roots[0].Path = "/srv/\x00artifacts" }},
		{"control root", func(c *Config) { c.Hosts[0].Roots[0].Path = "/srv/\nartifacts" }},
		{"backslash root", func(c *Config) { c.Hosts[0].Roots[0].Path = `/srv\artifacts` }},
		{"invalid UTF-8 root", func(c *Config) { c.Hosts[0].Roots[0].Path = "/srv/\xffartifacts" }},
		{"empty target", func(c *Config) { c.Hosts[0].Target = "" }},
		{"option target", func(c *Config) { c.Hosts[0].Target = "-oProxyCommand=bad" }},
		{"space target", func(c *Config) { c.Hosts[0].Target = "user@host name" }},
		{"unicode space target", func(c *Config) { c.Hosts[0].Target = "host\u00a0name" }},
		{"control target", func(c *Config) { c.Hosts[0].Target = "host\nname" }},
		{"invalid UTF-8 target", func(c *Config) { c.Hosts[0].Target = "host\xffname" }},
		{"traversal host id", func(c *Config) { c.Hosts[0].ID = "../work" }},
		{"empty root id", func(c *Config) { c.Hosts[0].Roots[0].ID = "" }},
		{"duplicate host", func(c *Config) { c.Hosts = append(c.Hosts, c.Hosts[0]) }},
		{"duplicate root", func(c *Config) { c.Hosts[0].Roots = append(c.Hosts[0].Roots, c.Hosts[0].Roots[0]) }},
		{"zero session", func(c *Config) { c.SessionHours = 0 }},
		{"negative session", func(c *Config) { c.SessionHours = -1 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := validConfig()
			cfg.AppOrigin, cfg.PreviewOrigin = "http://app.example:8787", "http://preview.example:8787"
			test.change(&cfg)
			if err := Validate(cfg); err == nil {
				t.Fatal("Validate accepted an invalid configuration")
			}
		})
	}
	for _, target := range []string{"my-ssh-alias", "user@host", "2001:db8::1", "user@2001:db8::1"} {
		cfg := validConfig()
		cfg.Hosts[0].Target = target
		if err := Validate(cfg); err != nil {
			t.Errorf("valid target %q: %v", target, err)
		}
	}
}
