package storage

import (
	"context"
	"fmt"
	"path"
	"strings"
)

const (
	maxSymlinks     = 40
	maxResolveSteps = 4096
	maxResolveDepth = 256
	maxResolveBytes = 64 * 1024
)

type pathKind uint8

const (
	regularPath pathKind = iota
	directoryPath
	anyPath
)

// beneath returns the uncleaned suffix so "link/.." retains filesystem semantics.
func beneath(root, name string) (string, bool) {
	if name == root {
		return "", true
	}
	prefix := strings.TrimSuffix(root, "/") + "/"
	if strings.HasPrefix(name, prefix) {
		return strings.TrimPrefix(name, prefix), true
	}
	return "", false
}

func validLink(link string) bool {
	return link != "" && len(link) <= maxResolveBytes && validPathText(link) && !strings.Contains(link, `\`)
}

// Absolute links are translated back into the anchored project.
// An alternate spelling (e.g. a configured-root alias) is resolved only to obtain
// a name; callers still rewalk the result from the original root descriptor.
// No file is ever opened by trusting this pathname check alone.
func absoluteLink(ctx context.Context, canonical, configured, link string, realpath func(string) (string, error)) (string, error) {
	if err := context.Cause(ctx); err != nil {
		return "", err
	}
	if rel, ok := beneath(canonical, link); ok {
		return rel, nil
	}
	if rel, ok := beneath(configured, link); ok {
		return rel, nil
	}
	full, err := realpath(link)
	if err := context.Cause(ctx); err != nil {
		return "", err
	}
	if err != nil || len(full) > maxResolveBytes {
		return "", ErrForbidden
	}
	if checked, err := validateRoot(full); err != nil || checked != full {
		return "", ErrForbidden
	}
	if rel, ok := beneath(canonical, full); ok {
		return rel, nil
	}
	return "", ErrForbidden
}

func linkParts(ctx context.Context, canonical, configured, link string, realpath func(string) (string, error)) ([]string, bool, error) {
	if !validLink(link) {
		return nil, false, ErrForbidden
	}
	absolute := path.IsAbs(link)
	if absolute {
		var err error
		link, err = absoluteLink(ctx, canonical, configured, link, realpath)
		if err != nil {
			return nil, false, err
		}
	}
	return strings.Split(link, "/"), absolute, nil
}

func resolvedError(ctx context.Context, err error, followed bool) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	if followed {
		return fmt.Errorf("%w: unavailable symlink target", ErrForbidden)
	}
	return err
}
