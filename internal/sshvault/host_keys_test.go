package sshvault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestWebHostRequiresDurableApprovalBeforeAuthentication(t *testing.T) {
	server := startTestSSH(t, nil, "ssh-password", "")
	host, port, _ := net.SplitHostPort(server.address)
	number, _ := strconv.Atoi(port)
	profile := Profile{Hostname: host, Port: number, User: "reader", Password: []byte("ssh-password")}
	runtime := NewRuntime(nil, false)
	defer runtime.Close()
	writeFailure := errors.New("fixture write failure")
	if err := runtime.AddHost("new-host", profile, nil, "admin-password", nil, func(*Envelope) error { return writeFailure }); !errors.Is(err, writeFailure) {
		t.Fatal("failed host save was accepted", err)
	}
	if _, err := runtime.DialSFTP(context.Background(), "new-host"); !errors.Is(err, ErrMissing) {
		t.Fatal("failed host save activated credentials", err)
	}
	var saved *Envelope
	save := func(envelope *Envelope) error { saved = envelope; return nil }
	if err := runtime.AddHost("new-host", profile, nil, "admin-password", nil, save); err != nil {
		t.Fatal(err)
	}
	if err := runtime.AddHost("new-host", profile, nil, "admin-password", saved, save); !errors.Is(err, ErrHostExists) {
		t.Fatal("duplicate alias replaced its credentials", err)
	}
	requirePrompt := func() HostKeyPrompt {
		t.Helper()
		wire, err := runtime.DialSFTP(context.Background(), "new-host")
		if wire != nil {
			wire.Close()
		}
		var challenge *HostKeyError
		if !errors.As(err, &challenge) {
			t.Fatal("unapproved host key did not stop the handshake", err)
		}
		prompt, err := runtime.HostKeyPrompt(challenge.Token)
		if err != nil {
			t.Fatal(err)
		}
		return prompt
	}
	prompt := requirePrompt()
	if prompt.Changed || len(prompt.PreviousFingerprints) != 0 || prompt.Target != "new-host" || prompt.Address != server.address ||
		prompt.Fingerprint != ssh.FingerprintSHA256(server.hostKey.PublicKey()) {
		t.Fatal("confirmation does not describe the observed server key")
	}
	if server.authAttempts.Load() != 0 {
		t.Fatal("SSH authentication was attempted before trust approval")
	}
	if err := runtime.AcceptHostKey(prompt.Token, "wrong-password", saved, save); !errors.Is(err, ErrDecrypt) {
		t.Fatal("wrong admin password saved trust", err)
	}
	if err := runtime.AcceptHostKey(prompt.Token, "admin-password", saved, func(*Envelope) error { return writeFailure }); !errors.Is(err, writeFailure) {
		t.Fatal("failed trust save was accepted", err)
	}
	if again := requirePrompt(); again.Token != prompt.Token || server.authAttempts.Load() != 0 {
		t.Fatal("failed approval changed trust or authenticated")
	}
	if err := runtime.AcceptHostKey(prompt.Token, "admin-password", saved, save); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.HostKeyPrompt(prompt.Token); !errors.Is(err, ErrHostKeyExpired) {
		t.Fatal("accepted challenge remained replayable")
	}
	wire, err := runtime.DialSFTP(context.Background(), "new-host")
	if err != nil {
		t.Fatal("approved key could not connect", err)
	}
	wire.Close()
	if server.authAttempts.Load() != 1 {
		t.Fatal("approved connection did not authenticate once")
	}
	restarted := NewRuntime(saved, false)
	defer restarted.Close()
	if err := restarted.Unlock("admin-password"); err != nil {
		t.Fatal(err)
	}
	wire, err = restarted.DialSFTP(context.Background(), "new-host")
	if err != nil {
		t.Fatal("saved key was not trusted after restart", err)
	}
	wire.Close()
}

func TestHostKeyConfirmationScopeRevocationAndExpiry(t *testing.T) {
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	old, _ := ssh.NewSignerFromKey(private)
	_, private, _ = ed25519.GenerateKey(rand.Reader)
	next, _ := ssh.NewSignerFromKey(private)
	bundle := Bundle{
		Hosts: map[string]Profile{
			"target": {Hostname: "target.example", Port: 22, User: "reader", Password: []byte("ssh-password"), KnownHosts: "trust"},
			"other":  {Hostname: "target.example", Port: 22, User: "reader", Password: []byte("ssh-password"), KnownHosts: "trust"},
		},
		Keys:       map[string][]byte{},
		KnownHosts: map[string]string{"trust": "target.example " + string(ssh.MarshalAuthorizedKey(old.PublicKey()))},
	}
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
	remote := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 22}
	check := func(alias string, key ssh.PublicKey) error {
		p := runtime.bundle.Hosts[alias]
		return runtime.confirmHostKey(alias, namedProfile{Name: alias, Profile: p}, runtime.envelope, runtime.check[p.KnownHosts])(p.Address(), remote, key)
	}
	challengeFor := func(alias string, key ssh.PublicKey) HostKeyPrompt {
		t.Helper()
		var challenge *HostKeyError
		if err := check(alias, key); !errors.As(err, &challenge) {
			t.Fatal("expected exact-key confirmation", err)
		}
		prompt, err := runtime.HostKeyPrompt(challenge.Token)
		if err != nil {
			t.Fatal(err)
		}
		return prompt
	}
	prompt := challengeFor("target", next.PublicKey())
	if !prompt.Changed || len(prompt.PreviousFingerprints) != 1 || prompt.PreviousFingerprints[0] != ssh.FingerprintSHA256(old.PublicKey()) {
		t.Fatal("changed key did not show previous fingerprint")
	}
	if err := runtime.AcceptHostKey(prompt.Token, "admin-password", nil, func(*Envelope) error { t.Fatal("stale revision saved"); return nil }); !errors.Is(err, ErrHostKeyExpired) {
		t.Fatal("stale credential revision was accepted", err)
	}
	if err := runtime.AcceptHostKey(prompt.Token, "admin-password", envelope, func(next *Envelope) error { envelope = next; return nil }); err != nil {
		t.Fatal(err)
	}
	if err := check("target", next.PublicKey()); err != nil {
		t.Fatal(err)
	}
	challengeFor("target", old.PublicKey()) // Old imported keys cannot bypass the replacement pin.
	other := challengeFor("other", next.PublicKey())
	if other.Host != "other" || !other.Changed {
		t.Fatal("approval leaked to another profile sharing known_hosts")
	}
	pending := runtime.pending[other.Token]
	pending.expires = time.Now().Add(-time.Second)
	runtime.pending[other.Token] = pending
	if _, err := runtime.HostKeyPrompt(other.Token); !errors.Is(err, ErrHostKeyExpired) {
		t.Fatal("expired prompt remained valid")
	}
	if err := runtime.AcceptHostKey(other.Token, "admin-password", envelope, func(*Envelope) error { t.Fatal("expired key saved"); return nil }); !errors.Is(err, ErrHostKeyExpired) {
		t.Fatal("expired key accepted", err)
	}
	prompt = challengeFor("other", next.PublicKey())
	runtime.Rewrap(envelope, &Envelope{Version: 1, Salt: bytes.Repeat([]byte{1}, 16), Ciphertext: make([]byte, 28)})
	if _, err := runtime.HostKeyPrompt(prompt.Token); !errors.Is(err, ErrHostKeyExpired) {
		t.Fatal("password change retained pending approval")
	}

	for _, revoked := range []bool{false, true} {
		data := ""
		if revoked {
			data = "@revoked * " + string(ssh.MarshalAuthorizedKey(next.PublicKey()))
		}
		callback, err := hostKeyCallback(data)
		if err != nil {
			t.Fatal(err)
		}
		runtime := NewRuntime(nil, false)
		key := next.PublicKey()
		if !revoked {
			certificate := &ssh.Certificate{Key: key, CertType: ssh.HostCert, ValidPrincipals: []string{"target.example"}, ValidBefore: ssh.CertTimeInfinity}
			if err := certificate.SignCert(rand.Reader, old); err != nil {
				t.Fatal(err)
			}
			key = certificate
		}
		profile := namedProfile{Name: "target", Profile: Profile{Hostname: "target.example", Port: 22, ApprovedHostKey: next.PublicKey().Marshal()}}
		err = runtime.confirmHostKey("target", profile, nil, callback)("target.example:22", remote, key)
		var challenge *HostKeyError
		if err == nil || errors.As(err, &challenge) || len(runtime.pending) != 0 {
			t.Fatal("revoked key or untrusted certificate became approvable", err)
		}
		runtime.Close()
	}
	authority, err := hostKeyCallback("@cert-authority target.example " + string(ssh.MarshalAuthorizedKey(old.PublicKey())))
	if err != nil {
		t.Fatal(err)
	}
	certificate := &ssh.Certificate{Key: next.PublicKey(), CertType: ssh.HostCert, ValidPrincipals: []string{"target.example"}, ValidBefore: ssh.CertTimeInfinity}
	if err := certificate.SignCert(rand.Reader, old); err != nil {
		t.Fatal(err)
	}
	certRuntime := NewRuntime(nil, false)
	defer certRuntime.Close()
	profile := namedProfile{Name: "target", Profile: Profile{Hostname: "target.example", Port: 22, ApprovedHostKey: next.PublicKey().Marshal()}}
	if err := certRuntime.confirmHostKey("target", profile, nil, authority)("target.example:22", remote, certificate); err != nil {
		t.Fatal("trusted certificate with the approved key was rejected", err)
	}
	profile.ApprovedHostKey = old.PublicKey().Marshal()
	if err := certRuntime.confirmHostKey("target", profile, nil, authority)("target.example:22", remote, certificate); err == nil {
		t.Fatal("a certificate bypassed the approved public key")
	}
}
