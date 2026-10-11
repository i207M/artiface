import { ArrowRight, LoaderCircle } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { api, APIError } from '../api'
import type { Host } from '../types'
import './sshHostForm.css'

const keyLimit = 32 * 1024
const byteLength = (value: string) => new TextEncoder().encode(value).length
const safeTarget = (value: string) => Boolean(value) && byteLength(value) <= 255 && !/^-|\s|[/\\\x00-\x1f\x7f]/u.test(value)

export default function SSHHostForm({ enabled = true, hosts = [], initialAlias = '', onAliasChange, onCreated, onCancel }: {
  enabled?: boolean
  hosts?: Host[]
  initialAlias?: string
  onAliasChange?: (alias: string) => void
  onCreated: (host: Host) => void
  onCancel?: () => void
}) {
  const [alias, setAlias] = useState(initialAlias)
  const [hostname, setHostname] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('22')
  const [jump, setJump] = useState('')
  const [authentication, setAuthentication] = useState<'password' | 'key'>('password')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState('')
  // Credentials never enter project drafts, application state, or browser storage.
  const sshPassword = useRef<HTMLInputElement>(null)
  const privateKey = useRef<HTMLTextAreaElement>(null)
  const keyPassphrase = useRef<HTMLInputElement>(null)
  const adminPassword = useRef<HTMLInputElement>(null)
  const keyFile = useRef<HTMLInputElement>(null)
  const request = useRef<AbortController | null>(null)
  const uploadVersion = useRef(0)
  const mounted = useRef(false)

  function clearSecrets() {
    for (const field of [sshPassword.current, privateKey.current, keyPassphrase.current, adminPassword.current, keyFile.current]) {
      if (field) field.value = ''
    }
    uploadVersion.current++
  }

  useLayoutEffect(() => {
    mounted.current = true
    const expire = () => {
      clearSecrets()
      request.current?.abort()
      request.current = null
      setExpired(true)
      setError('')
      setBusy(false)
      setReading(false)
    }
    window.addEventListener('artiface:unauthorized', expire)
    window.addEventListener('pagehide', expire)
    return () => {
      // Layout cleanup clears the inputs before their DOM nodes are detached.
      mounted.current = false
      clearSecrets()
      request.current?.abort()
      request.current = null
      window.removeEventListener('artiface:unauthorized', expire)
      window.removeEventListener('pagehide', expire)
    }
  }, [])

  useLayoutEffect(() => {
    if (enabled) return
    clearSecrets()
    request.current?.abort()
    request.current = null
    setBusy(false)
    setReading(false)
  }, [enabled])

  function changeAuthentication(next: 'password' | 'key') {
    clearSecrets()
    setReading(false)
    setAuthentication(next)
    setError('')
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    const version = ++uploadVersion.current
    if (privateKey.current) privateKey.current.value = ''
    setError('')
    if (!file) return
    if (!file.size || file.size > keyLimit) {
      setError('Choose a non-empty private key file of at most 32 KiB.')
      return
    }
    setReading(true)
    let bytes: Uint8Array | undefined
    try {
      bytes = new Uint8Array(await file.arrayBuffer())
      if (!mounted.current || version !== uploadVersion.current) return
      if (bytes.byteLength > keyLimit) throw new Error('Oversized key')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (privateKey.current) privateKey.current.value = text
    } catch {
      if (mounted.current && version === uploadVersion.current) setError('The private key file could not be read as text.')
    } finally {
      bytes?.fill(0)
      if (mounted.current && version === uploadVersion.current) setReading(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!enabled || expired || reading || request.current) return
    setError('')
    const cleanAlias = alias.trim()
    const cleanHostname = hostname.trim()
    const cleanUser = user.trim()
    const cleanJump = jump.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cleanAlias)) {
      setError('Use up to 64 letters, numbers, dots, underscores, or hyphens for the SSH alias, starting with a letter or number.')
      return
    }
    if (hosts.some(host => host.id === cleanAlias || host.kind !== 'local' && host.target === cleanAlias)) {
      setError('That SSH alias is already in use. Choose another name.')
      return
    }
    if (![cleanHostname, cleanUser].every(safeTarget)) {
      setError('Enter a hostname and username without spaces or control characters, using at most 255 bytes each.')
      return
    }
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      setError('Enter an SSH port between 1 and 65535.')
      return
    }
    if (cleanJump && (!safeTarget(cleanJump) || cleanJump === cleanAlias)) {
      setError('The jump host must be a different, existing SSH alias.')
      return
    }
    const credentials = {
      sshPassword: authentication === 'password' ? sshPassword.current?.value ?? '' : '',
      privateKey: authentication === 'key' ? privateKey.current?.value ?? '' : '',
      keyPassphrase: authentication === 'key' ? keyPassphrase.current?.value ?? '' : '',
      adminPassword: adminPassword.current?.value ?? '',
    }
    if (!credentials.adminPassword || byteLength(credentials.adminPassword) > 1024 ||
      authentication === 'password' && (!credentials.sshPassword || byteLength(credentials.sshPassword) > 4096) ||
      authentication === 'key' && (!credentials.privateKey.trim() || byteLength(credentials.privateKey) > keyLimit || byteLength(credentials.keyPassphrase) > 4096)) {
      setError('Enter the required credentials. Passwords and passphrases are limited to 4 KiB, private keys to 32 KiB, and the admin password to 1 KiB.')
      return
    }
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    try {
      const result = await api<{ host: Host }>('/api/ssh/hosts', { signal: controller.signal, body: {
        alias: cleanAlias, hostname: cleanHostname, user: cleanUser, port: Number(port),
        ...(cleanJump ? { jump: cleanJump } : {}),
        ...(authentication === 'password' ? { sshPassword: credentials.sshPassword }
          : { privateKey: credentials.privateKey, ...(credentials.keyPassphrase ? { keyPassphrase: credentials.keyPassphrase } : {}) }),
        adminPassword: credentials.adminPassword,
      } })
      if (controller.signal.aborted || !mounted.current) return
      clearSecrets()
      onCreated(result.host)
    } catch (failure) {
      if (controller.signal.aborted || !mounted.current) return
      // Never reflect submitted credentials through a server-provided error message.
      setError(failure instanceof APIError && failure.status === 409 && failure.message === 'SSH credentials changed elsewhere; restart the server before adding hosts'
        ? 'SSH credentials changed elsewhere. Restart the server before adding hosts.'
        : failure instanceof APIError && failure.status === 409 && failure.message === 'An SSH host with this alias already exists'
          ? 'That SSH alias is already in use. Choose another name.'
        : failure instanceof APIError && failure.status === 403 ? 'Check your Artiface admin password and permission to add SSH hosts.'
          : failure instanceof APIError && failure.status === 400 ? 'Check the host details, credentials, and private key passphrase.'
            : 'Could not save the SSH host. Please try again.')
    } finally {
      credentials.sshPassword = credentials.privateKey = credentials.keyPassphrase = credentials.adminPassword = ''
      if (request.current === controller) {
        request.current = null
        if (mounted.current) setBusy(false)
      }
    }
  }

  if (expired) return <p role="status">Sign in again before adding an SSH host.</p>
  const disabled = !enabled || busy
  return <form className="ssh-host-form" onSubmit={submit} aria-busy={busy || reading}>
    <p>Save the SSH host, then choose a project folder.</p>
    <fieldset disabled={disabled}>
      <legend className="sr-only">SSH host details</legend>
      <label>SSH alias<input name="alias" value={alias} onChange={event => { setAlias(event.target.value); onAliasChange?.(event.target.value) }} maxLength={64} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="research-server" required /></label>
      <span className="field-help">A unique name for this SSH host.</span>
      <div className="ssh-host-fields">
        <label>Hostname or IP address<input name="hostname" value={hostname} onChange={event => setHostname(event.target.value)} maxLength={255} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="server.example.org" required /></label>
        <label>SSH port<input name="port" value={port} onChange={event => setPort(event.target.value)} inputMode="numeric" maxLength={5} autoComplete="off" required /></label>
      </div>
      <label>SSH username<input name="user" value={user} onChange={event => setUser(event.target.value)} maxLength={255} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required /></label>
      <fieldset className="ssh-authentication">
        <legend>Authentication</legend>
        <label><input type="radio" name="authentication" value="password" checked={authentication === 'password'} onChange={() => changeAuthentication('password')} /> Password</label>
        <label><input type="radio" name="authentication" value="key" checked={authentication === 'key'} onChange={() => changeAuthentication('key')} /> Private key</label>
      </fieldset>
      {authentication === 'password'
        ? <label>SSH password<input ref={sshPassword} name="sshPassword" type="password" maxLength={4096} autoComplete="new-password" required /></label>
        : <>
          <label>Private key<textarea ref={privateKey} name="privateKey" rows={6} maxLength={keyLimit} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required
            onChange={() => { uploadVersion.current++; setReading(false); setError('') }} /></label>
          <label>Upload private key<input ref={keyFile} type="file" onChange={event => void upload(event)} disabled={reading} /></label>
          <span className="field-help">Paste an OpenSSH or PEM private key, or upload a file of at most 32 KiB.</span>
          <label>Key passphrase <span className="optional-label">(optional)</span><input ref={keyPassphrase} name="keyPassphrase" type="password" maxLength={4096} autoComplete="new-password" /></label>
        </>}
      <details><summary>Advanced</summary><label>Jump host alias <span className="optional-label">(optional)</span><input name="jump" value={jump} onChange={event => setJump(event.target.value)} maxLength={255} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Existing SSH alias" /></label><span className="field-help">The jump host must already be saved or imported.</span></details>
      <label>Artiface admin password<input ref={adminPassword} name="adminPassword" type="password" maxLength={1024} autoComplete="current-password" required /></label>
      <span className="field-help">SSH credentials are encrypted on the server with this password.</span>
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="setup-actions">
      {onCancel && <button type="button" className="button secondary" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="button primary" disabled={disabled || reading}>{busy ? <><LoaderCircle className="spin" size={16} /> Saving…</> : <>Save SSH host <ArrowRight size={16} /></>}</button>
    </div>
  </form>
}
