package pdfpreview

import (
	"context"
	"errors"
	"time"
)

var ErrOutlineUnavailable = errors.New("PDF outline unavailable; use Original mode for bookmarks, or check the server's pdftohtml installation and PDF extraction limits")

type OutlineItem struct {
	Title string `json:"title"`
	Depth int    `json:"depth"`
	Page  *int   `json:"page"`
}

type Outline struct {
	Items     []OutlineItem `json:"items"`
	Truncated bool          `json:"truncated"`
}

// Outline shares the immutable snapshot and rendering budgets with Page.
// Callers must authorize and validate the source before every lookup.
func (c *Cache) Outline(ctx context.Context, key, id string) (Outline, error) {
	ctx, finish, err := c.begin(ctx)
	if err != nil {
		return Outline{}, err
	}
	defer finish()
	if err := ctx.Err(); err != nil {
		return Outline{}, err
	}
	c.mu.Lock()
	c.pruneLocked(time.Now())
	doc := c.docs[key]
	if doc == nil || doc.id != id {
		c.mu.Unlock()
		return Outline{}, ErrExpired
	}
	doc.used = time.Now()
	if doc.outlineReady {
		result, err := doc.outline, doc.outlineErr
		c.mu.Unlock()
		return result, err
	}
	doc.active++
	c.mu.Unlock()
	defer func() { c.mu.Lock(); doc.active--; c.mu.Unlock() }()
	select {
	case doc.render <- struct{}{}:
		defer func() { <-doc.render }()
	case <-ctx.Done():
		return Outline{}, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return Outline{}, err
	}
	c.mu.Lock()
	if doc.outlineReady {
		result, err := doc.outline, doc.outlineErr
		c.mu.Unlock()
		return result, err
	}
	c.mu.Unlock()
	release, err := c.slot(ctx)
	if err != nil {
		return Outline{}, err
	}
	defer release()
	result, err := c.renderer.outline(ctx, doc.file, doc.info.Pages)
	if ctx.Err() != nil {
		return Outline{}, ctx.Err()
	}
	// A canceled caller must not poison another request's outline. Permanent
	// failures are cached too, so opening the panel cannot repeat costly work.
	if err == nil || errors.Is(err, ErrOutlineUnavailable) {
		c.mu.Lock()
		doc.outline, doc.outlineErr, doc.outlineReady = result, err, true
		c.mu.Unlock()
	}
	return result, err
}
