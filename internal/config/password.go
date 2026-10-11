package config

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	passwordMemory      = 19 * 1024 // KiB; OWASP's Argon2id m=19 MiB, t=2, p=1.
	passwordIterations  = 2
	passwordParallelism = 1
	passwordSaltBytes   = 16
	passwordKeyBytes    = 32
	maxPasswordBytes    = 1024
	maxEncodedHashBytes = 256
)

type hashParameters struct {
	memory      uint32
	iterations  uint32
	parallelism uint8
	salt        []byte
	key         []byte
}

// HashPassword generates a salted Argon2id hash suitable for configuration.
func HashPassword(password string) (string, error) {
	if !validPassword(password) {
		return "", errors.New("password must contain at least 6 characters and at most 1024 bytes of valid UTF-8")
	}
	salt := make([]byte, passwordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", errors.New("generate password salt: secure randomness is unavailable")
	}
	input := []byte(password)
	defer clear(input)
	key := argon2.IDKey(input, salt, passwordIterations, passwordMemory, passwordParallelism, passwordKeyBytes)
	defer clear(key)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, passwordMemory, passwordIterations, passwordParallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword fails closed for malformed, weak, or excessively costly hashes.
func VerifyPassword(encoded, password string) bool {
	if !validPassword(password) {
		return false
	}
	params, err := parseHash(encoded)
	if err != nil {
		return false
	}
	input := []byte(password)
	defer clear(input)
	key := argon2.IDKey(input, params.salt, params.iterations, params.memory, params.parallelism, uint32(len(params.key)))
	defer clear(key)
	return subtle.ConstantTimeCompare(key, params.key) == 1
}

func validPassword(password string) bool {
	return len(password) <= maxPasswordBytes && utf8.ValidString(password) && utf8.RuneCountInString(password) >= 6
}

func parseHash(encoded string) (hashParameters, error) {
	invalid := errors.New("expected a bounded, strong Argon2id encoded hash")
	if len(encoded) > maxEncodedHashBytes {
		return hashParameters{}, invalid
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		return hashParameters{}, invalid
	}
	fields := strings.Split(parts[3], ",")
	if len(fields) != 3 {
		return hashParameters{}, invalid
	}
	memory, ok := hashNumber(fields[0], "m=")
	if !ok || memory < passwordMemory || memory > 64*1024 {
		return hashParameters{}, invalid
	}
	iterations, ok := hashNumber(fields[1], "t=")
	if !ok || iterations < 1 || iterations > 4 || iterations == 1 && memory < 46*1024 {
		return hashParameters{}, invalid
	}
	parallelism, ok := hashNumber(fields[2], "p=")
	if !ok || parallelism < 1 || parallelism > 4 {
		return hashParameters{}, invalid
	}
	salt, err := decodeHashBytes(parts[4], 16, 32)
	if err != nil {
		return hashParameters{}, invalid
	}
	key, err := decodeHashBytes(parts[5], 32, 64)
	if err != nil {
		return hashParameters{}, invalid
	}
	return hashParameters{
		memory: memory, iterations: iterations, parallelism: uint8(parallelism),
		salt: salt, key: key,
	}, nil
}

func hashNumber(field, prefix string) (uint32, bool) {
	value, ok := strings.CutPrefix(field, prefix)
	if !ok || len(value) == 0 || len(value) > 10 || value[0] == '0' {
		return 0, false
	}
	number, err := strconv.ParseUint(value, 10, 32)
	return uint32(number), err == nil
}

func decodeHashBytes(encoded string, minBytes, maxBytes int) ([]byte, error) {
	if len(encoded) < base64.RawStdEncoding.EncodedLen(minBytes) || len(encoded) > base64.RawStdEncoding.EncodedLen(maxBytes) {
		return nil, errors.New("invalid encoded length")
	}
	data, err := base64.RawStdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) < minBytes || len(data) > maxBytes || base64.RawStdEncoding.EncodeToString(data) != encoded {
		return nil, errors.New("invalid base64")
	}
	return data, nil
}
