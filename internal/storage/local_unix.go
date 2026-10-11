//go:build unix

package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

type localRoot struct {
	file       *os.File
	canonical  string
	configured string
}

func openLocalRoot(ctx context.Context, root string) (*localRoot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, localOpenError(err)
	}
	if _, err := validateRoot(canonical); err != nil {
		return nil, err
	}
	fd, err := unix.Open(canonical, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, localOpenError(err)
	}
	return &localRoot{file: os.NewFile(uintptr(fd), canonical), canonical: canonical, configured: root}, nil
}

func (r *localRoot) Close() error { return r.file.Close() }

// Every step is O_NOFOLLOW and relative to an already opened directory.
// Symlink contents become new steps, never a pathname passed to a following open.
// ".." pops saved descriptors instead of consulting a possibly renamed parent.
// O_DIRECTORY and O_NONBLOCK keep replacement by FIFOs from blocking.
func (r *localRoot) walk(ctx context.Context, rel string, kind pathKind, scope *os.File) (*os.File, string, error) {
	if len(rel) > maxResolveBytes {
		return nil, "", ErrForbidden
	}
	raw, err := r.file.SyscallConn()
	if err != nil {
		return nil, "", err
	}
	var fd int
	var openErr error
	// Holding the raw connection prevents cancellation from closing/reusing the
	// anchor's descriptor between obtaining its integer and Openat.
	err = raw.Control(func(fdRoot uintptr) {
		fd, openErr = unix.Openat(int(fdRoot), ".", unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	})
	if err != nil {
		return nil, "", err
	}
	if openErr != nil {
		return nil, "", localOpenError(openErr)
	}
	stack := []*os.File{os.NewFile(uintptr(fd), r.canonical)}
	defer func() {
		for _, file := range stack {
			_ = file.Close()
		}
	}()
	names := []string{}
	pending := strings.Split(rel, "/")
	followed, links, steps, bytes := false, 0, 0, len(rel)
	var scopeInfo os.FileInfo
	if scope != nil {
		scopeInfo, err = scope.Stat()
		if err != nil {
			return nil, "", err
		}
	}
	for len(pending) > 0 {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		steps++
		if steps > maxResolveSteps || len(stack) > maxResolveDepth {
			return nil, "", ErrForbidden
		}
		part := pending[0]
		pending = pending[1:]
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(stack) == 1 {
				return nil, "", ErrForbidden
			}
			_ = stack[len(stack)-1].Close()
			stack = stack[:len(stack)-1]
			names = names[:len(names)-1]
			continue
		}
		flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
		if len(pending) > 0 || kind == directoryPath {
			flags |= unix.O_DIRECTORY
		}
		parent := stack[len(stack)-1]
		next, err := unix.Openat(int(parent.Fd()), part, flags, 0)
		if err != nil {
			if !errors.Is(err, unix.ELOOP) && !errors.Is(err, unix.ENOTDIR) {
				return nil, "", resolvedError(ctx, localOpenError(err), followed)
			}
			link, readErr := readLocalLink(int(parent.Fd()), part)
			if readErr != nil {
				return nil, "", resolvedError(ctx, ErrForbidden, followed)
			}
			followed = true
			links++
			bytes += len(link)
			if links > maxSymlinks || bytes > maxResolveBytes {
				return nil, "", ErrForbidden
			}
			parts, absolute, err := linkParts(ctx, r.canonical, r.configured, link, filepath.EvalSymlinks)
			if err != nil {
				return nil, "", err
			}
			if absolute {
				for _, file := range stack[1:] {
					_ = file.Close()
				}
				stack = stack[:1]
				names = nil
			}
			pending = append(parts, pending...)
			continue
		}
		stack = append(stack, os.NewFile(uintptr(next), part))
		names = append(names, part)
	}
	file := stack[len(stack)-1]
	info, err := file.Stat()
	if err != nil {
		return nil, "", err
	}
	if kind == directoryPath && !info.IsDir() || kind == regularPath && !info.Mode().IsRegular() ||
		!info.IsDir() && !info.Mode().IsRegular() {
		return nil, "", ErrForbidden
	}
	if scopeInfo != nil {
		// Require the actual scope directory in the descriptor ancestry.
		// A same-name replacement cannot turn the scope into a newly trusted root.
		found := false
		for _, ancestor := range stack[:len(stack)-1] {
			info, err := ancestor.Stat()
			if err != nil {
				return nil, "", err
			}
			if os.SameFile(scopeInfo, info) {
				found = true
				break
			}
		}
		if !found {
			return nil, "", ErrForbidden
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	stack = stack[:len(stack)-1] // Transfer ownership of the final descriptor.
	return file, strings.Join(names, "/"), nil
}

func openLocalPath(ctx context.Context, root, rel string, directory bool) (*os.File, error) {
	r, err := openLocalRoot(ctx, root)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	kind := regularPath
	if directory {
		kind = directoryPath
	}
	file, _, err := r.walk(ctx, rel, kind, nil)
	return file, err
}

func readLocalLink(fd int, name string) (string, error) {
	for size := 256; ; size = min(size*2, maxResolveBytes+1) {
		buffer := make([]byte, size)
		n, err := unix.Readlinkat(fd, name, buffer)
		if err != nil {
			return "", err
		}
		if n < size {
			return string(buffer[:n]), nil
		}
		if size > maxResolveBytes {
			return "", ErrForbidden
		}
	}
}

func localOpenError(err error) error {
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.ENXIO) {
		return ErrForbidden
	}
	return localError(err)
}
