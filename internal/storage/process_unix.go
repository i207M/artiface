//go:build unix

package storage

import (
	"os/exec"
	"syscall"
)

func prepareProcess(cmd *exec.Cmd) {
	// Put ProxyJump/ProxyCommand descendants in a group we can terminate too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcess(cmd *exec.Cmd) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
}
