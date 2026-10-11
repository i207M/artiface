package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func sshFixture(t *testing.T, filename, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverSSHIncludesLiteralsAndNeverExecutes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	base := filepath.Join(home, ".ssh")
	marker := filepath.Join(home, "executed")
	sshFixture(t, filepath.Join(home, "bin", "ssh"), "#!/bin/sh\n: > '"+marker+"'\nexit 1\n")
	if err := os.Chmod(filepath.Join(home, "bin", "ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Join(home, "bin"))
	sshFixture(t, filepath.Join(base, "config"), `
# Host ignored
hOsT = "alpha" 'beta' alpha *.example !excluded q?st -option "has space" literal!name [::1]
    HostName hidden.example
    ProxyCommand touch `+marker+`
Match exec "touch `+marker+`"
    LocalCommand touch `+marker+`
Include "conf.d/*.conf" 'with space/file' ~/outside.conf missing/*.conf absent.conf
Host omega
`)
	sshFixture(t, filepath.Join(base, "conf.d", "20.conf"), "Host delta\nInclude conf.d/*.conf\n")
	sshFixture(t, filepath.Join(base, "conf.d", "10.conf"), "Host gamma\nInclude config\n")
	sshFixture(t, filepath.Join(base, "with space", "file"), "Host epsilon\n")
	sshFixture(t, filepath.Join(home, "outside.conf"), "Host=zeta # inline comment\n")
	want := []string{"alpha", "beta", "literal!name", "[::1]", "gamma", "delta", "epsilon", "zeta", "omega"}
	for _, filename := range []string{"", filepath.Join(base, "config"), "~/.ssh/config"} {
		got, err := DiscoverSSH(filename)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("DiscoverSSH(%q) = %q, %v; want %q", filename, got, err, want)
		}
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("discovery executed an SSH or Match command")
	}
	// A directory wildcard may also match ordinary files.
	sshFixture(t, filepath.Join(base, "config"), "Include */*.conf\n")
	got, err := DiscoverSSH("")
	if err != nil || !reflect.DeepEqual(got, []string{"gamma", "delta"}) {
		t.Fatalf("directory globs = %q, %v", got, err)
	}
}

func TestDiscoverSSHBoundsAndPartialFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		fill func(*testing.T, string)
	}{
		{"bytes", func(t *testing.T, file string) { sshFixture(t, file, strings.Repeat("#", maxSSHBytes+1)) }},
		{"line", func(t *testing.T, file string) { sshFixture(t, file, strings.Repeat("#", 128<<10)) }},
		{"aliases", func(t *testing.T, file string) {
			var text strings.Builder
			for i := 0; i <= maxSSHAliases; i++ {
				fmt.Fprintf(&text, "Host h%d\n", i)
			}
			sshFixture(t, file, text.String())
		}},
		{"files", func(t *testing.T, file string) {
			sshFixture(t, file, "Include parts/*\n")
			for i := 0; i <= maxSSHFiles; i++ {
				sshFixture(t, filepath.Join(filepath.Dir(file), "parts", fmt.Sprint(i)), "Host alias\n")
			}
		}},
		{"depth", func(t *testing.T, file string) {
			for i := 0; i <= maxSSHDepth+1; i++ {
				next := fmt.Sprintf("%s%d", file, i+1)
				sshFixture(t, file, "Include "+next+"\n")
				file = next
			}
		}},
		{"quote", func(t *testing.T, file string) { sshFixture(t, file, "Host before\nInclude \"unclosed\n") }},
		{"directory", func(t *testing.T, file string) {
			if err := os.MkdirAll(file, 0700); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "config")
			tc.fill(t, file)
			aliases, err := DiscoverSSH(file)
			if err == nil || len(aliases) > maxSSHAliases {
				t.Fatalf("unbounded discovery = %d aliases, %v", len(aliases), err)
			}
		})
	}
	if aliases, err := DiscoverSSH(filepath.Join(t.TempDir(), "missing")); err != nil || len(aliases) != 0 {
		t.Fatalf("missing SSH config = %q, %v", aliases, err)
	}
	d := sshDiscovery{entries: 1}
	dir := t.TempDir()
	sshFixture(t, filepath.Join(dir, "one"), "")
	sshFixture(t, filepath.Join(dir, "two"), "")
	if _, err := d.glob(filepath.Join(dir, "*"), 0); err == nil {
		t.Fatal("directory enumeration was unbounded")
	}
}

func TestMergeTargetsPreservesRootsAndIDs(t *testing.T) {
	cfg := validConfig()
	// Configured IDs cannot steal the discovered host's identity.
	cfg.Hosts[0].ID = UniqueID("ssh", "new-alias", map[string]bool{})
	expected, _ := MergeTargets(cfg.Hosts, []string{"user@host", "new-alias"})
	if len(expected) != 2 || expected[0].ID == expected[1].ID || !reflect.DeepEqual(expected[0], cfg.Hosts[0]) {
		t.Fatal("host merge changed existing roots or reused an ID")
	}
	repeated, added := MergeTargets(expected, []string{"user@host", "new-alias"})
	if added != 0 || !reflect.DeepEqual(repeated, expected) {
		t.Fatal("repeated host merge was not idempotent")
	}
}

func TestUpdateDetectsExternalReplacementAndSerializesMerges(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "app.json")
	cfg := validConfig()
	if err := Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	external := cfg
	external.SessionHours = 99
	_, err := Update(filename, func(cfg *Config) error {
		// Simulate an external editor that does not participate in app locks.
		data, err := json.Marshal(external)
		if err != nil {
			return err
		}
		replacement := filepath.Join(filepath.Dir(filename), "external.json")
		if err := os.WriteFile(replacement, data, 0600); err != nil {
			return err
		}
		if err := os.Rename(replacement, filename); err != nil {
			return err
		}
		cfg.Hosts, _ = MergeTargets(cfg.Hosts, []string{"lost"})
		return nil
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("external replacement = %v; want conflict", err)
	}
	got, err := Load(filename)
	if err != nil || !reflect.DeepEqual(got, external) {
		t.Fatal("update overwrote the external edit")
	}
	var workers sync.WaitGroup
	for i := range 12 {
		workers.Go(func() {
			_, err := Update(filename, func(cfg *Config) error {
				cfg.Hosts, _ = MergeTargets(cfg.Hosts, []string{fmt.Sprintf("host-%d", i)})
				return nil
			})
			if err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	got, err = Load(filename)
	if err != nil || len(got.Hosts) != 13 || got.SessionHours != 99 {
		t.Fatalf("concurrent merges lost data: %d hosts, %v", len(got.Hosts), err)
	}
}
