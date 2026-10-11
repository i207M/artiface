package server

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"artiface/internal/storage"
)

type metadataStore struct {
	info                       metadataInfo
	openErr, statErr, closeErr error
	opens, stats, closes       int
	reads, seeks               int
	target, root, rel          string
}

func (*metadataStore) List(context.Context, string, string, string) ([]storage.Entry, error) {
	return nil, errors.New("unexpected listing")
}
func (*metadataStore) Close() error { return nil }
func (s *metadataStore) Open(_ context.Context, target, root, rel string) (storage.File, error) {
	s.opens++
	s.target, s.root, s.rel = target, root, rel
	if s.openErr != nil {
		return nil, s.openErr
	}
	return &metadataFile{store: s}, nil
}

type metadataFile struct{ store *metadataStore }

func (f *metadataFile) Stat() (fs.FileInfo, error) {
	f.store.stats++
	return f.store.info, f.store.statErr
}
func (f *metadataFile) Close() error {
	f.store.closes++
	return f.store.closeErr
}
func (f *metadataFile) Read([]byte) (int, error) {
	f.store.reads++
	return 0, errors.New("metadata request must not read contents")
}
func (f *metadataFile) Seek(int64, int) (int64, error) {
	f.store.seeks++
	return 0, errors.New("metadata request must not seek")
}

type metadataInfo struct {
	size     int64
	modified time.Time
	mode     fs.FileMode
}

func (metadataInfo) Name() string         { return "/private/source/path" }
func (i metadataInfo) Size() int64        { return i.size }
func (i metadataInfo) ModTime() time.Time { return i.modified }
func (i metadataInfo) Mode() fs.FileMode  { return i.mode }
func (i metadataInfo) IsDir() bool        { return i.mode.IsDir() }
func (metadataInfo) Sys() any             { return nil }

func TestStatOnlyInspectsMetadataAndVersionsChanges(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	base := metadataInfo{size: 123, modified: time.Date(2026, 9, 20, 12, 34, 56, 789, time.UTC), mode: 0600}
	store := &metadataStore{}
	app.store = store
	versions := make(map[string]bool)
	var first string
	for i, info := range []metadataInfo{
		base,
		base,
		{base.size, base.modified.In(time.FixedZone("elsewhere", 5*60*60)), base.mode},
		{base.size + 1, base.modified, base.mode},
		{base.size, base.modified.Add(time.Nanosecond), base.mode},
		{base.size, base.modified.Add(time.Second), base.mode},
		{base.size, base.modified, 0400},
	} {
		store.info = info
		w := request(app, "GET", "/api/file-info"+fileQuery("./reports//report.pdf"), nil, cookie, "")
		var got fileStat
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil {
			t.Fatalf("stat: %d %s", w.Code, w.Body)
		}
		if got.Name != "report.pdf" || got.Path != "reports/report.pdf" || got.Type != "file" ||
			got.Size != info.size || !got.Modified.Equal(info.modified) {
			t.Fatalf("metadata response: %+v", got)
		}
		var fields map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &fields); err != nil || len(fields) != 7 {
			t.Fatalf("stat returned unexpected metadata fields: %s", w.Body)
		}
		digest, err := hex.DecodeString(got.Version)
		if err != nil || len(digest) != 32 {
			t.Fatalf("invalid version token: %q", got.Version)
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json; charset=utf-8" {
			t.Fatalf("unsafe metadata headers: %v", w.Header())
		}
		if i == 0 {
			first = got.Version
		} else if i <= 2 && got.Version != first {
			t.Fatal("unchanged metadata or time zone changed the version")
		} else if i > 2 && versions[got.Version] {
			t.Fatal("size, precise modification time, or mode change did not change the version")
		}
		versions[got.Version] = true
		if store.opens != i+1 || store.stats != i+1 || store.closes != i+1 ||
			store.reads != 0 || store.seeks != 0 || len(app.previews) != 0 {
			t.Fatal("polling must open, stat, and close exactly once without reading or creating previews")
		}
		if store.target != "test-alias" || store.root != app.cfg.Hosts[0].Roots[0].Path || store.rel != "reports/report.pdf" {
			t.Fatal("stat did not pass the configured target and root with the normalized path")
		}
	}
}

func TestStatAuthorizationAndScopeBeforeStorage(t *testing.T) {
	app, _ := newTestApp(t)
	store := &metadataStore{}
	app.store = store
	cookie, _ := signIn(t, app)
	for _, tc := range []struct {
		name, host, origin, site string
		loc                      location
		authenticated            bool
		want                     int
	}{
		{"anonymous", app.appHost, "", "", location{"test", "artifacts", "report.pdf"}, false, 401},
		{"unknown host", app.appHost, "", "", location{"missing", "artifacts", "report.pdf"}, true, 404},
		{"unknown root", app.appHost, "", "", location{"test", "missing", "report.pdf"}, true, 404},
		{"absolute", app.appHost, "", "", location{"test", "artifacts", "/etc/passwd"}, true, 403},
		{"traversal", app.appHost, "", "", location{"test", "artifacts", "reports/../../secret"}, true, 403},
		{"backslash", app.appHost, "", "", location{"test", "artifacts", `reports\..\secret`}, true, 403},
		{"rebound host", "attacker.example:8787", "", "", location{"test", "artifacts", "report.pdf"}, true, 421},
		{"foreign origin", app.appHost, "https://attacker.example", "", location{"test", "artifacts", "report.pdf"}, true, 403},
		{"opaque report", app.appHost, "null", "", location{"test", "artifacts", "report.pdf"}, true, 403},
		{"cross-site", app.appHost, "", "cross-site", location{"test", "artifacts", "report.pdf"}, true, 403},
		{"same-site other port", app.appHost, "", "same-site", location{"test", "artifacts", "report.pdf"}, true, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query := url.Values{"host": {tc.loc.Host}, "root": {tc.loc.Root}, "path": {tc.loc.Path}}
			r := httptest.NewRequest("GET", "/api/file-info?"+query.Encode(), nil)
			r.Host = tc.host
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Sec-Fetch-Site", tc.site)
			if tc.authenticated {
				r.AddCookie(cookie)
			}
			w := httptest.NewRecorder()
			app.Handler().ServeHTTP(w, r)
			if w.Code != tc.want || store.opens != 0 {
				t.Fatalf("protected request: status %d, opens %d", w.Code, store.opens)
			}
		})
	}
}

func TestStatClosesFilesOnMetadataFailures(t *testing.T) {
	app, _ := newTestApp(t)
	cookie, _ := signIn(t, app)
	for _, tc := range []struct {
		name                       string
		openErr, statErr, closeErr error
		mode                       fs.FileMode
		want                       int
	}{
		{"missing", fs.ErrNotExist, nil, nil, 0600, 404},
		{"store boundary", storage.ErrForbidden, nil, nil, 0600, 403},
		{"stat permission", nil, fs.ErrPermission, nil, 0600, 403},
		{"stat unavailable", nil, errors.New("unavailable"), nil, 0600, 502},
		{"close failure", nil, nil, errors.New("close failed"), 0600, 502},
		{"directory", nil, nil, nil, fs.ModeDir | 0700, 403},
		{"special file", nil, nil, nil, fs.ModeNamedPipe | 0600, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &metadataStore{
				info: metadataInfo{mode: tc.mode}, openErr: tc.openErr,
				statErr: tc.statErr, closeErr: tc.closeErr,
			}
			app.store = store
			w := request(app, "GET", "/api/file-info"+fileQuery("report.pdf"), nil, cookie, "")
			wantCloses := 1
			if tc.openErr != nil {
				wantCloses = 0
			}
			if w.Code != tc.want || store.closes != wantCloses || store.reads != 0 || store.seeks != 0 || len(app.previews) != 0 {
				t.Fatalf("failure: status %d, closes %d, reads %d, seeks %d", w.Code, store.closes, store.reads, store.seeks)
			}
		})
	}
}
