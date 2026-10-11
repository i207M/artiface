package storage

import (
	"context"
	"errors"
	"io"
)

// Dispatch uses local storage only for the empty target, which SSH config forbids.
type Dispatch struct {
	Local Store
	SSH   Store
}

func New() *Dispatch {
	return &Dispatch{Local: NewLocal(), SSH: NewSSH()}
}

// NewWithSSH uses a credential-backed dialer without reading ~/.ssh at runtime.
func NewWithSSH(dial func(context.Context, string) (io.ReadWriteCloser, error)) *Dispatch {
	remote := NewSSH()
	if dial != nil {
		remote.dial = dial
	}
	return &Dispatch{Local: NewLocal(), SSH: remote}
}

func (s *Dispatch) source(target string) Store {
	if target == "" {
		return s.Local
	}
	return s.SSH
}

func (s *Dispatch) List(ctx context.Context, target, root, rel string) ([]Entry, error) {
	return s.source(target).List(ctx, target, root, rel)
}

func (s *Dispatch) beginListing(ctx context.Context, target, root string) (listingSession, error) {
	if source, ok := s.source(target).(listingSessionStore); ok {
		return source.beginListing(ctx, target, root)
	}
	return nil, nil
}

func (s *Dispatch) Open(ctx context.Context, target, root, rel string) (File, error) {
	return s.source(target).Open(ctx, target, root, rel)
}

func (s *Dispatch) OpenScoped(ctx context.Context, target, root, scope, rel string) (File, error) {
	if scoped, ok := s.source(target).(ScopedStore); ok {
		return scoped.OpenScoped(ctx, target, root, scope, rel)
	}
	// A fallback using a derived root would silently weaken containment.
	return nil, ErrUnsupported
}

func (s *Dispatch) Resolve(ctx context.Context, target, root, rel string) (string, error) {
	if resolver, ok := s.source(target).(Resolver); ok {
		return resolver.Resolve(ctx, target, root, rel)
	}
	return "", ErrUnsupported
}

func (s *Dispatch) BrowseFolders(ctx context.Context, target, directory string) (FolderListing, error) {
	if browser, ok := s.source(target).(FolderBrowser); ok {
		return browser.BrowseFolders(ctx, target, directory)
	}
	return FolderListing{}, ErrUnsupported
}

func (s *Dispatch) Close() error {
	return errors.Join(s.Local.Close(), s.SSH.Close())
}
