package storage

import (
	"context"
	"errors"
	"path"
)

var ErrUnsupported = errors.New("storage: folder browsing is unavailable")

// FolderBrowser exposes machine navigation for choosing new project roots.
// BrowseFolders is setup-only metadata access outside configured project roots.
// An empty directory selects home; entries contain absolute directory paths.
type FolderBrowser interface {
	BrowseFolders(ctx context.Context, target, directory string) (FolderListing, error)
}

type FolderListing struct {
	Path    string  `json:"path"`
	Parent  *string `json:"parent"`
	Home    string  `json:"home"`
	Entries []Entry `json:"entries"`
}

func folderListing(directory, home string, entries []Entry) FolderListing {
	result := FolderListing{Path: directory, Home: home, Entries: entries}
	if result.Entries == nil {
		result.Entries = []Entry{}
	}
	if directory != "/" {
		parent := path.Dir(directory)
		result.Parent = &parent
	}
	return result
}
