package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"artiface/internal/config"
)

func TestInitializeResetAndNoOverwrite(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "private", "config.json")
	initialPassword := "init42"
	t.Setenv("ARTIFACE_PASSWORD", initialPassword)
	var output bytes.Buffer
	if err := run([]string{"init", "--config", filename}, nil, &output, &output); err != nil {
		t.Fatal(err)
	}
	if _, present := os.LookupEnv("ARTIFACE_PASSWORD"); present {
		t.Fatal("initialization left the password environment variable set")
	}
	cfg, err := config.Load(filename)
	if err != nil || !config.VerifyPassword(cfg.PasswordHash, initialPassword) {
		t.Fatal("initialization did not save a usable private configuration")
	}
	if strings.Contains(output.String(), initialPassword) || strings.Contains(output.String(), cfg.PasswordHash) {
		t.Fatal("initialization printed a password or its hash")
	}
	before, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"init", "--config", filename}, nil, &output, &output); err == nil {
		t.Fatal("initialization overwrote an existing configuration")
	}
	if err := createConfig(filename, cfg); err == nil {
		t.Fatal("exclusive creation overwrote an existing configuration")
	}
	link := filename + ".link"
	if err := os.Symlink(filename, link); err != nil {
		t.Fatal(err)
	}
	if err := createConfig(link, cfg); err == nil {
		t.Fatal("exclusive creation followed an existing symlink")
	}
	after, err := os.ReadFile(filename)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("refused initialization changed the existing configuration")
	}

	cfg.Hosts = []config.Host{{
		ID: "work", Label: "Work", Target: "my-ssh-alias",
		Roots: []config.Root{{ID: "project", Label: "Project", Path: "/srv/artifacts"}},
	}}
	if err := config.Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	newPassword := "reset6"
	t.Setenv("ARTIFACE_PASSWORD", newPassword)
	if err := run([]string{"password", "--config", filename}, nil, &output, &output); err != nil {
		t.Fatal(err)
	}
	if _, present := os.LookupEnv("ARTIFACE_PASSWORD"); present {
		t.Fatal("password reset left the password environment variable set")
	}
	updated, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	if !config.VerifyPassword(updated.PasswordHash, newPassword) || config.VerifyPassword(updated.PasswordHash, initialPassword) {
		t.Fatal("password reset did not replace the old password")
	}
	if !reflect.DeepEqual(updated.Hosts, cfg.Hosts) {
		t.Fatal("password reset changed host configuration")
	}
	if strings.Contains(output.String(), newPassword) || strings.Contains(output.String(), updated.PasswordHash) {
		t.Fatal("password reset printed a password or its hash")
	}
}

func TestConcurrentInitializationHasOneWinner(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "config.json")
	cfg := config.Default()
	cfg.PasswordHash = "$argon2id$v=19$m=19456,t=2,p=1$" + strings.Repeat("A", 22) + "$" + strings.Repeat("A", 43)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Go(func() {
			<-start
			results <- createConfig(filename, cfg)
		})
	}
	close(start)
	workers.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("successful initializations = %d; want exactly one", successes)
	}
	if _, err := config.Load(filename); err != nil {
		t.Fatalf("winning configuration is unusable: %v", err)
	}
}

func TestInitializeBridgeNetworkSettings(t *testing.T) {
	for _, mode := range []string{"environment", "flags"} {
		t.Run(mode, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "config.json")
			t.Setenv("ARTIFACE_PASSWORD", "bridge6")
			t.Setenv("ARTIFACE_LISTEN", "0.0.0.0:8787")
			t.Setenv("ARTIFACE_APP_ORIGIN", "http://artiface.lan:8787")
			args := []string{"init", "--config", filename}
			if mode == "flags" {
				t.Setenv("ARTIFACE_LISTEN", "127.0.0.1:9999")
				t.Setenv("ARTIFACE_APP_ORIGIN", "http://environment.example")
				args = append(args, "--listen", "0.0.0.0:8787", "--app-origin", "http://artiface.lan:8787")
			}
			var output bytes.Buffer
			if err := run(args, nil, &output, &output); err != nil {
				t.Fatal(err)
			}
			cfg, err := config.Load(filename)
			if err != nil {
				t.Fatal(err)
			}
			app, preview := cfg.Origins()
			if cfg.Listen != "0.0.0.0:8787" || app != "http://artiface.lan:8787" ||
				preview != app || !config.VerifyPassword(cfg.PasswordHash, "bridge6") {
				t.Fatal("initialization did not persist a usable shared-origin bridge configuration")
			}
		})
	}
}

func TestStartupCreatesPrivateConfigurationOnce(t *testing.T) {
	for _, supplied := range []bool{false, true} {
		t.Run(fmt.Sprint(supplied), func(t *testing.T) {
			t.Setenv("ARTIFACE_PASSWORD", "")
			if err := os.Unsetenv("ARTIFACE_PASSWORD"); err != nil {
				t.Fatal(err)
			}
			password := "first6"
			if supplied {
				t.Setenv("ARTIFACE_PASSWORD", password)
			}
			filename := filepath.Join(t.TempDir(), "private", "config.json")
			t.Setenv("ARTIFACE_LISTEN", "0.0.0.0:8787")
			t.Setenv("ARTIFACE_APP_ORIGIN", "http://artiface.lan:8787")
			initial := initialConfig()
			var output bytes.Buffer
			cfg, err := loadOrCreateConfig(filename, initial, &output)
			if err != nil {
				t.Fatal(err)
			}
			if _, present := os.LookupEnv("ARTIFACE_PASSWORD"); present {
				t.Fatal("initial startup left a password in the subprocess environment")
			}
			if !supplied {
				password = ""
				for _, line := range strings.Split(output.String(), "\n") {
					if value, ok := strings.CutPrefix(line, "Initial password: "); ok {
						password = value
					}
				}
				if len(password) < 20 {
					t.Fatal("startup did not supply a strong initial password")
				}
			} else if strings.Contains(output.String(), password) {
				t.Fatal("startup printed a supplied password")
			}
			saved, err := config.Load(filename)
			local := config.Host{ID: "local", Label: "localhost", Kind: "local", Roots: []config.Root{}}
			if err != nil || !reflect.DeepEqual(saved, cfg) || cfg.Listen != "0.0.0.0:8787" ||
				cfg.AppOrigin != "http://artiface.lan:8787" || !reflect.DeepEqual(cfg.Hosts, []config.Host{local}) ||
				!config.VerifyPassword(cfg.PasswordHash, password) {
				t.Fatal("startup did not persist usable settings with localhost first", err)
			}
			sshConfig := filepath.Join(t.TempDir(), "ssh-config")
			if err := os.WriteFile(sshConfig, []byte("Host zeta alpha\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			aliases, err := config.DiscoverSSH(sshConfig)
			if err != nil {
				t.Fatal(err)
			}
			var imported int
			cfg, err = config.Update(filename, func(c *config.Config) error {
				c.Hosts, imported = config.MergeTargets(c.Hosts, aliases)
				return nil
			})
			if err != nil || imported != 2 || len(cfg.Hosts) != 3 ||
				!reflect.DeepEqual(cfg.Hosts[0], local) || cfg.Hosts[1].Target != "zeta" || cfg.Hosts[2].Target != "alpha" {
				t.Fatal("SSH import did not append hosts after localhost in discovery order", err)
			}
			// A later user-defined order is preserved on restart.
			cfg.Hosts[0], cfg.Hosts[1] = cfg.Hosts[1], cfg.Hosts[0]
			if err := config.Save(filename, cfg); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(filename)
			if bytes.Contains(before, []byte(password)) {
				t.Fatal("configuration stored the plaintext password")
			}
			output.Reset()
			t.Setenv("ARTIFACE_PASSWORD", "ignored")
			t.Setenv("ARTIFACE_LISTEN", "invalid")
			t.Setenv("ARTIFACE_APP_ORIGIN", "http://changed.example")
			restarted, err := loadOrCreateConfig(filename, initialConfig(), &output)
			after, _ := os.ReadFile(filename)
			if err != nil || !reflect.DeepEqual(restarted, cfg) || !bytes.Equal(before, after) || output.Len() != 0 {
				t.Fatal("restart replaced or reprinted initial settings", err)
			}
			if _, present := os.LookupEnv("ARTIFACE_PASSWORD"); present {
				t.Fatal("startup left a password in the subprocess environment")
			}
		})
	}
}

func TestStartupDoesNotReplaceInvalidConfiguration(t *testing.T) {
	for _, contents := range []string{"", "{}", `{"unknown":true}`, "invalid JSON"} {
		t.Run(contents, func(t *testing.T) {
			filename := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("ARTIFACE_PASSWORD", "first6")
			var output bytes.Buffer
			if _, err := loadOrCreateConfig(filename, config.Default(), &output); err == nil {
				t.Fatal("startup accepted an invalid existing configuration")
			}
			if _, present := os.LookupEnv("ARTIFACE_PASSWORD"); present {
				t.Fatal("failed startup left a password in the subprocess environment")
			}
			after, _ := os.ReadFile(filename)
			if string(after) != contents || output.Len() != 0 {
				t.Fatal("startup replaced an existing configuration")
			}
		})
	}
}
