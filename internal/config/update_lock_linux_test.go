package config

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestConfigurationUpdatesAcrossProcesses(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "config.json")
	cfg := validConfig()
	initial := len(cfg.Hosts)
	if err := Save(filename, cfg); err != nil {
		t.Fatal(err)
	}
	var children []*exec.Cmd
	for i := range 4 {
		cmd := exec.Command(os.Args[0], "-test.run=^TestConfigurationUpdateProcessHelper$")
		cmd.Env = append(os.Environ(), "ARTIFACE_UPDATE_TEST_FILE="+filename, fmt.Sprintf("ARTIFACE_UPDATE_TEST_WORKER=%d", i))
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		children = append(children, cmd)
	}
	for _, child := range children {
		if err := child.Wait(); err != nil {
			t.Fatal("concurrent CLI-style update failed", err)
		}
	}
	saved, err := Load(filename)
	if err != nil || len(saved.Hosts) != initial+32 {
		t.Fatal("concurrent processes lost configuration updates", err)
	}
	lock := filename + ".lock"
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filename, lock); err != nil {
		t.Fatal(err)
	}
	if _, err := Update(filename, func(*Config) error { t.Fatal("unsafe lock accepted"); return nil }); err == nil {
		t.Fatal("symlink lock was accepted")
	}
}

func TestConfigurationUpdateProcessHelper(t *testing.T) {
	filename := os.Getenv("ARTIFACE_UPDATE_TEST_FILE")
	if filename == "" {
		t.Skip("subprocess helper")
	}
	for i := range 8 {
		_, err := Update(filename, func(cfg *Config) error {
			target := fmt.Sprintf("worker-%s-%d", os.Getenv("ARTIFACE_UPDATE_TEST_WORKER"), i)
			cfg.Hosts, _ = MergeTargets(cfg.Hosts, []string{target})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
