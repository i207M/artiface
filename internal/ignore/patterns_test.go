package ignore

import (
	"errors"
	"strings"
	"testing"
)

func TestGlobScopeAndDirectorySemantics(t *testing.T) {
	for _, tc := range []struct {
		pattern, rel string
		directory    bool
		want         bool
	}{
		{"cache/", "cache", true, true},
		{"cache/", "cache", false, false},
		{"cache/", "nested/cache/file", false, true},
		{"cache/", "mycache/file", false, false},
		{"/cache/", "nested/cache/file", false, false},
		{"/cache/", "cache/file", false, true},
		{"reports/*.tmp", "reports/a.tmp", false, true},
		{"reports/*.tmp", "reports/nested/a.tmp", false, false},
		{"reports/*.tmp", "other/reports/a.tmp", false, false},
		{"reports/**/*.tmp", "reports/a.tmp", false, true},
		{"reports/**/*.tmp", "reports/a/b/c.tmp", false, true},
		{"**/plot?.png", "ploté.png", false, true},
		{"**/plot?.png", "a/b/ploté.png", false, true},
		{"**/plot?.png", "a/b/plot12.png", false, false},
		{"**/plot?.png", "a/b/PLOT1.png", false, false},
		{"foo/**/", "foo", true, true},
		{"foo/**/", "foo", false, false},
		{"foo/**/", "foo/bar/file", false, true},
		{"**/", "file", false, false},
		{"**/", "folder", true, true},
		{"**/", "folder/file", false, true},
		{"**/**/", "file", false, false},
		{"**/**/cache/", "a/cache/file", false, true},
		{"\r\n # comment\r\n *.tmp \r\n", "a.tmp", false, true},
		{"a#b", "a#b", false, true},
		{"", "node_modules/a.js", false, false},
	} {
		t.Run(tc.pattern+":"+tc.rel, func(t *testing.T) {
			m, err := Compile(tc.pattern)
			if err != nil {
				t.Fatal(err)
			}
			got, err := m.Ignored(tc.rel, tc.directory, NewBudget())
			if err != nil || got != tc.want {
				t.Fatalf("Ignored(%q, directory=%v) = %v, %v; want %v", tc.rel, tc.directory, got, err, tc.want)
			}
		})
	}
}

func TestGlobLimitsAndArtifactDefaults(t *testing.T) {
	for _, content := range []string{
		strings.Repeat("#", MaxContentBytes+1), strings.Repeat("a\n", maxPatterns+1),
		strings.Repeat("a", maxPatternBytes+1), "!cache/", `a\b`, "[ab]", "a/**b",
		"a//b", "../file", "./file", "/", "\xff", "a\x00b",
	} {
		if _, err := Compile(content); err == nil {
			t.Fatalf("unbounded or unsupported pattern accepted: %.40q", content)
		}
	}
	m, err := Compile(DefaultContent)
	if err != nil {
		t.Fatal(err)
	}
	for rel, want := range map[string]bool{
		"nested/__pycache__/a.pyc": true, ".git/objects/a": true, "node_modules/a": true,
		".venv/bin/python": true, ".pytest_cache/a": true, ".mypy_cache/a": true, ".ruff_cache/a": true,
		"build/report.html": false, "dist/chart.png": false, "checkpoints/model.bin": false,
		".hidden/plot.png": false,
	} {
		got, err := m.Ignored(rel, false, NewBudget())
		if err != nil || got != want {
			t.Fatalf("default %s: %v, %v", rel, got, err)
		}
	}
	budget := &Budget{remaining: 1}
	if _, err := m.Ignored("report.html", false, budget); !errors.Is(err, ErrWorkLimit) {
		t.Fatal("matching did not stop at its work limit", err)
	}
}
