//go:build !linux

package config

import "os"

func openConfigFile(filename string) (*os.File, error) {
	return os.Open(filename)
}

func singleFileLink(os.FileInfo) bool { return true }

func syncConfigDirectory(string) error { return nil }
