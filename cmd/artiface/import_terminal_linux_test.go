package main

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"artiface/internal/config"
	"artiface/internal/sshvault"

	"golang.org/x/sys/unix"
)

// Exercise the actual hidden terminal input; piping stdin cannot test pressing
// Enter because password prompts deliberately require a terminal.
func TestSSHImportTerminalPasswords(t *testing.T) {
	t.Setenv("ARTIFACE_PASSWORD", "")
	if err := os.Unsetenv("ARTIFACE_PASSWORD"); err != nil {
		t.Fatal(err)
	}
	filename, source := sshImportFixture(t)
	args := []string{"import-ssh", "--config", filename, "--ssh-config", source}
	output, err := runImportTerminal(t, args, [2]string{"press Enter to generate one", ""})
	if err != nil {
		t.Fatal(err)
	}
	_, passwordLine, found := strings.Cut(output, "Initial password: ")
	password, _, _ := strings.Cut(passwordLine, "\n")
	if !found || len(password) < 26 || strings.Count(output, password) != 1 || strings.Contains(output, "Confirm password:") {
		t.Fatal("blank input did not produce a strong password shown once without confirmation")
	}
	cfg, err := config.Load(filename)
	if err != nil || !config.VerifyPassword(cfg.PasswordHash, password) {
		t.Fatal("generated password cannot authenticate", err)
	}
	bundle, err := sshvault.Open(cfg.SSHCredentials, password)
	if err != nil {
		t.Fatal("generated password cannot unlock SSH", err)
	}
	bundle.Clear()

	before, _ := os.ReadFile(filename)
	vaultBefore, _ := os.ReadFile(config.SSHCredentialsPath(filename))
	output, err = runImportTerminal(t, args, [2]string{"Admin password:", ""})
	if err == nil || !strings.Contains(err.Error(), "incorrect admin password") || strings.Contains(output, "Initial password:") {
		t.Fatal("blank input replaced an existing password")
	}
	after, _ := os.ReadFile(filename)
	vaultAfter, _ := os.ReadFile(config.SSHCredentialsPath(filename))
	if !bytes.Equal(before, after) || !bytes.Equal(vaultBefore, vaultAfter) {
		t.Fatal("failed authentication changed saved files")
	}
	output, err = runImportTerminal(t, args, [2]string{"Admin password:", password})
	if err != nil || strings.Contains(output, password) || strings.Contains(output, "Initial password:") {
		t.Fatal("existing password was rejected or printed", err)
	}

	for _, tc := range []struct {
		name, confirmation, errorText string
	}{
		{"chosen", "chosen-password", ""},
		{"mismatch", "different-password", "passwords do not match"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filename, source := sshImportFixture(t)
			output, err := runImportTerminal(t,
				[]string{"import-ssh", "--config", filename, "--ssh-config", source},
				[2]string{"press Enter to generate one", "chosen-password"},
				[2]string{"Confirm password:", tc.confirmation})
			if strings.Contains(output, "chosen-password") || strings.Contains(output, tc.confirmation) || strings.Contains(output, "Initial password:") {
				t.Fatal("chosen password was printed")
			}
			if tc.errorText != "" {
				if err == nil || !strings.Contains(err.Error(), tc.errorText) {
					t.Fatal("mismatched confirmation accepted", err)
				}
				if _, err := os.Stat(filename); !os.IsNotExist(err) {
					t.Fatal("failed confirmation created a configuration")
				}
			} else {
				cfg, loadErr := config.Load(filename)
				if err != nil || loadErr != nil || !config.VerifyPassword(cfg.PasswordHash, "chosen-password") {
					t.Fatal("chosen password cannot authenticate", err, loadErr)
				}
			}
		})
	}

	t.Run("failed import does not publish password", func(t *testing.T) {
		filename, source := sshImportFixture(t)
		if err := os.Remove(source); err != nil {
			t.Fatal(err)
		}
		output, err := runImportTerminal(t,
			[]string{"import-ssh", "--config", filename, "--ssh-config", source},
			[2]string{"press Enter to generate one", ""})
		if err == nil || strings.Contains(output, "Initial password:") {
			t.Fatal("failed import announced a generated password")
		}
		for _, path := range []string{filename, config.SSHCredentialsPath(filename)} {
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("failed import left saved credentials")
			}
		}
	})

	t.Run("empty environment is not interactive Enter", func(t *testing.T) {
		t.Setenv("ARTIFACE_PASSWORD", "")
		filename, source := sshImportFixture(t)
		var output bytes.Buffer
		err := run([]string{"import-ssh", "--config", filename, "--ssh-config", source}, nil, &output, &output)
		if err == nil || !strings.Contains(err.Error(), "at least 6 characters") || output.Len() != 0 {
			t.Fatal("empty environment value generated or printed a password", err)
		}
		if _, err := os.Stat(filename); !os.IsNotExist(err) {
			t.Fatal("empty environment value created a configuration")
		}
	})
}

type importTerminalOutput struct {
	buffer  bytes.Buffer
	prompts chan string
}

func (o *importTerminalOutput) Write(p []byte) (int, error) {
	n, err := o.buffer.Write(p)
	if strings.HasSuffix(string(p), ": ") {
		o.prompts <- string(p)
	}
	return n, err
}

func runImportTerminal(t *testing.T, args []string, answers ...[2]string) (string, error) {
	t.Helper()
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	if err := unix.IoctlSetPointerInt(int(master.Fd()), unix.TIOCSPTLCK, 0); err != nil {
		t.Fatal(err)
	}
	number, err := unix.IoctlGetInt(int(master.Fd()), unix.TIOCGPTN)
	if err != nil {
		t.Fatal(err)
	}
	slave, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", number), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer slave.Close()
	output := &importTerminalOutput{prompts: make(chan string, 16)}
	result := make(chan error, 1)
	go func() { result <- run(args, slave, output, output) }()
	timeout := time.After(10 * time.Second)
	for _, answer := range answers {
		select {
		case prompt := <-output.prompts:
			if !strings.Contains(prompt, answer[0]) {
				t.Fatalf("unexpected prompt %q", prompt)
			}
		case err := <-result:
			t.Fatalf("command ended before prompt: %v", err)
		case <-timeout:
			t.Fatal("timed out waiting for password prompt")
		}
		// The prompt is written just before echo is disabled. Wait for the
		// terminal state, rather than racing ReadPassword with a fixed sleep.
		for {
			state, err := unix.IoctlGetTermios(int(slave.Fd()), unix.TCGETS)
			if err != nil {
				t.Fatal(err)
			}
			if state.Lflag&unix.ECHO == 0 {
				break
			}
			select {
			case <-timeout:
				t.Fatal("password input never disabled terminal echo")
			case <-time.After(time.Millisecond):
			}
		}
		if _, err := master.WriteString(answer[1] + "\n"); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case err := <-result:
		return output.buffer.String(), err
	case <-timeout:
		t.Fatal("terminal import did not finish")
		return "", nil
	}
}
