package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"artiface/internal/config"
)

func compressionFixture() []byte {
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << >> >>",
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

func TestCompressedPDFCacheIsNotAnAuthorizationCredential(t *testing.T) {
	app, _ := newTeamApp(t)
	if !app.pdfCache.Available() {
		t.Skip("Poppler is optional for native installs; container checks require it")
	}
	filename := filepath.Join(app.cfg.Hosts[0].Roots[0].Path, "reports", "report.pdf")
	if err := os.WriteFile(filename, compressionFixture(), 0600); err != nil {
		t.Fatal(err)
	}
	admin, adminCSRF := teamSignIn(t, app, "", testPassword, true)
	alice, csrf := teamSignIn(t, app, "alice", testPassword, false)
	bob, _ := teamSignIn(t, app, "bob", testPassword, false)
	loc := location{Host: "test", Root: "artifacts", Path: "reports/report.pdf"}
	info := func(force bool) string {
		t.Helper()
		w := request(app, "POST", "/api/pdf/info", struct {
			location
			Refresh bool `json:"refresh"`
		}{loc, force}, alice, csrf)
		var result struct {
			ID    string `json:"id"`
			Pages int    `json:"pages"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.ID) != 32 || result.Pages != 1 {
			t.Fatalf("PDF info: %d %s", w.Code, w.Body)
		}
		return result.ID
	}
	pageURL := func(id string, size int) string {
		return "/api/pdf/page?" + url.Values{
			"host": {loc.Host}, "root": {loc.Root}, "path": {loc.Path},
			"document": {id}, "page": {"1"}, "size": {strconv.Itoa(size)},
		}.Encode()
	}
	outlineURL := func(id string) string {
		return "/api/pdf/outline?" + url.Values{
			"host": {loc.Host}, "root": {loc.Root}, "path": {loc.Path}, "document": {id},
		}.Encode()
	}
	id := info(false)
	if info(false) != id {
		t.Fatal("unchanged source lost its cached snapshot")
	}
	for range 2 {
		w := request(app, "GET", outlineURL(id), nil, alice, "")
		if _, err := exec.LookPath("pdftohtml"); err != nil {
			if w.Code != http.StatusNotImplemented || !strings.Contains(w.Body.String(), "Original mode") {
				t.Fatal("missing outline tool lacked an actionable fallback", w.Code, w.Body)
			}
		} else if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"items":[],"truncated":false}` ||
			w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
			t.Fatal("empty/cached outline response", w.Code, w.Header(), w.Body)
		}
	}
	for _, size := range []int{320, 960, 1440, 1920, 2560, 3200, 3840} {
		w := request(app, "GET", pageURL(id, size), nil, alice, "")
		if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("PDF page size %d: %d %s", size, w.Code, w.Header())
		}
		dimensions, err := jpeg.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
		if err != nil || dimensions.Width != size || dimensions.Height < size/2 || dimensions.Height > size/2+1 {
			t.Fatalf("size %d: invalid page image %+v: %v", size, dimensions, err)
		}
	}
	for _, size := range []int{0, 999, 3841, 4096, 1000000} {
		if w := request(app, "GET", pageURL(id, size), nil, alice, ""); w.Code != http.StatusBadRequest {
			t.Fatalf("invalid image size %d: %d", size, w.Code)
		}
	}
	imageURL := pageURL(id, 3840)
	for _, caller := range []struct {
		cookie *http.Cookie
		status int
	}{{nil, 401}, {bob, 404}, {admin, 401}} {
		for _, endpoint := range []string{imageURL, outlineURL(id)} {
			if w := request(app, "GET", endpoint, nil, caller.cookie, ""); w.Code != caller.status {
				t.Fatal("cached PDF bypassed authentication/project grants", endpoint, w.Code)
			}
		}
	}
	newID := info(true)
	if newID == id {
		t.Fatal("manual refresh reused a stale snapshot")
	}
	for _, endpoint := range []string{imageURL, outlineURL(id)} {
		if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 409 {
			t.Fatal("old snapshot survived refresh", endpoint, w.Code)
		}
	}
	imageURL = pageURL(newID, 3840)
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": publicUser{ID: "alice", Username: "alice", Projects: []config.ProjectRef{}}})
	for _, endpoint := range []string{imageURL, outlineURL(newID)} {
		if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 404 {
			t.Fatal("cached PDF remained accessible after revocation", endpoint, w.Code)
		}
	}
	accessChange(t, app, admin, adminCSRF, map[string]any{"user": publicUser{ID: "alice", Username: "alice", Projects: []config.ProjectRef{{Host: "test", Root: "artifacts"}}}})
	if err := os.WriteFile(filename, append(compressionFixture(), []byte("\n% modified\n")...), 0600); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{imageURL, outlineURL(newID)} {
		if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 409 {
			t.Fatal("source metadata change reused old PDF data", endpoint, w.Code)
		}
	}
	newID = info(false)
	if w := request(app, "POST", "/api/logout", map[string]any{}, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code)
	}
	for _, endpoint := range []string{pageURL(newID, 3840), outlineURL(newID)} {
		if w := request(app, "GET", endpoint, nil, alice, ""); w.Code != 401 {
			t.Fatal("cached PDF bypassed logout", endpoint, w.Code)
		}
	}
}
