package storage

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitFixture(t *testing.T) (string, func(...string)) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := filepath.Join(t.TempDir(), "a repo ' $(not-a-command)")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_COUNT=0", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@invalid")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("fixture git %v: %v: %s", args, err, output)
		}
	}
	git("init", "-b", "main")
	return root, git
}

func TestGitStatusAndDiffStayScopedAndReadOnly(t *testing.T) {
	root, git := gitFixture(t)
	write := func(name, content string) {
		t.Helper()
		filename := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("reports/a + ü.txt", "before\n")
	write("reports/deleted.txt", "deleted content\n")
	write("outside.txt", "private outside the project\n")
	git("add", ".")
	git("commit", "-m", "fixture")
	write("reports/a + ü.txt", "after\n")
	write("outside.txt", "changed outside the project\n")
	write("reports/new.txt", "new content\n")
	if err := os.Remove(filepath.Join(root, "reports/deleted.txt")); err != nil {
		t.Fatal(err)
	}
	indexBefore, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(root, "reports")
	status, err := ReadGitStatus(context.Background(), "", project)
	if err != nil || status.Branch != "main" || len(status.Changes) != 3 {
		t.Fatalf("status: %#v, %v", status, err)
	}
	for _, change := range status.Changes {
		if strings.Contains(change.Path, "reports/") || strings.Contains(change.Path, "outside") {
			t.Fatalf("unscoped status path: %#v", change)
		}
	}
	for _, file := range []string{"a + ü.txt", "deleted.txt", "new.txt"} {
		patch, truncated, err := ReadGitDiff(context.Background(), "", project, file)
		if err != nil || truncated || !strings.Contains(patch, file) || strings.Contains(patch, root) || strings.Contains(patch, "outside") {
			t.Fatalf("diff %q: %q, %v, %v", file, patch, truncated, err)
		}
	}
	indexAfter, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil || string(indexBefore) != string(indexAfter) {
		t.Fatal("Git reads modified the index")
	}
	if _, err := os.Stat(filepath.Join(root, ".git/index.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Git reads left an index lock")
	}
	if _, _, err := ReadGitDiff(context.Background(), "", root, "../outside"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("traversal: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReadGitStatus(ctx, "", root); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestGitHelpersNeverRunAndLargeChangesStop(t *testing.T) {
	root, git := gitFixture(t)
	file := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(file, []byte("before\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "fixture")
	marker := filepath.Join(t.TempDir(), "helper-ran")
	helper := filepath.Join(root, "helper.sh")
	if err := os.WriteFile(helper, []byte("#!/bin/sh\nprintf unsafe > "+shellArgument(marker)+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	git("config", "core.fsmonitor", helper)
	git("config", "diff.external", helper)
	git("config", "diff.evil.textconv", helper)
	if err := os.WriteFile(filepath.Join(root, ".gitattributes"), []byte("*.txt diff=evil\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(strings.Repeat("changed line\n", 20_000)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadGitStatus(context.Background(), "", root); err != nil {
		t.Fatal(err)
	}
	patch, truncated, err := ReadGitDiff(context.Background(), "", root, "notes.txt")
	if err != nil || !truncated || len(patch) > MaxGitPatch || strings.Count(patch, "\n") > 2000 {
		t.Fatalf("large diff: %d bytes, %v, %v", len(patch), truncated, err)
	}
	git("config", "filter.evil.clean", helper)
	git("config", "filter.evil.process", helper)
	if _, err := ReadGitStatus(context.Background(), "", root); !errors.Is(err, ErrGitFilters) {
		t.Fatalf("custom filter: %v", err)
	}
	if _, _, err := ReadGitDiff(context.Background(), "", root, "notes.txt"); !errors.Is(err, ErrGitFilters) {
		t.Fatalf("custom filter diff: %v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("repository helper executed")
	}
	git("config", "--remove-section", "filter.evil")
	if err := os.WriteFile(filepath.Join(root, ".gitattributes"), []byte("*.txt filter=lfs\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadGitStatus(context.Background(), "", root); !errors.Is(err, ErrGitFilters) {
		t.Fatalf("filter attributes without a local driver were silently ignored: %v", err)
	}
	tooMany := []byte("\x00\x00" + strings.Repeat("? new.txt\x00", MaxGitChanges+1))
	if _, err := parseGitStatus(tooMany); !errors.Is(err, ErrGitLimit) {
		t.Fatalf("change limit: %v", err)
	}
}

func TestGitUnbornAndNonRepository(t *testing.T) {
	root, _ := gitFixture(t)
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("new file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	status, err := ReadGitStatus(context.Background(), "", root)
	if err != nil || len(status.Changes) != 1 || status.Changes[0].Worktree != "?" {
		t.Fatalf("unborn status: %#v %v", status, err)
	}
	patch, truncated, err := ReadGitDiff(context.Background(), "", root, "new.txt")
	if err != nil || truncated || !strings.Contains(patch, "+new file") {
		t.Fatalf("unborn diff: %q %v", patch, err)
	}
	if _, err := ReadGitStatus(context.Background(), "", t.TempDir()); !errors.Is(err, ErrGitNotRepo) {
		t.Fatalf("non-repository: %v", err)
	}
}

func TestGitDiffRejectsLargeFileVersionsBeforeDiffing(t *testing.T) {
	root, git := gitFixture(t)
	name := filepath.Join(root, "large.dat")
	file, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(MaxGitDiffFile + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadGitDiff(context.Background(), "", root, "large.dat"); !errors.Is(err, ErrGitFileSize) {
		t.Fatalf("large untracked input: %v", err)
	}
	git("add", "--", "large.dat")
	git("commit", "-m", "large baseline")
	if err := os.WriteFile(name, []byte("small replacement\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadGitDiff(context.Background(), "", root, "large.dat"); !errors.Is(err, ErrGitFileSize) {
		t.Fatalf("large committed input: %v", err)
	}
	git("config", "extensions.partialclone", "origin")
	if _, err := ReadGitStatus(context.Background(), "", root); !errors.Is(err, ErrGitFilters) {
		t.Fatalf("partial-clone extension: %v", err)
	}
}
