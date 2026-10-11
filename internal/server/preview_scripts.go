package server

import (
	"net/http"
	"sync"
	"time"
)

// This is a presentation hint tied to one capability, never an authorization
// decision or a content cache. Concurrent older responses cannot replace the
// result of a newer request for the main file.
type previewScriptCheck struct {
	mu      sync.Mutex
	attempt uint64
	status  string
}

func (c *previewScriptCheck) begin() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.attempt++
	c.status = "pending"
	return c.attempt
}

func (c *previewScriptCheck) publish(attempt uint64, status string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.attempt == attempt {
		c.status = status
	}
}

func (a *App) previewScripts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &body) {
		return
	}
	id, _, ok := a.current(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	a.hostsMu.RLock()
	a.mu.Lock()
	p, exists := a.previews[body.Token]
	s, active := a.sessions[id]
	own := exists && p.sessionID == id
	valid := own && active && time.Now().Before(p.expires) && time.Now().Before(s.expires) &&
		a.sessionValid(s) && (s.userID == "" || a.cfg.UserCanRead(s.userID, p.project))
	a.mu.Unlock()
	a.hostsMu.RUnlock()
	if exists && !own {
		fail(w, http.StatusForbidden, "This preview belongs to another session")
		return
	}
	if !valid || p.inspection == nil {
		// A live app session must not be logged out when its preview expires.
		fail(w, http.StatusGone, "Preview expired; reopen the file in Artiface")
		return
	}
	p.inspection.mu.Lock()
	status := p.inspection.status
	p.inspection.mu.Unlock()
	respond(w, http.StatusOK, map[string]any{
		"status": status, "projectLabel": p.projectLabel, "revision": p.revision, "canAllow": p.canAllow,
	})
}

// Observe only authored bytes the existing download writer accepted.
// The bridge prefix is inserted below this observer.
type previewScriptResponse struct {
	http.ResponseWriter
	download *downloadWriter
	check    *previewScriptCheck
	attempt  uint64
	size     int64
	scan     bool
	code     int
	written  int64
	failed   bool
	html     scriptDetector
}

func (w *previewScriptResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *previewScriptResponse) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *previewScriptResponse) Write(data []byte) (int, error) {
	if w.code == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(data)
	w.written += int64(n)
	w.failed = w.failed || err != nil || n != len(data)
	if w.scan && w.code == http.StatusOK {
		present := w.html.present
		w.html.feed(data[:n])
		if !present && w.html.present {
			w.check.publish(w.attempt, "present")
		}
	}
	return n, err
}

func (w *previewScriptResponse) finish() {
	if w.download != nil {
		w.download.mu.Lock()
		w.failed = w.failed || w.download.err != nil
		w.download.mu.Unlock()
	}
	status := "unknown"
	if w.scan && w.code == http.StatusOK {
		if w.html.present {
			// Positive evidence survives truncation, cancellation and write errors.
			status = "present"
		} else if !w.failed && w.written == w.size {
			status = w.html.result()
		}
	}
	w.check.publish(w.attempt, status)
}
