package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"artiface/internal/config"
)

func TestPasswordEnvironmentValidationAndClearing(t *testing.T) {
	for _, tc := range []struct {
		name, password string
		set, valid     bool
	}{
		{"valid", "initial6", true, true},
		{"empty", "", true, false},
		{"short", "short", true, false},
		{"unset without terminal", "", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ARTIFACE_PASSWORD", tc.password)
			if !tc.set {
				if err := os.Unsetenv("ARTIFACE_PASSWORD"); err != nil {
					t.Fatal(err)
				}
			}
			var output bytes.Buffer
			hash, err := readPasswordHash(nil, &output)
			if !tc.valid {
				if err == nil || hash != "" {
					t.Fatal("invalid or missing password was accepted")
				}
			} else if err != nil || !config.VerifyPassword(hash, tc.password) {
				t.Fatal("password environment value was not used")
			}
			if _, present := os.LookupEnv("ARTIFACE_PASSWORD"); present {
				t.Fatal("password was left in the environment")
			}
			if output.Len() != 0 {
				t.Fatal("automated password input was printed or prompted")
			}
		})
	}
}

func TestDefaultConfigurationPathAndNoOverwrite(t *testing.T) {
	switch runtime.GOOS {
	case "windows", "darwin", "ios", "plan9":
		t.Skip("this fixture uses XDG_CONFIG_HOME")
	}
	configDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configDir)
	preferred := filepath.Join(configDir, "artiface", "config.json")
	assertDefault := func() {
		t.Helper()
		if got, err := config.DefaultPath(); err != nil || got != preferred {
			t.Fatalf("default config = %q, %v; want %q", got, err, preferred)
		}
	}
	assertDefault()
	var output bytes.Buffer
	selected, err := configArgument("serve", nil, &output)
	if err != nil || selected != preferred {
		t.Fatal("server did not select the default Artiface config")
	}
	// Looking up a default path must not create its directory.
	if entries, err := os.ReadDir(configDir); err != nil || len(entries) != 0 {
		t.Fatal("default path lookup wrote to the config directory")
	}
	cfg := config.Default()
	cfg.PasswordHash, err = config.HashPassword("initial6")
	if err != nil {
		t.Fatal(err)
	}
	if err := createConfig(preferred, cfg); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(preferred)
	if err != nil {
		t.Fatal(err)
	}
	assertDefault()
	t.Setenv("ARTIFACE_PASSWORD", "overwrite6")
	if err := run([]string{"init"}, nil, &output, &output); err == nil {
		t.Fatal("default initialization overwrote the existing configuration")
	}
	after, err := os.ReadFile(preferred)
	if err != nil || !bytes.Equal(original, after) {
		t.Fatal("default initialization changed the existing configuration")
	}
	explicit := filepath.Join(configDir, "chosen.json")
	selected, err = configArgument("serve", []string{"--config", explicit}, &output)
	if err != nil || selected != explicit {
		t.Fatal("explicit config path did not override the default")
	}
	// A dangling symlink must not be replaced or followed during initialization.
	if err := os.Remove(preferred); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(configDir, "missing")
	if err := os.Symlink(missing, preferred); err != nil {
		t.Fatal(err)
	}
	assertDefault()
	if err := run([]string{"init"}, nil, &output, &output); err == nil {
		t.Fatal("initialization accepted a dangling config symlink")
	}
	if target, err := os.Readlink(preferred); err != nil || target != missing {
		t.Fatal("initialization changed the config symlink")
	}
	if _, err := os.Lstat(missing); !os.IsNotExist(err) {
		t.Fatal("initialization created a file through the config symlink")
	}
}
