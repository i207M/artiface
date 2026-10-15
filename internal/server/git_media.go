package server

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"path"
	"strings"

	"artiface/internal/storage"
)

// Media is returned as JSON bytes, never as executable same-origin content.
// SVGs are displayed only as images; PDFs are rendered by the client PDF reader.
func gitMediaType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	case ".svg":
		return "image/svg+xml"
	case ".pdf":
		return "application/pdf"
	}
	return ""
}

func (a *App) gitWorkingFile(ctx context.Context, source gitSource, rel string) (*storage.GitFileVersion, error) {
	file, err := a.store.Open(ctx, source.target, source.root, rel)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, storage.ErrForbidden
	}
	if info.Size() > storage.MaxGitDiffFile {
		return nil, storage.ErrGitFileSize
	}
	data, err := io.ReadAll(io.LimitReader(file, storage.MaxGitDiffFile+1))
	if err != nil {
		return nil, err
	}
	if len(data) > storage.MaxGitDiffFile {
		return nil, storage.ErrGitFileSize
	}
	return &storage.GitFileVersion{Data: data}, nil
}
