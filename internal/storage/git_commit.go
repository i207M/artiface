package storage

import (
	"bytes"
	"context"
	"errors"
	"strings"
)

var ErrGitCommit = errors.New("commit not found in this project")

type GitCommitFile struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type GitCommitDetails struct {
	Hash           string          `json:"hash"`
	Parents        []string        `json:"parents"`
	Author         string          `json:"author"`
	Email          string          `json:"email"`
	Date           string          `json:"date"`
	Committer      string          `json:"committer"`
	CommitterEmail string          `json:"committerEmail"`
	CommitDate     string          `json:"commitDate"`
	Message        string          `json:"message"`
	Files          []GitCommitFile `json:"files"`
	Truncated      bool            `json:"truncated"`
}

func ReadGitCommit(ctx context.Context, target, root, hash string) (GitCommitDetails, error) {
	return (GitReader{}).Commit(ctx, target, root, hash)
}

func (g GitReader) Commit(ctx context.Context, target, root, hash string) (GitCommitDetails, error) {
	if !gitObjectID(hash) {
		return GitCommitDetails{}, ErrForbidden
	}
	hash = strings.ToLower(hash)
	data, err := g.run(ctx, target, root, "commit", hash, 2<<20)
	if err != nil {
		return GitCommitDetails{}, err
	}
	fields := bytes.SplitN(data, []byte{0}, 10)
	if len(fields) != 10 || string(fields[0]) != hash {
		return GitCommitDetails{}, ErrGitUnavailable
	}
	text := func(index int) string { return strings.ToValidUTF8(string(fields[index]), "\uFFFD") }
	result := GitCommitDetails{
		Hash: hash, Parents: strings.Fields(text(1)), Author: text(2), Email: text(3), Date: text(4),
		Committer: text(5), CommitterEmail: text(6), CommitDate: text(7), Message: text(8),
		Files: []GitCommitFile{},
	}
	for _, parent := range result.Parents {
		if !gitObjectID(parent) {
			return GitCommitDetails{}, ErrGitUnavailable
		}
	}
	if len(fields[9]) == 0 {
		return result, nil
	}
	records := bytes.Split(bytes.TrimSuffix(fields[9], []byte{0}), []byte{0})
	if len(records)%2 != 0 {
		return GitCommitDetails{}, ErrGitUnavailable
	}
	for i := 0; i < len(records); i += 2 {
		status := string(records[i])
		if len(status) != 1 || !strings.Contains("ADMT", status) {
			return GitCommitDetails{}, ErrGitUnavailable
		}
		name, err := ValidateRelative(string(records[i+1]))
		if err != nil || name == "" {
			result.Truncated = true
			continue
		}
		if len(result.Files) == MaxGitChanges {
			result.Truncated = true
			break
		}
		result.Files = append(result.Files, GitCommitFile{Path: name, Status: status})
	}
	return result, nil
}
