package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"artiface/internal/sshvault"

	"github.com/pkg/sftp"
)

const (
	maxConnections           = 8
	maxDirectoryEntries      = 10_000
	defaultOperationTimeout  = 30 * time.Second
	defaultFileLifetime      = 5 * time.Minute
	defaultIdleTimeout       = time.Minute
	defaultReuseWindow       = 5 * time.Minute
	defaultTransportLifetime = defaultReuseWindow + defaultFileLifetime
	readPacketBytes          = 32 << 10
	maxReadRequests          = 4
	maxReadBytes             = maxReadRequests * readPacketBytes
)

type dialFunc func(context.Context, string) (io.ReadWriteCloser, error)

// SSH exclusively leases credential-backed SSH/SFTP connections to operations.
// At most eight connections exist, including idle ones.
// Idle connections expire after one minute and accept new leases for five minutes.
// Transports retire on return after that window and live at most ten minutes.
// Waiting and setup take at most 30s.
// Files retain their lease until Close, request cancellation, store Close,
// or their full five-minute lifetime limit.
// File checkout reserves that lifetime plus the initial operation timeout.
// Individual file operations also have a 30s timeout.
// NewSSH must be used to initialize an SSH store.
type SSH struct {
	mu        sync.Mutex
	active    map[*connection]struct{}
	idle      map[*sshTransport]*time.Timer
	available chan struct{}
	slots     chan struct{}
	shutdown  chan struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup

	dial              dialFunc
	operationTimeout  time.Duration
	fileLifetime      time.Duration
	idleTimeout       time.Duration
	transportLifetime time.Duration
	maxEntries        int
}

var _ Store = (*SSH)(nil)

func NewSSH() *SSH {
	return &SSH{
		active:            make(map[*connection]struct{}),
		idle:              make(map[*sshTransport]*time.Timer),
		available:         make(chan struct{}),
		slots:             make(chan struct{}, maxConnections),
		shutdown:          make(chan struct{}),
		dial:              func(context.Context, string) (io.ReadWriteCloser, error) { return nil, sshvault.ErrMissing },
		operationTimeout:  defaultOperationTimeout,
		fileLifetime:      defaultFileLifetime,
		idleTimeout:       defaultIdleTimeout,
		transportLifetime: defaultTransportLifetime,
		maxEntries:        maxDirectoryEntries,
	}
}

// Close cancels active operations and files, reaps subprocesses, and prevents
// new connections.
// It is safe to call concurrently and more than once.
func (s *SSH) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		close(s.shutdown)
		for c := range s.active {
			c.cancel(fs.ErrClosed)
		}
		idle := make([]*sshTransport, 0, len(s.idle))
		for transport, timer := range s.idle {
			timer.Stop()
			delete(s.idle, transport)
			idle = append(idle, transport)
		}
		s.mu.Unlock()
		for _, transport := range idle {
			s.discardIdle(transport)
		}
		s.wg.Wait()
	})
	return nil
}

// List returns entries with project-relative paths, sorted by name.
// Listings are limited to 10,000 entries and 16 MiB of SFTP responses.
// Contained symlinks expose their resolved type and retain a symlink marker.
func (s *SSH) List(ctx context.Context, target, root, rel string) ([]Entry, error) {
	root, rel, err := validateRequest(target, root, rel)
	if err != nil {
		return nil, err
	}
	c, err := s.connect(ctx, target, 0)
	if err != nil {
		return nil, err
	}
	defer c.close()

	canonical, _, err := c.resolveRoot(root)
	if err != nil {
		return nil, err
	}
	entries, err := c.list(canonical, root, rel)
	if err == nil {
		c.release()
	}
	return entries, err
}

func (c *connection) list(canonical, root, rel string) ([]Entry, error) {
	full, info, err := c.resolveWithin(canonical, root, rel)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%w: listing requires a directory", ErrForbidden)
	}
	base, _ := beneath(canonical, full)
	c.reader.limit(c.store.maxEntries)
	infos, err := c.client.ReadDirContext(c.ctx, full)
	c.reader.endDirectory()
	if err != nil {
		return nil, c.operationError("list directory", err)
	}
	if len(infos) > c.store.maxEntries {
		return nil, ErrTooLarge
	}
	entries := make([]Entry, 0, len(infos))
	for _, info := range infos {
		name := info.Name()
		if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) || !validPathText(name) {
			return nil, fmt.Errorf("%w: invalid directory entry", ErrForbidden)
		}
		symlink := info.Mode()&fs.ModeSymlink != 0
		var resolvedPath *string
		if symlink {
			resolvedFull, resolved, resolveErr := c.resolveWithin(canonical, root, path.Join(base, name))
			if c.ctx.Err() != nil {
				return nil, c.operationError("resolve directory entry", c.ctx.Err())
			}
			if failure := c.reader.failure(); failure != nil {
				return nil, failure
			}
			if c.failed.Load() {
				return nil, errListingSessionEnded
			}
			if resolveErr == nil {
				info = resolved
				resolvedRel, _ := beneath(canonical, resolvedFull)
				resolvedPath = &resolvedRel
			}
		} else if base != rel {
			resolvedRel := path.Join(base, name)
			resolvedPath = &resolvedRel
		}
		entries = append(entries, Entry{
			Name:         name,
			Path:         path.Join(rel, name),
			Type:         entryType(info.Mode()),
			Size:         info.Size(),
			Modified:     info.ModTime(),
			Symlink:      symlink,
			ResolvedPath: resolvedPath,
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	if err := context.Cause(c.ctx); err != nil {
		return nil, fmt.Errorf("storage: list directory: %w", err)
	}
	return entries, nil
}

// BrowseFolders permits the authenticated owner to choose a new project root.
// Home resolution is SFTP-only; no shell command or remote file read is needed.
func (s *SSH) BrowseFolders(ctx context.Context, target, directory string) (FolderListing, error) {
	if err := validateTarget(target); err != nil {
		return FolderListing{}, err
	}
	if directory != "" {
		if _, err := validateRoot(directory); err != nil {
			return FolderListing{}, err
		}
	}
	c, err := s.connect(ctx, target, 0)
	if err != nil {
		return FolderListing{}, err
	}
	defer c.close()
	home, err := c.client.RealPath(".")
	if err != nil {
		return FolderListing{}, c.operationError("resolve home directory", err)
	}
	if checked, err := validateRoot(home); err != nil || checked != home {
		return FolderListing{}, ErrForbidden
	}
	if directory == "" {
		directory = home
	}
	full, err := c.client.RealPath(directory)
	if err != nil {
		return FolderListing{}, c.operationError("resolve setup directory", err)
	}
	if checked, err := validateRoot(full); err != nil || checked != full {
		return FolderListing{}, ErrForbidden
	}
	info, err := c.client.Stat(full)
	if err != nil {
		return FolderListing{}, c.operationError("inspect setup directory", err)
	}
	if !info.IsDir() {
		return FolderListing{}, ErrForbidden
	}
	c.reader.limit(s.maxEntries)
	infos, err := c.client.ReadDirContext(c.ctx, full)
	if err != nil {
		return FolderListing{}, c.operationError("browse folders", err)
	}
	if len(infos) > s.maxEntries {
		return FolderListing{}, ErrTooLarge
	}
	c.reader.endDirectory()
	entries := []Entry{}
	for _, info := range infos {
		if err := c.ctx.Err(); err != nil {
			return FolderListing{}, c.operationError("browse folders", err)
		}
		name := info.Name()
		if !validEntryName(name) {
			return FolderListing{}, ErrForbidden
		}
		entryPath := path.Join(full, name)
		symlink := info.Mode()&fs.ModeSymlink != 0
		if symlink {
			info, err = c.client.Stat(entryPath)
			if err != nil {
				c.hadError.Store(true)
				continue
			}
		}
		if info.IsDir() {
			entries = append(entries, Entry{Name: name, Path: entryPath, Type: "directory",
				Size: info.Size(), Modified: info.ModTime(), Symlink: symlink})
		}
	}
	if err := c.ctx.Err(); err != nil {
		return FolderListing{}, c.operationError("browse folders", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	c.release()
	return folderListing(full, home, entries), nil
}

func (s *SSH) Open(ctx context.Context, target, root, rel string) (File, error) {
	return s.open(ctx, target, root, rel, nil)
}

func (s *SSH) OpenScoped(ctx context.Context, target, root, scope, rel string) (File, error) {
	checked, err := ValidateRelative(scope)
	if err != nil {
		return nil, err
	}
	return s.open(ctx, target, root, rel, &checked)
}

func (s *SSH) Resolve(ctx context.Context, target, root, rel string) (string, error) {
	root, rel, err := validateRequest(target, root, rel)
	if err != nil {
		return "", err
	}
	c, err := s.connect(ctx, target, 0)
	if err != nil {
		return "", err
	}
	defer c.close()
	canonical, _, err := c.resolveRoot(root)
	if err != nil {
		return "", err
	}
	resolved, err := c.resolve(canonical, root, rel)
	if err == nil {
		c.release()
	}
	return resolved, err
}

func (c *connection) resolve(canonical, root, rel string) (string, error) {
	full, _, err := c.resolveWithin(canonical, root, rel)
	if err != nil {
		return "", err
	}
	resolved, _ := beneath(canonical, full)
	return resolved, c.operationError("resolve project path", c.ctx.Err())
}

func (s *SSH) open(ctx context.Context, target, root, rel string, scope *string) (File, error) {
	root, rel, err := validateRequest(target, root, rel)
	if err != nil {
		return nil, err
	}
	// Reserve the full file lifetime after even the slowest permitted setup.
	c, err := s.connect(ctx, target, s.fileLifetime+s.operationTimeout)
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			c.close()
		}
	}()

	canonical, _, err := c.resolveRoot(root)
	if err != nil {
		return nil, err
	}
	scopePath := canonical
	if scope != nil {
		var info fs.FileInfo
		scopePath, info, err = c.resolveWithin(canonical, root, *scope)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, ErrForbidden
		}
		scopeRel, _ := beneath(canonical, scopePath)
		rel = path.Join(scopeRel, rel)
	}
	full, info, err := c.resolveWithin(canonical, root, rel)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: only regular files can be opened", ErrForbidden)
	}
	if _, ok := beneath(scopePath, full); !ok {
		return nil, ErrForbidden
	}
	f, err := c.client.Open(full)
	if err != nil {
		return nil, c.operationError("open file", err)
	}
	// The handle and post-open path checks are independent.
	// Overlap them to avoid an extra SFTP round trip, but await both before
	// exposing the file or reading contents.
	var verified string
	var verifyErr error
	var verification sync.WaitGroup
	verification.Go(func() {
		// SFTP cannot make this atomic; remote OS permissions remain the boundary.
		verified, _, verifyErr = c.checkResolved(canonical, full)
	})
	info, err = f.Stat()
	if err != nil {
		err = c.operationError("stat opened file", err)
	} else if !info.Mode().IsRegular() {
		err = fmt.Errorf("%w: opened handle is not a regular file", ErrForbidden)
	}
	if err != nil {
		// Unblock path verification if inspecting the handle already failed.
		c.cancel(fs.ErrClosed)
	}
	verification.Wait()
	if err != nil {
		return nil, err
	}
	if verifyErr != nil {
		return nil, verifyErr
	}
	if _, ok := beneath(scopePath, verified); !ok || verified != full {
		return nil, ErrForbidden
	}
	if !c.setTimeout(s.fileLifetime) {
		return nil, c.operationError("open file", context.Canceled)
	}
	keep = true
	resolved, _ := beneath(canonical, full)
	return &sshFile{file: f, conn: c, resolved: resolved}, nil
}

func validateRequest(target, root, rel string) (string, string, error) {
	if err := validateTarget(target); err != nil {
		return "", "", err
	}
	root, err := validateRoot(root)
	if err != nil {
		return "", "", err
	}
	rel, err = ValidateRelative(rel)
	return root, rel, err
}

type connection struct {
	*sshTransport
	store  *SSH
	ctx    context.Context
	cancel context.CancelCauseFunc

	// Closing these channels publishes each immutable field to cleanup.
	wireReady   chan struct{}
	clientReady chan struct{}
	done        chan struct{}

	timerMu  sync.Mutex
	timer    *time.Timer
	failed   atomic.Bool
	hadError atomic.Bool
}

func (s *SSH) connect(parent context.Context, target string, reserve time.Duration) (*connection, error) {
	ctx, cancel := context.WithCancelCause(parent)
	deadline := time.Now().Add(s.operationTimeout)
	c := &connection{
		store: s, ctx: ctx, cancel: cancel,
		wireReady: make(chan struct{}), clientReady: make(chan struct{}), done: make(chan struct{}),
	}
	c.timer = time.AfterFunc(s.operationTimeout, func() { cancel(context.DeadlineExceeded) })
	registered := false
	defer func() {
		if !registered {
			c.timer.Stop()
			cancel(fs.ErrClosed)
		}
	}()
	reused, err := s.checkout(c, target, reserve)
	if err != nil {
		return nil, err
	}
	registered = true
	c.setTimeout(time.Until(deadline))
	go c.cleanup()

	if reused {
		close(c.wireReady)
		close(c.clientReady)
		c.reader.reset()
		if err := context.Cause(ctx); err != nil {
			c.close()
			return nil, fmt.Errorf("storage: connect SSH/SFTP: %w", err)
		}
		return c, nil
	}

	wire, err := s.dial(ctx, target)
	c.wire = wire
	close(c.wireReady)
	if err != nil {
		close(c.clientReady)
		err = c.operationError("connect SSH", err)
		c.close()
		return nil, err
	}
	c.reader = &listingReader{reader: wire}
	c.client, err = sftp.NewClientPipe(c.reader, wire,
		sftp.MaxPacketChecked(readPacketBytes), sftp.UseConcurrentReads(false))
	close(c.clientReady)
	if err != nil {
		err = c.operationError("connect SSH/SFTP (check alias, authentication, known_hosts, and subsystem)", err)
		c.close()
		return nil, err
	}
	transport := c.sshTransport
	go func() {
		_ = transport.client.Wait()
		close(transport.dead)
	}()
	if err := context.Cause(ctx); err != nil {
		c.close()
		return nil, fmt.Errorf("storage: connect SSH/SFTP: %w", err)
	}
	return c, nil
}

func (c *connection) cleanup() {
	<-c.ctx.Done()
	<-c.wireReady
	c.timerMu.Lock()
	c.timer.Stop()
	c.timerMu.Unlock()
	if context.Cause(c.ctx) == errConnectionReturned {
		<-c.clientReady
		if c.store.park(c) {
			return
		}
	}
	if c.wire != nil {
		// Close the raw transport first so blocked reads AND writes finish.
		_ = c.wire.Close()
	}
	<-c.clientReady
	if c.client != nil {
		_ = c.client.Close()
	}
	c.store.mu.Lock()
	delete(c.store.active, c)
	<-c.store.slots
	close(c.done)
	c.store.notify()
	c.store.mu.Unlock()
	c.store.wg.Done()
}

func (c *connection) release() {
	c.cancel(errConnectionReturned)
	<-c.done
}

func (c *connection) close() {
	c.cancel(fs.ErrClosed)
	<-c.done
}

func (c *connection) setTimeout(d time.Duration) bool {
	c.timerMu.Lock()
	defer c.timerMu.Unlock()
	if c.ctx.Err() != nil {
		return false
	}
	c.timer.Reset(min(d, time.Until(c.expires)))
	return true
}

func (c *connection) operationError(op string, err error) error {
	if err == nil {
		return nil
	}
	c.hadError.Store(true)
	// Record transport/protocol failure before sanitizing it; symlink resolution
	// may otherwise turn it into an ordinary unavailable-path error.
	if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, fs.ErrPermission) && !errors.Is(err, fs.ErrInvalid) {
		var status *sftp.StatusError
		if !errors.As(err, &status) || status.FxCode() == sftp.ErrSSHFxBadMessage ||
			status.FxCode() == sftp.ErrSSHFxNoConnection || status.FxCode() == sftp.ErrSSHFxConnectionLost {
			c.failed.Store(true)
		}
	}
	if cause := context.Cause(c.ctx); cause != nil {
		return fmt.Errorf("storage: %s: %w", op, cause)
	}
	if c.reader != nil {
		if failure := c.reader.failure(); failure != nil {
			return fmt.Errorf("storage: %s: %w", op, failure)
		}
	}
	// Do not expose SSH stderr or arbitrary server-provided status messages.
	// Preserve only useful, well-known error classifications.
	var hostKey *sshvault.HostKeyError
	if errors.As(err, &hostKey) {
		return fmt.Errorf("storage: %s: %w", op, hostKey)
	}
	for _, known := range []error{fs.ErrNotExist, fs.ErrClosed, fs.ErrInvalid, io.EOF, io.ErrUnexpectedEOF,
		sshvault.ErrHostKeyExpired, sshvault.ErrDisabled, sshvault.ErrLocked, sshvault.ErrMissing} {
		if errors.Is(err, known) {
			return fmt.Errorf("storage: %s: %w", op, known)
		}
	}
	if errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("storage: %s: %w: permission denied", op, ErrForbidden)
	}
	return fmt.Errorf("storage: %s: SSH/SFTP request failed", op)
}

type sshFile struct {
	// Serialize offset operations while a batch reads independent packet ranges.
	mu        sync.Mutex
	file      *sftp.File
	conn      *connection
	resolved  string
	closed    atomic.Bool
	closeOnce sync.Once
}

var _ File = (*sshFile)(nil)

func (f *sshFile) ResolvedPath() string { return f.resolved }

func (f *sshFile) begin() (func(), error) {
	if err := context.Cause(f.conn.ctx); err != nil {
		return nil, fmt.Errorf("storage: file: %w", err)
	}
	if f.closed.Load() {
		return nil, fs.ErrClosed
	}
	timer := time.AfterFunc(f.conn.store.operationTimeout, func() { f.conn.cancel(context.DeadlineExceeded) })
	return func() { timer.Stop() }, nil
}

func (f *sshFile) Read(p []byte) (int, error) {
	stop, err := f.begin()
	if err != nil {
		return 0, err
	}
	defer stop()
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := context.Cause(f.conn.ctx); err != nil {
		return 0, err
	}
	n, err := f.readBatch(p)
	if err == io.EOF && f.conn.ctx.Err() == nil {
		// io.Reader requires the literal EOF value, including for io.Copy.
		return n, io.EOF
	}
	return n, f.conn.operationError("read file", err)
}

// Caller holds mu so Read/Seek cannot change the offset before the batch finishes.
func (f *sshFile) readBatch(p []byte) (int, error) {
	if len(p) <= readPacketBytes {
		return f.file.Read(p)
	}
	p = p[:min(len(p), maxReadBytes)]
	offset, err := f.file.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	var results [maxReadRequests]struct {
		n   int
		err error
	}
	count := (len(p) + readPacketBytes - 1) / readPacketBytes
	var group sync.WaitGroup
	for i := range count {
		group.Go(func() {
			start := i * readPacketBytes
			// Single-packet ReadAt retries short DATA replies until full or EOF.
			results[i].n, results[i].err = f.file.ReadAt(
				p[start:min(start+readPacketBytes, len(p))], offset+int64(start))
		})
	}
	group.Wait()
	n := 0
	for _, result := range results[:count] {
		n += result.n
		if result.err != nil {
			err = result.err
			break
		}
	}
	// Only the contiguous prefix is consumed, even if later packets succeeded.
	if _, seekErr := f.file.Seek(int64(n), io.SeekCurrent); err == nil {
		err = seekErr
	}
	return n, err
}

func (f *sshFile) Seek(offset int64, whence int) (int64, error) {
	stop, err := f.begin()
	if err != nil {
		return 0, err
	}
	defer stop()
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := context.Cause(f.conn.ctx); err != nil {
		return 0, err
	}
	n, err := f.file.Seek(offset, whence)
	return n, f.conn.operationError("seek file", err)
}

func (f *sshFile) Stat() (fs.FileInfo, error) {
	stop, err := f.begin()
	if err != nil {
		return nil, err
	}
	defer stop()
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := context.Cause(f.conn.ctx); err != nil {
		return nil, err
	}
	info, err := f.file.Stat()
	return info, f.conn.operationError("stat file", err)
}

func (f *sshFile) Close() error {
	f.closeOnce.Do(func() {
		f.closed.Store(true)
		// Closing during an operation must abort its blocked reads and writes.
		if !f.mu.TryLock() {
			f.conn.close()
			return
		}
		defer f.mu.Unlock()
		defer f.conn.close()
		if f.conn.ctx.Err() != nil || f.conn.hadError.Load() {
			return
		}
		// A successful CLOSE leaves no remote handle in the reusable session.
		timer := time.AfterFunc(f.conn.store.operationTimeout, func() {
			f.conn.cancel(context.DeadlineExceeded)
		})
		defer timer.Stop()
		if err := f.file.Close(); err == nil {
			f.conn.release()
		}
	})
	return nil
}
