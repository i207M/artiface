//go:build unix

package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/pkg/sftp"
)

type sessionFixture struct {
	*fixtureFS
	list       func(*sftp.Request) (sftp.ListerAt, error)
	lstat      func(*sftp.Request) (sftp.ListerAt, error)
	realpath   func(string) (string, error)
	readlink   func(string) (string, error)
	root       string
	rootCalls  atomic.Int32
	listCalls  atomic.Int32
	lstatCalls atomic.Int32
}

func (f *sessionFixture) RealPath(p string) (string, error) {
	if p == f.root {
		f.rootCalls.Add(1)
	}
	if f.realpath != nil {
		return f.realpath(p)
	}
	return f.fixtureFS.RealPath(p)
}

func (f *sessionFixture) Readlink(p string) (string, error) {
	if f.readlink != nil {
		return f.readlink(p)
	}
	return f.fixtureFS.Readlink(p)
}

func (f *sessionFixture) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	if r.Method == "List" {
		f.listCalls.Add(1)
		if f.list != nil {
			return f.list(r)
		}
	}
	return f.fixtureFS.Filelist(r)
}

func (f *sessionFixture) Lstat(r *sftp.Request) (sftp.ListerAt, error) {
	f.lstatCalls.Add(1)
	if f.lstat != nil {
		return f.lstat(r)
	}
	return f.fixtureFS.Lstat(r)
}

// Omitting the optional session capability exercises the ordinary traversal.
type ordinaryListingStore struct {
	Store
	Resolver
}

func TestRecursiveSSHSessionReusesOneConnection(t *testing.T) {
	root := t.TempDir()
	alias := filepath.Join(t.TempDir(), "configured")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	for i := range 20 {
		dir := filepath.Join(root, fmt.Sprintf("run-%02d", i))
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		writeFixture(t, filepath.Join(dir, "result"), "fixture")
	}
	fixture := &sessionFixture{fixtureFS: &fixtureFS{}, root: alias}
	store, state := fixtureStore(t, fixture)
	plain, err := ListRecursive(context.Background(), ordinaryListingStore{store, store}, "fixture", alias, "", false, nil)
	if err != nil || plain.Truncated || len(plain.Entries) != 20 ||
		state.started.Load() != 1 || fixture.rootCalls.Load() != 42 {
		t.Fatalf("ordinary walk: files=%d connections=%d root resolutions=%d err=%v",
			len(plain.Entries), state.started.Load(), fixture.rootCalls.Load(), err)
	}
	fixture.rootCalls.Store(0)
	fixture.listCalls.Store(0)
	dispatch := &Dispatch{SSH: store}
	result, err := ListRecursive(context.Background(), dispatch, "fixture", alias, "", false, nil)
	if err != nil || result.Truncated || len(result.Entries) != len(plain.Entries) ||
		state.started.Load() != 1 || fixture.rootCalls.Load() != 1 || fixture.listCalls.Load() != 21 {
		t.Fatalf("session walk: files=%d connections=%d root resolutions=%d listings=%d err=%v",
			len(result.Entries), state.started.Load(), fixture.rootCalls.Load(), fixture.listCalls.Load(), err)
	}
	for i := range result.Entries {
		if result.Entries[i].Path != plain.Entries[i].Path {
			t.Fatal("session changed recursive results")
		}
	}
	if state.active.Load() != 1 || len(store.active) != 0 || len(store.idle) != 1 ||
		fixture.opens.Load() != 0 || fixture.reads.Load() != 0 {
		t.Fatal("recursive session retained its lease or read file contents")
	}
	t.Log("21 directories / 20 files: 42 root resolutions reduced to one on a reused connection")
}

func TestRecursiveSSHSessionCancellationAndTerminalFailure(t *testing.T) {
	for _, action := range []string{"cancel", "deadline", "store close", "connection lost"} {
		t.Run(action, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				root := t.TempDir()
				for _, dir := range []string{"a-blocked", "b-unvisited"} {
					if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
						t.Fatal(err)
					}
				}
				writeFixture(t, filepath.Join(root, "result"), "fixture")
				store, state := fixtureStore(t, &fixtureFS{})
				dial := store.dial
				var wire *gatedConn
				store.dial = func(ctx context.Context, target string) (io.ReadWriteCloser, error) {
					conn, err := dial(ctx, target)
					if err != nil {
						return nil, err
					}
					wire = &gatedConn{ReadWriteCloser: conn, entered: make(chan struct{}), closed: make(chan struct{})}
					return wire, nil
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				armed := make(chan struct{})
				calls := 0
				filter := func(rel string, directory bool) (bool, error) {
					if rel == "a-blocked" && directory {
						calls++
						if calls == 2 { // After Resolve, immediately before this directory's List.
							wire.block.Store(true)
							close(armed)
						}
					}
					return false, nil
				}
				var result Listing
				var err error
				done := make(chan struct{})
				go func() {
					result, err = ListRecursive(ctx, store, "fixture", root, "", false, filter)
					close(done)
				}()
				<-armed
				<-wire.entered
				switch action {
				case "cancel":
					cancel()
				case "deadline":
					time.Sleep(defaultRecursiveLimits.timeout)
				case "store close":
					_ = store.Close()
				case "connection lost":
					_ = wire.Close()
				}
				<-done
				if err != nil || !result.Truncated || len(result.Entries) != 1 ||
					state.started.Load() != 1 || state.active.Load() != 0 || len(store.slots) != 0 {
					t.Fatalf("interrupted walk: %+v err=%v connections=%d active=%d", result, err, state.started.Load(), state.active.Load())
				}
				if action == "connection lost" && !strings.Contains(result.Warning, "connection failed") {
					t.Fatal("transport failure was mislabeled", result.Warning)
				}
			})
		})
	}
}

func TestSSHListingSessionRootAndFilterBoundaries(t *testing.T) {
	fx := newLinkFixture(t)
	fixture := &sessionFixture{fixtureFS: &fixtureFS{}, root: fx.alias}
	store, state := fixtureStore(t, fixture)
	session, err := store.beginListing(context.Background(), "fixture", fx.alias)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	for _, request := range []struct{ target, root, rel string }{
		{"another", fx.alias, ""},
		{"fixture", fx.root, ""},
		{"fixture", fx.alias, "../plain"},
		{"fixture", fx.alias, "escape/secret"},
	} {
		if _, err := session.Resolve(context.Background(), request.target, request.root, request.rel); !errors.Is(err, ErrForbidden) {
			t.Fatal("session accepted a different scope or escape", err)
		}
	}
	if err := os.Remove(fx.alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(fx.outside, fx.alias); err != nil {
		t.Fatal(err)
	}
	// Even configured-root absolute links rewalk the original canonical root.
	if resolved, err := session.Resolve(context.Background(), "fixture", fx.alias, "configured-alias"); err != nil || resolved != "plain" {
		t.Fatal("root replacement changed the session's project boundary", resolved, err)
	}
	if fixture.rootCalls.Load() != 1 {
		t.Fatal("session re-resolved the configured root")
	}
	session.Close()
	if err := os.Remove(fx.alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(fx.root, fx.alias); err != nil {
		t.Fatal(err)
	}
	fixture.listCalls.Store(0)
	filter := func(rel string, _ bool) (bool, error) { return rel == "reports", nil }
	result, err := ListRecursive(context.Background(), store, "fixture", fx.alias, "directory", false, filter)
	if err != nil || result.Truncated || len(result.Entries) != 0 || fixture.listCalls.Load() != 0 {
		t.Fatal("canonical filtering happened after listing the selected alias", result, err)
	}
	if state.active.Load() != 1 || len(store.active) != 0 || len(store.idle) != 1 ||
		fixture.opens.Load() != 0 || fixture.reads.Load() != 0 {
		t.Fatal("session boundary checks retained their lease or read contents")
	}
}

type sessionFileInfo struct {
	fs.FileInfo
	name string
}

func (f sessionFileInfo) Name() string { return f.name }

func TestSSHListingSessionWireLimits(t *testing.T) {
	for _, which := range []string{"cumulative bytes", "entry count", "packet size"} {
		t.Run(which, func(t *testing.T) {
			root := t.TempDir()
			for _, dir := range []string{"one", "two"} {
				if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
					t.Fatal(err)
				}
			}
			writeFixture(t, filepath.Join(root, "file"), "fixture")
			info, err := os.Stat(filepath.Join(root, "file"))
			if err != nil {
				t.Fatal(err)
			}
			count, width := maxDirectoryEntries, 512
			if which == "entry count" {
				count, width = 2, 1
			} else if which == "packet size" {
				count, width = 1, maxPacketBytes
			}
			infos := make(fixtureList, count)
			for i := range infos {
				infos[i] = sessionFileInfo{FileInfo: info, name: fmt.Sprintf("%05d-%s", i, strings.Repeat("x", width))}
			}
			fixture := &sessionFixture{fixtureFS: &fixtureFS{}, list: func(*sftp.Request) (sftp.ListerAt, error) {
				return infos, nil
			}}
			store, state := fixtureStore(t, fixture)
			if which == "entry count" {
				store.maxEntries = 1
			}
			session, err := store.beginListing(context.Background(), "fixture", root)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if which == "cumulative bytes" {
				if entries, err := session.List(context.Background(), "fixture", root, "one"); err != nil || len(entries) != count {
					t.Fatal("first bounded directory failed", len(entries), err)
				}
			}
			if entries, err := session.List(context.Background(), "fixture", root, "two"); entries != nil ||
				!errors.Is(err, errListingSessionEnded) || which != "packet size" && !errors.Is(err, ErrTooLarge) {
				t.Fatal("wire limit did not terminate the session", len(entries), err)
			}
			if which == "cumulative bytes" {
				reader := session.(*sshListingSession).conn.reader
				reader.mu.Lock()
				bytes := reader.bytes
				reader.mu.Unlock()
				if bytes <= maxDirectoryBytes || bytes > maxDirectoryBytes+maxPacketBytes+4 {
					t.Fatal("directory name counts did not reset or cumulative byte bound changed", bytes)
				}
			}
			calls := fixture.listCalls.Load()
			if _, err := session.List(context.Background(), "fixture", root, "one"); !errors.Is(err, errListingSessionEnded) ||
				fixture.listCalls.Load() != calls || state.started.Load() != 1 || state.active.Load() != 0 {
				t.Fatal("failed session issued more requests or retained its connection", err)
			}
		})
	}
}

func TestSSHListingSessionDoesNotHideTerminalSymlinkFailure(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink("target", filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	fixture := &sessionFixture{fixtureFS: &fixtureFS{}}
	fixture.lstat = func(r *sftp.Request) (sftp.ListerAt, error) {
		if r.Filepath == filepath.Join(root, "target") {
			return nil, sftp.ErrSSHFxConnectionLost
		}
		return fixture.fixtureFS.Lstat(r)
	}
	store, state := fixtureStore(t, fixture)
	session, err := store.beginListing(context.Background(), "fixture", root)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if entries, err := session.List(context.Background(), "fixture", root, ""); entries != nil ||
		!errors.Is(err, errListingSessionEnded) || state.active.Load() != 0 {
		t.Fatal("symlink error handling hid a terminal connection failure", entries, err)
	}
	calls := fixture.lstatCalls.Load()
	if _, err := session.Resolve(context.Background(), "fixture", root, "alias"); !errors.Is(err, errListingSessionEnded) ||
		fixture.lstatCalls.Load() != calls {
		t.Fatal("terminal session continued resolving paths", err)
	}
}

func TestRecursiveSSHSessionClassifiesAlternateAbsoluteLinkFailure(t *testing.T) {
	for _, tc := range []struct {
		name     string
		failure  error
		terminal bool
	}{
		{"connection lost", sftp.ErrSSHFxConnectionLost, true},
		{"bad message", sftp.ErrSSHFxBadMessage, true},
		{"missing alias", fs.ErrNotExist, false},
		{"denied alias", fs.ErrPermission, false},
		{"unavailable alias", sftp.ErrSSHFxFailure, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			later := filepath.Join(root, "z-after-failure")
			for _, dir := range []string{filepath.Join(root, "a-alias"), later} {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			writeFixture(t, filepath.Join(root, "first"), "first")
			writeFixture(t, filepath.Join(later, "last"), "last")
			alternate := filepath.Join(t.TempDir(), "alternate")
			if err := os.Symlink(filepath.Join(root, "first"), alternate); err != nil {
				t.Fatal(err)
			}
			const aliases = 4
			for i := range aliases {
				if err := os.Symlink(alternate, filepath.Join(root, "a-alias", fmt.Sprintf("link-%02d", i))); err != nil {
					t.Fatal(err)
				}
			}

			var aliasCalls, laterRequests, requestsAfterFailure atomic.Int32
			noteRequest := func(name string) {
				if tc.terminal && aliasCalls.Load() != 0 {
					requestsAfterFailure.Add(1)
				}
				if name == later || strings.HasPrefix(name, later+"/") {
					laterRequests.Add(1)
				}
			}
			fixture := &sessionFixture{fixtureFS: &fixtureFS{}}
			fixture.realpath = func(name string) (string, error) {
				noteRequest(name)
				if name == alternate {
					aliasCalls.Add(1)
					return "", tc.failure
				}
				return fixture.fixtureFS.RealPath(name)
			}
			fixture.lstat = func(r *sftp.Request) (sftp.ListerAt, error) {
				noteRequest(r.Filepath)
				return fixture.fixtureFS.Lstat(r)
			}
			fixture.readlink = func(name string) (string, error) {
				noteRequest(name)
				return fixture.fixtureFS.Readlink(name)
			}
			fixture.list = func(r *sftp.Request) (sftp.ListerAt, error) {
				noteRequest(r.Filepath)
				return fixture.fixtureFS.Filelist(r)
			}
			store, state := fixtureStore(t, fixture)
			result, err := ListRecursive(context.Background(), store, "fixture", root, "", false, nil)
			wantAliasCalls := int32(aliases)
			if tc.terminal {
				wantAliasCalls = 1
			}
			if err != nil || result.Truncated != tc.terminal || aliasCalls.Load() != wantAliasCalls || requestsAfterFailure.Load() != 0 {
				t.Fatalf("alternate alias failure: %+v err=%v alias calls=%d requests after terminal failure=%d",
					result, err, aliasCalls.Load(), requestsAfterFailure.Load())
			}
			if tc.terminal {
				if len(result.Entries) != 1 || result.Entries[0].Path != "first" ||
					!strings.Contains(result.Warning, "storage connection failed") ||
					fixture.listCalls.Load() != 2 || laterRequests.Load() != 0 {
					t.Fatalf("terminal alias failure lost partial results or continued traversal: %+v later requests=%d", result, laterRequests.Load())
				}
			} else if len(result.Entries) != 2 || result.Entries[0].Path != "first" ||
				result.Entries[1].Path != "z-after-failure/last" || result.Warning != "" ||
				fixture.listCalls.Load() != 3 || laterRequests.Load() == 0 {
				t.Fatalf("ordinary unavailable alias stopped traversal: %+v", result)
			}
			if state.started.Load() != 1 || state.active.Load() != 0 || len(store.slots) != 0 ||
				fixture.opens.Load() != 0 || fixture.reads.Load() != 0 {
				t.Fatal("alias failure redialed, retained a connection slot, or read file contents")
			}
		})
	}
}

func TestSSHListingSessionSkipsOrdinaryDirectoryErrors(t *testing.T) {
	for _, failure := range []error{fs.ErrNotExist, fs.ErrPermission, sftp.ErrSSHFxFailure} {
		t.Run(failure.Error(), func(t *testing.T) {
			root := t.TempDir()
			for _, dir := range []string{"denied", "next"} {
				if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
					t.Fatal(err)
				}
			}
			writeFixture(t, filepath.Join(root, "next", "result"), "fixture")
			fixture := &sessionFixture{fixtureFS: &fixtureFS{}}
			fixture.list = func(r *sftp.Request) (sftp.ListerAt, error) {
				if r.Filepath == filepath.Join(root, "denied") {
					return nil, failure
				}
				return fixture.fixtureFS.Filelist(r)
			}
			store, state := fixtureStore(t, fixture)
			store.maxEntries = 1
			session, err := store.beginListing(context.Background(), "fixture", root)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if _, err := session.List(context.Background(), "fixture", root, "denied"); err == nil ||
				errors.Is(err, errListingSessionEnded) {
				t.Fatal("ordinary directory failure ended the session", err)
			}
			// Canonical metadata replies after a failed ReadDir must not consume
			// that directory's NAME allowance, even when filtering skips List.
			for range 4 {
				if _, err := session.Resolve(context.Background(), "fixture", root, "next"); err != nil {
					t.Fatal("metadata consumed the failed directory's name budget", err)
				}
			}
			if entries, err := session.List(context.Background(), "fixture", root, "next"); err != nil || len(entries) != 1 {
				t.Fatal("session could not continue after an ordinary directory error", entries, err)
			}
			session.Close()
			if state.started.Load() != 1 || state.active.Load() != 0 {
				t.Fatal("ordinary directory failure redialed or retained the connection")
			}
		})
	}
}
