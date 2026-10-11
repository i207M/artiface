package storage

import (
	"fmt"
	"io/fs"
	"path"
	"strings"
)

func (c *connection) resolveRoot(root string) (string, fs.FileInfo, error) {
	canonical, err := c.client.RealPath(root)
	if err != nil {
		return "", nil, c.operationError("resolve project root", err)
	}
	if checked, err := validateRoot(canonical); err != nil || checked != canonical || len(canonical) > maxResolveBytes {
		return "", nil, ErrForbidden
	}
	info, err := c.client.Lstat(canonical)
	if err != nil {
		return "", nil, c.operationError("inspect project root", err)
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return "", nil, ErrForbidden
	}
	return canonical, info, nil
}

// SFTP has no descriptor-relative, no-follow open operation.
// Keep all names under the original canonical project, bound link expansion,
// and verify the server's final canonical name before using it.
// As with ordinary SFTP files, the remote host remains trusted against races.
func (c *connection) resolveWithin(root, configured, rel string) (string, fs.FileInfo, error) {
	if len(rel) > maxResolveBytes {
		return "", nil, ErrForbidden
	}
	names := []string{}
	pending := strings.Split(rel, "/")
	followed, links, steps, bytes := false, 0, 0, len(rel)
	for len(pending) > 0 {
		if err := c.ctx.Err(); err != nil {
			return "", nil, c.operationError("resolve project path", err)
		}
		steps++
		if steps > maxResolveSteps || len(names) > maxResolveDepth {
			return "", nil, ErrForbidden
		}
		part := pending[0]
		pending = pending[1:]
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(names) == 0 {
				return "", nil, ErrForbidden
			}
			names = names[:len(names)-1]
			continue
		}
		full := path.Join(root, strings.Join(names, "/"), part)
		info, err := c.client.Lstat(full)
		if err != nil {
			return "", nil, resolvedError(c.ctx, c.operationError("inspect project path", err), followed)
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			link, err := c.client.ReadLink(full)
			if err != nil {
				return "", nil, c.operationError("read project symlink", err)
			}
			followed = true
			links++
			bytes += len(link)
			if links > maxSymlinks || bytes > maxResolveBytes {
				return "", nil, ErrForbidden
			}
			parts, absolute, err := linkParts(c.ctx, root, configured, link, func(name string) (string, error) {
				resolved, err := c.client.RealPath(name)
				// Record terminal failures before absoluteLink sanitizes them.
				return resolved, c.operationError("resolve absolute project symlink", err)
			})
			if err != nil {
				return "", nil, err
			}
			if absolute {
				names = nil
			}
			pending = append(parts, pending...)
			continue
		}
		if len(pending) > 0 && !info.IsDir() {
			return "", nil, ErrForbidden
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return "", nil, ErrForbidden
		}
		names = append(names, part)
	}
	full := path.Join(root, strings.Join(names, "/"))
	return c.checkResolved(root, full)
}

func (c *connection) checkResolved(root, full string) (string, fs.FileInfo, error) {
	canonical, err := c.client.RealPath(full)
	if err != nil {
		return "", nil, c.operationError("verify resolved project path", err)
	}
	if checked, err := validateRoot(canonical); err != nil || checked != canonical || len(canonical) > maxResolveBytes {
		return "", nil, ErrForbidden
	}
	if _, ok := beneath(root, canonical); !ok {
		return "", nil, fmt.Errorf("%w: symlink escapes project", ErrForbidden)
	}
	info, err := c.client.Lstat(canonical)
	if err != nil {
		return "", nil, c.operationError("inspect resolved project path", err)
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return "", nil, ErrForbidden
	}
	return canonical, info, nil
}
