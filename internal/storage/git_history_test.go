package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitHistoryGraphRefsScopeAndReadOnly(t *testing.T) {
	root, git := gitFixture(t)
	if err := os.Mkdir(filepath.Join(root, "reports"), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	empty, err := ReadGitHistory(context.Background(), "", root, 0)
	if err != nil || len(empty.Commits) != 0 {
		t.Fatalf("unborn repository: %+v, %v", empty, err)
	}
	write("reports/start.txt", "start")
	git("add", ".")
	git("commit", "-m", "Start\n\nCommit body with <script>text</script> and ü.")
	git("checkout", "-b", "feature")
	write("reports/feature.txt", "feature")
	git("add", ".")
	git("commit", "-m", "Feature")
	git("tag", "-a", "v1", "-m", "Annotated release")
	git("update-ref", "refs/remotes/origin/feature", "HEAD")
	git("checkout", "main")
	write("reports/main.txt", "main")
	git("add", ".")
	git("commit", "-m", "Main")
	git("merge", "--no-ff", "feature", "-m", "Merge feature")
	write("outside.txt", "private outside project")
	git("add", ".")
	git("commit", "-m", "Outside only")
	git("commit", "--allow-empty", "-m", "Empty commit")
	index, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil {
		t.Fatal(err)
	}
	history, err := ReadGitHistory(context.Background(), "", root, 0)
	if err != nil || len(history.Commits) != 6 || history.Scoped || history.HasMore {
		t.Fatalf("history: %+v, %v", history, err)
	}
	found := map[string]GitCommit{}
	positions := map[string]int{}
	for i, commit := range history.Commits {
		found[strings.TrimSpace(strings.Split(commit.Message, "\n")[0])] = commit
		positions[commit.Hash] = i
		if commit.Author != "Fixture" || commit.Email != "fixture@invalid" || commit.Date == "" {
			t.Fatalf("missing commit metadata: %+v", commit)
		}
	}
	if len(found["Merge feature"].Parents) != 2 || !strings.Contains(found["Start"].Message, "<script>text</script>") {
		t.Fatalf("lost merge or commit body: %+v", found)
	}
	if strings.Join(found["Feature"].Refs, ",") != "feature,origin/feature,tag: v1" {
		t.Fatalf("branch/remote/annotated tag labels: %+v", found["Feature"].Refs)
	}
	if strings.Join(found["Empty commit"].Refs, ",") != "HEAD → main" || history.Head != found["Empty commit"].Hash {
		t.Fatalf("HEAD decoration: %+v", history)
	}
	for _, commit := range history.Commits {
		for _, parent := range commit.Parents {
			if positions[parent] <= positions[commit.Hash] {
				t.Fatal("graph is not topologically ordered")
			}
		}
	}
	scoped, err := ReadGitHistory(context.Background(), "", filepath.Join(root, "reports"), 0)
	if err != nil || !scoped.Scoped || len(scoped.Commits) == 0 {
		t.Fatalf("scoped history: %+v, %v", scoped, err)
	}
	for _, commit := range scoped.Commits {
		if strings.Contains(commit.Message, "Outside only") {
			t.Fatal("history exposed a commit outside the project")
		}
	}
	after, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil || string(index) != string(after) {
		t.Fatal("history modified the index")
	}
	git("checkout", "--detach", found["Feature"].Hash)
	detached, err := ReadGitHistory(context.Background(), "", root, 0)
	if err != nil || detached.Revision == history.Revision {
		t.Fatalf("HEAD change did not change history revision: %v", err)
	}
	for _, commit := range detached.Commits {
		if commit.Hash == detached.Head && !strings.Contains(strings.Join(commit.Refs, ","), "HEAD") {
			t.Fatal("missing detached HEAD")
		}
	}
}

func TestGitHistoryPaginationLimitsAndRemote(t *testing.T) {
	root, git := gitFixture(t)
	// One process makes a linear fixture larger than a history page.
	cmd := exec.Command("sh", "-c", `for i in $(seq 1 103); do git -C "$1" -c user.name=Fixture -c user.email=fixture@invalid commit --allow-empty -qm "Commit $i" || exit; done`, "fixture", root)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("history fixture: %v %s", err, output)
	}
	first, err := ReadGitHistory(context.Background(), "", root, 0)
	if err != nil || len(first.Commits) != 100 || !first.HasMore {
		t.Fatalf("first page: %d, %+v, %v", len(first.Commits), first.HasMore, err)
	}
	second, err := ReadGitHistory(context.Background(), "", root, 100)
	if err != nil || len(second.Commits) != 3 || second.HasMore || second.Revision != first.Revision || first.Commits[99].Parents[0] != second.Commits[0].Hash {
		t.Fatalf("next page: %+v, %v", second, err)
	}
	git("tag", "new-tag")
	changed, err := ReadGitHistory(context.Background(), "", root, 100)
	if err != nil || changed.Revision == first.Revision {
		t.Fatal("ref changes did not invalidate pagination")
	}
	var remoteCommand string
	reader := GitReader{Remote: func(ctx context.Context, target, command string, output io.Writer) error {
		remoteCommand = command
		cmd := exec.CommandContext(ctx, "sh", "-c", command)
		cmd.Stdout = output
		return cmd.Run()
	}}
	remote, err := reader.History(context.Background(), "fixture-host", root, 100)
	if err != nil || len(remote.Commits) != 3 || !strings.Contains(remoteCommand, "'timeout'") {
		t.Fatalf("remote history: %+v, %v", remote, err)
	}
	if _, err := reader.History(context.Background(), "fixture-host", root, -1); !errors.Is(err, ErrForbidden) {
		t.Fatal("invalid offset accepted", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReadGitHistory(cancelled, "", root, 0); !errors.Is(err, context.Canceled) {
		t.Fatal("history ignored cancellation", err)
	}
	git("config", "filter.fixture.process", "touch should-never-run")
	if _, err := ReadGitHistory(context.Background(), "", root, 0); !errors.Is(err, ErrGitFilters) {
		t.Fatal("custom helpers accepted", err)
	}
	big := GitReader{Remote: func(_ context.Context, _, _ string, w io.Writer) error {
		_, _ = io.WriteString(w, strings.Repeat("x", (2<<20)+1))
		return nil
	}}
	if _, err := big.History(context.Background(), "fixture-host", root, 0); !errors.Is(err, ErrGitLimit) {
		t.Fatal("history output was not bounded", err)
	}
}
