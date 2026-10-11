import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, APIError, errorMessage, sessionExpired } from '../api'

type PasswordField = 'current' | 'new' | 'confirmation'
type PasswordError = { field?: PasswordField; message: string }
const passwordPolicyError = 'password must contain at least 6 characters and at most 1024 bytes of valid UTF-8'

export default function PasswordSettings({ enabled }: { enabled: boolean }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PasswordError | null>(null)
  const fields = {
    current: useRef<HTMLInputElement>(null),
    new: useRef<HTMLInputElement>(null),
    confirmation: useRef<HTMLInputElement>(null),
  }
  const inFlight = useRef(false)
  const focusAttempt = useRef<{ controller: AbortController; origin: Element | null } | null>(null)

  useEffect(() => () => focusAttempt.current?.controller.abort(), [])
  useLayoutEffect(() => {
    const attempt = focusAttempt.current
    if (!attempt) return
    if (!enabled) attempt.controller.abort()
    if (busy) return
    focusAttempt.current = null
    const canFocus = !attempt.controller.signal.aborted && document.hasFocus() && document.activeElement === attempt.origin
    attempt.controller.abort()
    if (canFocus && error?.field) focusField(error.field)
  }, [busy, enabled, error])

  function focusField(field: PasswordField) {
    const input = fields[field].current
    if (!input || input.disabled) return
    input.focus({ preventScroll: true })
    const bounds = input.getBoundingClientRect()
    const header = input.closest('.settings-page')?.querySelector('.settings-header')?.getBoundingClientRect()
    if (bounds.top < (header?.bottom ?? 0) || bounds.bottom > window.innerHeight) input.scrollIntoView({ block: 'center' })
  }

  function clearFieldError(field: PasswordField) {
    setError(previous => previous?.field === field || (field === 'new' && previous?.field === 'confirmation') ? null : previous)
  }

  function rememberFocus(form: HTMLFormElement) {
    focusAttempt.current?.controller.abort()
    focusAttempt.current = null
    const origin = document.activeElement
    if (!origin || !form.contains(origin)) return
    const controller = new AbortController()
    const options = { capture: true, signal: controller.signal }
    const cancel = () => controller.abort()
    document.addEventListener('focusin', event => { if (event.target !== origin) cancel() }, options)
    document.addEventListener('pointerdown', cancel, options)
    document.addEventListener('keydown', cancel, options)
    document.addEventListener('wheel', cancel, { ...options, passive: true })
    window.addEventListener('blur', cancel, { signal: controller.signal })
    focusAttempt.current = { controller, origin }
  }

  function fieldError(field: PasswordField) {
    return error?.field === field
      ? <p id={`password-${field}-error`} className="form-error password-field-error" role="alert">{error.message}</p>
      : null
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || inFlight.current || !enabled) return
    setError(null)
    if (newPassword !== confirmation) {
      setError({ field: 'confirmation', message: 'New passwords do not match.' })
      focusField('confirmation')
      return
    }
    if (Array.from(newPassword).length < 6) {
      setError({ field: 'new', message: 'Use at least 6 characters.' })
      focusField('new')
      return
    }
    inFlight.current = true
    rememberFocus(event.currentTarget)
    setBusy(true)
    try {
      await api('/api/password', { body: { currentPassword, newPassword } })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      sessionExpired()
    } catch (failure) {
      const message = errorMessage(failure)
      const field = failure instanceof APIError && failure.status === 403 && message === 'Incorrect current password' ? 'current'
        : failure instanceof APIError && failure.status === 400 && message === passwordPolicyError ? 'new' : undefined
      setError({ field, message })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section className="settings-section">
    <h2>Change admin password</h2>
    <p>Use at least 6 characters. Changing the password signs out all devices, including this one.</p>
    <form className="password-settings" onSubmit={submit} aria-busy={busy} aria-describedby={error && !error.field ? 'password-form-error' : undefined}>
      <label htmlFor="current-password">Current password</label>
      <input ref={fields.current} id="current-password" name="currentPassword" type="password" autoComplete="current-password"
        autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={error?.field === 'current' || undefined}
        aria-describedby={error?.field === 'current' ? 'password-current-error' : undefined}
        value={currentPassword} onChange={event => { setCurrentPassword(event.target.value); clearFieldError('current') }} required disabled={!enabled} readOnly={busy} />
      {fieldError('current')}
      <label htmlFor="new-password">New password</label>
      <input ref={fields.new} id="new-password" name="newPassword" type="password" autoComplete="new-password"
        autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={error?.field === 'new' || undefined}
        aria-describedby={error?.field === 'new' ? 'password-new-error' : undefined}
        value={newPassword} onChange={event => { setNewPassword(event.target.value); clearFieldError('new') }} required disabled={!enabled} readOnly={busy} />
      {fieldError('new')}
      <label htmlFor="confirm-password">Confirm new password</label>
      <input ref={fields.confirmation} id="confirm-password" name="confirmation" type="password" autoComplete="new-password"
        autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={error?.field === 'confirmation' || undefined}
        aria-describedby={error?.field === 'confirmation' ? 'password-confirmation-error' : undefined}
        value={confirmation} onChange={event => { setConfirmation(event.target.value); clearFieldError('confirmation') }} required disabled={!enabled} readOnly={busy} />
      {fieldError('confirmation')}
      {error && !error.field && <p id="password-form-error" className="form-error" role="alert">{error.message}</p>}
      <button className="button primary" type="submit" disabled={!enabled || !currentPassword || !newPassword || !confirmation} aria-disabled={busy || undefined}>
        {busy ? 'Changing password…' : 'Change password'}
      </button>
    </form>
  </section>
}
