package config

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"artiface/internal/sshvault"

	"golang.org/x/crypto/ssh"
)

// SSHImportSecret asks only for an SSH password or an encrypted key's passphrase.
// It must not log, persist, or pass the answer in a subprocess environment.
type SSHImportSecret func(kind, alias string) ([]byte, error)

// ReadSSHCredentials snapshots resolved aliases and only their referenced keys.
// OpenSSH resolves ordinary Host/Include options, but executable configuration
// and Match are rejected before invoking it; this import never connects remotely.
func ReadSSHCredentials(source string, selected, passwordHosts []string, prompt SSHImportSecret) (sshvault.Bundle, []string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return sshvault.Bundle{}, nil, err
	}
	if source == "" {
		source = filepath.Join(home, ".ssh", "config")
	}
	if strings.HasPrefix(source, "~/") {
		source = filepath.Join(home, source[2:])
	}
	source, err = filepath.Abs(source)
	if err != nil {
		return sshvault.Bundle{}, nil, err
	}
	d := sshDiscovery{home: home, base: filepath.Dir(source), files: map[string]bool{}, seen: map[string]bool{}, contents: map[string][]byte{},
		bytes: maxSSHBytes, entries: 8192, inspect: func(key string, words []string) error {
			switch key {
			case "ciphers", "macs", "kexalgorithms", "hostkeyalgorithms", "pubkeyacceptedalgorithms", "pubkeyacceptedkeytypes", "requiredrsasize":
				return fmt.Errorf("SSH import cannot preserve custom %s policy; use a dedicated configuration without algorithm overrides", key)
			case "match", "proxycommand", "knownhostscommand", "localcommand", "remotecommand":
				if len(words) == 1 && words[0] == "none" && key != "match" {
					return nil
				}
				return fmt.Errorf("SSH import does not support %s; use Host entries and ProxyJump in a dedicated import configuration", key)
			}
			return nil
		}}
	if err := d.read(source, 0); err != nil {
		return sshvault.Bundle{}, nil, err
	}
	if len(selected) == 0 {
		selected = d.aliases
	}
	if len(selected) == 0 {
		return sshvault.Bundle{}, nil, errors.New("no SSH aliases found; use --host to select a host")
	}
	snapshot, pathRefs, cleanup, err := d.snapshot(source)
	if err != nil {
		return sshvault.Bundle{}, nil, err
	}
	defer cleanup()
	bundle := sshvault.Bundle{Hosts: map[string]sshvault.Profile{}, Keys: map[string][]byte{}, KnownHosts: map[string]string{}}
	complete := false
	defer func() {
		if !complete {
			bundle.Clear()
		}
	}()
	knownFiles := map[string]string{}
	trustBytes := 0
	keyFiles := map[string]string{}
	loading := map[string]bool{}
	var add func(string, int) error
	add = func(alias string, depth int) error {
		if loading[alias] || depth > 8 {
			return errors.New("SSH jump hosts contain a cycle or exceed 8 levels")
		}
		if _, ok := bundle.Hosts[alias]; ok {
			return nil
		}
		if !validTarget(alias) || len(bundle.Hosts) >= 128 {
			return errors.New("SSH import supports at most 128 valid host aliases")
		}
		loading[alias] = true
		defer delete(loading, alias)
		settings, err := resolvedSSH(snapshot, alias)
		if err != nil {
			return fmt.Errorf("%s: %w", alias, err)
		}
		first := func(key string) string {
			values := settings[key]
			if len(values) > 0 {
				return values[0]
			}
			return ""
		}
		port, err := strconv.Atoi(first("port"))
		if err != nil {
			return errors.New("OpenSSH returned an invalid port")
		}
		profile := sshvault.Profile{Hostname: first("hostname"), User: first("user"), Port: port}
		originalName := first("host")
		if originalName == "" {
			originalName = alias
		}
		if value := first("hostkeyalias"); value != "" && value != "none" {
			profile.HostKeyAlias = value
		}
		for _, value := range settings["certificatefile"] {
			if value != "none" {
				return fmt.Errorf("%s: SSH user certificates are not supported by credential import", alias)
			}
		}
		if value := first("proxycommand"); value != "" && value != "none" {
			return errors.New("ProxyCommand is not supported; use ProxyJump")
		}
		if value := first("proxyjump"); value != "" && value != "none" {
			for _, jump := range strings.Split(value, ",") {
				if err := add(jump, depth+1); err != nil {
					return err
				}
				profile.Jumps = append(profile.Jumps, jump)
			}
		}
		for _, identity := range settings["identityfile"] {
			filename, err := sshImportPath(identity, originalName, profile, home)
			if err != nil {
				return err
			}
			if filename == "" {
				continue
			}
			if id, ok := keyFiles[filename]; ok {
				profile.Keys = append(profile.Keys, id)
				continue
			}
			key, err := importSSHFile(filename, 32<<10)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return fmt.Errorf("%s: could not safely read an identity file", alias)
			}
			raw, err := ssh.ParseRawPrivateKey(key)
			clear(key)
			var encrypted *ssh.PassphraseMissingError
			if errors.As(err, &encrypted) {
				if prompt == nil {
					return errors.New("an encrypted SSH key requires a terminal passphrase")
				}
				passphrase, promptErr := prompt("passphrase", alias)
				if promptErr != nil {
					return promptErr
				}
				key, err = importSSHFile(filename, 32<<10)
				if err == nil {
					raw, err = ssh.ParseRawPrivateKeyWithPassphrase(key, passphrase)
				}
				clear(key)
				clear(passphrase)
			}
			if err != nil {
				return fmt.Errorf("%s: private key could not be imported; check its passphrase and key format", alias)
			}
			block, err := ssh.MarshalPrivateKey(raw, "Artiface imported identity")
			if err != nil {
				return errors.New("this SSH key cannot be imported; hardware-backed and agent-only identities are unsupported")
			}
			encoded := pem.EncodeToMemory(block)
			clear(block.Bytes)
			id := fmt.Sprintf("%x", sha256.Sum256(encoded))
			bundle.Keys[id], keyFiles[filename] = encoded, id
			profile.Keys = append(profile.Keys, id)
		}
		if slices.Contains(passwordHosts, alias) {
			if prompt == nil {
				return errors.New("SSH password import requires a terminal")
			}
			profile.Password, err = prompt("password", alias)
			if err != nil {
				return err
			}
		}
		var trust strings.Builder
		for _, setting := range []string{"userknownhostsfile", "globalknownhostsfile"} {
			for _, list := range settings[setting] {
				files, err := sshWords(list)
				if err != nil {
					return errors.New("could not resolve SSH known_hosts paths")
				}
				for _, value := range files {
					if value == "none" {
						continue
					}
					original, ok := pathRefs[value]
					if !ok {
						return errors.New("OpenSSH returned an unexpected known_hosts path")
					}
					value = original
					filename, err := sshImportPath(value, originalName, profile, home)
					if err != nil {
						return err
					}
					if filename == "" {
						continue
					}
					data, exists := knownFiles[filename]
					if !exists {
						bytes, err := importSSHFile(filename, sshvault.MaxPlaintext/2)
						if errors.Is(err, os.ErrNotExist) {
							continue
						}
						if err != nil {
							return errors.New("could not safely read an SSH known_hosts file")
						}
						data = string(bytes)
						knownFiles[filename] = data
					}
					trust.WriteString(data)
					trust.WriteByte('\n')
					if trust.Len() > sshvault.MaxPlaintext/2 {
						return errors.New("known_hosts data exceeds the import limit; use a dedicated file")
					}
				}
			}
		}
		data := trust.String()
		if strings.TrimSpace(data) == "" {
			data = ""
		}
		id := fmt.Sprintf("%x", sha256.Sum256([]byte(data)))
		if _, exists := bundle.KnownHosts[id]; !exists {
			if err := sshvault.CheckKnownHosts(data); err != nil {
				return err
			}
			trustBytes += len(data)
			if trustBytes > sshvault.MaxPlaintext/2 {
				return errors.New("known_hosts data exceeds the import limit")
			}
			bundle.KnownHosts[id] = data
		}
		profile.KnownHosts = id
		bundle.Hosts[alias] = profile
		return nil
	}
	for _, alias := range selected {
		if err := add(alias, 0); err != nil {
			return sshvault.Bundle{}, nil, err
		}
	}
	for _, host := range passwordHosts {
		if _, ok := bundle.Hosts[host]; !ok {
			return sshvault.Bundle{}, nil, errors.New("--password-host must name an imported alias or jump host")
		}
	}
	if err := bundle.Validate(); err != nil {
		return sshvault.Bundle{}, nil, err
	}
	complete = true
	return bundle, slices.Clone(selected), nil
}

type sshImportOutput struct {
	bytes.Buffer
	large bool
}

func (w *sshImportOutput) Write(p []byte) (int, error) {
	if w.Len()+len(p) > 256<<10 {
		w.large = true
		return 0, errors.New("SSH configuration output exceeds its limit")
	}
	return w.Buffer.Write(p)
}

func resolvedSSH(source, alias string) (map[string][]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := []string{"-G", "-F", source, "-oCanonicalizeHostname=no", "-oPermitLocalCommand=no"}
	target := alias
	if user, host, found := strings.Cut(target, "@"); found {
		if user == "" || host == "" {
			return nil, errors.New("invalid SSH login target")
		}
		args = append(args, "-l", user)
		target = host
	}
	if host, port, err := net.SplitHostPort(target); err == nil {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return nil, errors.New("invalid SSH jump-host port")
		}
		args = append(args, "-p", port)
		target = host
	} else if strings.HasPrefix(target, "[") && strings.HasSuffix(target, "]") {
		target = strings.TrimSuffix(strings.TrimPrefix(target, "["), "]")
	}
	args = append(args, "--", target)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	output := &sshImportOutput{}
	cmd.Stdout, cmd.Stderr, cmd.WaitDelay = output, io.Discard, time.Second
	if err := cmd.Run(); err != nil || output.large {
		return nil, errors.New("could not resolve SSH configuration; check the import source and OpenSSH installation")
	}
	result := map[string][]string{}
	for _, line := range strings.Split(output.String(), "\n") {
		key, value, ok := strings.Cut(line, " ")
		if ok {
			result[key] = append(result[key], strings.TrimSpace(value))
		}
	}
	return result, nil
}

func sshImportPath(value, alias string, profile sshvault.Profile, home string) (string, error) {
	if value == "none" {
		return "", nil
	}
	var result strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] != '%' {
			result.WriteByte(value[i])
			continue
		}
		i++
		if i == len(value) {
			return "", errors.New("invalid SSH path token")
		}
		localUser := ""
		if current, err := user.Current(); err == nil {
			localUser = current.Username
		}
		tokens := map[byte]string{'%': "%", 'd': home, 'h': profile.Hostname, 'r': profile.User, 'n': alias, 'p': strconv.Itoa(profile.Port), 'u': localUser}
		replacement, ok := tokens[value[i]]
		if !ok {
			return "", errors.New("unsupported SSH path token; use a literal path or ~/.ssh path")
		}
		result.WriteString(replacement)
	}
	value = result.String()
	if strings.HasPrefix(value, "~/") {
		value = filepath.Join(home, value[2:])
	}
	if strings.ContainsAny(value, "\x00\r\n") || strings.HasPrefix(value, "~") || strings.Contains(value, "${") {
		return "", errors.New("unsupported SSH identity or known_hosts path")
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(home, ".ssh", value)
	}
	return filepath.Clean(value), nil
}

func importSSHFile(filename string, limit int64) ([]byte, error) {
	// Resolve referenced symlinks, but never block on a FIFO or device.
	resolved, err := filepath.EvalSymlinks(filename)
	if err != nil {
		return nil, err
	}
	file, err := openConfigFile(resolved)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("SSH import requires regular files")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		clear(data)
		return nil, errors.New("SSH import file exceeds its limit")
	}
	return data, nil
}

// MergeSSHCredentials preserves existing sources and atomically re-encrypts the
// current vault, so an import cannot discard a concurrently saved password.
func MergeSSHCredentials(filename, password string, imported sshvault.Bundle, aliases []string) (Config, int, error) {
	count := 0
	cfg, err := Update(filename, func(cfg *Config) error {
		if !VerifyPassword(cfg.PasswordHash, password) {
			return errors.New("incorrect admin password")
		}
		bundle, err := sshvault.Open(cfg.SSHCredentials, password)
		if err != nil {
			return err
		}
		defer bundle.Clear()
		for alias, profile := range imported.Hosts {
			clear(bundle.Hosts[alias].Password)
			profile.Password = bytes.Clone(profile.Password)
			bundle.Hosts[alias] = profile
		}
		for id, key := range imported.Keys {
			clear(bundle.Keys[id])
			bundle.Keys[id] = bytes.Clone(key)
		}
		for id, data := range imported.KnownHosts {
			bundle.KnownHosts[id] = data
		}
		used := map[string]bool{}
		usedTrust := map[string]bool{}
		for _, host := range bundle.Hosts {
			usedTrust[host.KnownHosts] = true
			for _, key := range host.Keys {
				used[key] = true
			}
		}
		for id := range bundle.KnownHosts {
			if !usedTrust[id] {
				delete(bundle.KnownHosts, id)
			}
		}
		for id, key := range bundle.Keys {
			if !used[id] {
				clear(key)
				delete(bundle.Keys, id)
			}
		}
		cfg.SSHCredentials, err = sshvault.Seal(bundle, password)
		if err != nil {
			return err
		}
		cfg.Hosts, count = MergeTargets(cfg.Hosts, aliases)
		return nil
	})
	return cfg, count, err
}
