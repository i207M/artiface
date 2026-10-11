// Package storage provides read-only access to configured local and SSH roots.
//
// Symlinks may resolve to regular files and directories inside the project.
// Local operations resolve links while walking anchored directory descriptors.
// SFTP cannot atomically resolve and open a path without following symlinks.
// Source hosts are trusted: remote OS permissions remain the hard boundary
// against filesystem changes between these checks and subsequent operations.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	// ErrForbidden identifies refused targets, roots, paths, and file types.
	ErrForbidden = errors.New("storage: access forbidden")
	// ErrTooLarge identifies directory listings exceeding the resource limits.
	ErrTooLarge = errors.New("storage: directory too large")
)

type Entry struct {
	Name         string    `json:"name"`
	Path         string    `json:"path"`
	Type         string    `json:"type"`
	Size         int64     `json:"size"`
	Modified     time.Time `json:"modified"`
	Symlink      bool      `json:"symlink,omitempty"`
	ResolvedPath *string   `json:"resolvedPath,omitempty"`
}

type File interface {
	io.ReadSeekCloser
	Stat() (fs.FileInfo, error)
}

type Store interface {
	List(ctx context.Context, target, root, rel string) ([]Entry, error)
	Open(ctx context.Context, target, root, rel string) (File, error)
	Close() error
}

// ScopedStore optionally opens an asset relative to a project-relative directory.
// Both arguments pass ValidateRelative; the resolved file must remain within the
// resolved scope AND the original configured root.
// A derived scope must never be passed as a replacement configured root.
type ScopedStore interface {
	OpenScoped(ctx context.Context, target, root, scope, rel string) (File, error)
}

// Resolver optionally returns a canonical project-relative path for a regular
// file or directory, without reading contents or retaining an open file.
// It uses the same bounds, cancellation, and original-root containment as Open.
type Resolver interface {
	Resolve(ctx context.Context, target, root, rel string) (string, error)
}

// ResolvedFile exposes the canonical project-relative path used by an open file.
// HTML preview creators can use its directory as their asset scope.
// This is metadata, not a new trusted root or a promise about future mutations.
type ResolvedFile interface {
	File
	ResolvedPath() string
}

// ValidateRelative returns a normalized POSIX project-relative path.
// An empty path or "." denotes the root and normalizes to "".
// Any ".." component is rejected, even if cleaning would keep it inside the root.
// Paths are not URL-decoded here; callers must pass the already decoded path.
func ValidateRelative(rel string) (string, error) {
	if !validPathText(rel) || path.IsAbs(rel) || strings.Contains(rel, `\`) {
		return "", fmt.Errorf("%w: invalid project-relative path", ErrForbidden)
	}
	for _, part := range strings.Split(rel, "/") {
		if part == ".." {
			return "", fmt.Errorf("%w: parent traversal is not allowed", ErrForbidden)
		}
	}
	rel = path.Clean(rel)
	if rel == "." {
		return "", nil
	}
	return rel, nil
}

func validPathText(s string) bool {
	return utf8.ValidString(s) && !strings.ContainsFunc(s, unicode.IsControl)
}

func validateTarget(target string) error {
	if target == "" || strings.HasPrefix(target, "-") || !utf8.ValidString(target) ||
		strings.ContainsFunc(target, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
		return fmt.Errorf("%w: invalid SSH target", ErrForbidden)
	}
	return nil
}

func validateRoot(root string) (string, error) {
	if !path.IsAbs(root) || !validPathText(root) || strings.Contains(root, `\`) {
		return "", fmt.Errorf("%w: project root must be an absolute POSIX path", ErrForbidden)
	}
	for _, part := range strings.Split(root, "/") {
		if part == ".." {
			return "", fmt.Errorf("%w: parent traversal in project root", ErrForbidden)
		}
	}
	return path.Clean(root), nil
}

func entryType(mode fs.FileMode) string {
	switch {
	case mode&fs.ModeSymlink != 0:
		return "symlink"
	case mode.IsDir():
		return "directory"
	case mode.IsRegular():
		return "file"
	default:
		return "other"
	}
}
