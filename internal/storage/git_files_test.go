package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitDiffFilesVersionsScopeAndRemote(t *testing.T) {
	root, git := gitFixture(t)
	project := filepath.Join(root, "reports")
	if err := os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	head := func() string {
		t.Helper()
		data, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(data))
	}
	before, after := []byte("old\x00binary\nmissing 0\x00"), []byte("new\x00binary\xff")
	name := "figure ' $(echo nope) ü.png"
	write("reports/"+name, before)
	write("reports/deleted.pdf", before)
	write("private.png", []byte("private"))
	git("add", ".")
	git("commit", "-m", "Initial")
	initial := head()
	write("reports/"+name, after)
	write("reports/added.pdf", after)
	if err := os.Remove(filepath.Join(project, "deleted.pdf")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../private.png", filepath.Join(project, "link.png")); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-m", "Update")
	updated := head()
	write("reports/"+name, []byte("uncommitted"))
	remote := GitReader{Remote: func(ctx context.Context, _, command string, output io.Writer) error {
		cmd := exec.CommandContext(ctx, "sh", "-c", command)
		cmd.Stdout = output
		return cmd.Run()
	}}
	for _, target := range []string{"", "fixture-host"} {
		for _, item := range []struct {
			name, commit  string
			before, after []byte
		}{
			{name, initial, nil, before},
			{name, updated, before, after},
			{"added.pdf", updated, nil, after},
			{"deleted.pdf", updated, before, nil},
			{name, "", after, nil},
			{"missing.pdf", updated, nil, nil},
		} {
			result, err := remote.DiffFiles(context.Background(), target, project, item.name, item.commit)
			if err != nil {
				t.Fatal(item.name, target, err)
			}
			for i, version := range []*GitFileVersion{result.Before, result.After} {
				want := [][]byte{item.before, item.after}[i]
				if (version == nil) != (want == nil) || (version != nil && (version.Unsupported || !bytes.Equal(version.Data, want))) {
					t.Fatalf("incorrect version: %s %s side %d: %+v", target, item.name, i, version)
				}
			}
		}
		result, err := remote.DiffFiles(context.Background(), target, project, "link.png", updated)
		if err != nil || result.After == nil || !result.After.Unsupported || len(result.After.Data) != 0 {
			t.Fatal("symlink content exposed as a figure", result, err)
		}
		if _, err := remote.DiffFiles(context.Background(), target, project, "../private.png", updated); !errors.Is(err, ErrForbidden) {
			t.Fatal("escaped project", err)
		}
	}
	write("private.png", []byte("private update"))
	git("add", "private.png")
	git("commit", "-m", "Outside project")
	if _, err := ReadGitDiffFiles(context.Background(), "", project, name, head()); !errors.Is(err, ErrGitCommit) {
		t.Fatal("accepted commit outside project history", err)
	}
	git("checkout", "-b", "feature")
	write("reports/merge.pdf", after)
	git("add", ".")
	git("commit", "-m", "Branch")
	git("checkout", "main")
	write("reports/main.pdf", before)
	git("add", ".")
	git("commit", "-m", "Main")
	git("merge", "--no-ff", "feature", "-m", "Merge")
	result, err := ReadGitDiffFiles(context.Background(), "", project, "merge.pdf", head())
	if err != nil || result.Before != nil || result.After == nil || !bytes.Equal(result.After.Data, after) {
		t.Fatal("merge did not use first parent", result, err)
	}
}

func TestGitDiffFilesLimitsAndInvalidInput(t *testing.T) {
	root, git := gitFixture(t)
	name := filepath.Join(root, "large.pdf")
	if err := os.WriteFile(name, bytes.Repeat([]byte("x"), MaxGitDiffFile+1), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "Too large")
	if _, err := ReadGitDiffFiles(context.Background(), "", root, "large.pdf", ""); !errors.Is(err, ErrGitFileSize) {
		t.Fatal("oversized HEAD was accepted", err)
	}
	if err := os.WriteFile(name, []byte("small"), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "Smaller")
	hash, _ := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
	if _, err := ReadGitDiffFiles(context.Background(), "", root, "large.pdf", strings.TrimSpace(string(hash))); !errors.Is(err, ErrGitFileSize) {
		t.Fatal("oversized parent was accepted", err)
	}
	calls := 0
	reader := GitReader{Remote: func(context.Context, string, string, io.Writer) error { calls++; return nil }}
	for _, commit := range []string{"HEAD", "--all", strings.Repeat("a", 40) + "^1"} {
		if _, err := reader.DiffFiles(context.Background(), "remote", "/project", "figure.png", commit); !errors.Is(err, ErrForbidden) {
			t.Fatal("invalid revision accepted", err)
		}
	}
	if calls != 0 {
		t.Fatal("invalid input reached SSH")
	}
	for _, output := range []string{"file 3\x00xx", "file -1\x00", "missing 1\x00xmissing 0\x00", "file 0\x00missing 0\x00extra"} {
		reader.Remote = func(_ context.Context, _, _ string, w io.Writer) error {
			_, err := io.WriteString(w, output)
			return err
		}
		if _, err := reader.DiffFiles(context.Background(), "remote", "/project", "figure.png", ""); !errors.Is(err, ErrGitUnavailable) {
			t.Fatal("partial or malformed binary response accepted", err)
		}
	}
}
