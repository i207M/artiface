//go:build !unix

package ignore

import "os"

// Fail closed where descriptor-relative nonfollowing file operations are absent.
func openDirectory(string) (*os.File, error) { return nil, ErrUnsafe }
func checkPath(os.FileInfo, bool) error      { return ErrUnsafe }
func openAt(*os.File, string, int, os.FileMode) (*os.File, error) {
	return nil, ErrUnsafe
}
func removeAt(*os.File, string)              {}
func installAt(*os.File, string, bool) error { return ErrUnsafe }
func lockDirectory(*os.File) error           { return ErrUnsafe }
