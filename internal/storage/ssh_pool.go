package storage

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"time"

	"github.com/pkg/sftp"
)

// Only a completed lease can return a transport.
// A parent cancellation with fs.ErrClosed cannot be mistaken for this cause.
var errConnectionReturned = fmt.Errorf("SSH operation complete: %w", fs.ErrClosed)

type sshTransport struct {
	target     string
	reuseUntil time.Time
	expires    time.Time
	wire       io.ReadWriteCloser
	client     *sftp.Client
	reader     *listingReader
	dead       chan struct{}
}

func (t *sshTransport) reusable(reserve time.Duration) bool {
	select {
	case <-t.dead:
		return false
	default:
		now := time.Now()
		return now.Before(t.reuseUntil) && now.Before(t.expires) &&
			!now.Add(reserve).After(t.expires)
	}
}

// checkout transfers exclusive ownership, or reserves a slot before dialing.
// Slots count every live transport, including idle and closing transports.
func (s *SSH) checkout(c *connection, target string, reserve time.Duration) (bool, error) {
	for {
		s.mu.Lock()
		if err := context.Cause(c.ctx); err != nil {
			s.mu.Unlock()
			return false, fmt.Errorf("storage: waiting for SSH connection: %w", err)
		}
		select {
		case <-s.shutdown:
			s.mu.Unlock()
			return false, fmt.Errorf("storage: %w", fs.ErrClosed)
		default:
		}
		var victim *sshTransport
		for transport, timer := range s.idle {
			victim = transport
			if transport.target == target {
				delete(s.idle, transport)
				timer.Stop()
				if !transport.reusable(reserve) {
					break
				}
				c.sshTransport = transport
				s.active[c] = struct{}{}
				s.mu.Unlock()
				return true, nil
			}
		}
		// An unusable matching transport was removed above.
		if victim != nil && s.idle[victim] == nil {
			s.mu.Unlock()
			s.discardIdle(victim)
			continue
		}
		select {
		case s.slots <- struct{}{}:
			now := time.Now()
			c.sshTransport = &sshTransport{
				target: target, reuseUntil: now.Add(defaultReuseWindow),
				expires: now.Add(s.transportLifetime), dead: make(chan struct{}),
			}
			s.active[c] = struct{}{}
			s.wg.Add(1)
			s.mu.Unlock()
			return false, nil
		default:
		}
		// An idle connection to another target must not block a full pool.
		if victim != nil {
			s.idle[victim].Stop()
			delete(s.idle, victim)
			s.mu.Unlock()
			s.discardIdle(victim)
			continue
		}
		available := s.available
		s.mu.Unlock()
		select {
		case <-available:
		case <-c.ctx.Done():
		case <-s.shutdown:
		}
	}
}

// notify is called with mu held after returning a transport or freeing a slot.
func (s *SSH) notify() {
	close(s.available)
	s.available = make(chan struct{})
}

func (s *SSH) park(c *connection) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.shutdown:
		return false
	default:
	}
	if s.idleTimeout <= 0 || c.hadError.Load() || c.failed.Load() ||
		c.reader.failure() != nil || !c.reusable(0) {
		return false
	}
	transport := c.sshTransport
	var timer *time.Timer
	timer = time.AfterFunc(min(s.idleTimeout, time.Until(transport.reuseUntil), time.Until(transport.expires)), func() {
		s.mu.Lock()
		// A stopped timer may already be running after another checkout.
		if s.idle[transport] != timer {
			s.mu.Unlock()
			return
		}
		delete(s.idle, transport)
		s.mu.Unlock()
		s.discardIdle(transport)
	})
	delete(s.active, c)
	s.idle[transport] = timer
	close(c.done)
	s.notify()
	return true
}

// The caller has already removed the idle entry under mu, so no lease can
// acquire it while its process is closed and reaped.
func (s *SSH) discardIdle(transport *sshTransport) {
	_ = transport.wire.Close()
	_ = transport.client.Close()
	s.mu.Lock()
	<-s.slots
	s.notify()
	s.mu.Unlock()
	s.wg.Done()
}
