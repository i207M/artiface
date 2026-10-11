//go:build !unix

package storage

import "os/exec"

func prepareProcess(cmd *exec.Cmd) {}

func killProcess(cmd *exec.Cmd) {
	_ = cmd.Process.Kill()
}
