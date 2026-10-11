package config

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxSSHFiles   = 64
	maxSSHAliases = 1024
	maxSSHDepth   = 16
	maxSSHBytes   = 1 << 20
)

type sshDiscovery struct {
	home, base string
	files      map[string]bool
	seen       map[string]bool
	aliases    []string
	bytes      int
	entries    int
	inspect    func(string, []string) error
	contents   map[string][]byte
}

// DiscoverSSH collects literal Host declarations without evaluating Match,
// commands, environment variables, or tokens.
// A leading ~/ in filename uses the current process user's home directory.
// Relative Includes use the top-level configuration directory (normally ~/.ssh).
// A missing file is normal; other errors return any aliases found so far.
func DiscoverSSH(filename string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	switch {
	case filename == "":
		filename = filepath.Join(home, ".ssh", "config")
	case filename == "~":
		filename = home
	case strings.HasPrefix(filename, "~/"):
		filename = filepath.Join(home, filename[2:])
	case strings.HasPrefix(filename, "~"):
		return nil, errors.New("SSH discovery supports only the current user's ~/ paths")
	}
	d := sshDiscovery{home: home, base: filepath.Dir(filename), files: map[string]bool{},
		seen: map[string]bool{}, bytes: maxSSHBytes, entries: 8192}
	err = d.read(filename, 0)
	return d.aliases, err
}

func (d *sshDiscovery) read(filename string, depth int) error {
	if depth > maxSSHDepth {
		return errors.New("SSH Include nesting exceeds the limit")
	}
	filename, err := filepath.EvalSymlinks(filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if d.files[filename] {
		return nil
	}
	if len(d.files) >= maxSSHFiles {
		return errors.New("SSH discovery exceeds the file limit")
	}
	d.files[filename] = true
	// Resolve symlinks first, then use the nonblocking regular-file opener.
	f, err := openConfigFile(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("SSH configuration must be a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(d.bytes)+1))
	d.bytes -= len(data)
	if err != nil {
		return err
	}
	if d.bytes < 0 {
		return errors.New("SSH discovery exceeds the 1 MiB limit")
	}
	if d.contents != nil {
		d.contents[filename] = data
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		i := strings.IndexAny(line, " \t=")
		if i < 0 {
			continue
		}
		key := strings.ToLower(line[:i])
		if key != "host" && key != "include" && d.inspect == nil {
			continue
		}
		args := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line[i:]), "="))
		words, err := sshWords(args)
		if err != nil {
			return fmt.Errorf("%s: %w", filename, err)
		}
		if d.inspect != nil {
			if err := d.inspect(key, words); err != nil {
				return err
			}
		}
		if key != "host" && key != "include" {
			continue
		}
		for _, word := range words {
			if key == "include" {
				if err := d.include(word, depth+1); err != nil {
					return err
				}
			} else if validTarget(word) && !strings.ContainsAny(word, "*?") && !strings.HasPrefix(word, "!") && !d.seen[word] {
				if len(d.aliases) >= maxSSHAliases {
					return errors.New("SSH discovery exceeds the alias limit")
				}
				d.seen[word] = true
				d.aliases = append(d.aliases, word)
			}
		}
	}
	return scanner.Err()
}

func (d *sshDiscovery) include(pattern string, depth int) error {
	if strings.HasPrefix(pattern, "~/") {
		pattern = filepath.Join(d.home, pattern[2:])
	} else if strings.HasPrefix(pattern, "~") || strings.ContainsAny(pattern, "%$`") {
		return errors.New("SSH Include supports literal paths, ~/ and globs only")
	}
	if !filepath.IsAbs(pattern) {
		pattern = filepath.Join(d.base, pattern)
	}
	matches, err := d.glob(filepath.Clean(pattern), 0)
	if err != nil {
		return err
	}
	for _, name := range matches {
		if err := d.read(name, depth); err != nil {
			return err
		}
	}
	return nil
}

// Bound directory enumeration as well as the number of files actually parsed.
func (d *sshDiscovery) glob(pattern string, depth int) ([]string, error) {
	if depth > maxSSHDepth {
		return nil, errors.New("SSH Include glob nesting exceeds the limit")
	}
	if !strings.ContainsAny(pattern, "*?[") {
		return []string{pattern}, nil
	}
	dir, base := filepath.Split(pattern)
	dirs, err := d.glob(filepath.Clean(dir), depth+1)
	if err != nil {
		return nil, err
	}
	var matches []string
	for _, dir := range dirs {
		resolved, err := filepath.EvalSymlinks(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		f, err := openConfigFile(resolved)
		if err != nil {
			return nil, err
		}
		info, err := f.Stat()
		if err != nil || !info.IsDir() {
			f.Close()
			continue
		}
		names, err := f.Readdirnames(d.entries + 1)
		f.Close()
		d.entries -= len(names)
		if d.entries < 0 {
			return nil, errors.New("SSH Include exceeds the directory entry limit")
		}
		if err != nil && err != io.EOF {
			return nil, err
		}
		for _, name := range names {
			ok, err := filepath.Match(base, name)
			if err != nil {
				return nil, err
			}
			if ok {
				matches = append(matches, filepath.Join(dir, name))
			}
		}
	}
	sort.Strings(matches)
	return matches, nil
}

func sshWords(line string) ([]string, error) {
	var words []string
	for i := 0; i < len(line); {
		if line[i] == ' ' || line[i] == '\t' {
			i++
			continue
		}
		if line[i] == '#' {
			break
		}
		var word strings.Builder
		var quote byte
		for ; i < len(line); i++ {
			c := line[i]
			if c == '\\' && i+1 < len(line) {
				i++
				word.WriteByte(line[i])
			} else if quote != 0 && c == quote {
				quote = 0
			} else if quote == 0 && (c == '"' || c == '\'') {
				quote = c
			} else if quote == 0 && (c == ' ' || c == '\t') {
				break
			} else {
				word.WriteByte(c)
			}
		}
		if quote != 0 {
			return nil, errors.New("unclosed SSH configuration quote")
		}
		words = append(words, word.String())
	}
	return words, nil
}
