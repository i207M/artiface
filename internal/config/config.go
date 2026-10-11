// Package config manages Artiface's private configuration.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"artiface/internal/sshvault"
)

type Config struct {
	Mode                   string             `json:"mode,omitempty"`
	Users                  []User             `json:"users,omitempty"`
	Listen                 string             `json:"listen"`
	AppOrigin              string             `json:"appOrigin,omitempty"`
	PreviewOrigin          string             `json:"previewOrigin,omitempty"`
	PasswordHash           string             `json:"passwordHash"`
	SessionHours           int                `json:"sessionHours"`
	Hosts                  []Host             `json:"hosts"`
	HideLocalSource        bool               `json:"hideLocalSource,omitempty"`
	OpenProjects           []ProjectRef       `json:"openProjects"`
	SSHCredentialsRevision string             `json:"sshCredentialsRevision,omitempty"`
	SSHCredentials         *sshvault.Envelope `json:"-"`
}

type Host struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Target string `json:"target"`
	Kind   string `json:"kind,omitempty"`
	Hidden bool   `json:"hidden,omitempty"`
	Roots  []Root `json:"roots"`
}

type Root struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	Path           string `json:"path"`
	Hidden         bool   `json:"hidden,omitempty"`
	TrustedScripts bool   `json:"trustedScripts,omitempty"`
}

const maxConfigBytes = 1 << 20

var updateMu sync.Mutex

// ErrConflict means the configuration changed while an update was prepared.
var ErrConflict = errors.New("configuration changed; reload and try again")

// Default returns initial settings; a password must be set before saving.
func Default() Config {
	return Config{
		Listen:       "127.0.0.1:8787",
		SessionHours: 12,
		Hosts:        []Host{},
		OpenProjects: []ProjectRef{},
	}
}

// DefaultPath returns Artiface's per-user configuration path without creating it.
func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate user configuration directory: %w", err)
	}
	return filepath.Join(dir, "artiface", "config.json"), nil
}

// Load reads a regular configuration file and validates its contents.
// Omitted settings inherit their defaults.
func Load(filename string) (Config, error) {
	// Readers can overlap a sidecar update. Recheck the configuration so an
	// old revision read just before publication cannot select a pruned entry.
	for range 4 {
		data, err := readConfig(filename)
		if err != nil {
			return Config{}, err
		}
		cfg, err := parseConfig(data)
		if err != nil {
			return Config{}, err
		}
		cfg.SSHCredentials, err = loadSSHCredentials(filename, cfg.SSHCredentialsRevision)
		current, readErr := readConfig(filename)
		if readErr != nil {
			return Config{}, readErr
		}
		if !bytes.Equal(data, current) {
			continue
		}
		return cfg, err
	}
	return Config{}, ErrConflict
}

// LoadSettings reads the configuration without opening the credential sidecar.
// Password recovery uses it when the encrypted file is missing or damaged.
func LoadSettings(filename string) (Config, error) {
	data, err := readConfig(filename)
	if err != nil {
		return Config{}, err
	}
	return parseConfig(data)
}

func readConfig(filename string) ([]byte, error) {
	file, err := openConfigFile(filename)
	if err != nil {
		return nil, fmt.Errorf("open configuration: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect configuration: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("configuration must be a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read configuration: %w", err)
	}
	if len(data) > maxConfigBytes {
		return nil, errors.New("configuration exceeds the 1 MiB limit")
	}
	return data, nil
}

func parseConfig(data []byte) (Config, error) {
	cfg := Default()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("decode configuration: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return Config{}, errors.New("configuration must contain exactly one JSON object")
	}
	if err := Validate(cfg); err != nil {
		return Config{}, fmt.Errorf("invalid configuration: %w", err)
	}
	return cfg, nil
}

// Save atomically replaces a configuration with an owner-readable/writable file.
// Initialization must use exclusive creation instead to avoid overwriting a file.
func Save(filename string, cfg Config) error {
	return storeConfig(filename, cfg, false)
}

// Create publishes a new configuration without replacing an existing file.
func Create(filename string, cfg Config) error {
	return storeConfig(filename, cfg, true)
}

func storeConfig(filename string, cfg Config, exclusive bool) error {
	if err := Validate(cfg); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return err
	}
	updateMu.Lock()
	defer updateMu.Unlock()
	unlock, err := lockConfigUpdate(filename)
	if err != nil {
		return err
	}
	defer unlock()
	if exclusive {
		if _, err := os.Lstat(filename); err == nil {
			return os.ErrExist
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return save(filename, &cfg, nil, exclusive)
}

// Update serializes local updates and checks the original bytes before replacing.
// Non-cooperating external writers must still avoid the final check/rename window.
func Update(filename string, change func(*Config) error) (Config, error) {
	updateMu.Lock()
	defer updateMu.Unlock()
	unlock, err := lockConfigUpdate(filename)
	if err != nil {
		return Config{}, err
	}
	defer unlock()
	data, err := readConfig(filename)
	if err != nil {
		return Config{}, err
	}
	cfg, err := parseConfig(data)
	if err == nil {
		cfg.SSHCredentials, err = loadSSHCredentials(filename, cfg.SSHCredentialsRevision)
	}
	if err == nil {
		err = change(&cfg)
	}
	if err == nil {
		cfg.PruneOpenProjects()
		err = save(filename, &cfg, data, false)
	}
	return cfg, err
}

func save(filename string, cfg *Config, expected []byte, exclusive bool) error {
	cfg.SSHCredentialsRevision = sshCredentialRevision(cfg.SSHCredentials)
	if err := Validate(*cfg); err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}
	dir := filepath.Dir(filename)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create configuration directory: %w", err)
	}
	file, err := os.CreateTemp(dir, ".artiface-config-*")
	if err != nil {
		return fmt.Errorf("create temporary configuration: %w", err)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("secure configuration: %w", err)
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(cfg); err != nil {
		return fmt.Errorf("write configuration: %w", err)
	}
	if info, err := file.Stat(); err != nil || info.Size() > maxConfigBytes {
		return errors.New("configuration exceeds the 1 MiB limit or cannot be inspected")
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync configuration: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close configuration: %w", err)
	}
	if expected != nil {
		current, err := readConfig(filename)
		if err != nil || !bytes.Equal(current, expected) {
			return ErrConflict
		}
	}
	var previous Config
	if !exclusive {
		var err error
		previous, err = LoadSettings(filename)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := prepareSSHCredentials(filename, previous.SSHCredentialsRevision, cfg.SSHCredentials); err != nil {
		return err
	}
	if expected != nil {
		current, err := readConfig(filename)
		if err != nil || !bytes.Equal(current, expected) {
			return ErrConflict
		}
	}
	if exclusive {
		// Publish the complete file exclusively; readers never see a partial
		// initial configuration, and a concurrent creator cannot be replaced.
		if err := os.Link(file.Name(), filename); err != nil {
			return fmt.Errorf("create configuration: %w", err)
		}
	} else if err := os.Rename(file.Name(), filename); err != nil {
		return fmt.Errorf("replace configuration: %w", err)
	}
	if err := syncConfigDirectory(dir); err != nil {
		return err
	}
	// The configuration rename is the commit point. Cleanup is best effort
	// after it; startup retries it so an interruption cannot lose credentials.
	_ = pruneSSHCredentials(filename, cfg.SSHCredentialsRevision)
	return nil
}

// Validate checks configuration without performing password hashing or SSH I/O.
func Validate(cfg Config) error {
	if err := cfg.SSHCredentials.Validate(); err != nil {
		return err
	}
	if cfg.SSHCredentialsRevision != "" && !validSSHRevision(cfg.SSHCredentialsRevision) {
		return errors.New("sshCredentialsRevision must be a credential revision")
	}
	if err := validateUsers(cfg); err != nil {
		return err
	}
	if _, err := listenerPort(cfg.Listen); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	if err := validateOrigins(cfg.AppOrigin, cfg.PreviewOrigin); err != nil {
		return err
	}
	appIP, _, _ := net.SplitHostPort(cfg.Listen)
	if cfg.AppOrigin == "" && appIP != "127.0.0.1" {
		return errors.New("set appOrigin to the browser-facing URL when binding to an address other than 127.0.0.1")
	}
	if _, err := parseHash(cfg.PasswordHash); err != nil {
		return fmt.Errorf("passwordHash: %w; use 'artiface init' to generate a password hash", err)
	}
	const maxSessionHours = int64((1<<63 - 1) / time.Hour)
	if cfg.SessionHours < 1 || int64(cfg.SessionHours) > maxSessionHours {
		return errors.New("sessionHours must be positive and fit in a time.Duration")
	}
	hostIDs := make(map[string]bool, len(cfg.Hosts))
	for i, host := range cfg.Hosts {
		if !safeID(host.ID) {
			return fmt.Errorf("hosts[%d].id must be a safe identifier (1–64 ASCII letters, digits, '_' or '-', starting with a letter or digit)", i)
		}
		if hostIDs[host.ID] {
			return fmt.Errorf("hosts[%d].id duplicates another host", i)
		}
		hostIDs[host.ID] = true
		switch host.Kind {
		case "local":
			if host.Target != "" {
				return fmt.Errorf("hosts[%d].target must be empty for a local source", i)
			}
		case "", "ssh":
			if !validTarget(host.Target) {
				return fmt.Errorf("hosts[%d].target must be an SSH alias or login target without whitespace, control characters or a leading dash", i)
			}
		default:
			return fmt.Errorf("hosts[%d].kind must be ssh or local", i)
		}
		rootIDs := make(map[string]bool, len(host.Roots))
		for j, root := range host.Roots {
			if !safeID(root.ID) {
				return fmt.Errorf("hosts[%d].roots[%d].id must be a safe identifier (1–64 ASCII letters, digits, '_' or '-', starting with a letter or digit)", i, j)
			}
			if rootIDs[root.ID] {
				return fmt.Errorf("hosts[%d].roots[%d].id duplicates another root on this host", i, j)
			}
			rootIDs[root.ID] = true
			if !path.IsAbs(root.Path) || path.Clean(root.Path) != root.Path || !utf8.ValidString(root.Path) || strings.ContainsRune(root.Path, '\\') || strings.ContainsFunc(root.Path, unicode.IsControl) {
				return fmt.Errorf("hosts[%d].roots[%d].path must be a clean absolute POSIX path without backslashes or control characters", i, j)
			}
		}
	}
	return validateOpenProjects(cfg.OpenProjects)
}

func validTarget(target string) bool {
	return target != "" && !strings.HasPrefix(target, "-") && utf8.ValidString(target) &&
		!strings.ContainsFunc(target, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
}

func listenerPort(address string) (uint64, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil || net.JoinHostPort(host, port) != address {
		return 0, errors.New("must use an IPv4 or bracketed IPv6 address and an explicit port")
	}
	number, err := strconv.ParseUint(port, 10, 16)
	if err != nil || number == 0 || strconv.FormatUint(number, 10) != port {
		return 0, errors.New("port must be a decimal integer between 1 and 65535 without leading zeros")
	}
	return number, nil
}

func safeID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for i, c := range []byte(id) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			continue
		}
		if i == 0 || c != '_' && c != '-' {
			return false
		}
	}
	return true
}
