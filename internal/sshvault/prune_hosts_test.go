package sshvault

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func pruneHostsFixture(jumps map[string][]string) Bundle {
	bundle := Bundle{Hosts: map[string]Profile{}, Keys: map[string][]byte{}, KnownHosts: map[string]string{}}
	for alias, hops := range jumps {
		bundle.Hosts[alias] = Profile{
			Hostname: alias + ".invalid", User: "reader", Port: 22,
			Password: []byte("fixture-password-" + alias), Jumps: hops, KnownHosts: alias,
		}
		bundle.KnownHosts[alias] = ""
	}
	return bundle
}

func TestBundleRemoveHostsLastHostClearsCredentials(t *testing.T) {
	bundle := testBundle(t)
	defer bundle.Clear()
	password, key := bundle.Hosts["fixture"].Password, bundle.Keys["key"]
	if err := bundle.RemoveHosts([]string{"fixture"}, []string{"unimported-config-target"}); err != nil {
		t.Fatal(err)
	}
	if len(bundle.Hosts) != 0 || len(bundle.Keys) != 0 || len(bundle.KnownHosts) != 0 {
		t.Fatal("removing the last imported host retained credential data")
	}
	if !bytes.Equal(password, make([]byte, len(password))) || !bytes.Equal(key, make([]byte, len(key))) {
		t.Fatal("deleted password or private key bytes were not cleared")
	}
	if err := bundle.RemoveHosts([]string{"already-removed"}, nil); err != nil {
		t.Fatal("an already empty bundle could not be pruned", err)
	}
	var empty Bundle
	if err := empty.RemoveHosts(nil, nil); err != nil {
		t.Fatal("nil maps could not be pruned", err)
	}
}

func TestBundleRemoveHostsPreservesSharedIdentityUntilLastReference(t *testing.T) {
	bundle := testBundle(t)
	defer bundle.Clear()
	other := bundle.Hosts["fixture"]
	other.Hostname = "other.invalid"
	other.Password = []byte("other-fixture-password")
	bundle.Hosts["other"] = other
	bundle.KnownHosts["trust"] = strings.Replace(bundle.KnownHosts["trust"], "fixture.example ", "fixture.example,other.invalid ", 1)
	deletedPassword, keptPassword := bundle.Hosts["fixture"].Password, bytes.Clone(other.Password)
	key, originalKey := bundle.Keys["key"], bytes.Clone(bundle.Keys["key"])
	trust := bundle.KnownHosts["trust"]
	if err := bundle.RemoveHosts([]string{"fixture"}, []string{"other"}); err != nil {
		t.Fatal(err)
	}
	if len(bundle.Hosts) != 1 || !bytes.Equal(bundle.Hosts["other"].Password, keptPassword) ||
		len(bundle.Keys) != 1 || !bytes.Equal(key, originalKey) || len(bundle.KnownHosts) != 1 || bundle.KnownHosts["trust"] != trust {
		t.Fatal("removing one host changed its peer's shared identity or trust set")
	}
	if !bytes.Equal(deletedPassword, make([]byte, len(deletedPassword))) {
		t.Fatal("removed host password was not cleared")
	}
	if err := bundle.Validate(); err != nil {
		t.Fatal("retained host became invalid", err)
	}
	if err := bundle.RemoveHosts([]string{"other"}, nil); err != nil {
		t.Fatal(err)
	}
	if len(bundle.Hosts) != 0 || len(bundle.Keys) != 0 || len(bundle.KnownHosts) != 0 ||
		!bytes.Equal(key, make([]byte, len(key))) || !bytes.Equal(other.Password, make([]byte, len(other.Password))) {
		t.Fatal("last reference did not remove and clear the shared credentials")
	}
}

func TestBundleRemoveHostsPrunesOrphansAndPreservesMultipleRoots(t *testing.T) {
	bundle := pruneHostsFixture(map[string][]string{
		"remove": {"orphan-jump"}, "orphan-jump": {"orphan-deep"}, "orphan-deep": nil,
		"keep-a": {"shared-jump"}, "keep-b": {"shared-jump"}, "shared-jump": {"shared-deep"}, "shared-deep": nil,
		"unrooted": nil,
	})
	defer bundle.Clear()
	identity := testBundle(t)
	defer identity.Clear()
	key := identity.Keys["key"]
	bundle.Keys["removed-key"] = key
	removed := bundle.Hosts["remove"]
	removed.Keys = []string{"removed-key"}
	bundle.Hosts["remove"] = removed
	bundle.KnownHosts["unused"] = "# unrelated trust data\n"
	passwords := make(map[string][]byte)
	for alias, profile := range bundle.Hosts {
		passwords[alias] = profile.Password
	}
	if err := bundle.Validate(); err != nil {
		t.Fatal("invalid fixture", err)
	}
	if err := bundle.RemoveHosts([]string{"remove"}, []string{"keep-a", "unimported", "keep-b", "keep-a"}); err != nil {
		t.Fatal(err)
	}
	kept := []string{"keep-a", "keep-b", "shared-jump", "shared-deep"}
	if len(bundle.Hosts) != len(kept) || len(bundle.KnownHosts) != len(kept) || len(bundle.Keys) != 0 {
		t.Fatal("orphan profiles or unused credential sets survived pruning")
	}
	for alias, password := range passwords {
		_, exists := bundle.Hosts[alias]
		if exists != slices.Contains(kept, alias) {
			t.Fatalf("unexpected retained state for %s", alias)
		}
		if exists {
			if string(password) != "fixture-password-"+alias {
				t.Fatalf("retained password changed for %s", alias)
			}
		} else if !bytes.Equal(password, make([]byte, len(password))) {
			t.Fatalf("orphan password was not cleared for %s", alias)
		}
	}
	if !bytes.Equal(key, make([]byte, len(key))) {
		t.Fatal("orphan private key bytes were not cleared")
	}
	if err := bundle.Validate(); err != nil {
		t.Fatal("retained roots or jump chain became invalid", err)
	}
}

func TestBundleRemoveHostsRejectsDependenciesWithoutMutation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		jumps map[string][]string
	}{
		{"direct", map[string][]string{"keep": {"required"}, "required": nil}},
		{"transitive", map[string][]string{"keep": {"middle"}, "middle": {"required"}, "required": nil}},
		{"later explicit jump", map[string][]string{
			"keep": {"first", "later"}, "first": nil, "later": {"required"}, "required": nil,
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.jumps["remove"], tc.jumps["unrooted"] = nil, nil
			bundle := pruneHostsFixture(tc.jumps)
			defer bundle.Clear()
			identity := testBundle(t)
			defer identity.Clear()
			bundle.Keys["unused"] = identity.Keys["key"]
			bundle.KnownHosts["unused"] = "# must remain untouched on rejection\n"
			before, err := json.Marshal(bundle)
			if err != nil {
				t.Fatal(err)
			}
			err = bundle.RemoveHosts([]string{"remove", "required"}, []string{"keep"})
			var inUse *HostInUseError
			if !errors.Is(err, ErrHostInUse) || !errors.As(err, &inUse) || inUse.Alias != "required" || inUse.Dependent != "keep" {
				t.Fatal("missing dependency details", err)
			}
			after, err := json.Marshal(bundle)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("rejected deletion mutated or cleared credentials")
			}
		})
	}
}

func TestBundleRemoveHostsAllowsDependentAndJumpTogether(t *testing.T) {
	bundle := pruneHostsFixture(map[string][]string{
		"dependent": {"jump"}, "jump": {"implicit"}, "implicit": nil, "keep": nil,
	})
	defer bundle.Clear()
	if err := bundle.RemoveHosts([]string{"dependent", "jump"}, []string{"keep"}); err != nil {
		t.Fatal(err)
	}
	if len(bundle.Hosts) != 1 || bundle.Hosts["keep"].Hostname != "keep.invalid" ||
		len(bundle.Keys) != 0 || len(bundle.KnownHosts) != 1 {
		t.Fatal("joint deletion retained the dependent or orphan jumps")
	}
	if err := bundle.Validate(); err != nil {
		t.Fatal(err)
	}
}

func pruneTrustSigner(t *testing.T) ssh.Signer {
	t.Helper()
	bundle := testBundle(t)
	defer bundle.Clear()
	signer, err := ssh.ParsePrivateKey(bundle.Keys["key"])
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func TestBundleRemoveHostsFiltersTrustWithUpstreamMatcher(t *testing.T) {
	first, second := pruneTrustSigner(t), pruneTrustSigner(t)
	authority, revoked := pruneTrustSigner(t), pruneTrustSigner(t)
	keyText := func(signer ssh.Signer) string {
		return strings.TrimSuffix(string(ssh.MarshalAuthorizedKey(signer.PublicKey())), "\n")
	}
	hashed := knownhosts.HashHostname(knownhosts.Normalize("hash.example:2222"))
	wrongPortHash := knownhosts.HashHostname(knownhosts.Normalize("hash.example:22"))
	records := []struct {
		data string
		keep bool
	}{
		{"# deleted-only.example comment with many words\n", false},
		{"\n", false},
		{"deleted-only.example " + keyText(second) + "\n", false},
		{" \tkept.example\t" + keyText(first) + " arbitrary comment with more than five words\r\n", true},
		{"kept.example " + keyText(second) + "\n", true},
		{hashed + " " + keyText(first) + "\n", true},
		{wrongPortHash + " " + keyText(second) + "\n", false},
		{"hash.example " + keyText(second) + "\n", false},
		{"[port.example]:2200 " + keyText(first) + "\n", true},
		{"port.example " + keyText(second) + "\n", false},
		{"trusted-alias " + keyText(first) + "\n", true},
		{"[internal.invalid]:2200 " + keyText(second) + "\n", false},
		{"[trusted-alias]:2200 " + keyText(second) + "\n", false},
		{"[2001:db8::4]:2201 " + keyText(first) + "\n", true},
		{"!blocked.kept.example,*.kept.example " + keyText(first) + "\n", true},
		{"!kept.example,kept.example " + keyText(second) + "\n", false},
		{"@cert-authority deleted-ca.example,cert.example " + keyText(authority) + " arbitrary CA comment with many words\r\n", true},
		{"@cert-authority unrelated-ca.example " + keyText(second) + "\n", false},
		{"@cert-authority cert.example " + keyText(revoked) + "\n", true},
		{"@revoked unrelated-revocation-label.example " + keyText(revoked) + " globally effective despite unrelated hostname\n", true},
		{"jump.example " + keyText(first) + "\n", true},
		{"deleted-final.example " + keyText(second), false},
	}
	var original, wanted strings.Builder
	for _, record := range records {
		original.WriteString(record.data)
		if record.keep {
			wanted.WriteString(record.data)
		}
	}
	oldID := fmt.Sprintf("%x", sha256.Sum256([]byte(original.String())))
	bundle := pruneHostsFixture(map[string][]string{
		"deleted": nil, "plain": nil, "hashed": nil, "port": nil, "alias": nil,
		"alias-port": nil, "wildcard": nil, "negated": nil, "ca": {"jump"}, "jump": nil, "separate": nil,
	})
	defer bundle.Clear()
	addresses := map[string]string{
		"plain": "kept.example:22", "hashed": "hash.example:2222", "port": "port.example:2200",
		"alias": "trusted-alias:22", "alias-port": "[2001:db8::4]:2201",
		"wildcard": "node.kept.example:22", "negated": "blocked.kept.example:22", "ca": "cert.example:22", "jump": "jump.example:22",
	}
	profiles := map[string]struct {
		hostname, alias string
		port            int
	}{
		"deleted": {"deleted-only.example", "", 22},
		"plain":   {"kept.example", "", 22}, "hashed": {"hash.example", "", 2222}, "port": {"port.example", "", 2200},
		"alias": {"internal.invalid", "trusted-alias", 2200}, "alias-port": {"internal-v6.invalid", "[2001:db8::4]:2201", 22},
		"wildcard": {"node.kept.example", "", 22}, "negated": {"blocked.kept.example", "", 22},
		"ca": {"cert.example", "", 22}, "jump": {"jump.example", "", 22},
	}
	for alias, settings := range profiles {
		profile := bundle.Hosts[alias]
		profile.Hostname, profile.HostKeyAlias, profile.Port = settings.hostname, settings.alias, settings.port
		profile.KnownHosts = oldID
		bundle.Hosts[alias] = profile
	}
	// A different retained set can already own the preferred filtered-data ID.
	collisionID := fmt.Sprintf("filtered-%x", sha256.Sum256([]byte(wanted.String())))
	separateData := "separate.invalid " + keyText(second) + "\n"
	separate := bundle.Hosts["separate"]
	separate.KnownHosts = collisionID
	bundle.Hosts["separate"] = separate
	bundle.KnownHosts = map[string]string{oldID: original.String(), collisionID: separateData}
	before, err := hostKeyCallback(original.String())
	if err != nil {
		t.Fatal("invalid fixture", err)
	}
	roots := []string{"plain", "hashed", "port", "alias", "alias-port", "wildcard", "negated", "ca", "separate"}
	if err := bundle.RemoveHosts([]string{"deleted"}, roots); err != nil {
		t.Fatal(err)
	}
	newID := bundle.Hosts["plain"].KnownHosts
	filtered := bundle.KnownHosts[newID]
	if newID == oldID || newID == collisionID || filtered != wanted.String() || len(bundle.KnownHosts) != 2 {
		t.Fatal("filtered records or replacement trust IDs are incorrect")
	}
	if _, exists := bundle.KnownHosts[oldID]; exists || strings.Contains(filtered, "deleted-only.example") {
		t.Fatal("deleted-only hostname or stale trust ID remained")
	}
	if bundle.Hosts["separate"].KnownHosts != collisionID || bundle.KnownHosts[collisionID] != separateData {
		t.Fatal("re-keying overwrote another retained trust set")
	}
	for alias := range addresses {
		if bundle.Hosts[alias].KnownHosts != newID {
			t.Fatalf("retained profile %s was not re-keyed", alias)
		}
	}
	after, err := hostKeyCallback(filtered)
	if err != nil {
		t.Fatal(err)
	}
	certificate := func(signer ssh.Signer) *ssh.Certificate {
		cert := &ssh.Certificate{Key: first.PublicKey(), CertType: ssh.HostCert, ValidPrincipals: []string{"cert.example"}, ValidBefore: ssh.CertTimeInfinity}
		if err := cert.SignCert(rand.Reader, signer); err != nil {
			t.Fatal(err)
		}
		return cert
	}
	validCertificate, revokedCertificate := certificate(authority), certificate(revoked)
	remote := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 22}
	for alias, address := range addresses {
		for _, key := range []ssh.PublicKey{first.PublicKey(), second.PublicKey(), authority.PublicKey(), revoked.PublicKey(), validCertificate, revokedCertificate} {
			previous, current := before(address, remote, key), after(address, remote, key)
			if fmt.Sprint(previous) != fmt.Sprint(current) {
				t.Fatalf("verification changed for %s and %s", alias, key.Type())
			}
			var previousMismatch, currentMismatch *knownhosts.KeyError
			if errors.As(previous, &previousMismatch) {
				if !errors.As(current, &currentMismatch) {
					t.Fatal("key mismatch changed type")
				}
				fingerprints := func(mismatch *knownhosts.KeyError) []string {
					var result []string
					for _, known := range mismatch.Want {
						result = append(result, ssh.FingerprintSHA256(known.Key))
					}
					return result
				}
				if !reflect.DeepEqual(fingerprints(previousMismatch), fingerprints(currentMismatch)) {
					t.Fatalf("verification lost matching records for %s", alias)
				}
			}
		}
	}
	if err := after("cert.example:22", remote, validCertificate); err != nil {
		t.Fatal("retained certificate authority no longer verifies its host", err)
	}
	if err := after("cert.example:22", remote, revokedCertificate); err == nil {
		t.Fatal("unrelated-name revocation stopped revoking a certificate authority")
	}
	var revocation *knownhosts.RevokedError
	if !errors.As(after("kept.example:22", remote, revoked.PublicKey()), &revocation) {
		t.Fatal("retained globally revoked key became approvable")
	}
	// Reimporting the original hash-derived entry cannot overwrite filtered trust.
	bundle.KnownHosts[oldID] = original.String()
	if bundle.KnownHosts[bundle.Hosts["plain"].KnownHosts] != wanted.String() {
		t.Fatal("reimported original trust replaced another profile's filtered set")
	}
}

func TestBundleRemoveHostsFiltersTrustOnlyForReferencingProfiles(t *testing.T) {
	signer := pruneTrustSigner(t)
	key := string(ssh.MarshalAuthorizedKey(signer.PublicKey()))
	bundle := pruneHostsFixture(map[string][]string{"one": nil, "two": nil, "removed": nil})
	defer bundle.Clear()
	bundle.KnownHosts["one"] = "one.invalid " + key
	bundle.KnownHosts["two"] = "one.invalid " + key + "two.invalid " + key
	if err := bundle.RemoveHosts([]string{"removed"}, []string{"one", "two"}); err != nil {
		t.Fatal(err)
	}
	if bundle.KnownHosts[bundle.Hosts["one"].KnownHosts] != "one.invalid "+key ||
		bundle.KnownHosts[bundle.Hosts["two"].KnownHosts] != "two.invalid "+key {
		t.Fatal("trust filtering used profiles referencing a different set")
	}
}

func TestBundleRemoveHostsTrustFailureDoesNotMutate(t *testing.T) {
	for _, failure := range []string{"malformed", "missing set", "oversized", "temporary file"} {
		t.Run(failure, func(t *testing.T) {
			bundle := pruneHostsFixture(map[string][]string{"one": nil, "two": nil, "removed": nil})
			defer bundle.Clear()
			identity := testBundle(t)
			defer identity.Clear()
			bundle.Keys["unused"] = identity.Keys["key"]
			bundle.KnownHosts["one"] = identity.KnownHosts["trust"]
			switch failure {
			case "malformed":
				bundle.KnownHosts["two"] = "not valid known_hosts data\n"
			case "missing set":
				delete(bundle.KnownHosts, "two")
			case "oversized":
				bundle.KnownHosts["two"] = strings.Repeat("#", MaxPlaintext/2+1)
			case "temporary file":
				t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing"))
			}
			before, err := json.Marshal(bundle)
			if err != nil {
				t.Fatal(err)
			}
			if err := bundle.RemoveHosts([]string{"removed"}, []string{"one", "two"}); err == nil {
				t.Fatal("invalid trust was accepted")
			}
			after, err := json.Marshal(bundle)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("failed trust preparation mutated credentials")
			}
		})
	}
}
