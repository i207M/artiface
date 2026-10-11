package config

import (
	"encoding/base64"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

func TestPasswordHashVerificationAndLimits(t *testing.T) {
	password := "correct horse battery staple"
	first, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	second, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("independent password hashes reused a salt")
	}
	if !VerifyPassword(first, password) || VerifyPassword(first, "incorrect password") {
		t.Fatal("password verification did not distinguish matching passwords")
	}
	for _, invalid := range []string{"", "short", strings.Repeat("é", 5), strings.Repeat("a", 1025), strings.Repeat("\xff", 12)} {
		if _, err := HashPassword(invalid); err == nil {
			t.Fatal("HashPassword accepted an invalid password")
		}
		if VerifyPassword(first, invalid) {
			t.Fatal("VerifyPassword accepted an invalid password")
		}
	}
	for _, valid := range []string{"simple", strings.Repeat("é", 6), strings.Repeat("a", 1024)} {
		hash, err := HashPassword(valid)
		if err != nil || !VerifyPassword(hash, valid) {
			t.Fatal("a boundary-length password did not round trip")
		}
	}
}

func TestMalformedAndExpensiveHashesFailClosed(t *testing.T) {
	invalid := []string{
		"", "PLACEHOLDER", strings.Repeat("x", 257),
		strings.Replace(testHash, "argon2id", "argon2i", 1),
		strings.Replace(testHash, "v=19", "v=16", 1),
		strings.Replace(testHash, "m=19456", "m=0", 1),
		strings.Replace(testHash, "m=19456", "m=8192", 1),
		strings.Replace(testHash, "m=19456", "m=65537", 1),
		strings.Replace(testHash, "m=19456", "m=4294967295", 1),
		strings.Replace(testHash, "m=19456", "m=-19456", 1),
		strings.Replace(testHash, "m=19456", "m=019456", 1),
		strings.Replace(testHash, "t=2", "t=0", 1),
		strings.Replace(testHash, "t=2", "t=1", 1),
		strings.Replace(testHash, "t=2", "t=5", 1),
		strings.Replace(testHash, "t=2", "t=4294967295", 1),
		strings.Replace(testHash, "p=1", "p=0", 1),
		strings.Replace(testHash, "p=1", "p=5", 1),
		strings.Replace(testHash, "p=1", "p=256", 1),
		strings.Replace(testHash, "t=2", "m=2", 1),
		strings.Replace(testHash, "p=1", "p=1,x=1", 1),
		strings.Replace(testHash, strings.Repeat("A", 22)+"$", "AAAA$", 1),
		strings.Replace(testHash, strings.Repeat("A", 22)+"$", strings.Repeat("A", 44)+"$", 1),
		strings.Replace(testHash, strings.Repeat("A", 22)+"$", strings.Repeat("A", 22)+"==$", 1),
		strings.Replace(testHash, strings.Repeat("A", 22)+"$", strings.Repeat("A", 21)+"B$", 1),
		strings.Replace(testHash, strings.Repeat("A", 22)+"$", strings.Repeat("A", 22)+"\n$", 1),
		strings.TrimSuffix(testHash, strings.Repeat("A", 43)) + "AAAA",
		testHash + strings.Repeat("A", 44),
		testHash + "$",
		testHash + "=",
	}
	for i, encoded := range invalid {
		if _, err := parseHash(encoded); err == nil {
			t.Errorf("case %d: parseHash accepted a malformed or excessive hash", i)
		}
		if VerifyPassword(encoded, "correct horse battery staple") {
			t.Errorf("case %d: VerifyPassword accepted a malformed or excessive hash", i)
		}
		cfg := validConfig()
		cfg.PasswordHash = encoded
		if err := Validate(cfg); err == nil {
			t.Errorf("case %d: Validate accepted a malformed or excessive hash", i)
		}
	}
}

func TestVerifyCompatible64MiBHash(t *testing.T) {
	password := "a compatible external password"
	salt := []byte("a different salt")
	key := argon2.IDKey([]byte(password), salt, 1, 64*1024, 1, 32)
	encoded := "$argon2id$v=19$m=65536,t=1,p=1$" +
		base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key)
	if !VerifyPassword(encoded, password) {
		t.Fatal("VerifyPassword rejected a compatible 64 MiB Argon2id hash")
	}
}
