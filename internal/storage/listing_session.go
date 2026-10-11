package storage

import (
	"context"
	"errors"
)

type directoryLister interface {
	List(context.Context, string, string, string) ([]Entry, error)
}

// A listingSession belongs to one recursive request and is used sequentially
// under the context that opened it. It cannot open file contents.
type listingSession interface {
	directoryLister
	Resolver
	Close() error
}

type listingSessionStore interface {
	beginListing(context.Context, string, string) (listingSession, error)
}

var errListingSessionEnded = errors.New("storage: listing connection ended")

type sshListingSession struct {
	conn                    *connection
	target, root, canonical string
}

func (s *SSH) beginListing(ctx context.Context, target, root string) (listingSession, error) {
	root, _, err := validateRequest(target, root, "")
	if err != nil {
		return nil, err
	}
	c, err := s.connect(ctx, target, 0)
	if err != nil {
		return nil, err
	}
	canonical, _, err := c.resolveRoot(root)
	if err != nil {
		c.close()
		return nil, err
	}
	return &sshListingSession{conn: c, target: target, root: root, canonical: canonical}, nil
}

func (s *sshListingSession) Close() error {
	s.conn.release()
	return nil
}

func (s *sshListingSession) request(ctx context.Context, target, root, rel string) (string, error) {
	if err := ctx.Err(); err != nil {
		s.conn.hadError.Store(true)
		return "", err
	}
	if err := s.result(nil); err != nil {
		return "", err
	}
	root, rel, err := validateRequest(target, root, rel)
	if err != nil {
		s.conn.hadError.Store(true)
		return "", err
	}
	if target != s.target || root != s.root {
		s.conn.hadError.Store(true)
		return "", ErrForbidden
	}
	return rel, nil
}

func (s *sshListingSession) Resolve(ctx context.Context, target, root, rel string) (string, error) {
	rel, err := s.request(ctx, target, root, rel)
	if err != nil {
		return "", err
	}
	resolved, err := s.conn.resolve(s.canonical, s.root, rel)
	return resolved, s.result(err)
}

func (s *sshListingSession) List(ctx context.Context, target, root, rel string) ([]Entry, error) {
	rel, err := s.request(ctx, target, root, rel)
	if err != nil {
		return nil, err
	}
	entries, err := s.conn.list(s.canonical, s.root, rel)
	if err = s.result(err); err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *sshListingSession) result(err error) error {
	if err != nil {
		s.conn.hadError.Store(true)
	}
	failure := context.Cause(s.conn.ctx)
	if failure == nil {
		failure = s.conn.reader.failure()
	}
	if failure == nil && errors.Is(err, ErrTooLarge) {
		failure = ErrTooLarge
	}
	if failure != nil || s.conn.failed.Load() {
		// A dead reader cannot recover on the next directory. Release its slot
		// and distinguish this from skippable missing/denied subdirectories.
		s.conn.close()
		return errors.Join(errListingSessionEnded, failure)
	}
	return err
}
