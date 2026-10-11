package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

const (
	downloadLifetime  = 5 * time.Minute
	downloadWriteIdle = 30 * time.Second
	downloadBatchSize = 128 << 10
)

type downloadWriter struct {
	http.ResponseWriter
	ctx         context.Context
	controller  *http.ResponseController
	end         time.Time
	wroteHeader bool

	mu       sync.Mutex // Serializes deadline refreshes with cancellation.
	deadline time.Time
	err      error
}

func newDownload(w http.ResponseWriter, r *http.Request) (*downloadWriter, *http.Request, func(), error) {
	ctx, cancel := context.WithTimeout(r.Context(), downloadLifetime)
	end, _ := ctx.Deadline()
	d := &downloadWriter{ResponseWriter: w, ctx: ctx, controller: http.NewResponseController(w), end: end, deadline: end}
	if err := ctx.Err(); err != nil {
		cancel()
		return nil, nil, nil, err
	}
	// Bound storage setup too; the idle deadline starts when sending a response.
	if err := d.controller.SetWriteDeadline(end); errors.Is(err, http.ErrNotSupported) {
		// Recording/embedded writers retain their own limits and the request context.
		d.controller = nil
	} else if err != nil {
		cancel()
		return nil, nil, nil, err
	}
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		d.mu.Lock()
		d.interruptLocked(ctx.Err())
		d.mu.Unlock()
		close(interrupted)
	})
	finish := func() {
		// No callback may touch the connection after the handler returns.
		if !stop() {
			<-interrupted
		}
		cancel()
		// Leave the last deadline in place for net/http's final buffered flush.
	}
	return d, r.WithContext(ctx), finish, nil
}

func (d *downloadWriter) Unwrap() http.ResponseWriter { return d.ResponseWriter }

func (d *downloadWriter) interruptLocked(err error) {
	if d.err == nil {
		d.err = err
	}
	if d.controller != nil {
		_ = d.controller.SetWriteDeadline(time.Now())
	}
}

func (d *downloadWriter) refreshDeadline() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ctx.Err(); err != nil {
		d.interruptLocked(err)
	}
	if d.err != nil {
		return d.err
	}
	now := time.Now()
	if !now.Before(d.deadline) {
		d.interruptLocked(context.DeadlineExceeded)
		return d.err
	}
	deadline := now.Add(downloadWriteIdle)
	if d.end.Before(deadline) {
		deadline = d.end
	}
	if d.controller != nil {
		if err := d.controller.SetWriteDeadline(deadline); err != nil {
			d.interruptLocked(err)
			return d.err
		}
	}
	d.deadline = deadline
	return nil
}

func (d *downloadWriter) WriteHeader(status int) {
	if d.wroteHeader {
		return
	}
	d.wroteHeader = true
	// ServeContent removes Cache-Control on range errors before committing headers.
	d.Header().Set("Cache-Control", "no-store")
	if d.refreshDeadline() == nil {
		d.ResponseWriter.WriteHeader(status)
	}
}

func (d *downloadWriter) Write(p []byte) (int, error) {
	if !d.wroteHeader {
		d.WriteHeader(http.StatusOK)
	}
	if err := d.refreshDeadline(); err != nil {
		return 0, err
	}
	n, err := d.ResponseWriter.Write(p)
	if err != nil {
		d.mu.Lock()
		d.interruptLocked(err)
		d.mu.Unlock()
	} else if n > 0 {
		err = d.refreshDeadline()
	}
	return n, err
}

func (d *downloadWriter) ReadFrom(source io.Reader) (int64, error) {
	if err := d.refreshDeadline(); err != nil {
		return 0, err
	}
	// Hide both copy shortcuts: no recursive ReadFrom or bypass of the batch size.
	n, err := io.CopyBuffer(struct{ io.Writer }{d}, struct{ io.Reader }{source}, make([]byte, downloadBatchSize))
	if err != nil {
		d.mu.Lock()
		d.interruptLocked(err)
		d.mu.Unlock()
	}
	return n, err
}
