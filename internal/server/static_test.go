package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

func TestPrecompressedAssetsPreserveNegotiationAndRanges(t *testing.T) {
	app, _ := newTestApp(t)
	plain := []byte(strings.Repeat("const artiface = 'public application asset';\n", 100))
	var packed bytes.Buffer
	writer := gzip.NewWriter(&packed)
	if _, err := writer.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	app.assets = fstest.MapFS{
		"assets/app.js":    {Data: plain},
		"assets/app.js.gz": {Data: packed.Bytes()},
		"index.html":       {Data: []byte("<!doctype html>")},
	}
	for _, tc := range []struct {
		accept, method, rangeHeader string
		compressed                  bool
	}{
		{"", "GET", "", false},
		{"gzip", "GET", "", true},
		{"br, gzip;q=0.5", "GET", "", true},
		{"gzip;q=0", "GET", "", false},
		{"*;q=0.8", "GET", "", true},
		{"*;q=1, gzip;q=0", "GET", "", false},
		{"gzip;q=invalid", "GET", "", false},
		{"gzip;q=NaN", "GET", "", false},
		{"gzip;q=2", "GET", "", false},
		{"gzip", "HEAD", "", true},
		{"gzip", "GET", "bytes=0-4", false},
	} {
		t.Run(tc.accept+"/"+tc.method+"/"+tc.rangeHeader, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "/assets/app.js", nil)
			r.Host = app.appHost
			r.Header.Set("Accept-Encoding", tc.accept)
			r.Header.Set("Range", tc.rangeHeader)
			w := httptest.NewRecorder()
			app.Handler().ServeHTTP(w, r)
			wantStatus := 200
			want := plain
			if tc.rangeHeader != "" {
				wantStatus, want = 206, plain[:5]
			}
			if w.Code != wantStatus || w.Header().Get("Vary") != "Accept-Encoding" ||
				!strings.Contains(w.Header().Get("Content-Type"), "javascript") ||
				!strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
				t.Fatalf("asset response: %d %v", w.Code, w.Header())
			}
			if (w.Header().Get("Content-Encoding") == "gzip") != tc.compressed {
				t.Fatal("incorrect content encoding")
			}
			length := len(want)
			if tc.compressed {
				length = packed.Len()
			}
			if w.Header().Get("Content-Length") != strconv.Itoa(length) {
				t.Fatal("content length does not describe the selected representation")
			}
			body := w.Body.Bytes()
			if tc.method == "HEAD" {
				if len(body) != 0 {
					t.Fatal("HEAD included an asset body")
				}
				return
			}
			if tc.compressed {
				reader, err := gzip.NewReader(bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				body, err = io.ReadAll(reader)
				reader.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			if !bytes.Equal(body, want) {
				t.Fatal("asset bytes changed")
			}
		})
	}
	for _, name := range []string{"/index.html", "/assets/missing.js"} {
		r := httptest.NewRequest("GET", name, nil)
		r.Host = app.appHost
		r.Header.Set("Accept-Encoding", "gzip")
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, r)
		if w.Header().Get("Content-Encoding") != "" {
			t.Fatal("asset without compressed representation was marked as gzip")
		}
	}
	// Compression is scoped to public assets, never authenticated responses.
	cookie, _ := signIn(t, app)
	r := httptest.NewRequest("GET", "/api/text"+fileQuery("reports/index.html"), nil)
	r.Host = app.appHost
	r.AddCookie(cookie)
	r.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	app.Handler().ServeHTTP(w, r)
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("public asset compression changed private file responses")
	}
}
