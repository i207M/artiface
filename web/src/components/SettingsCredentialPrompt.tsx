import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import './settingsCredentials.css'

export function useAdminPassword(enabled = true) {
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    const element = input.current
    const clear = () => { if (element) element.value = '' }
    window.addEventListener('artiface:unauthorized', clear)
    window.addEventListener('pagehide', clear)
    return () => {
      clear()
      window.removeEventListener('artiface:unauthorized', clear)
      window.removeEventListener('pagehide', clear)
    }
  }, [enabled])
  return input
}

export function AdminPasswordField({ input, busy }: { input: RefObject<HTMLInputElement | null>; busy: boolean }) {
  return <label className="settings-admin-password">Admin password
    <input ref={input} type="password" name="adminPassword" aria-label="Admin password" autoComplete="current-password"
      required maxLength={1024} disabled={busy} onInput={event => {
        const element = event.currentTarget
        element.setCustomValidity(new TextEncoder().encode(element.value).length > 1024 ? 'Use an admin password of at most 1024 bytes.' : '')
      }} />
    <span>Required to remove saved SSH credentials and trusted keys.</span>
  </label>
}

export function takeAdminPassword(input: RefObject<HTMLInputElement | null>) {
  const password = input.current?.value ?? ''
  if (input.current) input.current.value = ''
  return password
}

export default function SettingsCredentialPrompt({ busy, error, onConfirm, onClose }: {
  busy: boolean; error: string; onConfirm: (password: string) => void; onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useAdminPassword()
  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])
  useLayoutEffect(() => { if (!busy) input.current?.focus() }, [busy, error, input])
  return <dialog ref={dialog} className="settings-confirm" aria-labelledby="settings-credentials-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(takeAdminPassword(input)) }}>
      <h2 id="settings-credentials-title">Remove saved SSH credentials?</h2>
      <p>This configuration removes SSH hosts, their saved credentials, and trusted keys. Files and folders on the machines will remain unchanged.</p>
      <AdminPasswordField input={input} busy={busy} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="settings-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save configuration'}</button>
      </div>
    </form>
  </dialog>
}
