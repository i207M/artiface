//go:build unix

package ignore

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func openDirectory(name string) (*os.File, error) {
	fd, err := unix.Open(name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	info, err := file.Stat()
	if err == nil {
		err = checkPath(info, true)
	}
	if err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func checkPath(info os.FileInfo, directory bool) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.IsDir() != directory ||
		!directory && (!info.Mode().IsRegular() || stat.Nlink != 1) {
		return ErrUnsafe
	}
	return nil
}

func openAt(dir *os.File, name string, flags int, mode os.FileMode) (*os.File, error) {
	fd, err := unix.Openat(int(dir.Fd()), name, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, uint32(mode))
	if err != nil {
		return nil, err
	}
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if info.Nlink != 1 {
		unix.Close(fd)
		return nil, ErrUnsafe
	}
	return os.NewFile(uintptr(fd), name), nil
}

func removeAt(dir *os.File, name string) {
	_ = unix.Unlinkat(int(dir.Fd()), name, 0)
}

// A nonblocking advisory lock serializes cooperating processes without creating
// another persistent file or letting a busy editor hold HTTP requests open.
// Closing the directory descriptor releases the lock.
func lockDirectory(dir *os.File) error {
	err := unix.Flock(int(dir.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if err == unix.EWOULDBLOCK || err == unix.EAGAIN {
		return ErrConflict
	}
	return err
}

func installAt(dir *os.File, temp string, missing bool) error {
	fd := int(dir.Fd())
	if missing {
		if err := unix.Linkat(fd, temp, fd, Filename, 0); err != nil {
			if err == unix.EEXIST {
				return ErrConflict
			}
			return err
		}
		removeAt(dir, temp)
		return nil
	}
	return unix.Renameat(fd, temp, fd, Filename)
}
