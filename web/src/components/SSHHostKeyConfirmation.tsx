import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, APIError, errorMessage, installSSHHostKeyConfirmation, isAborted } from '../api'
import { createSSHHostKeyQueue } from '../sshHostKeys'
import type { SSHHostKeyRequest } from '../sshHostKeys'
import './sshHostKey.css'

interface HostKeyDetails {
  token: string
  target: string
  host: string
  address: string
  keyType: string
  fingerprint: string
  changed: boolean
  previousFingerprints: string[]
}

function validDetails(value: HostKeyDetails, token: string) {
  return value?.token === token && ['target', 'host', 'address', 'keyType', 'fingerprint']
    .every(key => typeof value[key as keyof HostKeyDetails] === 'string' && value[key as keyof HostKeyDetails] !== '') &&
    typeof value.changed === 'boolean' && Array.isArray(value.previousFingerprints) &&
    value.previousFingerprints.every(fingerprint => typeof fingerprint === 'string')
}

export default function SSHHostKeyConfirmation({ canManage, passwordLabel = 'Admin password' }: {
  canManage: boolean
  passwordLabel?: string
}) {
  const [request, setRequest] = useState<SSHHostKeyRequest | null>(null)
  const [queue] = useState(() => createSSHHostKeyQueue(setRequest))
  useLayoutEffect(() => {
    if (!canManage) return
    return installSSHHostKeyConfirmation(queue)
  }, [canManage, queue])
  return canManage && request ? <HostKeyDialog key={request.id} request={request} passwordLabel={passwordLabel}
    onAccepted={() => queue.approve(request)} onStale={() => queue.retry(request)} onCancel={() => queue.cancel()} /> : null
}

function HostKeyDialog({ request, passwordLabel, onAccepted, onStale, onCancel }: {
  request: SSHHostKeyRequest
  passwordLabel: string
  onAccepted: () => void
  onStale: () => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const [details, setDetails] = useState<HostKeyDetails | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [terminal, setTerminal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const signal = request.controller.signal
  const stale = useRef(onStale)
  stale.current = onStale

  useLayoutEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    element?.showModal()
    return () => {
      if (passwordInput.current) passwordInput.current.value = ''
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length &&
        !previous.closest('[inert],[hidden]')) previous.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    setError('')
    void api<HostKeyDetails>('/api/ssh/host-key', { body: { token: request.token }, signal })
      .then(result => {
        if (signal.aborted) return
        if (!validDetails(result, request.token)) {
          setError('Invalid SSH host key confirmation. Close this dialog and retry the connection.')
          setTerminal(true)
          return
        }
        setDetails(result)
      })
      .catch(failure => {
        if (signal.aborted || isAborted(failure)) return
        if (failure instanceof APIError && failure.status === 409) { stale.current(); return }
        setError(errorMessage(failure))
        setTerminal(failure instanceof APIError && [400, 403, 404, 409, 410].includes(failure.status))
      })
      .finally(() => { if (!signal.aborted) setLoading(false) })
  }, [request, signal, attempt])

  async function accept(event: FormEvent) {
    event.preventDefault()
    if (!details || saving || !password || terminal || signal.aborted) return
    const secret = password
    setPassword('')
    setSaving(true)
    setError('')
    try {
      await api('/api/ssh/host-key/accept', { body: { token: request.token, password: secret }, signal })
      if (!signal.aborted) onAccepted()
    } catch (failure) {
      if (signal.aborted || isAborted(failure)) return
      setError(errorMessage(failure))
      setTerminal(failure instanceof APIError && [404, 409, 410].includes(failure.status))
      passwordInput.current?.focus({ preventScroll: true })
    } finally {
      if (!signal.aborted) setSaving(false)
    }
  }

  return <dialog ref={dialog} className="ssh-host-key-dialog" aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel() }}>
    <h2 id={`${id}-title`}>{details ? details.changed ? 'SSH host key changed' : 'Unknown SSH host key' : 'Confirm SSH host key'}</h2>
    <p id={`${id}-description`}>{details?.changed
      ? 'This server is presenting a different key. Verify the new fingerprint with your server administrator before accepting.'
      : 'Verify the SHA256 fingerprint with your server administrator before accepting this key.'}</p>
    {loading && <p role="status">Checking SSH host key…</p>}
    {details && <dl className="ssh-host-key-details">
      <dt>Connection</dt><dd>{details.target}</dd>
      <dt>Host / jump host</dt><dd>{details.host}</dd>
      <dt>Address</dt><dd>{details.address}</dd>
      <dt>Key type</dt><dd>{details.keyType}</dd>
      <dt>SHA256 fingerprint</dt><dd><code>{details.fingerprint}</code></dd>
      {details.changed && details.previousFingerprints.length > 0 && <>
        <dt>Previous fingerprints</dt><dd>{details.previousFingerprints.map(fingerprint => <code key={fingerprint}>{fingerprint}</code>)}</dd>
      </>}
    </dl>}
    {error && <p id={`${id}-error`} className="form-error" role="alert">{error}</p>}
    {terminal && <p>Close this dialog and retry the connection to request a fresh confirmation.</p>}
    <form onSubmit={accept}>
      {details && !terminal && <div className="ssh-host-key-password">
        <label htmlFor={`${id}-password`}>{passwordLabel}</label>
        <input ref={passwordInput} id={`${id}-password`} type="password" value={password}
          onChange={event => setPassword(event.target.value)} autoComplete="off" autoCapitalize="none"
          spellCheck={false} required readOnly={saving} aria-describedby={`${id}-password-help`} />
        <small id={`${id}-password-help`}>Used to encrypt and save this trusted key. It is not kept in the browser.</small>
      </div>}
      <div className="ssh-host-key-actions">
        <button type="button" className="button secondary" autoFocus onClick={onCancel}>{terminal ? 'Close' : 'Cancel'}</button>
        {!details && !loading && !terminal && <button type="button" className="button secondary" onClick={() => setAttempt(value => value + 1)}>Retry key details</button>}
        {details && !terminal && <button type="submit" className="button primary" disabled={!password || saving}>
          {saving ? 'Saving trusted key…' : 'Accept and retry'}
        </button>}
      </div>
    </form>
  </dialog>
}
