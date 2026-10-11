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
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/pkg/sftp"
)

func TestSSHPoolReusesTransportWithFreshLeasesRootsAndTargets(t *testing.T) {
	firstRoot, secondRoot := t.TempDir(), t.TempDir()
	writeFixture(t, filepath.Join(firstRoot, "file"), "first")
	writeFixture(t, filepath.Join(secondRoot, "file"), "second")
	if err := os.Mkdir(filepath.Join(secondRoot, "scope"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../file", filepath.Join(secondRoot, "scope", "escape")); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(firstRoot, root); err != nil {
		t.Fatal(err)
	}
	fixture := &fixtureFS{home: secondRoot}
	store, state := fixtureStore(t, fixture)
	oldCtx, oldCancel := context.WithCancel(context.Background())
	defer oldCancel()
	first, err := store.Open(oldCtx, "fixture", root, "file")
	if err != nil {
		t.Fatal(err)
	}
	firstLease := first.(*sshFile).conn
	first.Close()
	if fixture.closes.Load() != 1 || state.active.Load() != 1 {
		t.Fatal("returning a file did not close its remote handle and retain its transport")
	}
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secondRoot, root); err != nil {
		t.Fatal(err)
	}
	second, err := store.Open(context.Background(), "fixture", root, "file")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	secondLease := second.(*sshFile).conn
	if firstLease == secondLease || firstLease.sshTransport != secondLease.sshTransport {
		t.Fatal("checkout did not create a fresh lease on the same transport")
	}
	oldCancel()
	first.Close()
	if _, err := first.Read(make([]byte, 1)); !errors.Is(err, fs.ErrClosed) {
		t.Fatal("an old file could use the checked-out transport", err)
	}
	data, err := io.ReadAll(second)
	if err != nil || string(data) != "second" {
		t.Fatalf("old cancellation or a cached root affected the next lease: %q, %v", data, err)
	}
	second.Close()
	if _, err := store.List(context.Background(), "fixture", root, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(context.Background(), "fixture", root, "file"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BrowseFolders(context.Background(), "fixture", ""); err != nil {
		t.Fatal(err)
	}
	if result, err := ListRecursive(context.Background(), store, "fixture", root, "", false, nil); err != nil || result.Truncated {
		t.Fatal(result, err)
	}
	if state.started.Load() != 1 || fixture.closes.Load() != 2 || len(store.active) != 0 {
		t.Fatal("sequential file and metadata operations repeated setup or retained a lease")
	}
	other, err := store.Open(context.Background(), "other-target", root, "file")
	if err != nil {
		t.Fatal(err)
	}
	if other.(*sshFile).conn.sshTransport == secondLease.sshTransport || state.started.Load() != 2 {
		t.Fatal("different SSH targets shared an authenticated transport")
	}
	other.Close()
	opens := fixture.opens.Load()
	if file, err := store.OpenScoped(context.Background(), "fixture", root, "scope", "escape"); file != nil || !errors.Is(err, ErrForbidden) || fixture.opens.Load() != opens {
		t.Fatal("a pooled connection bypassed preview containment", err)
	}
	if state.active.Load() != 1 || len(store.idle) != 1 {
		t.Fatal("a failed lease was retained or another target's idle transport was discarded")
	}
}

func TestSSHPoolBoundsIdleAndBusyConnectionsAndEvictsOtherTargets(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "file"), "content")
	store, state := fixtureStore(t, &fixtureFS{})
	files := make([]File, maxConnections)
	for i := range files {
		var err error
		files[i], err = store.Open(context.Background(), "fixture", root, "file")
		if err != nil {
			t.Fatal(err)
		}
		defer files[i].Close()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := store.List(ctx, "fixture", root, ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("full pool did not bound its waiting request", err)
	}
	for _, file := range files[1:] {
		file.Close()
	}
	if state.started.Load() != maxConnections || state.active.Load() != maxConnections ||
		len(store.active) != 1 || len(store.idle) != maxConnections-1 {
		t.Fatal("idle connections escaped the total connection bound")
	}
	if _, err := store.List(context.Background(), "fixture", root, ""); err != nil {
		t.Fatal("idle return did not release capacity to same-target requests", err)
	}
	if state.started.Load() != maxConnections {
		t.Fatal("same-target checkout ignored available idle connections")
	}
	if _, err := store.List(context.Background(), "another-target", root, ""); err != nil {
		t.Fatal("other-target request could not evict an idle connection", err)
	}
	if state.started.Load() != maxConnections+1 || state.active.Load() != maxConnections {
		t.Fatal("eviction exceeded the total connection bound")
	}
	if data, err := io.ReadAll(files[0]); err != nil || string(data) != "content" {
		t.Fatal("idle eviction interrupted an active lease", err)
	}
	var closers sync.WaitGroup
	for range 5 {
		closers.Go(func() { _ = store.Close() })
	}
	closers.Wait()
	if state.active.Load() != 0 || len(store.slots) != 0 || len(store.idle) != 0 || len(store.active) != 0 {
		t.Fatal("shutdown retained active or idle transports")
	}
}

func TestSSHPoolWaitingRequestWakesWhenLeaseReturns(t *testing.T) {
	for _, target := range []string{"fixture", "other-target"} {
		t.Run(target, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				root := t.TempDir()
				writeFixture(t, filepath.Join(root, "file"), "content")
				store, state := fixtureStore(t, &fixtureFS{})
				store.slots = make(chan struct{}, 1)
				file, err := store.Open(context.Background(), "fixture", root, "file")
				if err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				go func() {
					_, err := store.List(context.Background(), target, root, "")
					done <- err
				}()
				synctest.Wait()
				select {
				case err := <-done:
					t.Fatal("a waiter bypassed the occupied pool slot", err)
				default:
				}
				file.Close()
				if err := <-done; err != nil {
					t.Fatal("returning a lease did not wake its waiter", err)
				}
				wantStarts := int32(1)
				if target != "fixture" {
					wantStarts = 2
				}
				if state.started.Load() != wantStarts || state.active.Load() != 1 || len(store.active) != 0 {
					t.Fatal("waiting checkout did not reuse or evict the returned transport")
				}
			})
		})
	}
}

func TestSSHPoolIdleExpiryAndAbsoluteLifetime(t *testing.T) {
	for _, kind := range []string{"idle", "reuse cutoff", "absolute lifetime"} {
		t.Run(kind, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				root := t.TempDir()
				writeFixture(t, filepath.Join(root, "file"), "content")
				store, state := fixtureStore(t, &fixtureFS{})
				if kind == "absolute lifetime" {
					// Isolate the absolute cap from the ordinary shorter file timer.
					store.fileLifetime = 2 * defaultTransportLifetime
					file, err := store.Open(context.Background(), "fixture", root, "file")
					if err != nil {
						t.Fatal(err)
					}
					defer file.Close()
					time.Sleep(defaultTransportLifetime)
					await(t, file.(*sshFile).conn.done, "absolute transport lifetime")
					if _, err := file.Read(make([]byte, 1)); !errors.Is(err, context.DeadlineExceeded) {
						t.Fatal("active file outlived its authenticated transport", err)
					}
				} else {
					if _, err := store.List(context.Background(), "fixture", root, ""); err != nil {
						t.Fatal(err)
					}
					if kind == "idle" {
						time.Sleep(defaultIdleTimeout - time.Second)
						if state.active.Load() != 1 {
							t.Fatal("idle connection expired early")
						}
						time.Sleep(time.Second)
					} else {
						// Frequent use refreshes idle expiry, never reuse eligibility.
						for range 9 {
							time.Sleep(30 * time.Second)
							if _, err := store.List(context.Background(), "fixture", root, ""); err != nil {
								t.Fatal(err)
							}
						}
						time.Sleep(30 * time.Second)
					}
				}
				synctest.Wait()
				if state.started.Load() != 1 || state.active.Load() != 0 || len(store.slots) != 0 {
					t.Fatal("expiry redialed or retained its process/slot")
				}
				if _, err := store.List(context.Background(), "fixture", root, ""); err != nil || state.started.Load() != 2 {
					t.Fatal("expired transport was reused", err)
				}
			})
		})
	}
}

func TestSSHPoolFileKeepsFullLifetimeNearReuseCutoff(t *testing.T) {
	for _, tc := range []struct {
		name        string
		age         time.Duration
		reused      bool
		returnEarly bool
	}{
		{"borrowed file lifetime", defaultReuseWindow - defaultOperationTimeout - time.Second, true, false},
		{"retire on return", defaultReuseWindow - defaultOperationTimeout - time.Second, true, true},
		{"new transport near cutoff", defaultReuseWindow - time.Second, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				root := t.TempDir()
				writeFixture(t, filepath.Join(root, "file"), "content")
				fixture := &fixtureFS{beforeOpen: func(string) {
					// Include almost the entire setup budget before the file timer starts.
					time.Sleep(defaultOperationTimeout - time.Second)
				}}
				store, state := fixtureStore(t, fixture)
				if _, err := store.List(context.Background(), "fixture", root, ""); err != nil {
					t.Fatal(err)
				}
				var original *sshTransport
				for transport := range store.idle {
					original = transport
				}
				untilOpen := time.Now().Add(tc.age)
				for time.Now().Before(untilOpen) {
					time.Sleep(min(30*time.Second, time.Until(untilOpen)))
					if _, err := store.List(context.Background(), "fixture", root, ""); err != nil {
						t.Fatal(err)
					}
				}
				file, err := store.Open(context.Background(), "fixture", root, "file")
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				conn := file.(*sshFile).conn
				wantStarts := int32(1)
				if !tc.reused {
					wantStarts = 2
				}
				if (conn.sshTransport == original) != tc.reused || state.started.Load() != wantStarts ||
					time.Until(conn.expires) < defaultFileLifetime {
					t.Fatal("file checkout did not reserve its complete post-open lifetime")
				}
				if tc.returnEarly {
					time.Sleep(time.Until(original.reuseUntil) + time.Second)
					file.Close()
				} else {
					time.Sleep(defaultFileLifetime - time.Second)
					if _, err := file.Read(make([]byte, 1)); err != nil {
						t.Fatal("transport age shortened the file's five-minute lease", err)
					}
					time.Sleep(time.Second)
					await(t, conn.done, "complete file lifetime")
					if _, err := file.Read(make([]byte, 1)); !errors.Is(err, context.DeadlineExceeded) {
						t.Fatal("file exceeded its normal lifetime", err)
					}
				}
				synctest.Wait()
				if state.active.Load() != 0 || len(store.idle) != 0 || len(store.slots) != 0 {
					t.Fatal("transport was pooled after its reuse cutoff or file expiry")
				}
				if _, err := store.List(context.Background(), "fixture", root, ""); err != nil ||
					state.started.Load() != wantStarts+1 {
					t.Fatal("retired transport accepted another lease", err)
				}
			})
		})
	}
}

func TestSSHPoolDiscardsDisconnectedAndFailedLeases(t *testing.T) {
	for _, failure := range []string{"idle disconnect", "missing file", "read error", "closed request"} {
		t.Run(failure, func(t *testing.T) {
			root := t.TempDir()
			writeFixture(t, filepath.Join(root, "file"), "content")
			fixture := &fixtureFS{}
			store, state := fixtureStore(t, fixture)
			if _, err := store.List(context.Background(), "fixture", root, ""); err != nil {
				t.Fatal(err)
			}
			switch failure {
			case "idle disconnect":
				for transport := range store.idle {
					_ = transport.wire.Close()
					await(t, transport.dead, "idle peer disconnect")
				}
			case "missing file":
				if _, err := store.Open(context.Background(), "fixture", root, "missing"); !errors.Is(err, fs.ErrNotExist) {
					t.Fatal(err)
				}
			case "read error":
				fixture.readAt = func(*os.File, []byte, int64) (int, error) {
					return 0, io.ErrUnexpectedEOF
				}
				file, err := store.Open(context.Background(), "fixture", root, "file")
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.Read(make([]byte, 1)); err == nil {
					t.Fatal("fixture read did not fail")
				}
				file.Close()
			case "closed request":
				ctx, cancel := context.WithCancelCause(context.Background())
				file, err := store.Open(ctx, "fixture", root, "file")
				if err != nil {
					t.Fatal(err)
				}
				cancel(fs.ErrClosed)
				await(t, file.(*sshFile).conn.done, "request cancellation with fs.ErrClosed")
				file.Close()
			}
			if state.active.Load() != 0 {
				t.Fatal("disconnected or failed connection stayed live")
			}
			if _, err := store.List(context.Background(), "fixture", root, ""); err != nil || state.started.Load() != 2 {
				t.Fatal("failed connection was reused", err)
			}
		})
	}
}

func TestSSHPoolCloseReplyTimeoutDiscardsTransport(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		root := t.TempDir()
		writeFixture(t, filepath.Join(root, "file"), "content")
		gate, entered := make(chan struct{}), make(chan struct{})
		defer close(gate)
		fixture := &fixtureFS{beforeClose: func() {
			close(entered)
			<-gate
		}}
		store, state := fixtureStore(t, fixture)
		file, err := store.Open(context.Background(), "fixture", root, "file")
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() {
			file.Close()
			close(done)
		}()
		<-entered
		time.Sleep(defaultOperationTimeout)
		<-done
		if state.active.Load() != 0 || len(store.idle) != 0 || len(store.slots) != 0 {
			t.Fatal("unresponsive SFTP CLOSE was pooled or retained its slot")
		}
	})
}

func TestSSHPoolResetsListingBudgetBetweenLeases(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "file"), "content")
	info, err := os.Stat(filepath.Join(root, "file"))
	if err != nil {
		t.Fatal(err)
	}
	infos := make(fixtureList, maxDirectoryEntries)
	for i := range infos {
		infos[i] = sessionFileInfo{FileInfo: info, name: fmt.Sprintf("%05d-%s", i, strings.Repeat("x", 512))}
	}
	fixture := &sessionFixture{fixtureFS: &fixtureFS{}, list: func(*sftp.Request) (sftp.ListerAt, error) {
		return infos, nil
	}}
	store, state := fixtureStore(t, fixture)
	for range 3 {
		entries, err := store.List(context.Background(), "fixture", root, "")
		if err != nil || len(entries) != len(infos) {
			t.Fatalf("another lease inherited a directory response budget: entries=%d err=%v", len(entries), err)
		}
	}
	if state.started.Load() != 1 || state.active.Load() != 1 {
		t.Fatal("independent listing budgets required separate connections")
	}
}

func TestSSHPoolReusesAndReapsOwnedSubprocess(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "file"), "content")
	store := openSSHSubsystem(t)
	dial := store.dial
	var processes []*sshProcess
	store.dial = func(ctx context.Context, target string) (io.ReadWriteCloser, error) {
		wire, err := dial(ctx, target)
		if err == nil {
			processes = append(processes, wire.(*sshProcess))
		}
		return wire, err
	}
	for range 3 {
		if _, err := store.List(context.Background(), "fixture", root, ""); err != nil {
			t.Fatal(err)
		}
		file, err := store.Open(context.Background(), "fixture", root, "file")
		if err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
	if len(processes) != 1 || processes[0].cmd.ProcessState != nil {
		t.Fatal("sequential operations restarted or prematurely reaped the SFTP subprocess")
	}
	store.Close()
	if processes[0].cmd.ProcessState == nil || len(store.slots) != 0 {
		t.Fatal("store shutdown did not reap its idle subprocess")
	}
}
