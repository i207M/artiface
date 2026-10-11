package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/pkg/sftp"
)

func TestRefusesUnsafeRequestsBeforeConnecting(t *testing.T) {
	s := NewSSH()
	defer s.Close()
	s.dial = func(context.Context, string) (io.ReadWriteCloser, error) {
		t.Error("invalid request started a connection")
		return nil, errors.New("unexpected connection")
	}
	for _, rel := range []string{"..", "../secret", "x/../../secret", "x/../safe", "/etc/passwd", "//absolute", `x\..\secret`, "x\x00y", "x\ny", string([]byte{255})} {
		t.Run(fmt.Sprintf("path-%q", rel), func(t *testing.T) {
			if _, err := ValidateRelative(rel); !errors.Is(err, ErrForbidden) {
				t.Fatalf("ValidateRelative(%q) = %v", rel, err)
			}
			if _, err := s.Open(context.Background(), "fixture", "/root", rel); !errors.Is(err, ErrForbidden) {
				t.Fatalf("Open(%q) = %v", rel, err)
			}
			if _, err := s.List(context.Background(), "fixture", "/root", rel); !errors.Is(err, ErrForbidden) {
				t.Fatalf("List(%q) = %v", rel, err)
			}
		})
	}
	for _, target := range []string{"", "-oProxyCommand=anything", " host", "host name", "host\tname", "host\nname", "host\u00a0name", "host\x00name"} {
		if _, err := s.List(context.Background(), target, "/root", ""); !errors.Is(err, ErrForbidden) {
			t.Errorf("target %q: %v", target, err)
		}
	}
	for _, root := range []string{"", "relative", "/a/../b", "/a\x00b", `/a\b`} {
		if _, err := s.List(context.Background(), "fixture", root, ""); !errors.Is(err, ErrForbidden) {
			t.Errorf("root %q: %v", root, err)
		}
	}
	for input, want := range map[string]string{
		"": "", ".": "", "./": "", "a//./b/": "a/b",
		"report with spaces.html": "report with spaces.html",
		"%2e%2e/file":             "%2e%2e/file",
	} {
		if got, err := ValidateRelative(input); err != nil || got != want {
			t.Errorf("ValidateRelative(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
}

func TestSSHRootSymlinkAndFileBoundaries(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "report.html"), "hello world")
	if err := os.Mkdir(filepath.Join(root, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(root, "nested", "plot.txt"), "plot")
	outside := t.TempDir()
	writeFixture(t, filepath.Join(outside, "secret"), "outside")
	rootLink := filepath.Join(t.TempDir(), "configured-root")
	for link, target := range map[string]string{
		rootLink:                         root,
		filepath.Join(root, "escape"):    outside,
		filepath.Join(root, "file-link"): filepath.Join(root, "report.html"),
		filepath.Join(root, "dir-link"):  filepath.Join(root, "nested"),
		filepath.Join(root, "dangling"):  filepath.Join(outside, "missing"),
	} {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	handlers := &fixtureFS{}
	s, state := fixtureStore(t, handlers)
	entries, err := s.List(context.Background(), "fixture", rootLink, "")
	if err != nil {
		t.Fatal(err)
	}
	got := make(map[string]string)
	for _, entry := range entries {
		got[entry.Name] = entry.Type
		if entry.Path != entry.Name || entry.Modified.IsZero() {
			t.Errorf("invalid entry metadata: %+v", entry)
		}
	}
	want := map[string]string{"report.html": "file", "nested": "directory", "escape": "symlink", "file-link": "file", "dir-link": "directory", "dangling": "symlink"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("listing = %v; want %v", got, want)
	}
	if state.active.Load() != 0 {
		t.Fatal("List retained a connection")
	}
	for _, rel := range []string{"escape/secret", "dangling", "nested", "", "report.html/child"} {
		if _, err := s.Open(context.Background(), "fixture", rootLink, rel); !errors.Is(err, ErrForbidden) {
			t.Errorf("Open(%q) = %v; want forbidden", rel, err)
		}
	}
	for _, rel := range []string{"escape", "file-link", "dangling", "report.html"} {
		if _, err := s.List(context.Background(), "fixture", rootLink, rel); !errors.Is(err, ErrForbidden) {
			t.Errorf("List(%q) = %v; want forbidden", rel, err)
		}
	}
	if _, err := s.Open(context.Background(), "fixture", rootLink, "missing"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing file error = %v", err)
	}
	entries, err = s.List(context.Background(), "fixture", rootLink, "./nested//")
	if err != nil || len(entries) != 1 || entries[0].Path != "nested/plot.txt" {
		t.Fatalf("nested listing = %+v, %v", entries, err)
	}
	f, err := s.Open(context.Background(), "fixture", rootLink, "report.html")
	if err != nil {
		t.Fatal(err)
	}
	if state.active.Load() != 1 {
		t.Fatal("open file did not retain its connection")
	}
	info, err := f.Stat()
	if err != nil || info.Size() != 11 || !info.Mode().IsRegular() {
		t.Fatalf("Stat = %v, %v", info, err)
	}
	if err := f.Close(); err != nil || state.active.Load() != 1 || len(s.active) != 0 ||
		len(s.idle) != 1 || handlers.reads.Load() != 0 {
		t.Fatal("metadata-only Open/Stat/Close read contents or retained its lease")
	}
	f, err = s.Open(context.Background(), "fixture", rootLink, "report.html")
	if err != nil {
		t.Fatal(err)
	}
	if offset, err := f.Seek(-5, io.SeekEnd); err != nil || offset != 6 {
		t.Fatalf("Seek = %d, %v", offset, err)
	}
	data, err := io.ReadAll(f)
	if err != nil || string(data) != "world" {
		t.Fatalf("read = %q, %v", data, err)
	}
	var closers sync.WaitGroup
	for i := 0; i < 10; i++ {
		closers.Go(func() {
			if err := f.Close(); err != nil {
				t.Errorf("Close: %v", err)
			}
		})
	}
	closers.Wait()
	if state.active.Load() != 1 || len(s.active) != 0 || len(s.idle) != 1 {
		t.Fatal("file Close did not return its idle connection")
	}
	if _, err := f.Read(make([]byte, 1)); !errors.Is(err, fs.ErrClosed) {
		t.Errorf("Read after Close = %v", err)
	}
	if _, err := s.List(context.Background(), "fixture", filepath.Join(root, "report.html"), ""); !errors.Is(err, ErrForbidden) {
		t.Errorf("file configured as root: %v", err)
	}
}

func TestSSHOpenOverlapsVerificationAndWaitsForBothChecks(t *testing.T) {
	for _, action := range []string{"handle first", "path first", "cancel", "handle denied", "path denied"} {
		t.Run(action, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				root := t.TempDir()
				writeFixture(t, filepath.Join(root, "file"), "content")
				statStarted, pathStarted := make(chan struct{}), make(chan struct{})
				statGate, pathGate := make(chan struct{}), make(chan struct{})
				releaseStat := sync.OnceFunc(func() { close(statGate) })
				releasePath := sync.OnceFunc(func() { close(pathGate) })
				defer releaseStat()
				defer releasePath()
				fixture := &openVerificationFixture{
					fixtureFS: &fixtureFS{},
					stat: func() error {
						<-statGate
						if action == "handle denied" {
							return sftp.ErrSSHFxPermissionDenied
						}
						return nil
					},
					verify: func() error {
						<-pathGate
						if action == "path denied" {
							return sftp.ErrSSHFxPermissionDenied
						}
						return nil
					},
				}
				store, state := fixtureStore(t, fixture)
				dial := store.dial
				store.dial = func(ctx context.Context, target string) (io.ReadWriteCloser, error) {
					wire, err := dial(ctx, target)
					if err != nil {
						return nil, err
					}
					return &openVerificationWire{ReadWriteCloser: wire, observe: func(kind byte) {
						if fixture.opens.Load() != 0 {
							switch kind {
							case 8: // SSH_FXP_FSTAT
								close(statStarted)
							case 16: // SSH_FXP_REALPATH
								close(pathStarted)
							}
						}
					}}, nil
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var file File
				var err error
				done := make(chan struct{})
				go func() {
					file, err = store.Open(ctx, "fixture", root, "file")
					close(done)
				}()
				synctest.Wait()
				for name, started := range map[string]<-chan struct{}{"handle": statStarted, "path": pathStarted} {
					select {
					case <-started:
					default:
						t.Fatalf("%s check waited for the other check's response", name)
					}
				}
				switch action {
				case "cancel":
					cancel()
				default:
					if action == "handle first" {
						releaseStat()
					} else {
						releasePath()
					}
					synctest.Wait()
					select {
					case <-done:
						t.Fatal("Open returned before both verification checks finished")
					default:
					}
					releaseStat()
					releasePath()
				}
				<-done
				if action == "cancel" {
					if !errors.Is(err, context.Canceled) || file != nil {
						t.Fatalf("cancelled verification: file=%v err=%v", file, err)
					}
				} else if strings.HasSuffix(action, "denied") {
					if !errors.Is(err, ErrForbidden) || file != nil {
						t.Fatalf("failed verification: file=%v err=%v", file, err)
					}
				} else {
					if err != nil || file == nil {
						t.Fatalf("verified open: file=%v err=%v", file, err)
					}
					file.Close()
				}
				wantIdle := 0
				if action == "handle first" || action == "path first" {
					wantIdle = 1
				}
				if fixture.opens.Load() != 1 || fixture.reads.Load() != 0 ||
					state.started.Load() != 1 || state.active.Load() != int32(wantIdle) ||
					len(store.slots) != wantIdle || len(store.active) != 0 {
					t.Fatal("verification read contents, redialed, or retained a failed connection")
				}
			})
		})
	}
}

type openVerificationFixture struct {
	*fixtureFS
	stat, verify func() error
}

type openVerificationWire struct {
	io.ReadWriteCloser
	observe func(byte)
}

func (w *openVerificationWire) Write(p []byte) (int, error) {
	n, err := w.ReadWriteCloser.Write(p)
	// These metadata requests fit in one framed SFTP write.
	if err == nil && len(p) >= 5 {
		w.observe(p[4])
	}
	return n, err
}

func (f *openVerificationFixture) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	if r.Method == "Stat" {
		if err := f.stat(); err != nil {
			return nil, err
		}
	}
	return f.fixtureFS.Filelist(r)
}

func (f *openVerificationFixture) RealPath(name string) (string, error) {
	if f.opens.Load() != 0 {
		if err := f.verify(); err != nil {
			return "", err
		}
	}
	return f.fixtureFS.RealPath(name)
}

func TestSSHBulkReadBatchesAndSeek(t *testing.T) {
	for _, short := range []bool{false, true} {
		t.Run(fmt.Sprintf("short-packets=%t", short), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				const packet, batch = 32 << 10, 128 << 10
				data := make([]byte, 3*batch+19)
				for i := range data {
					data[i] = byte((i + i/packet) % 251)
				}
				root := t.TempDir()
				writeFixture(t, filepath.Join(root, "file"), string(data))
				gate := make(chan struct{})
				release := sync.OnceFunc(func() { close(gate) })
				defer release()
				var mu sync.Mutex
				active, peak, largest := 0, 0, 0
				offsets := map[int64]bool{}
				emptySent := false
				handlers := &fixtureFS{readAt: func(file *os.File, p []byte, offset int64) (int, error) {
					mu.Lock()
					active++
					peak, largest = max(peak, active), max(largest, len(p))
					offsets[offset] = true
					empty := short && offset == 0 && !emptySent
					emptySent = emptySent || empty
					mu.Unlock()
					defer func() { mu.Lock(); active--; mu.Unlock() }()
					<-gate
					if empty {
						return 0, nil
					}
					if short {
						p = p[:min(len(p), 4093)]
					}
					return file.ReadAt(p, offset)
				}}
				// Allow larger replies so the server cannot hide oversized requests.
				s, state := fixtureStore(t, handlers, sftp.WithRSMaxTxPacket(batch))
				file, err := s.Open(context.Background(), "fixture", root, "file")
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				var copied bytes.Buffer
				done := make(chan error, 1)
				go func() {
					// Hide ReaderFrom so the requested copy batch reaches the source.
					_, err := io.CopyBuffer(struct{ io.Writer }{&copied},
						io.LimitReader(file, int64(len(data))+1), make([]byte, batch))
					done <- err
				}()
				synctest.Wait()
				if active != 4 || len(offsets) != 4 || largest != packet {
					t.Fatalf("copy did not pipeline four bounded reads: active=%d offsets=%v largest=%d", active, offsets, largest)
				}
				for offset := int64(0); offset < batch; offset += packet {
					if !offsets[offset] {
						t.Fatalf("missing read at offset %d", offset)
					}
				}
				release()
				if err := <-done; err != nil || !bytes.Equal(copied.Bytes(), data) {
					t.Fatalf("bulk copy lost or reordered bytes: %v", err)
				}
				if position, err := file.Seek(0, io.SeekCurrent); err != nil || position != int64(len(data)) {
					t.Fatalf("copy position = %d, %v", position, err)
				}
				if _, err := file.Seek(0, io.SeekStart); err != nil {
					t.Fatal(err)
				}
				buffer := make([]byte, 2*batch)
				if n, err := file.Read(buffer); err != nil || n != batch ||
					!bytes.Equal(buffer[:batch], data[:batch]) || !bytes.Equal(buffer[batch:], make([]byte, batch)) {
					t.Fatalf("oversized caller buffer bypassed the read bound: n=%d err=%v", n, err)
				}
				if _, err := file.Seek(-17, io.SeekCurrent); err != nil {
					t.Fatal(err)
				}
				if tail, err := io.ReadAll(io.LimitReader(file, 17)); err != nil || !bytes.Equal(tail, data[batch-17:batch]) {
					t.Fatalf("bounded range after seek: %v", err)
				}
				if _, err := file.Seek(-19, io.SeekEnd); err != nil {
					t.Fatal(err)
				}
				if n, err := file.Read(buffer); n != 19 || err != io.EOF || !bytes.Equal(buffer[:19], data[len(data)-19:]) {
					t.Fatalf("partial EOF = %d, %v", n, err)
				}
				if n, err := file.Read(buffer); n != 0 || err != io.EOF {
					t.Fatalf("final EOF = %d, %v", n, err)
				}
				if n, err := file.Read(nil); n != 0 || err != nil {
					t.Fatalf("empty read = %d, %v", n, err)
				}
				synctest.Wait()
				if peak != 4 || largest > packet || state.started.Load() != 1 {
					t.Fatalf("bulk read bounds: peak=%d packet=%d connections=%d", peak, largest, state.started.Load())
				}
			})
		})
	}
}

func TestSSHBulkReadReturnsContiguousPrefixOnError(t *testing.T) {
	const packet, failureOffset = 32 << 10, (32 << 10) + 4093
	data := bytes.Repeat([]byte("ordered file contents\n"), 7000)
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "file"), string(data))
	s, _ := fixtureStore(t, &fixtureFS{readAt: func(file *os.File, p []byte, offset int64) (int, error) {
		if offset == failureOffset {
			return 0, sftp.ErrSSHFxPermissionDenied
		}
		if offset == packet {
			p = p[:4093]
		}
		return file.ReadAt(p, offset)
	}})
	file, err := s.Open(context.Background(), "fixture", root, "file")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	buffer := make([]byte, 128<<10)
	n, err := file.Read(buffer)
	if n != failureOffset || !errors.Is(err, ErrForbidden) || !bytes.Equal(buffer[:n], data[:n]) {
		t.Fatalf("partial failure returned noncontiguous bytes: n=%d err=%v", n, err)
	}
	if position, err := file.Seek(0, io.SeekCurrent); err != nil || position != failureOffset {
		t.Fatalf("failed read advanced past its returned bytes: %d, %v", position, err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if n, err := file.Read(buffer[:17]); n != 17 || err != nil || !bytes.Equal(buffer[:17], data[:17]) {
		t.Fatalf("seek after partial failure: n=%d err=%v", n, err)
	}
}

func TestSSHDirectoryLimit(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 205; i++ {
		writeFixture(t, filepath.Join(root, fmt.Sprintf("%03d", i)), "")
	}
	s, state := fixtureStore(t, &fixtureFS{})
	s.maxEntries = 200 // Crosses multiple SFTP READDIR response packets.
	if entries, err := s.List(context.Background(), "fixture", root, ""); !errors.Is(err, ErrTooLarge) || entries != nil {
		t.Fatalf("oversized listing = %d entries, %v", len(entries), err)
	}
	if state.active.Load() != 0 {
		t.Fatal("oversized directory retained its connection")
	}
	s.maxEntries = 205
	entries, err := s.List(context.Background(), "fixture", root, "")
	if err != nil || len(entries) != 205 {
		t.Fatalf("listing at exact limit = %d, %v", len(entries), err)
	}
}

func TestSSHConnectionLimitCancellationAndClose(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "file"), "content")
	s, state := fixtureStore(t, &fixtureFS{})
	s.slots = make(chan struct{}, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first, err := s.Open(ctx, "fixture", root, "file")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Open(context.Background(), "fixture", root, "file")
	if err != nil {
		t.Fatal(err)
	}
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer waitCancel()
	if _, err := s.List(waitCtx, "fixture", root, ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting for a slot = %v", err)
	}
	if state.started.Load() != 2 || state.active.Load() != 2 {
		t.Fatalf("connection bound bypassed: started=%d active=%d", state.started.Load(), state.active.Load())
	}
	cancel()
	await(t, first.(*sshFile).conn.done, "request cancellation cleanup")
	if _, err := first.Read(make([]byte, 1)); !errors.Is(err, context.Canceled) {
		t.Fatalf("Read after request cancellation = %v", err)
	}
	if _, err := s.List(context.Background(), "fixture", root, ""); err != nil {
		t.Fatalf("cancelled file did not release its slot: %v", err)
	}
	var closers sync.WaitGroup
	for i := 0; i < 10; i++ {
		closers.Go(func() { _ = s.Close() })
	}
	closers.Wait()
	if state.active.Load() != 0 {
		t.Fatal("store Close retained connections")
	}
	if _, err := second.Stat(); !errors.Is(err, fs.ErrClosed) {
		t.Fatalf("Stat after store Close = %v", err)
	}
	if _, err := s.Open(context.Background(), "fixture", root, "file"); !errors.Is(err, fs.ErrClosed) {
		t.Fatalf("Open after store Close = %v", err)
	}
	_ = first.Close()
	_ = second.Close()
}

func TestSSHCancellationDuringHandshake(t *testing.T) {
	for _, blocked := range []string{"read", "write"} {
		t.Run(blocked, func(t *testing.T) {
			s := NewSSH()
			defer s.Close()
			entered := make(chan struct{})
			peerDone := make(chan struct{})
			s.dial = func(context.Context, string) (io.ReadWriteCloser, error) {
				client, server := net.Pipe()
				go func() {
					defer close(peerDone)
					defer server.Close()
					close(entered)
					if blocked == "read" {
						// Accept INIT without ever sending VERSION.
						_, _ = io.Copy(io.Discard, server)
					} else {
						// Never read INIT, so the client write blocks.
						<-s.shutdown
					}
				}()
				return client, nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			result := make(chan error, 1)
			go func() {
				_, err := s.List(ctx, "fixture", "/root", "")
				result <- err
			}()
			await(t, entered, "handshake")
			cancel()
			if err := awaitError(t, result); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel handshake = %v", err)
			}
			_ = s.Close()
			await(t, peerDone, "handshake server cleanup")
		})
	}
}

func TestSSHOperationAndFileTimeouts(t *testing.T) {
	t.Run("stalled setup", func(t *testing.T) {
		s := NewSSH()
		defer s.Close()
		s.operationTimeout = 30 * time.Millisecond
		s.dial = func(ctx context.Context, _ string) (io.ReadWriteCloser, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		if _, err := s.List(context.Background(), "fixture", "/root", ""); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("setup timeout = %v", err)
		}
	})
	t.Run("file lifetime", func(t *testing.T) {
		root := t.TempDir()
		writeFixture(t, filepath.Join(root, "file"), "content")
		s, state := fixtureStore(t, &fixtureFS{})
		s.fileLifetime = 30 * time.Millisecond
		f, err := s.Open(context.Background(), "fixture", root, "file")
		if err != nil {
			t.Fatal(err)
		}
		await(t, f.(*sshFile).conn.done, "file lifetime")
		if _, err := f.Read(make([]byte, 1)); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expired file Read = %v", err)
		}
		if state.active.Load() != 0 {
			t.Fatal("expired file retained its connection")
		}
	})
}

func TestSSHBlockedFileReadCleanup(t *testing.T) {
	for _, action := range []string{"cancel request", "close file", "close store", "read timeout", "file lifetime"} {
		t.Run(action, func(t *testing.T) {
			root := t.TempDir()
			writeFixture(t, filepath.Join(root, "file"), "content")
			s, state := fixtureStore(t, &fixtureFS{})
			dial := s.dial
			var wire *gatedConn
			s.dial = func(ctx context.Context, target string) (io.ReadWriteCloser, error) {
				conn, err := dial(ctx, target)
				if err != nil {
					return nil, err
				}
				wire = &gatedConn{ReadWriteCloser: conn, entered: make(chan struct{}), closed: make(chan struct{})}
				return wire, nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f, err := s.Open(ctx, "fixture", root, "file")
			if err != nil {
				t.Fatal(err)
			}
			if action == "read timeout" {
				s.operationTimeout = 40 * time.Millisecond
			} else if action == "file lifetime" {
				f.(*sshFile).conn.setTimeout(40 * time.Millisecond)
			}
			wire.block.Store(true)
			result := make(chan error, 1)
			go func() {
				_, err := f.Read(make([]byte, 128<<10))
				result <- err
			}()
			await(t, wire.entered, "blocked file read")
			want := error(fs.ErrClosed)
			switch action {
			case "cancel request":
				cancel()
				want = context.Canceled
			case "close file":
				_ = f.Close()
			case "close store":
				_ = s.Close()
			case "read timeout", "file lifetime":
				want = context.DeadlineExceeded
			}
			if err := awaitError(t, result); !errors.Is(err, want) {
				t.Fatalf("blocked read = %v; want %v", err, want)
			}
			await(t, f.(*sshFile).conn.done, "blocked file cleanup")
			if state.active.Load() != 0 {
				t.Fatal("blocked read retained its connection")
			}
		})
	}
}

func TestSSHSubprocessCancellation(t *testing.T) {
	s := NewSSH()
	defer s.Close()
	var process *sshProcess
	started := make(chan struct{})
	s.dial = func(context.Context, string) (io.ReadWriteCloser, error) {
		cmd := exec.Command(os.Args[0], "-test.run=^TestStorageProcessHelper$")
		cmd.Env = append(os.Environ(), "ARTIFACE_STORAGE_TEST_HELPER=1")
		var err error
		process, err = startProcess(cmd)
		close(started)
		return process, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := s.List(ctx, "fixture", "/root", "")
		result <- err
	}()
	await(t, started, "subprocess startup")
	cancel()
	if err := awaitError(t, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("subprocess cancellation = %v", err)
	}
	if process == nil || process.cmd.ProcessState == nil {
		t.Fatal("subprocess was not reaped")
	}
	if err := process.Close(); err != nil {
		t.Fatalf("repeated process Close = %v", err)
	}
}

func TestSSHSubprocessFailureDoesNotExposeStderr(t *testing.T) {
	s := NewSSH()
	defer s.Close()
	var process *sshProcess
	s.dial = func(context.Context, string) (io.ReadWriteCloser, error) {
		cmd := exec.Command(os.Args[0], "-test.run=^TestStorageProcessHelper$")
		cmd.Env = append(os.Environ(), "ARTIFACE_STORAGE_TEST_HELPER=fail")
		var err error
		process, err = startProcess(cmd)
		return process, err
	}
	_, err := s.List(context.Background(), "fixture", "/root", "")
	if err == nil || strings.Contains(err.Error(), "private SSH diagnostic") {
		t.Fatalf("SSH failure = %v", err)
	}
	if process == nil || process.cmd.ProcessState == nil {
		t.Fatal("failed subprocess was not reaped")
	}
}

func TestStorageProcessHelper(t *testing.T) {
	mode := os.Getenv("ARTIFACE_STORAGE_TEST_HELPER")
	if mode == "" {
		return
	}
	_, _ = fmt.Fprintln(os.Stderr, "private SSH diagnostic that must never reach API errors")
	if mode == "fail" {
		os.Exit(23)
	}
	time.Sleep(time.Hour)
	os.Exit(0)
}

// These handlers use local fixtures and genuine SFTP framing over net.Pipe.
// RealPath deliberately resolves links, matching OpenSSH instead of pkg/sftp's
// default test server, which only converts paths to absolute form.
type fixtureFS struct {
	home        string
	opens       atomic.Int32
	closes      atomic.Int32
	reads       atomic.Int32
	beforeOpen  func(string)
	beforeClose func()
	readAt      func(*os.File, []byte, int64) (int, error)
}

func (f *fixtureFS) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	f.opens.Add(1)
	if f.beforeOpen != nil {
		f.beforeOpen(r.Filepath)
	}
	file, err := os.Open(r.Filepath)
	if err != nil {
		return nil, err
	}
	return &fixtureFile{File: file, reads: &f.reads, closes: &f.closes, readAt: f.readAt, beforeClose: f.beforeClose}, nil
}

type fixtureFile struct {
	*os.File
	reads       *atomic.Int32
	closes      *atomic.Int32
	readAt      func(*os.File, []byte, int64) (int, error)
	beforeClose func()
}

func (f *fixtureFile) Close() error {
	if f.beforeClose != nil {
		f.beforeClose()
	}
	f.closes.Add(1)
	return f.File.Close()
}

func (f *fixtureFile) ReadAt(p []byte, offset int64) (int, error) {
	f.reads.Add(1)
	if f.readAt != nil {
		return f.readAt(f.File, p, offset)
	}
	return f.File.ReadAt(p, offset)
}

func (f *fixtureFS) RealPath(p string) (string, error) {
	if p == "." && f.home != "" {
		p = f.home
	}
	absolute, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}

func (*fixtureFS) Readlink(p string) (string, error) { return os.Readlink(p) }

func (*fixtureFS) Lstat(r *sftp.Request) (sftp.ListerAt, error) {
	info, err := os.Lstat(r.Filepath)
	return fixtureList{info}, err
}

func (*fixtureFS) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	if r.Method == "Stat" {
		info, err := os.Stat(r.Filepath)
		return fixtureList{info}, err
	}
	entries, err := os.ReadDir(r.Filepath)
	if err != nil {
		return nil, err
	}
	infos := make(fixtureList, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		infos = append(infos, info)
	}
	return infos, nil
}

type fixtureList []os.FileInfo

func (l fixtureList) ListAt(dst []os.FileInfo, offset int64) (int, error) {
	if offset >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(dst, l[offset:])
	if n < len(dst) {
		return n, io.EOF
	}
	return n, nil
}

type fixtureState struct {
	active  atomic.Int32
	started atomic.Int32
	wg      sync.WaitGroup
}

type gatedConn struct {
	io.ReadWriteCloser
	block   atomic.Bool
	entered chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func (c *gatedConn) Read(p []byte) (int, error) {
	n, err := c.ReadWriteCloser.Read(p)
	if c.block.Load() {
		close(c.entered)
		<-c.closed
		return 0, io.ErrClosedPipe
	}
	return n, err
}

func (c *gatedConn) Close() error {
	c.once.Do(func() {
		close(c.closed)
		_ = c.ReadWriteCloser.Close()
	})
	return nil
}

type fixtureConn struct {
	net.Conn
	once  sync.Once
	state *fixtureState
}

func (c *fixtureConn) Close() error {
	c.once.Do(func() {
		_ = c.Conn.Close()
		c.state.active.Add(-1)
	})
	return nil
}

type fixtureHandlers interface {
	sftp.FileReader
	sftp.FileLister
}

func fixtureStore(t *testing.T, handlers fixtureHandlers, options ...sftp.RequestServerOption) (*SSH, *fixtureState) {
	t.Helper()
	s := NewSSH()
	state := &fixtureState{}
	s.dial = func(ctx context.Context, _ string) (io.ReadWriteCloser, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		client, server := net.Pipe()
		state.active.Add(1)
		state.started.Add(1)
		rs := sftp.NewRequestServer(server, sftp.Handlers{FileGet: handlers, FileList: handlers}, options...)
		state.wg.Go(func() {
			defer server.Close()
			defer rs.Close()
			_ = rs.Serve()
		})
		return &fixtureConn{Conn: client, state: state}, nil
	}
	t.Cleanup(func() {
		_ = s.Close()
		done := make(chan struct{})
		go func() {
			state.wg.Wait()
			close(done)
		}()
		await(t, done, "fixture server cleanup")
		if state.active.Load() != 0 {
			t.Error("fixture connections leaked")
		}
	})
	return s, state
}

func writeFixture(t *testing.T, name, content string) {
	t.Helper()
	if err := os.WriteFile(name, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func await(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func awaitError(t *testing.T, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for operation")
		return nil
	}
}
