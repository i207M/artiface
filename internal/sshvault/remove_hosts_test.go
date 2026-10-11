package sshvault

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestHostRemovalClosesOnlyDeletedTransportsAfterPersistence(t *testing.T) {
	first := startTestSSH(t, nil, "ssh-password", "")
	second := startTestSSH(t, nil, "ssh-password", "")
	bundle := Bundle{Hosts: map[string]Profile{}, Keys: map[string][]byte{}, KnownHosts: map[string]string{}}
	defer bundle.Clear()
	for alias, server := range map[string]testSSHServer{"removed": first, "kept": second} {
		host, port, _ := net.SplitHostPort(server.address)
		number, _ := strconv.Atoi(port)
		bundle.Hosts[alias] = Profile{Hostname: host, Port: number, User: "reader", Password: []byte("ssh-password"), KnownHosts: alias, ApprovedHostKey: server.hostKey.PublicKey().Marshal()}
		bundle.KnownHosts[alias] = knownhosts.Normalize(server.address) + " " + string(ssh.MarshalAuthorizedKey(server.hostKey.PublicKey()))
	}
	envelope, err := Seal(bundle, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	runtime := NewRuntime(envelope, false)
	defer runtime.Close()
	if err := runtime.Unlock("admin-password"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	client := func(ctx context.Context, target string) *sftp.Client {
		t.Helper()
		wire, err := runtime.DialSFTP(ctx, target)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { wire.Close() })
		reader, err := sftp.NewClientPipe(wire, wire)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { reader.Close() })
		return reader
	}
	removed, kept := client(ctx, "removed"), client(context.Background(), "kept")
	cancel() // A pooled transport must outlive the request which created it.
	if _, err := removed.Getwd(); err != nil {
		t.Fatal("setup request cancellation closed a reusable transport", err)
	}
	commandCtx, commandCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer commandCancel()
	commandDone := make(chan error, 1)
	go func() { commandDone <- runtime.Run(commandCtx, "removed", "fixture-block", io.Discard) }()
	select {
	case <-first.commands:
	case <-time.After(5 * time.Second):
		t.Fatal("command fixture did not start")
	}
	failed := errors.New("fixture storage failure")
	if err := runtime.RemoveHosts([]string{"removed"}, []string{"kept"}, "admin-password", envelope, func(*Envelope) error { return failed }); !errors.Is(err, failed) {
		t.Fatal("failed deletion was accepted", err)
	}
	if !runtime.Matches(envelope) {
		t.Fatal("failed save changed the active credentials")
	}
	if _, err := removed.Getwd(); err != nil {
		t.Fatal("failed save closed an existing transport", err)
	}
	select {
	case err := <-commandDone:
		t.Fatal("failed save interrupted an existing command", err)
	default:
	}
	save := func(next *Envelope) error { envelope = next; return nil }
	if err := runtime.RemoveHosts([]string{"removed"}, []string{"kept"}, "admin-password", envelope, save); err != nil {
		t.Fatal(err)
	}
	if _, err := removed.Getwd(); err == nil {
		t.Fatal("deleted host's existing SFTP connection remained usable")
	}
	select {
	case err := <-commandDone:
		if err == nil {
			t.Fatal("deleted host's command completed normally instead of being interrupted")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("deleted host's command connection stayed open")
	}
	if _, err := kept.Getwd(); err != nil {
		t.Fatal("deletion interrupted a different host", err)
	}
	if _, err := runtime.DialSFTP(context.Background(), "removed"); !errors.Is(err, ErrMissing) {
		t.Fatal("deleted host could reconnect", err)
	}
	if err := runtime.RemoveHosts([]string{"kept"}, nil, "admin-password", envelope, save); err != nil {
		t.Fatal(err)
	}
	if envelope != nil || !runtime.Matches(nil) {
		t.Fatal("last host left an encrypted credential snapshot")
	}
	if _, err := kept.Getwd(); err == nil {
		t.Fatal("last host's pooled connection remained usable")
	}
	profile := bundle.Hosts["removed"]
	if err := runtime.AddHost("removed", profile, nil, "admin-password", nil, save); err != nil {
		t.Fatal("removed alias could not be reused", err)
	}
	_, err = runtime.DialSFTP(context.Background(), "removed")
	var untrusted *HostKeyError
	if !errors.As(err, &untrusted) {
		t.Fatal("re-added host reused its deleted trust", err)
	}
}

func TestHostRemovalCancelsPendingHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	number, _ := strconv.Atoi(port)
	bundle := Bundle{Hosts: map[string]Profile{"pending": {
		Hostname: host, Port: number, User: "reader", Password: []byte("ssh-password"), KnownHosts: "trust",
	}}, Keys: map[string][]byte{}, KnownHosts: map[string]string{"trust": ""}}
	defer bundle.Clear()
	envelope, err := Seal(bundle, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	runtime := NewRuntime(envelope, false)
	defer runtime.Close()
	if err := runtime.Unlock("admin-password"); err != nil {
		t.Fatal(err)
	}
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.Accept()
		accepted <- conn
	}()
	done := make(chan error, 1)
	go func() {
		wire, err := runtime.DialSFTP(context.Background(), "pending")
		if wire != nil {
			wire.Close()
		}
		done <- err
	}()
	select {
	case conn := <-accepted:
		if conn == nil {
			t.Fatal("fixture accept failed")
		}
		defer conn.Close() // Deliberately never sends the SSH version.
	case <-time.After(5 * time.Second):
		t.Fatal("SSH connection was not started")
	}
	if err := runtime.RemoveHosts([]string{"pending"}, nil, "admin-password", envelope, func(*Envelope) error { return nil }); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("deleted host completed its pending handshake")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("deletion did not interrupt the handshake")
	}
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	if len(runtime.active) != 0 {
		t.Fatal("closed connection remained registered")
	}
}
