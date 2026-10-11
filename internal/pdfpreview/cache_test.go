package pdfpreview

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type fakeRenderer struct {
	infos, pages   int
	block, entered chan struct{}
}

func (f *fakeRenderer) available() bool { return true }
func (f *fakeRenderer) outline(context.Context, *os.File, int) (Outline, error) {
	return Outline{}, ErrOutlineUnavailable
}
func (f *fakeRenderer) info(ctx context.Context, file *os.File, page int) (Info, error) {
	f.infos++
	if _, err := os.Stat(file.Name()); !errors.Is(err, os.ErrNotExist) {
		return Info{}, errors.New("snapshot was not unlinked")
	}
	return Info{Pages: 3, Width: 595, Height: 842}, nil
}
func (f *fakeRenderer) page(ctx context.Context, file *os.File, page, size int) (Page, error) {
	f.pages++
	if f.entered != nil {
		close(f.entered)
		select {
		case <-f.block:
		case <-ctx.Done():
			return Page{}, ctx.Err()
		}
	}
	return Page{JPEG: []byte("jpeg"), Width: 595, Height: 842}, nil
}

func source(t *testing.T) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "source-")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("%PDF-1.4\nfixture"); err != nil {
		t.Fatal(err)
	}
	file.Seek(0, io.SeekStart)
	t.Cleanup(func() { file.Close() })
	return file
}

func reopenSource(t *testing.T, file *os.File) *os.File {
	t.Helper()
	reopened, err := os.OpenFile(file.Name(), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.Close() })
	return reopened
}

func TestSnapshotReuseForcedRefreshExpiryAndCancellation(t *testing.T) {
	cache := New()
	defer cache.Close()
	renderer := &fakeRenderer{}
	cache.renderer = renderer
	file := source(t)
	stat, _ := file.Stat()
	first, err := cache.Document(context.Background(), "source-v1", file, stat, false)
	if err != nil {
		t.Fatal(err)
	}
	// The source is closed after copying: a cache hit must not read it again.
	second, err := cache.Document(context.Background(), "source-v1", file, stat, false)
	if err != nil || first.ID != second.ID || renderer.infos != 1 {
		t.Fatal("unchanged PDF was copied or parsed again", err)
	}
	for i, size := range []int{320, 960, 1440, 1920, 2560, 3200, 3840} {
		for range 2 {
			if _, err := cache.Page(context.Background(), "source-v1", first.ID, 1, size); err != nil {
				t.Fatalf("size %d: %v", size, err)
			}
		}
		if renderer.pages != i+1 {
			t.Fatalf("size %d did not get its own cached image", size)
		}
	}
	for _, invalid := range []struct{ page, size int }{{0, 960}, {4, 960}, {1, 999}, {10001, 1920}, {1, 3841}, {1, 4096}, {1, 1000000}} {
		if _, err := cache.Page(context.Background(), "source-v1", first.ID, invalid.page, invalid.size); !errors.Is(err, ErrPage) {
			t.Fatal("invalid request reached the renderer", err)
		}
	}
	if renderer.pages != 7 {
		t.Fatal("invalid request reached the renderer")
	}
	if _, err := cache.Page(context.Background(), "source-v2", first.ID, 1, 960); !errors.Is(err, ErrExpired) {
		t.Fatal("different source version reused old pages")
	}
	file, err = os.Open(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	replaced, err := cache.Document(context.Background(), "source-v1", file, stat, true)
	if err != nil || replaced.ID == first.ID {
		t.Fatal("manual refresh did not replace the snapshot", err)
	}
	if _, err := cache.Page(context.Background(), "source-v1", first.ID, 1, 960); !errors.Is(err, ErrExpired) {
		t.Fatal("old snapshot was still usable")
	}
	cache.mu.Lock()
	snapshot := cache.docs["source-v1"].file
	cache.docs["source-v1"].used = time.Now().Add(-idleLifetime)
	cache.pruneLocked(time.Now())
	cache.mu.Unlock()
	if _, err := snapshot.Stat(); err == nil || cache.bytes != 0 || cache.imgBytes != 0 {
		t.Fatal("idle snapshot retained its descriptor or cache bytes")
	}
	file = reopenSource(t, file)
	info, err := cache.Document(context.Background(), "cancel", file, stat, false)
	if err != nil {
		t.Fatal(err)
	}
	renderer.block, renderer.entered = make(chan struct{}), make(chan struct{})
	var group sync.WaitGroup
	group.Add(1)
	go func() {
		defer group.Done()
		if _, err := cache.Page(context.Background(), "cancel", info.ID, 1, 3840); !errors.Is(err, context.Canceled) {
			t.Errorf("shutdown did not cancel rendering: %v", err)
		}
	}()
	<-renderer.entered
	cache.Close()
	group.Wait()
	if cache.bytes != 0 || len(cache.docs) != 0 {
		t.Fatal("shutdown retained PDF data")
	}
}

type observedSource struct {
	*os.File
	closed chan struct{}
	once   sync.Once
	calls  atomic.Int32
}

func (s *observedSource) Close() error {
	s.calls.Add(1)
	s.once.Do(func() {
		_ = s.File.Close()
		close(s.closed)
	})
	return nil
}

type closingReadSource struct {
	*observedSource
	entered chan struct{}
}

func (s *closingReadSource) Read([]byte) (int, error) {
	close(s.entered)
	<-s.closed
	return 0, fs.ErrClosed
}

type waitingInfoRenderer struct {
	fakeRenderer
	entered, release chan struct{}
	err              error
}

func (r *waitingInfoRenderer) info(ctx context.Context, _ *os.File, _ int) (Info, error) {
	close(r.entered)
	select {
	case <-ctx.Done():
		if r.err != nil {
			return Info{}, r.err
		}
		return Info{}, ctx.Err()
	case <-r.release:
		return Info{Pages: 1, Width: 400, Height: 200}, r.err
	}
}

func TestSharedPreparationWaiterCancellationAndSourceRelease(t *testing.T) {
	for _, scenario := range []string{"success", "leader canceled", "leader deadline", "closed during copy", "waiter canceled", "decode error after cancellation", "renderer timeout", "shutdown"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cache := New()
				defer cache.Close()
				renderer := &waitingInfoRenderer{entered: make(chan struct{}), release: make(chan struct{})}
				if scenario == "decode error after cancellation" {
					renderer.err = ErrInvalid
				} else if scenario == "renderer timeout" {
					renderer.err = context.DeadlineExceeded
				}
				cache.renderer = renderer
				first := &observedSource{File: source(t), closed: make(chan struct{})}
				defer first.Close()
				stat, _ := first.Stat()
				second := &observedSource{File: reopenSource(t, first.File), closed: make(chan struct{})}
				defer second.Close()
				leader, cancelLeader := context.WithTimeout(context.Background(), time.Minute)
				defer cancelLeader()
				waiter, cancelWaiter := context.WithCancel(context.Background())
				defer cancelWaiter()
				var copying Source = first
				entered := renderer.entered
				if scenario == "closed during copy" {
					entered = make(chan struct{})
					copying = &closingReadSource{observedSource: first, entered: entered}
				}
				loaded := make(chan error, 1)
				go func() {
					_, err := cache.Document(leader, "shared", copying, stat, false)
					loaded <- err
				}()
				<-entered
				if scenario != "closed during copy" {
					select {
					case <-first.closed:
					default:
						t.Fatal("snapshot parsing retained the source file/SSH slot")
					}
				}
				waited := make(chan error, 1)
				go func() {
					_, err := cache.Document(waiter, "shared", second, stat, false)
					waited <- err
				}()
				<-second.closed
				wantLeader, wantWaiter := error(nil), error(nil)
				switch scenario {
				case "leader canceled", "closed during copy":
					cancelLeader()
					wantLeader, wantWaiter = context.Canceled, ErrSharedCanceled
				case "leader deadline":
					time.Sleep(time.Minute)
					wantLeader, wantWaiter = context.DeadlineExceeded, ErrSharedCanceled
				case "waiter canceled":
					cancelWaiter()
					synctest.Wait()
					close(renderer.release)
					wantWaiter = context.Canceled
				case "decode error after cancellation":
					cancelLeader()
					wantLeader, wantWaiter = ErrInvalid, ErrInvalid
				case "renderer timeout":
					close(renderer.release)
					wantLeader, wantWaiter = context.DeadlineExceeded, context.DeadlineExceeded
				case "shutdown":
					cache.Close()
					wantLeader, wantWaiter = context.Canceled, context.Canceled
				default:
					close(renderer.release)
				}
				if err := <-loaded; !errors.Is(err, wantLeader) {
					t.Fatalf("preparing request = %v; want %v", err, wantLeader)
				}
				if err := <-waited; !errors.Is(err, wantWaiter) {
					t.Fatalf("waiting request = %v; want %v", err, wantWaiter)
				}
				if wantWaiter == ErrSharedCanceled && waiter.Err() != nil {
					t.Fatal("retry requested for a canceled caller")
				}
				if _, err := first.Stat(); !errors.Is(err, fs.ErrClosed) {
					t.Fatal("closed source remained usable", err)
				}
				if first.calls.Load() != 1 || second.calls.Load() != 1 {
					t.Fatal("cache cancellation and early release called source.Close more than once")
				}
				// Deferred Close and cancellation after the early release remain safe.
				cancelLeader()
				first.Close()
				second.Close()
				if wantLeader != nil && (len(cache.docs) != 0 || cache.bytes != 0) {
					t.Fatal("failed shared preparation retained a snapshot or its budget")
				}
			})
		})
	}
}

func TestCachedPageDoesNotWaitForRenderer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cache := New()
		defer cache.Close()
		renderer := &fakeRenderer{}
		cache.renderer = renderer
		file := source(t)
		stat, _ := file.Stat()
		info, err := cache.Document(context.Background(), "source", file, stat, false)
		if err != nil {
			t.Fatal(err)
		}
		first, err := cache.Page(context.Background(), "source", info.ID, 1, 3840)
		if err != nil {
			t.Fatal(err)
		}

		renderer.block, renderer.entered = make(chan struct{}), make(chan struct{})
		rendered := make(chan error, 2)
		renderSecond := func() {
			_, err := cache.Page(context.Background(), "source", info.ID, 2, 3840)
			rendered <- err
		}
		go renderSecond()
		<-renderer.entered
		// A second cache miss must still share the pending page's render.
		go renderSecond()
		type result struct {
			page Page
			err  error
		}
		cached := make(chan result, 1)
		go func() {
			page, err := cache.Page(context.Background(), "source", info.ID, 1, 3840)
			cached <- result{page, err}
		}()
		synctest.Wait()
		select {
		case got := <-cached:
			if got.err != nil || !bytes.Equal(got.page.JPEG, first.JPEG) {
				t.Fatalf("cached page: %v", got.err)
			}
		default:
			t.Fatal("cached page waited for the blocked renderer")
		}
		close(renderer.block)
		for range 2 {
			if err := <-rendered; err != nil {
				t.Fatal(err)
			}
		}
		if renderer.pages != 2 {
			t.Fatal("concurrent requests rendered the same page more than once")
		}
	})
}

type batchSource struct {
	*os.File
	maxRead int
}

func (s *batchSource) Read(p []byte) (int, error) {
	s.maxRead = max(s.maxRead, len(p))
	return s.File.Read(p)
}

func TestSnapshotCopyUsesBoundedBatches(t *testing.T) {
	cache := New()
	defer cache.Close()
	cache.renderer = &fakeRenderer{}
	file := source(t)
	data := append([]byte("%PDF-1.4\n"), bytes.Repeat([]byte("snapshot data\n"), 25000)...)
	if _, err := file.WriteAt(data, 0); err != nil {
		t.Fatal(err)
	}
	stat, _ := file.Stat()
	source := &batchSource{File: file}
	if _, err := cache.Document(context.Background(), "batch", source, stat, false); err != nil {
		t.Fatal(err)
	}
	if source.maxRead != 128<<10 {
		t.Fatalf("snapshot copy did not use bounded 128 KiB reads: %d", source.maxRead)
	}
	cache.mu.Lock()
	snapshot := cache.docs["batch"].file
	cache.mu.Unlock()
	copied := make([]byte, len(data))
	if _, err := snapshot.ReadAt(copied, 0); err != nil || !bytes.Equal(copied, data) {
		t.Fatalf("snapshot copy changed bytes: %v", err)
	}
}

func TestSnapshotLimitsAndSourceMutation(t *testing.T) {
	cache := New()
	defer cache.Close()
	cache.renderer = &fakeRenderer{}
	file := source(t)
	stat, _ := file.Stat()
	for i := range maxDocuments + 1 {
		file = reopenSource(t, file)
		if _, err := cache.Document(context.Background(), fmt.Sprint(i), file, stat, false); err != nil {
			t.Fatal(err)
		}
	}
	if len(cache.docs) != maxDocuments || cache.docs["0"] != nil {
		t.Fatal("source LRU limit not enforced")
	}
	// Growing input cannot be copied past its validated size.
	file = reopenSource(t, file)
	file.Seek(0, io.SeekEnd)
	file.WriteString("changed")
	file.Seek(0, io.SeekStart)
	if _, err := cache.Document(context.Background(), "changed", file, stat, false); !errors.Is(err, ErrChanged) {
		t.Fatal("mutating source was accepted", err)
	}
	if err := file.Truncate(MaxSourceBytes + 1); err != nil {
		t.Fatal(err)
	}
	large, _ := file.Stat()
	if _, err := cache.Document(context.Background(), "large", file, large, false); !errors.Is(err, ErrTooLarge) {
		t.Fatal("source size limit not enforced", err)
	}
}

func pdfFixture() []byte {
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
	stream := "BT /F1 20 Tf 40 100 Td (Compression fixture) Tj ET"
	objects = append(objects, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream))
	var data strings.Builder
	data.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, object := range objects {
		offsets = append(offsets, data.Len())
		fmt.Fprintf(&data, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := data.Len()
	fmt.Fprintf(&data, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&data, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&data, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return []byte(data.String())
}

func TestPopplerRendersAnonymousDescriptorAndRejectsNonPDF(t *testing.T) {
	cache := New()
	defer cache.Close()
	if !cache.Available() {
		t.Skip("Poppler is optional for native installs; Docker checks require it")
	}
	filename := filepath.Join(t.TempDir(), "report.pdf")
	if err := os.WriteFile(filename, pdfFixture(), 0600); err != nil {
		t.Fatal(err)
	}
	file, _ := os.Open(filename)
	defer file.Close()
	stat, _ := file.Stat()
	info, err := cache.Document(context.Background(), "real", file, stat, false)
	if err != nil || info.Pages != 1 || info.Width != 400 || info.Height != 200 {
		t.Fatal("real PDF metadata", info, err)
	}
	for _, size := range []int{320, 960, 3840} {
		page, err := cache.Page(context.Background(), "real", info.ID, 1, size)
		if err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		dimensions, err := jpeg.DecodeConfig(bytes.NewReader(page.JPEG))
		if err != nil || dimensions.Width != size || dimensions.Height < size/2 || dimensions.Height > size/2+1 {
			t.Fatalf("size %d: invalid rendered image %+v: %v", size, dimensions, err)
		}
		if len(page.JPEG) > 8<<20 {
			t.Fatal("rendered image exceeded output byte limit")
		}
	}
	if err := os.WriteFile(filename, []byte("<html>not PDF</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	file = reopenSource(t, file)
	stat, _ = file.Stat()
	if _, err := cache.Document(context.Background(), "invalid", file, stat, false); !errors.Is(err, ErrInvalid) {
		t.Fatal("non-PDF input was rendered", err)
	}
}
