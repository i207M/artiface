// Package buildinfo identifies the source and compilation time of the running app.
package buildinfo

import "runtime/debug"

// GitCommit is injected by Docker, where the build context excludes .git.
var GitCommit string

// BuildTime is an RFC3339 UTC timestamp injected by Make and Docker at compilation.
// Direct go builds leave it empty rather than substituting the server start time.
var BuildTime string

func Commit() string {
	if GitCommit != "" {
		return GitCommit
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	var revision string
	var modified bool
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			modified = setting.Value == "true"
		}
	}
	if revision == "" {
		return "unknown"
	}
	if modified {
		return revision + "-dirty"
	}
	return revision
}
