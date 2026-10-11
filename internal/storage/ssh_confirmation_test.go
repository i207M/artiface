package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"artiface/internal/sshvault"
)

func TestSSHSetupErrorsSurviveTransportSanitization(t *testing.T) {
	challenge := &sshvault.HostKeyError{Token: "fixture-confirmation"}
	for _, expected := range []error{challenge, sshvault.ErrHostKeyExpired, sshvault.ErrDisabled, sshvault.ErrLocked, sshvault.ErrMissing} {
		store := NewWithSSH(func(context.Context, string) (io.ReadWriteCloser, error) {
			return nil, fmt.Errorf("untrusted details must not escape: %w", expected)
		})
		_, folderErr := store.BrowseFolders(context.Background(), "fixture", "")
		_, listErr := store.List(context.Background(), "fixture", "/", "")
		_, fileErr := store.Open(context.Background(), "fixture", "/", "file.txt")
		store.Close()
		for _, err := range []error{folderErr, listErr, fileErr} {
			if !errors.Is(err, expected) || strings.Contains(err.Error(), "untrusted details") {
				t.Fatal("SSH setup classification was lost or exposed arbitrary details", err)
			}
		}
	}
}
