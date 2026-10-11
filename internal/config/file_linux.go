package config

import (
	"os"
	"syscall"
)

func openConfigFile(filename string) (*os.File, error) {
	// Refuse symlinks and avoid blocking on a FIFO before checking the file type.
	fd, err := syscall.Open(filename, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: filename, Err: err}
	}
	return os.NewFile(uintptr(fd), filename), nil
}

func singleFileLink(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	// An open snapshot can be unlinked by an atomic replacement while being
	// read. It is still safe; additional links to its inode are not.
	return ok && stat.Nlink <= 1
}

func syncConfigDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
