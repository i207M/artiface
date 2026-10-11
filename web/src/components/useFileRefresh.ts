import { useCallback, useEffect, useRef, useState } from 'react'
import { api, APIError, apiURL, errorMessage, isAborted } from '../api'
import type { Entry, FileLocation } from '../types'

export interface FileMetadata extends Entry {
  version: string
  trustedScripts?: boolean
}

interface Options {
  location: FileLocation
  intervalSeconds: number
  paused: boolean
  busy?: boolean
  retry?: boolean
  validateContent?: boolean
  onChange: (signal: AbortSignal, metadata: FileMetadata) => Promise<FileMetadata | null>
  onUnavailable?: () => void
}

// Keep the baseline across pauses, and schedule the next check only after the
// previous check (including its refresh) has settled.
export function useFileRefresh({ location, intervalSeconds, paused, busy = false, retry = false, validateContent = false, onChange, onUnavailable }: Options) {
  const url = apiURL('file-info', location)
  const [metadata, setMetadata] = useState<FileMetadata | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const baseline = useRef<{ url: string; version?: string }>({ url })
  const catchUp = useRef(false)
  const pending = useRef(false)
  const latest = useRef({ onChange, onUnavailable, busy, retry, validateContent })
  const checkRef = useRef<() => void>(() => {})
  latest.current = { onChange, onUnavailable, busy, retry, validateContent }
  const checkNow = useCallback(() => checkRef.current(), [])

  useEffect(() => {
    if (baseline.current.url !== url) {
      baseline.current = { url }
      pending.current = false
      setMetadata(null)
      setError('')
    }
    const delay = Math.min(300, Math.max(2, Number.isFinite(intervalSeconds) ? intervalSeconds : 10)) * 1000
    let disposed = false
    let timer: number | undefined
    let controller: AbortController | undefined
    let running = false
    let checkAgain = false
    const allowed = () => !disposed && !paused && document.visibilityState !== 'hidden'
    const schedule = () => {
      window.clearTimeout(timer)
      if (allowed()) timer = window.setTimeout(() => { void check() }, delay)
    }

    async function check() {
      if (!allowed()) return
      if (running) { checkAgain = true; return }
      // A slow content request must not accumulate more refresh work.
      if (latest.current.busy && baseline.current.version !== undefined) { schedule(); return }
      window.clearTimeout(timer)
      running = true
      controller = new AbortController()
      const signal = controller.signal
      setChecking(true)
      try {
        const result = await api<FileMetadata>(url, { signal })
        if (signal.aborted || !allowed()) return
        if (typeof result.version !== 'string' || !result.version) throw new Error('File metadata did not include a version.')
        const previous = baseline.current.version
        const changed = previous !== undefined && previous !== result.version
        setMetadata(result)
        // A stat is acknowledged only after the reader validates its adopted responses.
        const initialRead = previous === undefined && catchUp.current
        let acknowledged: FileMetadata | null = result
        if (changed || latest.current.retry || initialRead || pending.current || latest.current.validateContent) {
          pending.current = true
          acknowledged = await latest.current.onChange(signal, result)
        }
        if (signal.aborted || !allowed()) return
        if (!acknowledged) return
        baseline.current.version = acknowledged.version
        pending.current = false
        setMetadata(acknowledged)
        catchUp.current = false
        setError('')
      } catch (failure) {
        if (!signal.aborted && !disposed && !isAborted(failure)) {
          if (failure instanceof APIError && [401, 403, 404].includes(failure.status)) latest.current.onUnavailable?.()
          catchUp.current = true
          setError(errorMessage(failure))
        }
      } finally {
        running = false
        if (!disposed) setChecking(false)
        if (checkAgain && allowed()) {
          checkAgain = false
          void check()
        } else {
          schedule()
        }
      }
    }

    function visibilityChanged() {
      window.clearTimeout(timer)
      if (document.visibilityState === 'hidden') {
        catchUp.current = true
        controller?.abort()
        setChecking(false)
      } else if (!paused) {
        void check()
      }
    }

    checkRef.current = () => { void check() }
    document.addEventListener('visibilitychange', visibilityChanged)
    if (paused || document.visibilityState === 'hidden') catchUp.current = true
    else void check()
    if (paused) setChecking(false)
    return () => {
      disposed = true
      checkRef.current = () => {}
      window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [url, intervalSeconds, paused])

  return { metadata, error, checking, checkNow }
}
