package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestGitCommitFilesMetadataScopeAndMerge(t *testing.T) {
	root, git := gitFixture(t)
	write := func(name, text string) {
		t.Helper()
		full := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	head := func() string {
		t.Helper()
		output, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(output))
	}
	write("reports/src/first.txt", "before")
	write("reports/old.txt", "old")
	write("private.txt", "outside")
	git("add", ".")
	git("commit", "-m", "Initial commit")
	initial := head()
	first, err := ReadGitCommit(context.Background(), "", root, initial)
	if err != nil || len(first.Parents) != 0 || len(first.Files) != 3 {
		t.Fatalf("root commit: %+v %v", first, err)
	}
	for _, file := range first.Files {
		if file.Status != "A" {
			t.Fatal("root commit did not list additions", file)
		}
	}
	write("reports/src/first.txt", "after")
	write("reports/plots/a + ü.csv", "new")
	write("outside-only.txt", "outside change")
	if err := os.Remove(filepath.Join(root, "reports/old.txt")); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "--author=Contributor <contributor@invalid>", "-m", "Update reports\n\nLiteral <script>text</script>.")
	updated := head()
	index, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil {
		t.Fatal(err)
	}
	scopedRoot := filepath.Join(root, "reports")
	details, err := ReadGitCommit(context.Background(), "", scopedRoot, updated)
	want := []GitCommitFile{{Path: "old.txt", Status: "D"}, {Path: "plots/a + ü.csv", Status: "A"}, {Path: "src/first.txt", Status: "M"}}
	if err != nil || !slices.Equal(details.Files, want) || details.Truncated {
		t.Fatalf("scoped changes: %+v %v", details, err)
	}
	if details.Author != "Contributor" || details.Email != "contributor@invalid" || details.Committer != "Fixture" ||
		details.CommitterEmail != "fixture@invalid" || details.Date == "" || details.CommitDate == "" ||
		!strings.Contains(details.Message, "<script>text</script>") || !slices.Equal(details.Parents, []string{initial}) {
		t.Fatalf("commit metadata was lost: %+v", details)
	}
	after, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil || !slices.Equal(index, after) {
		t.Fatal("commit read modified the index")
	}
	write("private.txt", "only outside the project")
	git("add", ".")
	git("commit", "-m", "Private outside commit")
	if _, err := ReadGitCommit(context.Background(), "", scopedRoot, head()); !errors.Is(err, ErrGitCommit) {
		t.Fatal("commit outside the scoped history exposed metadata", err)
	}
	git("checkout", "-b", "feature")
	write("reports/branch.txt", "branch")
	git("add", ".")
	git("commit", "-m", "Feature")
	git("checkout", "main")
	write("reports/main.txt", "main")
	git("add", ".")
	git("commit", "-m", "Main")
	git("merge", "--no-ff", "feature", "-m", "Merge")
	merge, err := ReadGitCommit(context.Background(), "", scopedRoot, head())
	if err != nil || len(merge.Parents) != 2 || !slices.Equal(merge.Files, []GitCommitFile{{Path: "branch.txt", Status: "A"}}) {
		t.Fatalf("merge should compare against its first parent: %+v %v", merge, err)
	}
	remote := GitReader{Remote: func(ctx context.Context, _, command string, output io.Writer) error {
		cmd := exec.CommandContext(ctx, "sh", "-c", command)
		cmd.Stdout = output
		return cmd.Run()
	}}
	remoteDetails, err := remote.Commit(context.Background(), "fixture-host", scopedRoot, updated)
	if err != nil || !slices.Equal(remoteDetails.Files, want) {
		t.Fatalf("remote commit read: %+v %v", remoteDetails, err)
	}
}

func TestGitCommitRejectsReferencesAndBoundsFiles(t *testing.T) {
	hash := strings.Repeat("a", 40)
	calls := 0
	reader := GitReader{Remote: func(_ context.Context, _, _ string, output io.Writer) error {
		calls++
		_, _ = io.WriteString(output, strings.Join([]string{hash, "", "Author", "author@invalid", "date", "Committer", "committer@invalid", "date", "Message", ""}, "\x00"))
		for index := 0; index < MaxGitChanges+1; index++ {
			_, _ = fmt.Fprintf(output, "A\x00file-%d.txt\x00", index)
		}
		return nil
	}}
	for _, invalid := range []string{"", "HEAD", "--all", hash + "^1", strings.Repeat("z", 40), "a/b"} {
		if _, err := reader.Commit(context.Background(), "fixture-host", "/project", invalid); !errors.Is(err, ErrForbidden) {
			t.Fatal("invalid commit accepted", invalid, err)
		}
	}
	if calls != 0 {
		t.Fatal("invalid commit ran a command")
	}
	result, err := reader.Commit(context.Background(), "fixture-host", "/project", hash)
	if err != nil || len(result.Files) != MaxGitChanges || !result.Truncated {
		t.Fatalf("unbounded file list: %d %v %v", len(result.Files), result.Truncated, err)
	}
}
