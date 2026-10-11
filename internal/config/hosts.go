package config

import (
	"crypto/sha256"
	"fmt"
)

// UniqueID gives a target or root a stable safe ID, avoiding configured IDs.
func UniqueID(prefix, value string, used map[string]bool) string {
	hash := sha256.Sum256([]byte(value))
	base := fmt.Sprintf("%s-%x", prefix, hash[:16])
	id := base
	for n := 2; used[id]; n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	used[id] = true
	return id
}

// MergeTargets preserves existing hosts and roots and adds each new target once.
// The returned slice owns its backing array; existing roots remain immutable.
func MergeTargets(hosts []Host, targets []string) ([]Host, int) {
	merged := append([]Host{}, hosts...)
	ids, seen := map[string]bool{}, map[string]bool{}
	for _, host := range hosts {
		ids[host.ID], seen[host.Target] = true, true
	}
	for _, target := range targets {
		if !seen[target] {
			merged = append(merged, Host{ID: UniqueID("ssh", target, ids),
				Label: target, Target: target, Roots: []Root{}})
			seen[target] = true
		}
	}
	return merged, len(merged) - len(hosts)
}
