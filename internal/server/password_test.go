package server

import (
	"bytes"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"artiface/internal/config"
)

func TestPasswordChangePreservesSettingsAndRevokesAccess(t *testing.T) {
	app, _, filename, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	otherCookie, otherCSRF := signIn(t, app)
	previewURL := makePreview(t, app, otherCookie, otherCSRF)
	before, err := config.Load(filename)
	if err != nil {
		t.Fatal(err)
	}
	// A pending external settings edit must survive the password change.
	before.SessionHours++
	if err := config.Save(filename, before); err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(filename)
	newPassword := "after6"
	body := map[string]string{"currentPassword": testPassword, "newPassword": newPassword}
	for _, attempt := range []struct {
		cookie  *http.Cookie
		csrf    string
		current string
		next    string
		want    int
	}{
		{nil, "", testPassword, newPassword, 401},
		{cookie, "", testPassword, newPassword, 403},
		{cookie, csrf, "incorrect", newPassword, 403},
		{cookie, csrf, testPassword, "short", 400},
	} {
		w := request(app, "POST", "/api/password", map[string]string{
			"currentPassword": attempt.current, "newPassword": attempt.next,
		}, attempt.cookie, attempt.csrf)
		if w.Code != attempt.want {
			t.Fatalf("password change status = %d; want %d", w.Code, attempt.want)
		}
	}
	unchanged, _ := os.ReadFile(filename)
	if !bytes.Equal(unchanged, original) {
		t.Fatal("rejected change modified the configuration")
	}
	w := request(app, "POST", "/api/password", body, cookie, csrf)
	if w.Code != 200 {
		t.Fatalf("change password: %d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), newPassword) || strings.Contains(w.Body.String(), "$argon2") {
		t.Fatal("password response disclosed credentials")
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].MaxAge >= 0 {
		t.Fatal("password change did not clear the browser cookie")
	}
	saved, err := config.Load(filename)
	if err != nil || !config.VerifyPassword(saved.PasswordHash, newPassword) ||
		config.VerifyPassword(saved.PasswordHash, testPassword) {
		t.Fatal("new password was not persisted", err)
	}
	saved.PasswordHash = before.PasswordHash
	if !reflect.DeepEqual(saved, before) {
		t.Fatal("password change modified other settings")
	}
	for _, sessionCookie := range []*http.Cookie{cookie, otherCookie} {
		if w := request(app, "GET", "/api/hosts", nil, sessionCookie, ""); w.Code != 401 {
			t.Fatal("old session survived password change")
		}
	}
	if w := previewRequest(app, previewURL); w.Code != 401 {
		t.Fatal("preview capability survived password change")
	}
	if w := request(app, "POST", "/api/login", map[string]string{"password": testPassword}, nil, ""); w.Code != 401 {
		t.Fatal("old password still authenticates")
	}
	if w := request(app, "POST", "/api/login", map[string]string{"password": newPassword}, nil, ""); w.Code != 200 {
		t.Fatal("new password requires an unnecessary restart")
	}
}

func TestPasswordChangeSharesLoginRateLimit(t *testing.T) {
	app, _, _, _ := newSetupApp(t, "")
	cookie, csrf := signIn(t, app)
	for range 5 {
		w := request(app, "POST", "/api/password",
			map[string]string{"currentPassword": "incorrect", "newPassword": "after6"}, cookie, csrf)
		if w.Code != 403 {
			t.Fatal("unexpected password failure status", w.Code)
		}
	}
	for _, endpoint := range []string{"/api/password", "/api/login"} {
		w := request(app, "POST", endpoint, map[string]string{}, cookie, csrf)
		if w.Code != 429 || w.Header().Get("Retry-After") == "" {
			t.Fatal("password attempts bypassed the shared rate limit")
		}
	}
}
