package pdfpreview

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"testing/synctest"
	"time"
	"unicode/utf8"
)

func TestPopplerOutlineParsingAndBounds(t *testing.T) {
	wrap := func(body string) []byte {
		return []byte(`<?xml version="1.0"?><!DOCTYPE pdf2xml SYSTEM "pdf2xml.dtd"><pdf2xml>` +
			`<page number="1"><text>Private page text must not be returned</text></page>` + body + `</pdf2xml>`)
	}
	data := wrap(`<outline><item page="1"> Chapter &amp; Ω </item><outline><item page="3">Child</item></outline>` +
		`<item>Group</item><outline><item page="2">Nested</item></outline>` +
		`<item page="0">External</item><item page="4">Outside</item><item page="-1">Invalid</item><item> </item></outline>`)
	result, err := parseOutline(data, 3)
	if err != nil || result.Truncated || len(result.Items) != 8 {
		t.Fatalf("outline: %+v, %v", result, err)
	}
	for i, expected := range []struct {
		title string
		depth int
		page  int
	}{{"Chapter & Ω", 0, 1}, {"Child", 1, 3}, {"Group", 0, 0}, {"Nested", 1, 2},
		{"External", 0, 0}, {"Outside", 0, 0}, {"Invalid", 0, 0}, {"Untitled section", 0, 0}} {
		item := result.Items[i]
		page := 0
		if item.Page != nil {
			page = *item.Page
		}
		if item.Title != expected.title || item.Depth != expected.depth || page != expected.page {
			t.Fatalf("item %d: %+v, page %d", i, item, page)
		}
	}
	encoded, _ := json.Marshal(result)
	if bytes.Contains(encoded, []byte("Private")) || !bytes.Contains(encoded, []byte(`"page":null`)) {
		t.Fatalf("unexpected response: %s", encoded)
	}
	result, err = parseOutline(wrap(""), 3)
	if err != nil || result.Items == nil || len(result.Items) != 0 || result.Truncated {
		t.Fatal("no bookmarks must return an empty array", result, err)
	}
	for _, count := range []int{500, 501} {
		result, err = parseOutline(wrap("<outline>"+strings.Repeat(`<item page="1">Entry</item>`, count)+"</outline>"), 3)
		if err != nil || len(result.Items) != 500 || result.Truncated != (count > 500) {
			t.Fatal("entry limit", len(result.Items), result.Truncated, err)
		}
	}
	var deep strings.Builder
	for range 33 {
		deep.WriteString(`<outline><item page="1">Level</item>`)
	}
	deep.WriteString(strings.Repeat("</outline>", 32))
	deep.WriteString(`<item page="2">Last sibling</item></outline>`)
	result, err = parseOutline(wrap(deep.String()), 3)
	if err != nil || !result.Truncated || len(result.Items) != 33 ||
		result.Items[31].Depth != 31 || result.Items[32].Depth != 0 || result.Items[32].Title != "Last sibling" {
		t.Fatal("depth truncation lost a later sibling", result, err)
	}
	result, err = parseOutline(wrap("<outline><item>"+strings.Repeat("尾", 4097)+"</item></outline>"), 3)
	if err != nil || !result.Truncated || utf8.RuneCountInString(result.Items[0].Title) != 4096 ||
		!utf8.ValidString(result.Items[0].Title) {
		t.Fatal("title limit broke Unicode", err)
	}
	for _, invalid := range [][]byte{
		nil, []byte("<pdf2xml><outline>"), []byte("<pdf2xml/><pdf2xml/>"),
		wrap(`<outline><item>&unresolved;</item></outline>`),
		append(wrap(""), bytes.Repeat([]byte(" "), maxOutlineBytes)...),
	} {
		if _, err := parseOutline(invalid, 3); !errors.Is(err, ErrOutlineUnavailable) {
			t.Fatal("invalid or oversized XML was accepted", err)
		}
	}
}

type outlineRenderer struct {
	fakeRenderer
	calls int
	run   func(context.Context, *os.File, int) (Outline, error)
}

func (r *outlineRenderer) outline(ctx context.Context, file *os.File, pages int) (Outline, error) {
	r.calls++
	return r.run(ctx, file, pages)
}

func TestOutlineCacheSerializationCancellationAndLifetime(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cache := New()
		defer cache.Close()
		entered, release := make(chan struct{}), make(chan struct{})
		renderer := &outlineRenderer{run: func(ctx context.Context, file *os.File, pages int) (Outline, error) {
			if _, err := os.Stat(file.Name()); !errors.Is(err, os.ErrNotExist) || pages != 3 {
				t.Error("outline did not use the validated anonymous snapshot")
			}
			close(entered)
			select {
			case <-release:
				return Outline{Items: []OutlineItem{{Title: "Section"}}}, nil
			case <-ctx.Done():
				return Outline{}, ctx.Err()
			}
		}}
		cache.renderer = renderer
		file := source(t)
		stat, _ := file.Stat()
		info, err := cache.Document(context.Background(), "source", file, stat, false)
		if err != nil {
			t.Fatal(err)
		}
		if renderer.calls != 0 {
			t.Fatal("metadata eagerly extracted the outline")
		}
		// Occupying both global slots must also block outline extraction.
		cache.jobs <- struct{}{}
		cache.jobs <- struct{}{}
		leader, cancel := context.WithCancel(context.Background())
		done := make(chan error, 2)
		go func() {
			_, err := cache.Outline(leader, "source", info.ID)
			done <- err
		}()
		synctest.Wait()
		if renderer.calls != 0 {
			t.Fatal("outline bypassed the global job bound")
		}
		<-cache.jobs
		<-cache.jobs
		<-entered
		waiter, cancelWaiter := context.WithCancel(context.Background())
		go func() {
			_, err := cache.Outline(waiter, "source", info.ID)
			done <- err
		}()
		synctest.Wait()
		cancelWaiter()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatal("waiting outline did not honor cancellation", err)
		}
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatal("extracting outline did not honor cancellation", err)
		}
		if cache.docs["source"].outlineReady {
			t.Fatal("cancellation poisoned the snapshot's outline cache")
		}
		entered, release = make(chan struct{}), make(chan struct{})
		for range 2 {
			go func() {
				_, err := cache.Outline(context.Background(), "source", info.ID)
				done <- err
			}()
		}
		<-entered
		synctest.Wait()
		if renderer.calls != 2 {
			t.Fatal("concurrent outlines were not deduplicated")
		}
		pageDone := make(chan error, 1)
		go func() {
			_, err := cache.Page(context.Background(), "source", info.ID, 1, 320)
			pageDone <- err
		}()
		synctest.Wait()
		if renderer.pages != 0 {
			t.Fatal("page renderer accessed the shared descriptor during extraction")
		}
		close(release)
		for range 2 {
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		if err := <-pageDone; err != nil {
			t.Fatal(err)
		}
		if renderer.calls != 2 {
			t.Fatal("outline was extracted again after waiting")
		}
		renderer.block, renderer.entered = make(chan struct{}), make(chan struct{})
		go func() {
			_, err := cache.Page(context.Background(), "source", info.ID, 2, 320)
			pageDone <- err
		}()
		<-renderer.entered
		// A cached outline must remain responsive while another page renders.
		cached := make(chan error, 1)
		go func() {
			result, err := cache.Outline(context.Background(), "source", info.ID)
			if err == nil && len(result.Items) != 1 {
				err = errors.New("cached outline changed")
			}
			cached <- err
		}()
		synctest.Wait()
		select {
		case err := <-cached:
			if err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatal("cached outline waited for the page renderer")
		}
		close(renderer.block)
		if err := <-pageDone; err != nil {
			t.Fatal(err)
		}
		for _, pair := range [][2]string{{"changed-source", info.ID}, {"source", strings.Repeat("0", 32)}} {
			if _, err := cache.Outline(context.Background(), pair[0], pair[1]); !errors.Is(err, ErrExpired) {
				t.Fatal("outline ignored source/snapshot identity", err)
			}
		}
		cache.mu.Lock()
		snapshot := cache.docs["source"].file
		cache.docs["source"].used = time.Now().Add(-idleLifetime)
		cache.pruneLocked(time.Now())
		cache.mu.Unlock()
		if _, err := cache.Outline(context.Background(), "source", info.ID); !errors.Is(err, ErrExpired) {
			t.Fatal("outline survived snapshot eviction", err)
		}
		if _, err := snapshot.Stat(); err == nil {
			t.Fatal("outline retained the expired snapshot")
		}
	})
}

func TestUnavailableOutlineIsCachedWithoutDisablingPages(t *testing.T) {
	cache := New()
	defer cache.Close()
	renderer := &outlineRenderer{run: func(context.Context, *os.File, int) (Outline, error) {
		return Outline{}, ErrOutlineUnavailable
	}}
	cache.renderer = renderer
	file := source(t)
	stat, _ := file.Stat()
	info, err := cache.Document(context.Background(), "source", file, stat, false)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := cache.Outline(context.Background(), "source", info.ID); !errors.Is(err, ErrOutlineUnavailable) {
			t.Fatal(err)
		}
	}
	if renderer.calls != 1 {
		t.Fatal("permanent extraction failure was retried")
	}
	if _, err := cache.Page(context.Background(), "source", info.ID, 1, 320); err != nil {
		t.Fatal("outline failure disabled compression", err)
	}
}

func outlineFixture() []byte {
	// The second page has a marker proving that only page one is converted.
	first := "q 1 0 0 1 0 0 cm /Im1 Do Q"
	second := "BT /F1 12 Tf 10 50 Td (SECOND_PAGE_PRIVATE_TEXT) Tj ET"
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /Names << /Dests << /Names [(finish) [4 0 R /Fit]] >> >> >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 13 0 R >> >> /Contents 6 0 R >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(first), first),
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(second), second),
		"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nRGB\nendstream",
		"<< /Type /Outlines /First 9 0 R /Last 12 0 R /Count 4 >>",
		"<< /Title (Chapter & First) /Parent 8 0 R /Dest [3 0 R /Fit] /First 10 0 R /Last 10 0 R /Count 1 /Next 11 0 R >>",
		"<< /Title (Nested last page) /Parent 9 0 R /Dest [4 0 R /Fit] >>",
		"<< /Title <FEFF0055006E00690063006F00640065002003A900205C3E> /Parent 8 0 R /Dest (finish) /Prev 9 0 R /Next 12 0 R >>",
		"<< /Title (External) /Parent 8 0 R /A << /S /URI /URI (https://example.invalid/) >> /Prev 11 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
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

func TestPopplerOutlineAnonymousSnapshotAndStdoutOnly(t *testing.T) {
	cache := New()
	defer cache.Close()
	p := cache.renderer.(*poppler)
	if !p.available() || p.pdftohtml == "" {
		t.Skip("Poppler/pdftohtml is optional for native installs")
	}
	work := t.TempDir()
	t.Chdir(work)
	file := source(t)
	data := outlineFixture()
	if err := os.WriteFile(file.Name(), data, 0600); err != nil {
		t.Fatal(err)
	}
	stat, _ := file.Stat()
	info, err := cache.Document(context.Background(), "real", file, stat, false)
	if err != nil {
		t.Fatal(err)
	}
	result, err := cache.Outline(context.Background(), "real", info.ID)
	one, two := 1, 2
	want := Outline{Items: []OutlineItem{
		{Title: "Chapter & First", Page: &one},
		{Title: "Nested last page", Depth: 1, Page: &two},
		{Title: "Unicode Ω 尾", Page: &two},
		{Title: "External"},
	}}
	if err != nil || !reflect.DeepEqual(result, want) {
		t.Fatalf("real outline: %+v, %v", result, err)
	}
	entries, err := os.ReadDir(work)
	if err != nil || len(entries) != 0 {
		t.Fatal("outline extraction generated files", entries, err)
	}
	// Observe raw output once to catch accidental full-document conversion.
	raw, err := p.runWithFileLimit(context.Background(), cache.docs["real"].file, p.pdftohtml,
		[]string{"-xml", "-stdout", "-i", "-enc", "UTF-8", "-f", "1", "-l", "1"}, maxOutlineBytes, 0)
	if err != nil || bytes.Contains(raw, []byte("SECOND_PAGE_PRIVATE_TEXT")) || bytes.Contains(raw, []byte("<image")) {
		t.Fatal("outline extraction converted later pages or images", err)
	}
	p.pdftohtml = ""
	if !p.available() {
		t.Fatal("missing outline utility disabled compression")
	}
	if _, err := p.outline(context.Background(), cache.docs["real"].file, info.Pages); !errors.Is(err, ErrOutlineUnavailable) {
		t.Fatal("missing outline utility did not report unavailable", err)
	}
}

func TestOutlineSubprocessOutputAndFileLimits(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("prlimit is the Linux resource boundary")
	}
	p := newPoppler()
	if p.prlimit == "" {
		t.Skip("prlimit is not installed")
	}
	script := filepath.Join(t.TempDir(), "outline-tool")
	file := source(t)
	// Check the actual inherited file-size limit before producing XML.
	if err := os.WriteFile(script, []byte("#!/bin/sh\n[ \"$(ulimit -f)\" = 0 ] || exit 1\nprintf '<pdf2xml/>'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	p.pdftohtml = script
	if result, err := p.outline(context.Background(), file, 1); err != nil || len(result.Items) != 0 {
		t.Fatal("outline subprocess did not forbid regular-file output", result, err)
	}
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec head -c 524289 /dev/zero\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := p.outline(context.Background(), file, 1); !errors.Is(err, ErrOutlineUnavailable) {
		t.Fatal("oversized subprocess output did not report unavailable", err)
	}
}
