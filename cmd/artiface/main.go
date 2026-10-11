package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"artiface/internal/config"
)

const version = "dev"

const usage = `Artiface: browse artifacts on local and SSH sources.

Usage:
  artiface init     [--config path]   Create a private configuration
  artiface password [--config path] [--forget-ssh]
                                     Change password or explicitly recover without SSH credentials
  artiface serve    [--config path]   Start the application server
  artiface import-ssh [--config path] [--ssh-config path] [--host alias]
                     [--password-host alias]
                                     Import and encrypt SSH credentials without granting folders
  artiface version
  artiface help

New passwords you choose are prompted twice without echo.
serve creates a missing configuration and prints a generated initial password once.
For automation, set ARTIFACE_PASSWORD for init, import-ssh, password, or first-time serve; there is no password flag.
The default configuration is artiface/config.json in your user configuration directory.
SSH import defaults to ~/.ssh/config and creates a missing app configuration.
On first-time import, choose an admin password or press Enter to generate one.
Generated passwords are shown once after a successful import; existing configurations require their current password.
It snapshots supported settings, private keys and known_hosts once.
Use --password-host to prompt for an SSH login password; repeat --host to select aliases.
Runtime SSH uses only imported credentials, unlocked through admin sign-in after restart.
Password changes preserve credentials by re-encrypting with the new password.
Recovery without the old password requires --forget-ssh followed by a fresh import.
init and serve also accept --listen, --app-origin, and --preview-origin.
ARTIFACE_LISTEN and ARTIFACE_APP_ORIGIN provide defaults for a new configuration.
Explicit flags take precedence over environment defaults.
These settings apply only when creating a configuration; existing files are loaded unchanged.
serve accepts --mode personal|team, or ARTIFACE_MODE, on every start.
The flag takes precedence over the environment, then the saved mode (default: personal).
Mode is fixed until restart; Team administration is at /admin/.
ARTIFACE_DISABLE_SSH=true blocks all SSH connections for this run, including remote Git.
It defaults to false and is read on every server start.
Admin sign-in leaves SSH credentials locked; local projects remain available.
`

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "artiface: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, input *os.File, output, errorOutput io.Writer) error {
	if len(args) == 0 {
		_, err := io.WriteString(output, usage)
		return err
	}
	switch args[0] {
	case "help", "-h", "--help":
		_, err := io.WriteString(output, usage)
		return err
	case "version", "--version":
		_, err := fmt.Fprintf(output, "artiface %s\n", version)
		return err
	case "import-ssh":
		return importSSHCommand(args[1:], input, output, errorOutput)
	case "init", "password", "serve":
		initial := initialConfig()
		mode := os.Getenv("ARTIFACE_MODE")
		forgetSSH := false
		filename, err := configArgument(args[0], args[1:], errorOutput, func(flags *flag.FlagSet) {
			if args[0] == "serve" {
				flags.StringVar(&mode, "mode", mode, "startup mode: personal or team (default: saved mode, then personal)")
			}
			if args[0] == "password" {
				flags.BoolVar(&forgetSSH, "forget-ssh", false, "discard encrypted SSH credentials when recovering a forgotten admin password")
			}
			if args[0] != "password" {
				flags.StringVar(&initial.Listen, "listen", initial.Listen, "listener IP and port for a new configuration")
				flags.StringVar(&initial.AppOrigin, "app-origin", initial.AppOrigin, "browser-facing HTTP or HTTPS URL for a new configuration")
				flags.StringVar(&initial.PreviewOrigin, "preview-origin", "", "optional separate preview URL for a new configuration")
			}
		})
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		if err != nil {
			return err
		}
		switch args[0] {
		case "init":
			return initialize(filename, input, output, initial)
		case "password":
			return resetPassword(filename, input, output, forgetSSH)
		default:
			return serve(filename, output, initial, mode)
		}
	default:
		return errors.New("unknown command; run 'artiface help' for usage")
	}
}

func initialConfig() config.Config {
	cfg := config.Default()
	cfg.Hosts = []config.Host{{ID: "local", Label: "localhost", Kind: "local", Roots: []config.Root{}}}
	if value, present := os.LookupEnv("ARTIFACE_LISTEN"); present {
		cfg.Listen = value
	}
	if value, present := os.LookupEnv("ARTIFACE_APP_ORIGIN"); present {
		cfg.AppOrigin = value
	}
	return cfg
}

func configArgument(command string, args []string, output io.Writer, configure ...func(*flag.FlagSet)) (string, error) {
	flags := flag.NewFlagSet("artiface "+command, flag.ContinueOnError)
	flags.SetOutput(output)
	filename := flags.String("config", "", "configuration file path (default: user configuration directory/artiface/config.json)")
	for _, addFlags := range configure {
		addFlags(flags)
	}
	if err := flags.Parse(args); err != nil {
		return "", err
	}
	if flags.NArg() != 0 {
		return "", errors.New("unexpected positional arguments; use --config path")
	}
	if *filename == "" {
		value, err := config.DefaultPath()
		if err != nil {
			return "", err
		}
		*filename = value
	}
	absolute, err := filepath.Abs(*filename)
	if err != nil {
		return "", fmt.Errorf("resolve configuration path: %w", err)
	}
	return absolute, nil
}
