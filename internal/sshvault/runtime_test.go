package sshvault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type testSSHServer struct {
	address      string
	hostKey      ssh.Signer
	authAttempts *atomic.Int32
	commands     chan string
}

func startTestSSH(t *testing.T, identity ssh.PublicKey, password string, forward string) testSSHServer {
	t.Helper()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(key)
	authAttempts := &atomic.Int32{}
	commands := make(chan string, 8)
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			authAttempts.Add(1)
			if identity != nil && bytes.Equal(identity.Marshal(), key.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("denied")
		},
		PasswordCallback: func(_ ssh.ConnMetadata, value []byte) (*ssh.Permissions, error) {
			authAttempts.Add(1)
			if password != "" && string(value) == password {
				return nil, nil
			}
			return nil, errors.New("denied")
		},
	}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	connections := map[net.Conn]bool{}
	var workers sync.WaitGroup
	workers.Go(func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections[conn] = true
			mu.Unlock()
			workers.Go(func() {
				defer func() { conn.Close(); mu.Lock(); delete(connections, conn); mu.Unlock() }()
				server, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				defer server.Close()
				go ssh.DiscardRequests(requests)
				for incoming := range channels {
					switch incoming.ChannelType() {
					case "direct-tcpip":
						var request struct {
							Host       string
							Port       uint32
							Origin     string
							OriginPort uint32
						}
						if ssh.Unmarshal(incoming.ExtraData(), &request) != nil || net.JoinHostPort(request.Host, strconv.Itoa(int(request.Port))) != forward {
							incoming.Reject(ssh.Prohibited, "not allowed")
							continue
						}
						upstream, err := net.DialTimeout("tcp", forward, time.Second)
						if err != nil {
							incoming.Reject(ssh.ConnectionFailed, "unavailable")
							continue
						}
						channel, reqs, err := incoming.Accept()
						if err != nil {
							upstream.Close()
							continue
						}
						go ssh.DiscardRequests(reqs)
						workers.Go(func() {
							defer upstream.Close()
							defer channel.Close()
							done := make(chan struct{})
							go func() { io.Copy(channel, upstream); channel.Close(); close(done) }()
							io.Copy(upstream, channel)
							upstream.Close()
							<-done
						})
					case "session":
						channel, reqs, err := incoming.Accept()
						if err != nil {
							continue
						}
						workers.Go(func() {
							defer channel.Close()
							for req := range reqs {
								var command struct{ Value string }
								if ssh.Unmarshal(req.Payload, &command) != nil {
									req.Reply(false, nil)
									continue
								}
								if req.Type == "subsystem" && command.Value == "sftp" {
									req.Reply(true, nil)
									server, err := sftp.NewServer(channel, sftp.ReadOnly())
									if err == nil {
										_ = server.Serve()
										_ = server.Close()
									}
									return
								}
								if req.Type == "exec" && command.Value == "fixture-read" {
									req.Reply(true, nil)
									io.WriteString(channel, "fixture output")
									channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
									return
								}
								if req.Type == "exec" && command.Value == "fixture-block" {
									req.Reply(true, nil)
									commands <- command.Value
									_ = server.Wait()
									return
								}
								req.Reply(false, nil)
							}
						})
					default:
						incoming.Reject(ssh.UnknownChannelType, "unsupported")
					}
				}
			})
		}
	})
	t.Cleanup(func() {
		listener.Close()
		mu.Lock()
		for conn := range connections {
			conn.Close()
		}
		mu.Unlock()
		done := make(chan struct{})
		go func() { workers.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("SSH fixture leaked connections")
		}
	})
	return testSSHServer{address: listener.Addr().String(), hostKey: signer, authAttempts: authAttempts, commands: commands}
}

func TestRuntimeUsesImportedKeysPasswordsAndJumpHosts(t *testing.T) {
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(private)
	block, _ := ssh.MarshalPrivateKey(private, "fixture")
	target := startTestSSH(t, nil, "ssh-fixture-password", "")
	jump := startTestSSH(t, signer.PublicKey(), "", target.address)
	profile := func(server testSSHServer) Profile {
		host, port, _ := net.SplitHostPort(server.address)
		number, _ := strconv.Atoi(port)
		return Profile{Hostname: host, Port: number, User: "reader"}
	}
	dest, bastion := profile(target), profile(jump)
	dest.Password, dest.Jumps, bastion.Keys = []byte("ssh-fixture-password"), []string{"jump"}, []string{"key"}
	dest.HostKeyAlias = "trusted-target"
	dest.KnownHosts, bastion.KnownHosts = "target", "jump"
	bundle := Bundle{Hosts: map[string]Profile{"target": dest, "jump": bastion}, Keys: map[string][]byte{"key": pem.EncodeToMemory(block)}, KnownHosts: map[string]string{}}
	defer bundle.Clear()
	for _, server := range []testSSHServer{target, jump} {
		name := knownhosts.Normalize(server.address)
		if server.address == target.address {
			name = "trusted-target"
		}
		id := "jump"
		if server.address == target.address {
			id = "target"
		}
		bundle.KnownHosts[id] = knownhosts.HashHostname(name) + " " + string(ssh.MarshalAuthorizedKey(server.hostKey.PublicKey()))
	}
	envelope, err := Seal(bundle, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	disabled := NewRuntime(envelope, true)
	defer disabled.Close()
	if err := disabled.Unlock("admin-password"); err != nil {
		t.Fatal(err)
	}
	if !disabled.Disabled() || !disabled.Locked() || disabled.unlocked || len(disabled.bundle.Hosts) != 0 {
		t.Fatal("disabled runtime decrypted credentials")
	}
	if _, err := disabled.DialSFTP(context.Background(), "target"); !errors.Is(err, ErrDisabled) {
		t.Fatal("disabled runtime allowed SFTP or jump-host connection", err)
	}
	if err := disabled.Run(context.Background(), "target", "fixture-read", io.Discard); !errors.Is(err, ErrDisabled) {
		t.Fatal("disabled runtime allowed remote command", err)
	}
	runtime := NewRuntime(envelope, false)
	defer runtime.Close()
	if _, err := runtime.DialSFTP(context.Background(), "target"); !errors.Is(err, ErrLocked) {
		t.Fatal("locked runtime connected", err)
	}
	if err := runtime.Unlock("admin-password"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SSH_AUTH_SOCK", filepath.Join(t.TempDir(), "absent"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wire, err := runtime.DialSFTP(ctx, "target")
	if err != nil {
		t.Fatal(err)
	}
	client, err := sftp.NewClientPipe(wire, wire)
	if err != nil {
		wire.Close()
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "artifact.txt")
	if err := os.WriteFile(filename, []byte("imported credentials work"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := client.Open(filename)
	if err != nil {
		client.Close()
		wire.Close()
		t.Fatal(err)
	}
	data, err := io.ReadAll(file)
	file.Close()
	client.Close()
	wire.Close()
	if err != nil || string(data) != "imported credentials work" {
		t.Fatal("SFTP through imported jump host failed", err)
	}
	var output bytes.Buffer
	if err := runtime.Run(ctx, "target", "fixture-read", &output); err != nil || output.String() != "fixture output" {
		t.Fatal("credential-backed command failed", err)
	}
	bad := bundle
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	otherSigner, _ := ssh.NewSignerFromKey(otherKey)
	// A correct jump-host key in another profile's trust set must not rescue
	// a mismatch in the jump profile's own trust set.
	bad.KnownHosts = map[string]string{"target": bundle.KnownHosts["target"] + bundle.KnownHosts["jump"], "jump": fmt.Sprintf("%s %s", knownhosts.Normalize(jump.address), ssh.MarshalAuthorizedKey(otherSigner.PublicKey()))}
	badEnvelope, err := Seal(bad, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	wrong := NewRuntime(badEnvelope, false)
	defer wrong.Close()
	if err := wrong.Unlock("admin-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := wrong.DialSFTP(ctx, "target"); err == nil {
		t.Fatal("changed host key was accepted")
	}
}
