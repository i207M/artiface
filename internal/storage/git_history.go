package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

const GitHistoryPageSize = 100

type GitCommit struct {
	Hash    string   `json:"hash"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	Date    string   `json:"date"`
	Message string   `json:"message"`
	Refs    []string `json:"refs"`
}

type GitHistory struct {
	Commits  []GitCommit `json:"commits"`
	Revision string      `json:"revision"`
	HasMore  bool        `json:"hasMore"`
	Scoped   bool        `json:"scoped"`
	Head     string      `json:"head"`
}

func ReadGitHistory(ctx context.Context, target, root string, offset int) (GitHistory, error) {
	return (GitReader{}).History(ctx, target, root, offset)
}

func (g GitReader) History(ctx context.Context, target, root string, offset int) (GitHistory, error) {
	if offset < 0 || offset > 100000 {
		return GitHistory{}, ErrForbidden
	}
	data, err := g.run(ctx, target, root, "history", strconv.Itoa(offset), 2<<20)
	if err != nil {
		return GitHistory{}, err
	}
	return parseGitHistory(data)
}

func gitObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func parseGitHistory(data []byte) (GitHistory, error) {
	// The ref snapshot also anchors pagination: callers reject a changed revision
	// rather than joining pages from different branch tips.
	fields := bytes.SplitN(data, []byte{0}, 5)
	if len(fields) != 5 {
		return GitHistory{}, ErrGitUnavailable
	}
	revision := sha256.Sum256(bytes.Join(fields[:4], []byte{0}))
	result := GitHistory{
		Commits: []GitCommit{}, Revision: hex.EncodeToString(revision[:]),
		Scoped: len(fields[0]) > 0, Head: string(fields[1]),
	}
	if result.Head != "" && !gitObjectID(result.Head) {
		return GitHistory{}, ErrGitUnavailable
	}
	refs := make(map[string][]string)
	branch := string(fields[2])
	for _, line := range strings.Split(string(fields[3]), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, " ", 3)
		if len(parts) != 3 || !gitObjectID(parts[0]) || (parts[1] != "" && !gitObjectID(parts[1])) {
			return GitHistory{}, ErrGitUnavailable
		}
		hash := parts[0]
		if parts[1] != "" {
			hash = parts[1] // Annotated tags decorate the commit they point at.
		}
		name := parts[2]
		switch {
		case strings.HasPrefix(name, "refs/heads/"):
			name = strings.TrimPrefix(name, "refs/heads/")
		case strings.HasPrefix(name, "refs/remotes/"):
			name = strings.TrimPrefix(name, "refs/remotes/")
		case strings.HasPrefix(name, "refs/tags/"):
			name = "tag: " + strings.TrimPrefix(name, "refs/tags/")
		default:
			continue
		}
		if parts[2] == branch && hash == result.Head {
			name = "HEAD → " + name
		}
		refs[hash] = append(refs[hash], strings.ToValidUTF8(name, "\uFFFD"))
	}
	if branch == "" && result.Head != "" {
		refs[result.Head] = append([]string{"HEAD"}, refs[result.Head]...)
	}
	records := bytes.Split(bytes.TrimSuffix(fields[4], []byte{0}), []byte{0})
	if len(fields[4]) == 0 {
		return result, nil
	}
	if len(records)%6 != 0 {
		return GitHistory{}, ErrGitUnavailable
	}
	for i := 0; i < len(records); i += 6 {
		hash := string(records[i])
		parents := strings.Fields(string(records[i+1]))
		if !gitObjectID(hash) {
			return GitHistory{}, ErrGitUnavailable
		}
		for _, parent := range parents {
			if !gitObjectID(parent) {
				return GitHistory{}, ErrGitUnavailable
			}
		}
		if len(result.Commits) == GitHistoryPageSize {
			result.HasMore = true
			break
		}
		result.Commits = append(result.Commits, GitCommit{
			Hash: hash, Parents: parents,
			Author: strings.ToValidUTF8(string(records[i+2]), "\uFFFD"),
			Email:  strings.ToValidUTF8(string(records[i+3]), "\uFFFD"),
			Date:   string(records[i+4]), Message: strings.ToValidUTF8(string(records[i+5]), "\uFFFD"),
			Refs: append([]string{}, refs[hash]...),
		})
	}
	return result, nil
}
