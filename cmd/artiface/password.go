package main

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"

	"artiface/internal/config"
	"artiface/internal/sshvault"

	"golang.org/x/term"
)

func initialize(filename string, input *os.File, output io.Writer, cfg config.Config) error {
	if _, err := os.Lstat(filename); err == nil {
		return errors.New("configuration already exists; use 'artiface password' to reset its password")
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect configuration path: %w", err)
	}
	encoded, err := readPasswordHash(input, output)
	if err != nil {
		return err
	}
	cfg.PasswordHash = encoded
	if err := createConfig(filename, cfg); err != nil {
		return err
	}
	_, err = fmt.Fprintf(output, "Created configuration: %s\nImport hosts with 'artiface import-ssh', or start 'artiface serve' and choose a host and folder in the web app.\nPass --config with this file for either command.\n", filename)
	return err
}

func resetPassword(filename string, input *os.File, output io.Writer, forgetSSH bool) error {
	load := config.Load
	if forgetSSH {
		load = config.LoadSettings
	}
	before, err := load(filename)
	if err != nil {
		return err
	}
	var bundle sshvault.Bundle
	if before.SSHCredentials != nil && !forgetSSH {
		value, supplied := os.LookupEnv("ARTIFACE_CURRENT_PASSWORD")
		_ = os.Unsetenv("ARTIFACE_CURRENT_PASSWORD")
		current := []byte(value)
		if !supplied {
			current, err = readSecret(input, output, "Current admin password (needed to keep SSH credentials): ")
		}
		defer clear(current)
		if err != nil {
			return errors.New("enter the current admin password, or explicitly use --forget-ssh and reimport credentials after recovery")
		}
		if !config.VerifyPassword(before.PasswordHash, string(current)) {
			return errors.New("incorrect current admin password")
		}
		bundle, err = sshvault.Open(before.SSHCredentials, string(current))
		if err != nil {
			return err
		}
		defer bundle.Clear()
	}
	password, _, err := readNewPassword(input, output, false)
	defer clear(password)
	if err != nil {
		return err
	}
	encoded, err := config.HashPassword(string(password))
	if err != nil {
		return err
	}
	var encrypted *sshvault.Envelope
	if before.SSHCredentials != nil && !forgetSSH {
		encrypted, err = sshvault.Seal(bundle, string(password))
		if err != nil {
			return err
		}
	}
	// Preserve any host settings edited while the user was entering a password.
	if forgetSSH {
		err = config.ForgetSSH(filename, before.PasswordHash, encoded)
	} else {
		_, err = config.Update(filename, func(cfg *config.Config) error {
			if cfg.PasswordHash != before.PasswordHash || !reflect.DeepEqual(cfg.SSHCredentials, before.SSHCredentials) {
				return config.ErrConflict
			}
			cfg.PasswordHash = encoded
			cfg.SSHCredentials = encrypted
			return nil
		})
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(output, "Updated password in: %s\nRestart a running Artiface server to apply the new password.\n", filename)
	return err
}

func readPasswordHash(input *os.File, output io.Writer) (string, error) {
	password, _, err := readNewPassword(input, output, false)
	defer clear(password)
	if err != nil {
		return "", err
	}
	return config.HashPassword(string(password))
}

func readNewPassword(input *os.File, output io.Writer, generateIfEmpty bool) ([]byte, bool, error) {
	password, present, err := passwordEnvironment()
	if err != nil {
		return nil, false, err
	}
	if present {
		return []byte(password), false, nil
	}
	if input == nil || !term.IsTerminal(int(input.Fd())) {
		return nil, false, errors.New("password input requires a terminal; set ARTIFACE_PASSWORD for automation")
	}
	prompt := "New password (at least 6 characters): "
	if generateIfEmpty {
		prompt = "Choose an admin password (at least 6 characters), or press Enter to generate one: "
	}
	if _, err := io.WriteString(output, prompt); err != nil {
		return nil, false, err
	}
	first, err := term.ReadPassword(int(input.Fd()))
	fmt.Fprintln(output)
	if err != nil {
		clear(first)
		return nil, false, errors.New("could not read password from the terminal")
	}
	if generateIfEmpty && len(first) == 0 {
		return []byte(rand.Text()), true, nil
	}
	if _, err := io.WriteString(output, "Confirm password: "); err != nil {
		clear(first)
		return nil, false, err
	}
	second, err := term.ReadPassword(int(input.Fd()))
	fmt.Fprintln(output)
	defer clear(second)
	if err != nil {
		clear(first)
		return nil, false, errors.New("could not read password confirmation from the terminal")
	}
	if subtle.ConstantTimeCompare(first, second) != 1 {
		clear(first)
		return nil, false, errors.New("passwords do not match")
	}
	return first, false, nil
}

func readSecret(input *os.File, output io.Writer, label string) ([]byte, error) {
	if input == nil || !term.IsTerminal(int(input.Fd())) {
		return nil, errors.New("secret input requires an interactive terminal")
	}
	if _, err := io.WriteString(output, label); err != nil {
		return nil, err
	}
	value, err := term.ReadPassword(int(input.Fd()))
	fmt.Fprintln(output)
	if err != nil {
		clear(value)
		return nil, errors.New("could not read secret from terminal")
	}
	return value, nil
}

func passwordEnvironment() (string, bool, error) {
	password, present := os.LookupEnv("ARTIFACE_PASSWORD")
	if present {
		// Consume the startup credential before any subprocess.
		if err := os.Unsetenv("ARTIFACE_PASSWORD"); err != nil {
			return "", false, fmt.Errorf("could not clear ARTIFACE_PASSWORD from the environment: %w", err)
		}
	}
	return password, present, nil
}

func loadOrCreateConfig(filename string, initial config.Config, output io.Writer) (config.Config, error) {
	// Remove startup credentials before any SSH subprocess, even on restarts.
	password, supplied, err := passwordEnvironment()
	if err != nil {
		return config.Config{}, err
	}
	cfg, err := config.Load(filename)
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		return cfg, err
	}
	if !supplied {
		password = rand.Text()
	}
	initial.PasswordHash, err = config.HashPassword(password)
	if err != nil {
		return config.Config{}, err
	}
	if err := createConfig(filename, initial); err != nil {
		return config.Config{}, err
	}
	if _, err := fmt.Fprintf(output, "Created configuration: %s\n", filename); err != nil {
		return config.Config{}, err
	}
	if !supplied {
		if _, err := fmt.Fprintf(output, "Initial password: %s\nThis password is shown only when the configuration is created.\n", password); err != nil {
			return config.Config{}, err
		}
	}
	return initial, nil
}

func createConfig(filename string, cfg config.Config) error {
	err := config.Create(filename, cfg)
	if errors.Is(err, os.ErrExist) {
		return errors.New("configuration already exists; use 'artiface password' to reset its password")
	}
	return err
}
