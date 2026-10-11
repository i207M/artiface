package sshvault

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"testing"

	"golang.org/x/crypto/ssh"
)

func testBundle(t *testing.T) Bundle {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(key, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return Bundle{
		Hosts:      map[string]Profile{"fixture": {Hostname: "fixture.example", Port: 22, User: "reader", Keys: []string{"key"}, Password: []byte("private-ssh-password"), KnownHosts: "trust"}},
		Keys:       map[string][]byte{"key": pem.EncodeToMemory(block)},
		KnownHosts: map[string]string{"trust": "fixture.example " + string(ssh.MarshalAuthorizedKey(signer.PublicKey()))},
	}
}

func TestVaultAuthenticationTamperingAndRekey(t *testing.T) {
	bundle := testBundle(t)
	defer bundle.Clear()
	first, err := Seal(bundle, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	second, err := Seal(bundle, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first.Salt, second.Salt) || bytes.Equal(first.Ciphertext, second.Ciphertext) {
		t.Fatal("encryption reused salt or ciphertext")
	}
	serialized, _ := json.Marshal(first)
	for _, secret := range [][]byte{[]byte("private-ssh-password"), []byte("PRIVATE KEY"), []byte("fixture.example"), bundle.Keys["key"]} {
		if bytes.Contains(serialized, secret) {
			t.Fatal("encrypted envelope exposed credential material")
		}
	}
	if _, err := Open(first, "wrong-password"); !errors.Is(err, ErrDecrypt) {
		t.Fatal("wrong password decrypted the vault", err)
	}
	decoded, err := Open(first, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	defer decoded.Clear()
	if !bytes.Equal(decoded.Keys["key"], bundle.Keys["key"]) || !bytes.Equal(decoded.Hosts["fixture"].Password, bundle.Hosts["fixture"].Password) {
		t.Fatal("credential round trip changed data")
	}
	rekeyed, err := Seal(decoded, "new-admin-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(rekeyed, "admin-password"); !errors.Is(err, ErrDecrypt) {
		t.Fatal("old password decrypted rekeyed vault")
	}
	newBundle, err := Open(rekeyed, "new-admin-password")
	if err != nil {
		t.Fatal(err)
	}
	newBundle.Clear()
	tampered := *first
	tampered.Ciphertext = bytes.Clone(first.Ciphertext)
	tampered.Ciphertext[len(tampered.Ciphertext)-1] ^= 1
	if _, err := Open(&tampered, "admin-password"); !errors.Is(err, ErrDecrypt) {
		t.Fatal("tampered ciphertext was accepted")
	}
	for _, broken := range []*Envelope{{Version: 2, Salt: first.Salt, Ciphertext: first.Ciphertext}, {Version: 1, Salt: first.Salt, Ciphertext: make([]byte, MaxPlaintext+29)}} {
		if broken.Validate() == nil {
			t.Fatal("unbounded or unknown envelope accepted")
		}
	}
}

func TestVaultRejectsMissingKeysAndJumpCycles(t *testing.T) {
	bundle := testBundle(t)
	defer bundle.Clear()
	host := bundle.Hosts["fixture"]
	host.Keys = []string{"missing"}
	bundle.Hosts["fixture"] = host
	if bundle.Validate() == nil {
		t.Fatal("missing identity accepted")
	}
	host.Keys, host.Jumps = []string{"key"}, []string{"fixture"}
	bundle.Hosts["fixture"] = host
	if bundle.Validate() == nil {
		t.Fatal("cyclic jump hosts accepted")
	}
}
