import { ArrowRight, Eye, EyeOff, FileText, LoaderCircle, LockKeyhole, PanelTop, Terminal } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { adminPage, api, APIError, errorMessage, setCSRFToken } from '../api'
import type { SessionInfo } from '../types'
import { Brand } from './Common'

export default function Login({ mode, onSuccess }: { mode: SessionInfo['mode']; onSuccess: (session: SessionInfo) => void }) {
  const teamUser = mode === 'team' && !adminPage
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invalidCredentials, setInvalidCredentials] = useState(false)
  const passwordField = useRef<HTMLInputElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const selection = useRef<{ start: number; end: number; direction: 'forward' | 'backward' | 'none'; focused: boolean } | null>(null)

  useLayoutEffect(() => {
    if (!busy && error && document.activeElement === submitButton.current) passwordField.current?.focus({ preventScroll: true })
  }, [busy, error])
  useLayoutEffect(() => {
    if (selection.current && passwordField.current) {
      const { start, end, direction, focused } = selection.current
      const input = passwordField.current
      selection.current = null
      if (focused) input.focus({ preventScroll: true })
      input.setSelectionRange(start, end, direction)
    }
  }, [visible])

  function clearError() {
    setError('')
    setInvalidCredentials(false)
  }

  function revealPassword() {
    const input = passwordField.current
    if (input && input.selectionStart !== null && input.selectionEnd !== null) {
      const focused = document.activeElement === input
      selection.current = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection ?? 'none', focused }
      // Change the input type while unfocused, then restore it within the same interaction.
      if (focused) input.blur()
    }
    setVisible(value => !value)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !password) return
    setBusy(true)
    clearError()
    try {
      const result = await api<SessionInfo>('/api/login', { body: { password, ...(teamUser ? { username } : {}) } })
      setCSRFToken(result.csrfToken)
      setPassword('')
      onSuccess(result)
    } catch (failure) {
      setError(errorMessage(failure))
      setInvalidCredentials(failure instanceof APIError && failure.status === 401)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <header className="login-header"><Brand /><span className="private-label"><LockKeyhole size={13} /> Your private workspace</span></header>
      <main className="login-main">
        <div className="login-intro">
          <span className="eyebrow"><span className="status-dot" /> A little closer to your work</span>
          <h2>All your artifacts.<br /><span>One quiet workspace.</span></h2>
          <p>Explore reports, documents, and code from local folders and SSH machines.</p>
          <div className="login-artifacts" aria-hidden="true">
            <div className="artifact-card artifact-back"><Terminal size={22} /><span>Source code</span><div className="mock-code"><i /><i /><i /><i /></div></div>
            <div className="artifact-card artifact-middle"><PanelTop size={22} /><span>Interactive reports</span><div className="mock-chart"><i /><i /><i /><i /><i /><i /></div></div>
            <div className="artifact-card artifact-front"><FileText size={22} /><span>Research & notes</span><div className="mock-document"><i /><i /><i /><i /></div><span className="mock-badge">Made for a closer look</span></div>
          </div>
        </div>
        <section className="login-card" aria-labelledby="login-title">
          <div className="state-symbol"><LockKeyhole size={24} /></div>
          <h1 id="login-title">{adminPage ? 'Administration' : 'Sign in'}</h1>
          <p>{adminPage ? 'Enter the admin password to manage users, projects, and machines.' : teamUser ? 'Sign in with the account your admin created.' : 'Enter your workspace password to continue.'}</p>
          <form onSubmit={submit} aria-busy={busy} aria-describedby={error ? 'login-error' : undefined}>
            {teamUser && <><label htmlFor="username">Username</label><input id="username" name="username" value={username} onChange={event => { setUsername(event.target.value); clearError() }} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus required readOnly={busy} aria-invalid={invalidCredentials || undefined} aria-describedby={invalidCredentials ? 'login-error' : undefined} /></>}
            <label htmlFor="password">{adminPage ? 'Admin password' : teamUser ? 'Password' : 'Workspace password'}</label>
            <div className="password-field">
              <input ref={passwordField} id="password" name="password" type={visible ? 'text' : 'password'} value={password} onChange={(event) => { setPassword(event.target.value); clearError() }} placeholder="Enter your password" autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus={!teamUser} required readOnly={busy} aria-invalid={invalidCredentials || undefined} aria-describedby={invalidCredentials ? 'login-error' : undefined} />
              <button type="button" className="icon-button" aria-label={visible ? 'Hide password' : 'Show password'} title={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} onPointerDown={event => {
                if (event.isPrimary && event.button === 0 && document.activeElement === passwordField.current) event.preventDefault()
              }} onClick={revealPassword}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            </div>
            {error && <p className="form-error" id="login-error" role="alert">{error}</p>}
            <button ref={submitButton} className="button primary login-submit" type="submit" disabled={!password || (teamUser && !username)} aria-disabled={busy || undefined}>{busy ? <><LoaderCircle size={16} className="spin" /> Signing in…</> : <>{adminPage ? 'Open admin panel' : 'Open workspace'} <ArrowRight size={17} /></>}</button>
          </form>
          {(teamUser || adminPage) && <p><a href={adminPage ? '/' : '/admin/'}>{adminPage ? 'Back to workspace' : 'Admin sign in'}</a></p>}
          <div className="login-note"><span className="login-note-heading"><LockKeyhole size={14} /><span>Private by default.</span></span><span>Your files stay on your machines.</span></div>
        </section>
      </main>
      <footer className="login-footer"><span>A home for the things you make.</span><span>Local and SSH · Read only</span></footer>
    </div>
  )
}
