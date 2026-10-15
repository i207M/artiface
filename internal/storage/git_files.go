package storage

import (
	"bytes"
	"context"
	"strconv"
	"strings"
)

type GitFileVersion struct {
	Data        []byte `json:"data,omitempty"`
	Unsupported bool   `json:"unsupported,omitempty"`
}

type GitFileVersions struct {
	Before *GitFileVersion `json:"before"`
	After  *GitFileVersion `json:"after"`
}

func ReadGitDiffFiles(ctx context.Context, target, root, rel, commit string) (GitFileVersions, error) {
	return (GitReader{}).DiffFiles(ctx, target, root, rel, commit)
}

// A blank commit reads only HEAD. The caller supplies the working-tree version
// through the contained storage reader, never through the Git shell command.
func (g GitReader) DiffFiles(ctx context.Context, target, root, rel, commit string) (GitFileVersions, error) {
	if rel == "" || (commit != "" && !gitObjectID(commit)) {
		return GitFileVersions{}, ErrForbidden
	}
	data, err := g.run(ctx, target, root, "diff-files", rel, 2*MaxGitDiffFile+256, strings.ToLower(commit))
	if err != nil {
		return GitFileVersions{}, err
	}
	var result GitFileVersions
	for _, version := range []**GitFileVersion{&result.Before, &result.After} {
		header, rest, ok := bytes.Cut(data, []byte{0})
		if !ok {
			return GitFileVersions{}, ErrGitUnavailable
		}
		kind, length, ok := strings.Cut(string(header), " ")
		size, err := strconv.Atoi(length)
		if !ok || err != nil || size < 0 || size > MaxGitDiffFile || size > len(rest) {
			return GitFileVersions{}, ErrGitUnavailable
		}
		switch kind {
		case "file":
			*version = &GitFileVersion{Data: rest[:size]}
		case "unsupported", "missing":
			if size != 0 {
				return GitFileVersions{}, ErrGitUnavailable
			}
			if kind == "unsupported" {
				*version = &GitFileVersion{Unsupported: true}
			}
		default:
			return GitFileVersions{}, ErrGitUnavailable
		}
		data = rest[size:]
	}
	if len(data) != 0 {
		return GitFileVersions{}, ErrGitUnavailable
	}
	return result, nil
}
