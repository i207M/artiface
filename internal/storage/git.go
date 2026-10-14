package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"time"

	"artiface/internal/sshvault"
	"golang.org/x/crypto/ssh"
)

const (
	GitTimeout     = 8 * time.Second
	MaxGitChanges  = 2000
	MaxGitPatch    = 128 << 10
	MaxGitDiffFile = 8 << 20
)

var (
	ErrGitUnavailable = errors.New("git is unavailable")
	ErrGitNotRepo     = errors.New("not a working repository")
	ErrGitFilters     = errors.New("repository uses custom filters or partial-clone fetching")
	ErrGitLimit       = errors.New("git check exceeded its time or size limit")
	ErrGitFileSize    = errors.New("git diff file version is too large")
)

type GitChange struct {
	Path      string `json:"path"`
	Index     string `json:"index"`
	Worktree  string `json:"worktree"`
	Directory bool   `json:"directory,omitempty"`
}

type GitStatus struct {
	Branch  string      `json:"branch"`
	Changes []GitChange `json:"changes"`
}

// Only these fixed, read-only operations are exposed.
// Custom filters and partial clones are excluded: inspecting them can run
// repository-defined programs or fetch objects. No repository helper is needed
// for an ordinary status, text diff, or history read.
const gitScript = `
cd "$1" 2>/dev/null || exit 24
g() {
  env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 \
    GIT_ATTR_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 \
    git --no-pager --no-optional-locks --literal-pathspecs \
    -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false \
    -c maintenance.auto=false -c gc.auto=0 -c submodule.recurse=false \
    -c status.renames=false -c diff.renames=false -c diff.external= -c core.quotePath=false \
    -c trace2.normalTarget=0 -c trace2.perfTarget=0 -c trace2.eventTarget=0 \
    -c protocol.allow=never "$@"
}
command -v git >/dev/null 2>&1 || exit 22
[ "$(g rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || exit 20
helpers=$(g config --includes --get-regexp '^(filter\..*\.(clean|process)|remote\..*\.promisor|extensions\.partialclone)$' 2>/dev/null)
[ -z "$helpers" ] || exit 21
prefix=$(g rev-parse --show-prefix 2>/dev/null) || exit 24
case "$2" in
  status)
    printf '%s\000' "$prefix"
    g ls-files -z -- . | g check-attr -z filter --stdin
    printf '\000'
    g status --porcelain=v2 --branch --no-ahead-behind -z --untracked-files=normal --ignore-submodules=all -- . 2>/dev/null
    ;;
  diff)
    g check-attr -z filter -- "$3"
    printf '\000'
    if [ -f "$3" ]; then
      size=$(wc -c < "$3") || exit 24
      [ "$size" -le 8388608 ] || exit 25
    fi
    if g rev-parse --verify HEAD >/dev/null 2>&1; then
      if g ls-files --error-unmatch -- "$3" >/dev/null 2>&1 || g cat-file -e "HEAD:$prefix$3" 2>/dev/null; then
        kind=$(g cat-file -t "HEAD:$prefix$3" 2>/dev/null) || kind=missing
        [ "$kind" != tree ] || exit 24
        if [ "$kind" = blob ]; then
          size=$(g cat-file -s "HEAD:$prefix$3") || exit 24
          [ "$size" -le 8388608 ] || exit 25
        fi
        g diff --no-ext-diff --no-textconv --no-renames --ignore-submodules=all --relative --no-color HEAD -- "$3" 2>/dev/null
        exit $?
      fi
    fi
    g diff --no-index --no-ext-diff --no-textconv --no-color -- /dev/null "$3" 2>/dev/null
    result=$?
    [ "$result" -le 1 ]
    ;;
  history)
    offset=$3
    refs=$(g for-each-ref --format='%(objectname) %(*objectname) %(refname)' refs/heads refs/remotes refs/tags) || exit 24
    head=$(g rev-parse --verify HEAD 2>/dev/null) || head=
    branch=$(g symbolic-ref -q HEAD 2>/dev/null) || branch=
    printf '%s\000%s\000%s\000%s\000' "$prefix" "$head" "$branch" "$refs"
    [ -n "$head$refs" ] || exit 0
    set --
    [ -z "$prefix" ] || set -- .
    {
      [ -z "$head" ] || printf '%s\n' "$head"
      printf '%s\n' "$refs" | while read -r object rest; do
        [ -z "$object" ] || printf '%s\n' "$object"
      done
    } | g log --stdin --topo-order --full-history --simplify-merges --parents \
      --no-color --no-decorate --no-notes --no-show-signature --encoding=UTF-8 \
      --skip="$offset" --max-count=101 -z \
      --format='%H%x00%P%x00%an%x00%ae%x00%aI%x00%B' -- "$@" 2>/dev/null
    ;;
  commit)
    [ "$(g cat-file -t "$3" 2>/dev/null)" = commit ] || exit 26
    if [ -n "$prefix" ]; then
      scoped=$(g log -1 --full-history --simplify-merges --parents --no-notes --no-show-signature --format=%H "$3" -- . 2>/dev/null) || exit 24
      [ "$scoped" = "$3" ] || exit 26
    fi
    g log -1 -z --no-color --no-decorate --no-notes --no-show-signature --encoding=UTF-8 \
      --format='%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B' "$3" -- 2>/dev/null || exit 24
    parent=$(g rev-parse --verify "$3^1" 2>/dev/null) || parent=
    if [ -n "$parent" ]; then
      set -- "$parent" "$3"
    else
      set -- --root "$3"
    fi
    g diff-tree -r --no-commit-id --name-status -z --no-renames --no-ext-diff --no-textconv \
      --ignore-submodules=none --relative "$@" -- . 2>/dev/null
    ;;
  *) exit 24 ;;
esac
`

func shellArgument(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

type gitOutput struct {
	buffer bytes.Buffer
	limit  int
	cancel context.CancelFunc
	large  bool
}

func (w *gitOutput) Bytes() []byte { return w.buffer.Bytes() }

func (w *gitOutput) Write(p []byte) (int, error) {
	length := len(p)
	remaining := w.limit - w.buffer.Len()
	if len(p) > remaining {
		p = p[:remaining]
		w.large = true
		w.cancel()
	}
	_, _ = w.buffer.Write(p)
	return length, nil
}

type GitReader struct {
	Remote func(context.Context, string, string, io.Writer) error
}

func runGit(parent context.Context, target, root, operation, rel string, limit int) ([]byte, error) {
	return (GitReader{}).run(parent, target, root, operation, rel, limit)
}

func (g GitReader) run(parent context.Context, target, root, operation, rel string, limit int) ([]byte, error) {
	var err error
	if target == "" {
		root, rel, err = validateLocalRequest(target, root, rel)
	} else {
		root, rel, err = validateRequest(target, root, rel)
	}
	if err != nil {
		return nil, err
	}
	if target != "" && g.Remote == nil {
		return nil, sshvault.ErrMissing
	}
	ctx, cancel := context.WithTimeout(parent, GitTimeout)
	defer cancel()
	args := []string{"-c", gitScript, "artiface-git", root, operation, rel}
	cmd := exec.CommandContext(ctx, "sh", args...)
	remoteCommand := ""
	if target != "" {
		// The remote timeout bounds work even if the SSH channel disconnects.
		remote := []string{"timeout", "-k", "1", "8", "sh"}
		remote = append(remote, args...)
		for i := range remote {
			remote[i] = shellArgument(remote[i])
		}
		remoteCommand = strings.Join(remote, " ")
	}
	prepareProcess(cmd)
	cmd.Cancel = func() error { killProcess(cmd); return nil }
	cmd.WaitDelay = time.Second
	output := &gitOutput{limit: limit, cancel: cancel}
	cmd.Stdout, cmd.Stderr = output, io.Discard
	if target != "" && g.Remote != nil {
		err = g.Remote(ctx, target, remoteCommand, output)
	} else {
		err = cmd.Run()
	}
	if parent.Err() != nil {
		return nil, parent.Err()
	}
	if output.large || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return output.Bytes(), ErrGitLimit
	}
	var exit *exec.ExitError
	var remoteExit *ssh.ExitError
	exitCode := 0
	if errors.As(err, &exit) {
		exitCode = exit.ExitCode()
	} else if errors.As(err, &remoteExit) {
		exitCode = remoteExit.ExitStatus()
	}
	if exitCode != 0 {
		switch exitCode {
		case 20:
			return nil, ErrGitNotRepo
		case 21:
			return nil, ErrGitFilters
		case 25:
			return nil, ErrGitFileSize
		case 26:
			return nil, ErrGitCommit
		case 124, 137:
			return nil, ErrGitLimit
		}
	}
	if err != nil {
		return nil, errors.Join(ErrGitUnavailable, err)
	}
	return output.Bytes(), nil
}

func ReadGitStatus(ctx context.Context, target, root string) (GitStatus, error) {
	return (GitReader{}).Status(ctx, target, root)
}

func (g GitReader) Status(ctx context.Context, target, root string) (GitStatus, error) {
	data, err := g.run(ctx, target, root, "status", "", 512<<10)
	if err != nil {
		return GitStatus{}, err
	}
	return parseGitStatus(data)
}

func parseGitStatus(data []byte) (GitStatus, error) {
	prefixBytes, attributes, ok := bytes.Cut(data, []byte{0})
	if !ok {
		return GitStatus{}, ErrGitUnavailable
	}
	status, err := afterGitAttributes(attributes)
	if err != nil {
		return GitStatus{}, err
	}
	records := bytes.Split(status, []byte{0})
	prefix := string(prefixBytes)
	result := GitStatus{Changes: []GitChange{}}
	for i := 0; i < len(records); i++ {
		record := string(records[i])
		if strings.HasPrefix(record, "# branch.head ") {
			result.Branch = strings.TrimPrefix(record, "# branch.head ")
			continue
		}
		if record == "" || strings.HasPrefix(record, "#") {
			continue
		}
		var filename, index, worktree string
		switch record[0] {
		case '?':
			if !strings.HasPrefix(record, "? ") {
				return GitStatus{}, ErrGitUnavailable
			}
			filename, index, worktree = record[2:], "?", "?"
		case '1', '2', 'u':
			count := 9
			if record[0] == '2' {
				count = 10
				i++ // Original rename path is outside the displayed status.
			} else if record[0] == 'u' {
				count = 11
			}
			fields := strings.SplitN(record, " ", count)
			if len(fields) != count || len(fields[1]) != 2 {
				return GitStatus{}, ErrGitUnavailable
			}
			filename, index, worktree = fields[count-1], fields[1][:1], fields[1][1:]
		default:
			continue
		}
		if !strings.HasPrefix(filename, prefix) {
			continue
		}
		relative := strings.TrimPrefix(filename, prefix)
		normalized, err := ValidateRelative(relative)
		if err != nil || normalized == "" {
			continue
		}
		result.Changes = append(result.Changes, GitChange{Path: normalized, Index: index, Worktree: worktree, Directory: strings.HasSuffix(relative, "/")})
		if len(result.Changes) > MaxGitChanges {
			return GitStatus{}, ErrGitLimit
		}
	}
	return result, nil
}

// Unknown filter drivers must not silently produce incorrect status for LFS or
// other filtered files when global configuration is intentionally excluded.
func afterGitAttributes(data []byte) ([]byte, error) {
	for {
		filename, rest, ok := bytes.Cut(data, []byte{0})
		if !ok {
			return nil, ErrGitUnavailable
		}
		if len(filename) == 0 {
			return rest, nil
		}
		attribute, rest, ok := bytes.Cut(rest, []byte{0})
		if !ok || string(attribute) != "filter" {
			return nil, ErrGitUnavailable
		}
		value, rest, ok := bytes.Cut(rest, []byte{0})
		if !ok {
			return nil, ErrGitUnavailable
		}
		if string(value) != "unspecified" && string(value) != "unset" {
			return nil, ErrGitFilters
		}
		data = rest
	}
}

func ReadGitDiff(ctx context.Context, target, root, rel string) (string, bool, error) {
	return (GitReader{}).Diff(ctx, target, root, rel)
}

func (g GitReader) Diff(ctx context.Context, target, root, rel string) (string, bool, error) {
	if rel == "" {
		return "", false, ErrForbidden
	}
	data, err := g.run(ctx, target, root, "diff", rel, MaxGitPatch)
	truncated := errors.Is(err, ErrGitLimit) && len(data) > 0
	if truncated {
		// End at a complete line; the UI explicitly identifies a partial diff.
		if end := bytes.LastIndexByte(data, '\n'); end >= 0 {
			data = data[:end+1]
		}
		err = nil
	}
	if err != nil {
		return "", false, err
	}
	data, err = afterGitAttributes(data)
	if err != nil {
		return "", false, err
	}
	lines := 0
	for i, b := range data {
		if b == '\n' {
			lines++
			if lines == 2000 && i+1 < len(data) {
				data, truncated = data[:i+1], true
				break
			}
		}
	}
	return strings.ToValidUTF8(string(data), "\uFFFD"), truncated, err
}
