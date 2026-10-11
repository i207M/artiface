//go:build !unix

package storage

import (
	"context"
	"os"
)

type localRoot struct{}

func openLocalRoot(context.Context, string) (*localRoot, error) {
	return nil, ErrUnsupported
}

func (*localRoot) Close() error { return nil }

func (*localRoot) walk(context.Context, string, pathKind, *os.File) (*os.File, string, error) {
	return nil, "", ErrUnsupported
}

// Fail closed on platforms without the descriptor and nonblocking primitives.
func openLocalPath(context.Context, string, string, bool) (*os.File, error) {
	return nil, ErrUnsupported
}
