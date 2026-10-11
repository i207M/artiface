package config

import (
	"errors"
	"os"
	"syscall"
)

// A separate inode survives atomic config replacement, coordinating CLI imports
// and the web server. Kernel locks disappear on process exit; the empty file stays.
func lockConfigUpdate(filename string) (func(), error) {
	name := filename + ".lock"
	fd, err := syscall.Open(name, syscall.O_RDWR|syscall.O_CREAT|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return nil, errors.New("could not open the configuration update lock")
	}
	file := os.NewFile(uintptr(fd), name)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("configuration update lock must be a regular file")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Nlink != 1 {
		file.Close()
		return nil, errors.New("configuration update lock must not have links")
	}
	for {
		err = syscall.Flock(fd, syscall.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			break
		}
	}
	if err != nil {
		file.Close()
		return nil, errors.New("could not lock configuration updates")
	}
	return func() { _ = file.Close() }, nil
}
