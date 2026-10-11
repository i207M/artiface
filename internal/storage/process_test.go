package storage

import (
	"io"
	"os/exec"
	"sync"
)

type sshProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	once   sync.Once
}

func startProcess(cmd *exec.Cmd) (*sshProcess, error) {
	prepareProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	return &sshProcess{cmd: cmd, stdin: stdin, stdout: stdout}, nil
}

func (p *sshProcess) Read(b []byte) (int, error)  { return p.stdout.Read(b) }
func (p *sshProcess) Write(b []byte) (int, error) { return p.stdin.Write(b) }

func (p *sshProcess) Close() error {
	p.once.Do(func() {
		// Close both pipes before waiting, including when an SFTP write blocks.
		_ = p.stdin.Close()
		_ = p.stdout.Close()
		killProcess(p.cmd)
		// This is the only Wait call, shared by all concurrent Close calls.
		// A killed subprocess is expected when closing a read-only connection.
		_ = p.cmd.Wait()
	})
	return nil
}
