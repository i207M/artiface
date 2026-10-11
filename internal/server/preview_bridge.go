package server

import (
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
)

//go:embed preview_bridge.js
var previewBridgeJS string

func previewHTML(name string) bool {
	ext := strings.ToLower(path.Ext(name))
	return ext == ".html" || ext == ".htm"
}

// This sits below the script observer and download writer: the observer sees
// only authored bytes, and downloads retain their deadlines and bounded reads.
// ServeContent still decides status, conditionals and raw range behavior.
type previewHTMLResponse struct {
	http.ResponseWriter
	token, origin string
	scripts       bool
	started       bool
	transformed   bool
	marker        string
	expected      int64
	written       int64
	err           error
}

func (w *previewHTMLResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *previewHTMLResponse) WriteHeader(code int) {
	if w.started {
		return
	}
	w.started = true
	if code != http.StatusOK {
		w.ResponseWriter.WriteHeader(code)
		return
	}
	w.transformed = true
	w.expected, w.err = strconv.ParseInt(w.Header().Get("Content-Length"), 10, 64)
	if w.err != nil {
		w.expected, w.err = -1, nil
	}
	w.marker = randomToken()
	attribute := ""
	if !w.scripts {
		nonce := w.marker
		attribute = ` nonce="` + nonce + `"`
		policy := w.Header().Get("Content-Security-Policy")
		policy = strings.Replace(policy, "script-src 'none'", "script-src 'nonce-"+nonce+"'", 1)
		policy = strings.TrimSuffix(policy, "; sandbox") + "; sandbox allow-scripts"
		w.Header().Set("Content-Security-Policy", policy)
	}
	// JSON escapes HTML delimiters, quotes and line separators.
	// No authored file content or filename is interpolated into this script.
	token, _ := json.Marshal(w.token)
	origin, _ := json.Marshal(w.origin)
	marker, _ := json.Marshal(w.marker)
	prefix := "<!doctype html><meta name=\"color-scheme\" content=\"light\">" +
		"<style>:where(html){color-scheme:light}</style><script" + attribute + ">" +
		previewBridgeJS + "(" + string(token) + "," + string(origin) + "," + string(marker) + ");</script>"
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(code)
	n, err := io.WriteString(w.ResponseWriter, prefix)
	if err == nil && n != len(prefix) {
		err = io.ErrShortWrite
	}
	if err == nil {
		// Commit the prefix before the first storage read, including empty files.
		// This also prevents net/http from inferring a transformed content length.
		err = http.NewResponseController(w.ResponseWriter).Flush()
		if errors.Is(err, http.ErrNotSupported) {
			err = nil
		}
	}
	w.err = err
}

func (w *previewHTMLResponse) Write(data []byte) (int, error) {
	if !w.started {
		w.WriteHeader(http.StatusOK)
	}
	if w.err != nil {
		return 0, w.err
	}
	n, err := w.ResponseWriter.Write(data)
	w.written += int64(n)
	if err != nil {
		w.err = err
	} else if n != len(data) {
		w.err = io.ErrShortWrite
	}
	return n, err
}

func (w *previewHTMLResponse) finish() {
	if !w.transformed || w.err != nil || w.written != w.expected {
		return
	}
	// A chunked response can end cleanly after a source read fails.
	// A marker after every authored byte lets the bridge distinguish that case.
	_, _ = io.WriteString(w.ResponseWriter, `<meta name="artiface-preview-complete" content="`+w.marker+`">`)
}
