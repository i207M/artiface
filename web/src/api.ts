import type { FileLocation } from './types'

let csrfToken = ''
let sessionGeneration = 0
let sessionController = new AbortController()
export const adminPage = window.location.pathname === '/admin/' || window.location.pathname === '/admin'

export class APIError extends Error {
  status: number
  sshHostKey?: { token: string }

  constructor(message: string, status: number, sshHostKey?: { token: string }) {
    super(message)
    this.name = 'APIError'
    this.status = status
    this.sshHostKey = sshHostKey
  }
}

export interface SSHHostKeyConfirmation {
  confirm: (token: string, signal?: AbortSignal) => Promise<'accepted' | 'retry' | 'stale'>
  clear: () => void
}

let hostKeyConfirmation: SSHHostKeyConfirmation | undefined

function clearSSHHostKeyConfirmation() {
  sessionGeneration++
  sessionController.abort()
  sessionController = new AbortController()
  const previous = hostKeyConfirmation
  hostKeyConfirmation = undefined
  previous?.clear()
}

// Installed only by the authenticated owner's/admin's dialog.
export function installSSHHostKeyConfirmation(confirmation: SSHHostKeyConfirmation) {
  if (hostKeyConfirmation) clearSSHHostKeyConfirmation()
  hostKeyConfirmation = confirmation
  return () => {
    if (hostKeyConfirmation === confirmation) clearSSHHostKeyConfirmation()
  }
}

export function setCSRFToken(token = '') {
  if (csrfToken !== token) clearSSHHostKeyConfirmation()
  csrfToken = token
}

export function sessionExpired() {
  csrfToken = ''
  clearSSHHostKeyConfirmation()
  window.dispatchEvent(new Event('artiface:unauthorized'))
}

export function apiURL(endpoint: string, location: FileLocation, download = false) {
  const query = new URLSearchParams({
    host: location.host,
    root: location.root,
    path: location.path,
  })
  if (download) query.set('download', '1')
  return `/api/${endpoint}?${query}`
}

function retrySignal(session: AbortSignal, request?: AbortSignal) {
  const controller = new AbortController()
  const signals = request ? [session, request] : [session]
  const abort = () => controller.abort()
  for (const signal of signals) {
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  }
  return {
    signal: controller.signal,
    dispose: () => { for (const signal of signals) signal.removeEventListener('abort', abort) },
  }
}

export async function api<T>(
  url: string,
  options: { body?: unknown; signal?: AbortSignal; method?: 'GET' | 'POST' | 'HEAD'; keepalive?: boolean } = {},
): Promise<T> {
  const generation = sessionGeneration
  const sessionSignal = sessionController.signal
  const accepted = new Set<string>()
  let hostKeyRetries = 0
  let staleRetries = 0
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET')
  const endpoint = url.replace(/^\/api\/admin\//, '/api/')
  const confirmationEndpoint = endpoint === '/api/ssh/host-key' || endpoint === '/api/ssh/host-key/accept'
  const requestURL = adminPage && url.startsWith('/api/') && !url.startsWith('/api/admin/') ? url.replace('/api/', '/api/admin/') : url
  const body = method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined
  for (;;) {
    options.signal?.throwIfAborted()
    if (hostKeyRetries && generation !== sessionGeneration) throw new DOMException('Session changed', 'AbortError')
    const composed = hostKeyRetries ? retrySignal(sessionSignal, options.signal) : null
    try {
      const response = await fetch(requestURL, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: composed?.signal ?? options.signal,
        keepalive: options.keepalive,
        headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : {},
        body,
      })
      options.signal?.throwIfAborted()
      if (hostKeyRetries && generation !== sessionGeneration) throw new DOMException('Session changed', 'AbortError')
      if (response.status === 401 && endpoint !== '/api/login' && generation === sessionGeneration) sessionExpired()
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        options.signal?.throwIfAborted()
        const token = response.status === 409 && typeof payload?.sshHostKey?.token === 'string' &&
          payload.sshHostKey.token.length > 0 && payload.sshHostKey.token.length <= 512 ? payload.sshHostKey.token : undefined
        const failure = new APIError(
          typeof payload?.error === 'string' ? payload.error : `Request failed (${response.status}).`,
          response.status, token ? { token } : undefined,
        )
        if (token && !confirmationEndpoint && url.startsWith('/api/')) {
          if (generation !== sessionGeneration) throw new DOMException('Session changed', 'AbortError')
          if (!hostKeyConfirmation) {
            throw new APIError('Ask your administrator to verify and accept the SSH host key, then retry.', 409, { token })
          }
          // Allow nine approved hops, plus bounded retries for invalidated queued tokens.
          if (accepted.size >= 9 || hostKeyRetries >= 18 || accepted.has(token)) {
            throw new APIError('SSH still requires host key confirmation after retrying. Check the connection and try again.', 409, { token })
          }
          const outcome = await hostKeyConfirmation.confirm(token, options.signal)
          options.signal?.throwIfAborted()
          hostKeyRetries++
          if (outcome === 'stale' && staleRetries++ > 0) {
            throw new APIError('SSH host key confirmation expired. Retry the connection to request a fresh confirmation.', 409)
          }
          if (outcome === 'accepted') accepted.add(token)
          continue
        }
        throw failure
      }
      const value = method === 'HEAD' || response.status === 204 ? undefined : await response.json()
      options.signal?.throwIfAborted()
      if (hostKeyRetries && generation !== sessionGeneration) throw new DOMException('Session changed', 'AbortError')
      if (method === 'POST' && endpoint === '/api/logout') clearSSHHostKeyConfirmation()
      if (method === 'POST' && ['/api/settings', '/api/projects', '/api/projects/trust', '/api/ssh/hosts', '/api/ssh/host-key/accept'].includes(endpoint)) {
        window.dispatchEvent(new Event('artiface:configuration-changed'))
      }
      return value as T
    } finally { composed?.dispose() }
  }
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return 'Something went wrong. Please try again.'
}

export function isAborted(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}
