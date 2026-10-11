package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// OpenSSH's -G output loses quotes around known_hosts paths and expands ~ using
// passwd rather than HOME. Snapshot the already-checked configuration and replace
// those paths with opaque tokens before resolution. Host/Include ordering stays
// with OpenSSH, and later source edits cannot introduce executable directives.
func (d *sshDiscovery) snapshot(source string) (string, map[string]string, func(), error) {
	directory, err := os.MkdirTemp("", ".artiface-ssh-import-*")
	if err != nil {
		return "", nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	failed := true
	defer func() {
		if failed {
			cleanup()
		}
	}()
	source, err = filepath.EvalSymlinks(source)
	if err != nil {
		return "", nil, nil, err
	}
	files := map[string]string{}
	var names []string
	for name := range d.contents {
		names = append(names, name)
	}
	sort.Strings(names)
	for i, name := range names {
		files[name] = filepath.Join(directory, fmt.Sprintf("%d.conf", i))
	}
	if files[source] == "" {
		return "", nil, nil, errors.New("SSH configuration could not be snapshotted")
	}
	paths := map[string]string{}
	token := func(path string) string {
		name := fmt.Sprintf("/artiface-import-path-%d", len(paths))
		paths[name] = path
		return name
	}
	quote := func(value string) string { return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"` }
	globs := sshDiscovery{entries: 8192}
	for _, name := range names {
		var output strings.Builder
		scanner := bufio.NewScanner(strings.NewReader(string(d.contents[name])))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			i := strings.IndexAny(line, " \t=")
			if i < 0 {
				return "", nil, nil, errors.New("SSH configuration contains an option without a value")
			}
			key := strings.ToLower(line[:i])
			args, err := sshWords(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line[i:]), "=")))
			if err != nil {
				return "", nil, nil, err
			}
			switch key {
			case "userknownhostsfile", "globalknownhostsfile":
				for i, path := range args {
					if path != "none" {
						args[i] = token(path)
					}
				}
			case "include":
				var included []string
				for _, pattern := range args {
					if strings.HasPrefix(pattern, "~/") {
						pattern = filepath.Join(d.home, pattern[2:])
					}
					if !filepath.IsAbs(pattern) {
						pattern = filepath.Join(d.base, pattern)
					}
					matches, err := globs.glob(filepath.Clean(pattern), 0)
					if err != nil {
						return "", nil, nil, err
					}
					for _, match := range matches {
						resolved, err := filepath.EvalSymlinks(match)
						if errors.Is(err, os.ErrNotExist) {
							continue
						}
						if err != nil || files[resolved] == "" {
							return "", nil, nil, errors.New("SSH include files changed during import; retry")
						}
						included = append(included, files[resolved])
					}
				}
				args = included
				if len(args) == 0 {
					continue
				}
			default:
				// Some OpenSSH directives (notably ProxyJump) parse the raw
				// remainder differently from ordinary quoted argument lists.
				output.WriteString(scanner.Text())
				output.WriteByte('\n')
				continue
			}
			output.WriteString(key)
			for _, arg := range args {
				output.WriteByte(' ')
				output.WriteString(quote(arg))
			}
			output.WriteByte('\n')
		}
		if err := scanner.Err(); err != nil {
			return "", nil, nil, err
		}
		if name == source {
			// These fallback directives apply only if no earlier Host block chose
			// a trust file, preserving the normal first-value-wins behavior.
			fmt.Fprintf(&output, "Host *\nUserKnownHostsFile %s %s\nGlobalKnownHostsFile %s %s\n",
				token("~/.ssh/known_hosts"), token("~/.ssh/known_hosts2"),
				token("/etc/ssh/ssh_known_hosts"), token("/etc/ssh/ssh_known_hosts2"))
		}
		if err := os.WriteFile(files[name], []byte(output.String()), 0600); err != nil {
			return "", nil, nil, err
		}
	}
	failed = false
	return files[source], paths, cleanup, nil
}
