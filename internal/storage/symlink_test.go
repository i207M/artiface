//go:build unix

package storage

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type linkFixture struct {
	root, alias, outside string
}

func newLinkFixture(t *testing.T) linkFixture {
	t.Helper()
	f := linkFixture{root: t.TempDir(), alias: filepath.Join(t.TempDir(), "configured"), outside: t.TempDir()}
	for _, dir := range []string{"reports/assets", "shared"} {
		if err := os.MkdirAll(filepath.Join(f.root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range map[string]string{
		"plain": "plain", "reports/index.html": "<p>report</p>", "reports/assets/plot.png": "image",
		"shared/secret": "project-only",
	} {
		writeFixture(t, filepath.Join(f.root, name), content)
	}
	writeFixture(t, filepath.Join(f.outside, "secret"), "outside")
	alternate := filepath.Join(t.TempDir(), "alternate")
	for link, target := range map[string]string{f.alias: f.root, alternate: f.root} {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{
		"file-link":                  "plain",
		"chain":                      "file-link",
		"index.html":                 "reports/index.html",
		"directory":                  "reports",
		"absolute-file":              filepath.Join(f.root, "plain"),
		"absolute-directory":         filepath.Join(f.root, "reports"),
		"configured-alias":           filepath.Join(f.alias, "plain"),
		"alternate-alias":            filepath.Join(alternate, "plain"),
		"reports/parent-back":        "../reports/assets/plot.png",
		"reports/parent-escape":      "../shared/secret",
		"reports/absolute-escape":    filepath.Join(f.root, "shared/secret"),
		"reports/plot":               "assets/plot.png",
		"reports/assets/up":          "..",
		"filesystem-dotdot":          "reports/assets/up/assets/../index.html",
		"absolute-filesystem-dotdot": f.root + "/reports/assets/up/assets/../index.html",
		"escape":                     f.outside,
		"broken":                     "missing",
		"loop":                       "loop",
		"loop-a":                     "loop-b",
		"loop-b":                     "loop-a",
		"traversal":                  "../../etc/passwd",
		"fifo-link":                  "fifo",
	} {
		if err := os.Symlink(target, filepath.Join(f.root, link)); err != nil {
			t.Fatal(err)
		}
	}
	if err := unix.Mkfifo(filepath.Join(f.root, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	return f
}

func openSSHSubsystem(t *testing.T) *SSH {
	t.Helper()
	var binary string
	for _, candidate := range []string{"/usr/libexec/openssh/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/lib/ssh/sftp-server"} {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			binary = candidate
			break
		}
	}
	if binary == "" {
		var err error
		binary, err = exec.LookPath("sftp-server")
		if err != nil {
			t.Skip("OpenSSH sftp-server is unavailable")
		}
	}
	s := NewSSH()
	s.dial = func(context.Context, string) (io.ReadWriteCloser, error) {
		return startProcess(exec.Command(binary))
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestSymlinkResolutionAndPreviewScope(t *testing.T) {
	for _, backend := range []string{"local", "SFTP fixture", "OpenSSH subsystem"} {
		t.Run(backend, func(t *testing.T) {
			fx := newLinkFixture(t)
			var store Store
			var fixture *fixtureFS
			target := "fixture"
			switch backend {
			case "local":
				store, target = NewLocal(), ""
			case "SFTP fixture":
				fixture = &fixtureFS{}
				store, _ = fixtureStore(t, fixture)
			default:
				store = openSSHSubsystem(t)
			}
			defer store.Close()
			resolver := store.(Resolver)
			for requested, want := range map[string]string{
				"chain": "plain", "index.html": "reports/index.html", "directory": "reports",
				"absolute-directory/assets/up": "reports", "": "",
			} {
				got, err := resolver.Resolve(context.Background(), target, fx.alias, requested)
				if err != nil || got != want {
					t.Fatalf("Resolve(%s) = %s, %v; want %s", requested, got, err, want)
				}
			}
			for _, requested := range []string{"escape/secret", "loop", "fifo-link", "broken", "../plain"} {
				if _, err := resolver.Resolve(context.Background(), target, fx.root, requested); !errors.Is(err, ErrForbidden) {
					t.Errorf("unsafe Resolve(%s): %v", requested, err)
				}
			}
			cancelled, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := resolver.Resolve(cancelled, target, fx.root, "chain"); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled Resolve: %v", err)
			}
			if fixture != nil && (fixture.opens.Load() != 0 || fixture.reads.Load() != 0) {
				t.Fatal("Resolve opened or read file contents")
			}
			for requested, resolved := range map[string]string{
				"chain": "plain", "absolute-file": "plain", "configured-alias": "plain", "alternate-alias": "plain",
				"directory/index.html": "reports/index.html", "absolute-directory/plot": "reports/assets/plot.png",
				"filesystem-dotdot": "reports/index.html", "absolute-filesystem-dotdot": "reports/index.html",
				"index.html": "reports/index.html", "reports/parent-back": "reports/assets/plot.png",
			} {
				file, err := store.Open(context.Background(), target, fx.alias, requested)
				if err != nil {
					t.Fatalf("Open(%s): %v", requested, err)
				}
				if got := file.(ResolvedFile).ResolvedPath(); got != resolved {
					t.Errorf("resolved %s = %s; want %s", requested, got, resolved)
				}
				want, err := os.ReadFile(filepath.Join(fx.root, resolved))
				if err != nil {
					t.Fatal(err)
				}
				got, err := io.ReadAll(file)
				info, statErr := file.Stat()
				file.Close()
				if err != nil || statErr != nil || string(got) != string(want) || info.Size() != int64(len(want)) {
					t.Fatalf("read/stat %s: %q, %v, %v", requested, got, err, statErr)
				}
			}
			for _, directory := range []string{"directory", "absolute-directory"} {
				entries, err := store.List(context.Background(), target, fx.alias, directory)
				if err != nil {
					t.Fatal(err)
				}
				found := map[string]Entry{}
				for _, entry := range entries {
					found[entry.Name] = entry
					if path.Dir(entry.Path) != directory {
						t.Errorf("listing changed requested path: %+v", entry)
					}
				}
				if entry := found["plot"]; entry.Type != "file" || !entry.Symlink || entry.Size != 5 ||
					entry.ResolvedPath == nil || *entry.ResolvedPath != "reports/assets/plot.png" {
					t.Errorf("resolved link metadata: %+v", entry)
				}
				if entry := found["assets"]; entry.Type != "directory" || entry.Symlink ||
					entry.ResolvedPath == nil || *entry.ResolvedPath != "reports/assets" {
					t.Errorf("directory metadata: %+v", entry)
				}
				if entry := found["index.html"]; entry.Type != "file" || entry.Symlink ||
					entry.ResolvedPath == nil || *entry.ResolvedPath != "reports/index.html" {
					t.Errorf("regular child lost its canonical parent: %+v", entry)
				}
			}
			entries, err := store.List(context.Background(), target, fx.root, "")
			if err != nil {
				t.Fatal(err)
			}
			found := map[string]Entry{}
			for _, entry := range entries {
				found[entry.Name] = entry
			}
			for _, name := range []string{"broken", "loop", "loop-a", "escape", "fifo-link", "traversal"} {
				if entry := found[name]; entry.Type != "symlink" || !entry.Symlink || entry.ResolvedPath != nil {
					t.Errorf("invalid link should remain non-openable: %+v", entry)
				}
			}
			for _, name := range []string{"broken", "loop", "loop-a", "escape/secret", "fifo", "fifo-link", "traversal", "../plain"} {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				done := make(chan error, 1)
				go func() {
					file, err := store.Open(ctx, target, fx.root, name)
					if file != nil {
						file.Close()
					}
					done <- err
				}()
				select {
				case err := <-done:
					if !errors.Is(err, ErrForbidden) {
						t.Errorf("Open(%s) = %v; want forbidden", name, err)
					}
				case <-ctx.Done():
					t.Fatalf("Open(%s) blocked on invalid link or special file", name)
				}
				cancel()
			}
			scoped := store.(ScopedStore)
			for _, scope := range []string{"reports", "directory", "absolute-directory"} {
				for _, name := range []string{"index.html", "plot", "parent-back", "assets/up/plot"} {
					file, err := scoped.OpenScoped(context.Background(), target, fx.alias, scope, name)
					if err != nil {
						t.Fatalf("OpenScoped(%s, %s): %v", scope, name, err)
					}
					file.Close()
				}
				for _, name := range []string{"parent-escape", "absolute-escape", "../plain", "/plain"} {
					if file, err := scoped.OpenScoped(context.Background(), target, fx.alias, scope, name); err == nil {
						file.Close()
						t.Fatalf("OpenScoped(%s, %s) escaped its preview scope", scope, name)
					}
				}
			}
			// A scope cannot introduce a new root by naming an escaping symlink.
			if file, err := scoped.OpenScoped(context.Background(), target, fx.alias, "escape", "secret"); err == nil {
				file.Close()
				t.Fatal("escaping scope became a trusted root")
			}
			if file, err := scoped.OpenScoped(context.Background(), target, fx.alias, "", "index.html"); err != nil {
				t.Fatal(err)
			} else {
				file.Close()
			}
		})
	}
}

func TestLocalScopedDirectoryReplacementCannotEscape(t *testing.T) {
	fx := newLinkFixture(t)
	writeFixture(t, filepath.Join(fx.outside, "index.html"), "outside")
	s := NewLocal()
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Go(func() {
		for ctx.Err() == nil {
			_ = os.Symlink("reports", filepath.Join(fx.root, "next"))
			_ = os.Rename(filepath.Join(fx.root, "next"), filepath.Join(fx.root, "racing"))
			_ = os.Symlink(fx.outside, filepath.Join(fx.root, "next"))
			_ = os.Rename(filepath.Join(fx.root, "next"), filepath.Join(fx.root, "racing"))
		}
	})
	defer func() { cancel(); wg.Wait() }()
	for range 200 {
		file, err := s.OpenScoped(context.Background(), "", fx.root, "racing", "index.html")
		if err != nil {
			if !errors.Is(err, ErrForbidden) && !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("replacement error: %v", err)
			}
			continue
		}
		data, err := io.ReadAll(file)
		file.Close()
		if err != nil || string(data) != "<p>report</p>" {
			t.Fatalf("directory replacement escaped project/scope: %q, %v", data, err)
		}
	}
}

func TestSSHReplacementBeforeOpenRetainsScopeAndCancellation(t *testing.T) {
	for _, replacement := range []string{"outside project", "outside preview", "FIFO"} {
		t.Run(replacement, func(t *testing.T) {
			fx := newLinkFixture(t)
			openPath := filepath.Join(fx.root, "reports/index.html")
			fixture := &fixtureFS{}
			var replaced atomic.Bool
			fixture.beforeOpen = func(name string) {
				if name != openPath {
					t.Errorf("unexpected open target: %s", name)
					return
				}
				if err := os.Remove(name); err != nil {
					t.Error(err)
					return
				}
				if replacement == "FIFO" {
					if err := unix.Mkfifo(name, 0600); err != nil {
						t.Error(err)
					}
				} else {
					target := filepath.Join(fx.outside, "secret")
					if replacement == "outside preview" {
						target = filepath.Join(fx.root, "shared/secret")
					}
					if err := os.Symlink(target, name); err != nil {
						t.Error(err)
					}
				}
				replaced.Store(true)
			}
			store, state := fixtureStore(t, fixture)
			store.operationTimeout = 200 * time.Millisecond
			if replacement == "FIFO" {
				// The SFTP request server itself is now blocked in os.Open.
				// Release it after testing the client's bounded cancellation.
				t.Cleanup(func() {
					file, err := os.OpenFile(openPath, os.O_WRONLY|unix.O_NONBLOCK, 0)
					if err != nil {
						t.Error(err)
						return
					}
					file.Close()
				})
			}
			done := make(chan error, 1)
			go func() {
				file, err := store.OpenScoped(context.Background(), "fixture", fx.root, "reports", "index.html")
				if file != nil {
					file.Close()
				}
				done <- err
			}()
			err := awaitError(t, done)
			if replacement == "FIFO" {
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Errorf("FIFO replacement did not respect operation timeout: %v", err)
				}
			} else if !errors.Is(err, ErrForbidden) {
				t.Errorf("replacement escaped: %v", err)
			}
			if !replaced.Load() || fixture.reads.Load() != 0 || state.active.Load() != 0 {
				t.Fatalf("replacement check read contents or leaked a connection: replaced=%v reads=%d active=%d",
					replaced.Load(), fixture.reads.Load(), state.active.Load())
			}
		})
	}
}
