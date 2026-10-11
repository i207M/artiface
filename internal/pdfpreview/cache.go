// Package pdfpreview renders bounded, on-demand PDF page images.
package pdfpreview

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"sync"
	"time"
)

const (
	MaxSourceBytes = int64(1 << 30)
	maxSourceCache = int64(2 << 30)
	maxDocuments   = 4
	maxImageCache  = 64 << 20
	maxImages      = 256
	idleLifetime   = 15 * time.Minute
)

var (
	ErrUnavailable = errors.New("PDF compression requires Poppler on the Artiface server")
	ErrTooLarge    = errors.New("PDF compression supports files up to 1 GiB")
	ErrChanged     = errors.New("PDF changed; refresh the file")
	ErrExpired     = errors.New("Compressed PDF expired; refresh the file")
	ErrBusy        = errors.New("PDF compression is busy; try again shortly")
	ErrInvalid     = errors.New("Could not render this PDF; try Original mode or download it")
	ErrPage        = errors.New("Invalid PDF page or image size")
	// ErrSharedCanceled asks a live waiter to reopen its source after the request
	// preparing the shared snapshot was canceled. The preparing caller never gets it.
	ErrSharedCanceled = errors.New("Shared PDF preparation was interrupted")
)

type Source interface {
	io.Reader
	io.Closer
	Stat() (fs.FileInfo, error)
}

type Info struct {
	ID     string  `json:"id"`
	Pages  int     `json:"pages"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type Page struct {
	JPEG   []byte
	Width  float64
	Height float64
}

type renderer interface {
	available() bool
	info(context.Context, *os.File, int) (Info, error)
	page(context.Context, *os.File, int, int) (Page, error)
	outline(context.Context, *os.File, int) (Outline, error)
}

type document struct {
	key, id      string
	size         int64
	file         *os.File
	info         Info
	ready        chan struct{}
	err          error
	active       int
	used         time.Time
	outline      Outline
	outlineErr   error
	outlineReady bool
	// Inherited descriptors share a seek offset on some platforms.
	render chan struct{}
}

type imageKey struct {
	id, source string
	page, size int
}

type image struct {
	page Page
	used time.Time
}

type Cache struct {
	mu       sync.Mutex
	docs     map[string]*document
	images   map[imageKey]image
	bytes    int64
	imgBytes int
	renderer renderer
	jobs     chan struct{}
	ctx      context.Context
	cancel   context.CancelFunc
	closed   bool
	wg       sync.WaitGroup
	done     chan struct{}
}

func New() *Cache {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Cache{docs: map[string]*document{}, images: map[imageKey]image{}, renderer: newPoppler(),
		jobs: make(chan struct{}, 2), ctx: ctx, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(c.done)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				c.mu.Lock()
				c.pruneLocked(now)
				c.mu.Unlock()
			}
		}
	}()
	return c
}

func (c *Cache) Available() bool { return c.renderer.available() }

func (c *Cache) Close() {
	c.mu.Lock()
	c.closed = true
	c.cancel()
	c.mu.Unlock()
	c.wg.Wait()
	<-c.done
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.docs {
		c.removeLocked(key)
	}
	clear(c.images)
	c.imgBytes = 0
}

func (c *Cache) begin(ctx context.Context) (context.Context, func(), error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, nil, fs.ErrClosed
	}
	if !c.Available() {
		return nil, nil, ErrUnavailable
	}
	c.wg.Add(1)
	child, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(c.ctx, cancel)
	return child, func() { stop(); cancel(); c.wg.Done() }, nil
}

func (c *Cache) slot(ctx context.Context) (func(), error) {
	select {
	case c.jobs <- struct{}{}:
		return func() { <-c.jobs }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Document never returns source bytes. An unchanged snapshot is shared across
// requests, but HTTP authorization must be checked before every cache lookup.
// The source may be closed on cache hits, cancellation, or after copying.
// Callers must still close it on return; source.Close must be idempotent.
func (c *Cache) Document(ctx context.Context, key string, source Source, stat fs.FileInfo, force bool) (Info, error) {
	if stat.Size() < 1 || stat.Size() > MaxSourceBytes {
		return Info{}, ErrTooLarge
	}
	ctx, finish, err := c.begin(ctx)
	if err != nil {
		return Info{}, err
	}
	defer finish()
	closeSource := sync.OnceFunc(func() { _ = source.Close() })
	stop := context.AfterFunc(ctx, closeSource)
	defer stop()
	c.mu.Lock()
	c.pruneLocked(time.Now())
	if old := c.docs[key]; old != nil && force {
		if old.active != 0 {
			c.mu.Unlock()
			return Info{}, ErrBusy
		}
		c.removeLocked(key)
	}
	if old := c.docs[key]; old != nil {
		old.used = time.Now()
		ready := old.ready
		c.mu.Unlock()
		// Waiting for another request's copy must not occupy an SSH connection.
		closeSource()
		select {
		case <-ready:
			if err := ctx.Err(); err != nil {
				return Info{}, err
			}
			return old.info, old.err
		case <-ctx.Done():
			return Info{}, ctx.Err()
		}
	}
	for len(c.docs) >= maxDocuments || c.bytes+stat.Size() > maxSourceCache {
		key := c.oldestLocked()
		if key == "" {
			c.mu.Unlock()
			return Info{}, ErrBusy
		}
		c.removeLocked(key)
	}
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		c.mu.Unlock()
		return Info{}, err
	}
	doc := &document{key: key, id: hex.EncodeToString(token[:]), size: stat.Size(),
		ready: make(chan struct{}), active: 1, used: time.Now(), render: make(chan struct{}, 1)}
	c.docs[key], c.bytes = doc, c.bytes+doc.size
	c.mu.Unlock()
	info, file, loadErr := c.prepare(ctx, source, stat, closeSource)
	c.mu.Lock()
	doc.file, doc.info, doc.err = file, info, loadErr
	if ctx.Err() != nil && c.ctx.Err() == nil &&
		(errors.Is(loadErr, context.Canceled) || errors.Is(loadErr, context.DeadlineExceeded)) {
		doc.err = ErrSharedCanceled
	}
	doc.info.ID = doc.id
	doc.active = 0
	if loadErr != nil {
		c.removeLocked(key)
	}
	close(doc.ready)
	c.mu.Unlock()
	return doc.info, loadErr
}

func (c *Cache) prepare(ctx context.Context, source Source, stat fs.FileInfo, closeSource func()) (Info, *os.File, error) {
	release, err := c.slot(ctx)
	if err != nil {
		return Info{}, nil, err
	}
	defer release()
	file, err := os.CreateTemp("", "artiface-pdf-")
	if err != nil {
		return Info{}, nil, err
	}
	// Unlink before writing any private bytes. The OS reclaims even an abruptly
	// terminated server's snapshots when its inherited descriptors are closed.
	if err := os.Remove(file.Name()); err != nil {
		file.Close()
		_ = os.Remove(file.Name())
		return Info{}, nil, err
	}
	keep := false
	defer func() {
		if !keep {
			file.Close()
		}
	}()
	// Hide ReadFrom so os.File cannot replace the bounded bulk-read buffer.
	n, err := io.CopyBuffer(struct{ io.Writer }{file}, io.LimitReader(source, stat.Size()+1),
		make([]byte, min(128<<10, stat.Size()+1)))
	if err != nil {
		if ctx.Err() != nil && errors.Is(err, fs.ErrClosed) {
			err = ctx.Err()
		}
		return Info{}, nil, err
	}
	after, err := source.Stat()
	if err != nil {
		if ctx.Err() != nil && errors.Is(err, fs.ErrClosed) {
			err = ctx.Err()
		}
		return Info{}, nil, err
	}
	if n != stat.Size() || after.Size() != stat.Size() || !after.ModTime().Equal(stat.ModTime()) || after.Mode() != stat.Mode() {
		return Info{}, nil, ErrChanged
	}
	// Parsing only needs the snapshot; release the source's file/SSH slot first.
	closeSource()
	header := make([]byte, min(1024, n))
	if _, err := file.ReadAt(header, 0); err != nil || !bytes.Contains(header, []byte("%PDF-")) {
		return Info{}, nil, ErrInvalid
	}
	info, err := c.renderer.info(ctx, file, 1)
	if err != nil {
		return Info{}, nil, err
	}
	keep = true
	return info, file, nil
}

// ValidSize reports whether size is a supported longest edge in pixels.
func ValidSize(size int) bool {
	switch size {
	case 320, 960, 1440, 1920, 2560, 3200, 3840:
		return true
	default:
		return false
	}
}

func (c *Cache) Page(ctx context.Context, key, id string, number, size int) (Page, error) {
	if number < 1 || !ValidSize(size) {
		return Page{}, ErrPage
	}
	ctx, finish, err := c.begin(ctx)
	if err != nil {
		return Page{}, err
	}
	defer finish()
	c.mu.Lock()
	c.pruneLocked(time.Now())
	doc := c.docs[key]
	if doc == nil || doc.id != id {
		c.mu.Unlock()
		return Page{}, ErrExpired
	}
	if number > doc.info.Pages {
		c.mu.Unlock()
		return Page{}, ErrPage
	}
	doc.used = time.Now()
	cacheKey := imageKey{id: id, source: key, page: number, size: size}
	// Cached images do not access the snapshot's shared file descriptor.
	if cached, ok := c.images[cacheKey]; ok {
		cached.used = doc.used
		c.images[cacheKey] = cached
		c.mu.Unlock()
		return cached.page, nil
	}
	doc.active++
	c.mu.Unlock()
	defer func() { c.mu.Lock(); doc.active--; c.mu.Unlock() }()
	select {
	case doc.render <- struct{}{}:
		defer func() { <-doc.render }()
	case <-ctx.Done():
		return Page{}, ctx.Err()
	}
	// A request ahead of us may have rendered this image while we waited.
	c.mu.Lock()
	if cached, ok := c.images[cacheKey]; ok {
		cached.used = time.Now()
		c.images[cacheKey] = cached
		c.mu.Unlock()
		return cached.page, nil
	}
	c.mu.Unlock()
	release, err := c.slot(ctx)
	if err != nil {
		return Page{}, err
	}
	defer release()
	page, err := c.renderer.page(ctx, doc.file, number, size)
	if err != nil {
		return Page{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.images) >= maxImages || c.imgBytes+len(page.JPEG) > maxImageCache {
		var oldest imageKey
		var used time.Time
		for key, value := range c.images {
			if used.IsZero() || value.used.Before(used) {
				oldest, used = key, value.used
			}
		}
		if used.IsZero() {
			break
		}
		c.imgBytes -= len(c.images[oldest].page.JPEG)
		delete(c.images, oldest)
	}
	c.images[cacheKey] = image{page: page, used: time.Now()}
	c.imgBytes += len(page.JPEG)
	return page, nil
}

func (c *Cache) removeLocked(key string) {
	doc := c.docs[key]
	if doc == nil {
		return
	}
	if doc.file != nil {
		_ = doc.file.Close()
	}
	c.bytes -= doc.size
	delete(c.docs, key)
	for imageKey, image := range c.images {
		if imageKey.id == doc.id {
			c.imgBytes -= len(image.page.JPEG)
			delete(c.images, imageKey)
		}
	}
}

func (c *Cache) oldestLocked() string {
	var oldest *document
	for _, doc := range c.docs {
		if doc.active == 0 && (oldest == nil || doc.used.Before(oldest.used)) {
			oldest = doc
		}
	}
	if oldest != nil {
		return oldest.key
	}
	return ""
}

func (c *Cache) pruneLocked(now time.Time) {
	for key, doc := range c.docs {
		if doc.active == 0 && now.Sub(doc.used) >= idleLifetime {
			c.removeLocked(key)
		}
	}
}
