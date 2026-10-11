//go:build !linux

package config

// Other platforms retain in-process serialization and the expected-bytes check.
func lockConfigUpdate(string) (func(), error) { return func() {}, nil }
