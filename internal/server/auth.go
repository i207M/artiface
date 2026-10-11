package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"time"

	"artiface/internal/config"
	"artiface/internal/sshvault"
)

type session struct {
	csrf       string
	expires    time.Time
	admin      bool
	userID     string
	credential string
}

func adminRequest(r *http.Request) bool { return strings.HasPrefix(r.URL.Path, "/api/admin/") }

func sessionCookie(r *http.Request) (string, string) {
	if adminRequest(r) {
		return "artiface_admin", "/api/admin/"
	}
	return cookieName, "/"
}

// Caller holds hostsMu. This also invalidates a user's existing sessions after
// a password reset, account removal, or disabling the account.
func (a *App) sessionValid(s session) bool {
	if s.admin {
		return true
	}
	if a.cfg.ModeName() == "personal" {
		return s.userID == ""
	}
	user, ok := a.cfg.User(s.userID)
	return ok && !user.Disabled && user.PasswordHash == s.credential
}

func randomToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("operating system randomness unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func (a *App) current(r *http.Request) (string, session, bool) {
	name, _ := sessionCookie(r)
	cookie, err := r.Cookie(name)
	if err != nil || len(cookie.Value) != 43 {
		return "", session{}, false
	}
	a.hostsMu.RLock()
	defer a.hostsMu.RUnlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[cookie.Value]
	if !ok || !time.Now().Before(s.expires) || !a.sessionValid(s) {
		delete(a.sessions, cookie.Value)
		return "", session{}, false
	}
	if s.admin != adminRequest(r) {
		return "", session{}, false
	}
	return cookie.Value, s, true
}

// Source management is available to the personal owner or the separate admin
// session, never to a team user's normal workspace session.
func (a *App) manage(next http.HandlerFunc) http.Handler {
	return a.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, s, ok := a.current(r)
		if !ok || s.userID != "" {
			fail(w, http.StatusForbidden, "Administrator access is required")
			return
		}
		next(w, r)
	}))
}

func (a *App) sessionResponse(s session, authenticated bool) map[string]any {
	a.hostsMu.RLock()
	defer a.hostsMu.RUnlock()
	result := map[string]any{"authenticated": authenticated, "mode": a.cfg.ModeName()}
	if authenticated {
		result["sshLocked"] = a.sshCredentials.Locked()
		role := "personal"
		if s.admin {
			role = "admin"
		} else if s.userID != "" {
			role = "user"
			user, _ := a.cfg.User(s.userID)
			result["userID"], result["username"] = user.ID, user.Username
		}
		result["role"], result["csrfToken"] = role, s.csrf
	}
	return result
}

func (a *App) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, s, ok := a.current(r)
		if !ok {
			fail(w, http.StatusUnauthorized, "Sign in to continue")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(s.csrf)) != 1 {
				fail(w, http.StatusForbidden, "Invalid session token; reload and try again")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) sessionStatus(w http.ResponseWriter, r *http.Request) {
	_, s, ok := a.current(r)
	respond(w, http.StatusOK, a.sessionResponse(s, ok))
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
		Username string `json:"username"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !a.beginPasswordCheck(w) {
		return
	}
	defer func() { <-a.loginBusy }()
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	a.hostsMu.RLock()
	mode, hours := a.cfg.ModeName(), a.cfg.SessionHours
	users := a.cfg.Users
	a.hostsMu.RUnlock()
	a.mu.Lock()
	hash := a.passwordHash
	a.mu.Unlock()
	s := session{admin: adminRequest(r)}
	found := true
	if mode == "team" && !s.admin {
		found = false
		for _, user := range users {
			if user.Username == strings.ToLower(strings.TrimSpace(body.Username)) && !user.Disabled {
				hash, s.userID, found = user.PasswordHash, user.ID, true
				s.credential = hash
				break
			}
		}
	}
	// Unknown and disabled usernames still perform a real password hash check.
	verified := a.checkPassword(hash, body.Password)
	if !found || !verified {
		if !found && verified {
			a.mu.Lock()
			a.failures++
			a.mu.Unlock()
		}
		message := "Incorrect password"
		if mode == "team" && !s.admin {
			message = "Incorrect username or password"
		}
		fail(w, http.StatusUnauthorized, message)
		return
	}
	// A team user's password can never unlock the shared vault, even when the
	// user's password happens to equal the admin password.
	if s.userID == "" {
		if err := a.sshCredentials.Unlock(body.Password); err != nil {
			fail(w, http.StatusInternalServerError, "Could not unlock SSH credentials. Restore the configuration or use the CLI password recovery command.")
			return
		}
	}
	now := time.Now()
	id := randomToken()
	s.csrf, s.expires = randomToken(), now.Add(time.Duration(hours)*time.Hour)
	name, cookiePath := sessionCookie(r)
	a.mu.Lock()
	a.pruneLocked(now)
	// Replacing this browser's session avoids accumulating sessions on repeated logins.
	if cookie, err := r.Cookie(name); err == nil {
		delete(a.sessions, cookie.Value)
	}
	count := 0
	for _, existing := range a.sessions {
		if existing.admin == s.admin && existing.userID == s.userID {
			count++
		}
	}
	if count >= maxSessions || len(a.sessions) >= 2048 {
		a.mu.Unlock()
		fail(w, http.StatusTooManyRequests, "Too many active sessions; sign out from another browser or restart the app")
		return
	}
	a.sessions[id] = s
	a.failures = 0
	a.mu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: id, Path: cookiePath, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Expires: s.expires,
		MaxAge: hours * 3600,
		Secure: strings.HasPrefix(a.origin, "https://"),
	})
	respond(w, http.StatusOK, a.sessionResponse(s, true))
}

// Login and password changes share rate limits and cannot race credential updates.
func (a *App) beginPasswordCheck(w http.ResponseWriter) bool {
	select {
	case a.loginBusy <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "2")
		fail(w, http.StatusTooManyRequests, "A password check is already in progress; try again shortly")
		return false
	}
	now := time.Now()
	a.mu.Lock()
	if !now.Before(a.resetAt) {
		a.failures = 0
		a.resetAt = now.Add(time.Minute)
	}
	throttled := a.failures >= 5
	a.mu.Unlock()
	if throttled {
		<-a.loginBusy
		w.Header().Set("Retry-After", "60")
		fail(w, http.StatusTooManyRequests, "Too many failed attempts; try again in a minute")
		return false
	}
	return true
}

func (a *App) checkPassword(hash, password string) bool {
	if !config.VerifyPassword(hash, password) {
		a.mu.Lock()
		a.failures++
		a.mu.Unlock()
		return false
	}
	return true
}

func (a *App) changePassword(w http.ResponseWriter, r *http.Request) {
	if !a.setupAllowed(w) {
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !decode(w, r, &body) || !a.beginPasswordCheck(w) {
		return
	}
	defer func() { <-a.loginBusy }()
	if _, _, ok := a.current(r); !ok {
		fail(w, http.StatusUnauthorized, "Sign in to continue")
		return
	}
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	current, err := config.Load(a.configFile)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Could not load configuration")
		return
	}
	if !a.checkPassword(current.PasswordHash, body.CurrentPassword) {
		fail(w, http.StatusForbidden, "Incorrect current password")
		return
	}
	hash, err := config.HashPassword(body.NewPassword)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	var encrypted *sshvault.Envelope
	if current.SSHCredentials != nil {
		bundle, unlockErr := sshvault.Open(current.SSHCredentials, body.CurrentPassword)
		if unlockErr != nil {
			fail(w, http.StatusConflict, "Could not decrypt stored SSH credentials; the password was not changed")
			return
		}
		defer bundle.Clear()
		encrypted, err = sshvault.Seal(bundle, body.NewPassword)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Could not re-encrypt SSH credentials; the password was not changed")
			return
		}
	}
	_, err = config.Update(a.configFile, func(cfg *config.Config) error {
		if cfg.PasswordHash != current.PasswordHash || !reflect.DeepEqual(cfg.SSHCredentials, current.SSHCredentials) {
			return config.ErrConflict
		}
		cfg.PasswordHash = hash
		cfg.SSHCredentials = encrypted
		return nil
	})
	if err != nil {
		if errors.Is(err, config.ErrConflict) {
			fail(w, http.StatusConflict, "Password changed elsewhere; sign in again")
		} else {
			fail(w, http.StatusInternalServerError, "Could not save password")
		}
		return
	}
	a.mu.Lock()
	a.passwordHash = hash
	clear(a.sessions)
	clear(a.previews)
	a.failures = 0
	a.mu.Unlock()
	a.sshCredentials.Rewrap(current.SSHCredentials, encrypted)
	a.logout(w, r)
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	id, _, _ := a.current(r)
	a.mu.Lock()
	delete(a.sessions, id)
	for token, p := range a.previews {
		if p.sessionID == id {
			delete(a.previews, token)
		}
	}
	a.mu.Unlock()
	name, cookiePath := sessionCookie(r)
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: "", Path: cookiePath, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0),
		Secure: strings.HasPrefix(a.origin, "https://"),
	})
	respond(w, http.StatusOK, map[string]bool{"authenticated": false})
}

// Call with a.mu held. Expired capabilities never survive their parent session.
func (a *App) pruneLocked(now time.Time) {
	for id, s := range a.sessions {
		if !now.Before(s.expires) {
			delete(a.sessions, id)
		}
	}
	for token, p := range a.previews {
		if _, ok := a.sessions[p.sessionID]; !ok || !now.Before(p.expires) {
			delete(a.previews, token)
		}
	}
}
