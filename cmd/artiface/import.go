package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"artiface/internal/config"
	"artiface/internal/sshvault"
)

type repeatedFlag []string

func (f *repeatedFlag) String() string         { return fmt.Sprint([]string(*f)) }
func (f *repeatedFlag) Set(value string) error { *f = append(*f, value); return nil }

func importSSHCommand(args []string, input *os.File, output, errorOutput io.Writer) error {
	flags := flag.NewFlagSet("artiface import-ssh", flag.ContinueOnError)
	flags.SetOutput(errorOutput)
	filename := flags.String("config", "", "private application configuration; created if missing")
	source := flags.String("ssh-config", "", "SSH configuration to import once (default ~/.ssh/config)")
	var hosts, passwordHosts repeatedFlag
	flags.Var(&hosts, "host", "import only this SSH alias; repeat for multiple hosts")
	flags.Var(&passwordHosts, "password-host", "prompt for this host's SSH login password; repeat as needed")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments; use --config, --ssh-config, and --host")
	}
	if *filename == "" {
		value, err := config.DefaultPath()
		if err != nil {
			return err
		}
		*filename = value
	}
	absolute, err := filepath.Abs(*filename)
	if err != nil {
		return err
	}
	*filename = absolute
	cfg, err := config.Load(*filename)
	create := errors.Is(err, os.ErrNotExist)
	if err != nil && !create {
		return err
	}
	var password []byte
	var generated bool
	if create {
		cfg = initialConfig()
		password, generated, err = readNewPassword(input, output, true)
	} else {
		var value string
		var supplied bool
		value, supplied, err = passwordEnvironment()
		if supplied {
			password = []byte(value)
		} else if err == nil {
			password, err = readSecret(input, output, "Admin password: ")
		}
	}
	defer clear(password)
	if err != nil {
		return err
	}
	if create {
		cfg.PasswordHash, err = config.HashPassword(string(password))
		if err != nil {
			return err
		}
	} else if !config.VerifyPassword(cfg.PasswordHash, string(password)) {
		return errors.New("incorrect admin password")
	}
	bundle, aliases, err := config.ReadSSHCredentials(*source, hosts, passwordHosts, func(kind, alias string) ([]byte, error) {
		return readSecret(input, output, fmt.Sprintf("SSH %s for %s: ", kind, alias))
	})
	if err != nil {
		return err
	}
	defer bundle.Clear()
	imported := 0
	if create {
		cfg.SSHCredentials, err = sshvault.Seal(bundle, string(password))
		if err == nil {
			cfg.Hosts, imported = config.MergeTargets(cfg.Hosts, aliases)
			err = createConfig(*filename, cfg)
		}
	} else {
		_, imported, err = config.MergeSSHCredentials(*filename, string(password), bundle, aliases)
	}
	if err != nil {
		return err
	}
	if generated {
		if _, err := fmt.Fprintf(output, "Initial password: %s\nSave this password; it is shown only once after the configuration is created.\n", password); err != nil {
			return err
		}
	}
	_, err = fmt.Fprintf(output, "Imported encrypted credentials for %d SSH hosts (%d new sources).\nNo project roots were added.\nRestart Artiface, then sign in as the personal owner or team admin to unlock SSH.\nThe original .ssh directory is no longer needed at runtime.\n", len(aliases), imported)
	return err
}
