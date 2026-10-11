import { APIError } from './api'

interface Waiter {
  finish: (failure?: Error, outcome?: 'accepted' | 'retry' | 'stale') => void
}

export interface SSHHostKeyRequest {
  id: number
  token: string
  controller: AbortController
  waiters: Set<Waiter>
}

// Cancel suppresses the involved tokens for one minute.
// Background refreshes share those tokens; other SSH hosts remain usable.
export const sshHostKeyCooldown = 60_000

export function createSSHHostKeyQueue(present: (request: SSHHostKeyRequest | null) => void) {
  const pending = new Map<string, SSHHostKeyRequest>()
  const accepted = new Set<string>()
  const cancelled = new Map<string, number>()
  let current: SSHHostKeyRequest | null = null
  let sequence = 0

  function advance() {
    const next = pending.values().next().value ?? null
    if (next !== current) { current = next; present(next) }
  }

  function settle(request: SSHHostKeyRequest, failure?: Error, outcome: 'accepted' | 'retry' | 'stale' = 'accepted') {
    pending.delete(request.token)
    request.controller.abort()
    for (const waiter of [...request.waiters]) waiter.finish(failure, outcome)
  }

  function dismiss(failure: Error) {
    for (const request of [...pending.values()]) settle(request, failure)
    advance()
  }

  return {
    confirm(token: string, signal?: AbortSignal): Promise<'accepted' | 'retry' | 'stale'> {
      signal?.throwIfAborted()
      for (const [key, until] of cancelled) if (until <= Date.now()) cancelled.delete(key)
      if (cancelled.has(token)) {
        return Promise.reject(new APIError('SSH host key confirmation was cancelled. Wait one minute before retrying this host.', 409))
      }
      // A late 409 from a request already in flight must not reopen an accepted key.
      if (accepted.has(token)) return Promise.resolve('accepted')
      let request = pending.get(token)
      if (!request) {
        if (pending.size >= 128) return Promise.reject(new APIError('Too many SSH confirmations are pending. Retry the connection later.', 429))
        request = { id: ++sequence, token, controller: new AbortController(), waiters: new Set() }
        pending.set(token, request)
      }
      const entry = request
      const promise = new Promise<'accepted' | 'retry' | 'stale'>((resolve, reject) => {
        const waiter: Waiter = {
          finish(failure, outcome = 'accepted') {
            entry.waiters.delete(waiter)
            signal?.removeEventListener('abort', abort)
            if (failure) reject(failure)
            else resolve(outcome)
          },
        }
        const abort = () => {
          waiter.finish(new DOMException('Request cancelled', 'AbortError'))
          if (!entry.waiters.size) {
            pending.delete(token)
            entry.controller.abort()
            advance()
          }
        }
        entry.waiters.add(waiter)
        signal?.addEventListener('abort', abort, { once: true })
      })
      advance()
      return promise
    },
    approve(request: SSHHostKeyRequest) {
      if (pending.get(request.token) !== request || request.controller.signal.aborted) return
      accepted.add(request.token)
      if (accepted.size > 128) accepted.delete(accepted.values().next().value!)
      settle(request)
      // Acceptance replaces the encrypted envelope and invalidates other tokens.
      // Retry their original requests to obtain current challenges.
      for (const queued of [...pending.values()]) settle(queued, undefined, 'retry')
      advance()
    },
    retry(request: SSHHostKeyRequest) {
      if (pending.get(request.token) !== request || request.controller.signal.aborted) return
      settle(request, undefined, 'stale')
      advance()
    },
    cancel() {
      for (const token of pending.keys()) cancelled.set(token, Date.now() + sshHostKeyCooldown)
      while (cancelled.size > 128) cancelled.delete(cancelled.keys().next().value!)
      dismiss(new APIError('SSH host key was not accepted. Wait one minute before retrying this host.', 409))
    },
    clear() {
      cancelled.clear()
      accepted.clear()
      dismiss(new DOMException('Session changed', 'AbortError'))
    },
  }
}
