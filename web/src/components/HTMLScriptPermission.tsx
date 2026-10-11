import { Code2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, APIError, errorMessage, isAborted } from '../api'
import type { FileLocation } from '../types'

interface Inspection {
  status: 'pending' | 'present' | 'absent' | 'unknown'
  projectLabel: string
  revision: string
  canAllow: boolean
}

export default function HTMLScriptPermission({ token, location, onDismiss, onAllowed, onReload }: {
  token: string
  location: FileLocation
  onDismiss: () => void
  onAllowed: () => void
  onReload: () => void
}) {
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [allowed, setAllowed] = useState(false)
  const [reloadRequired, setReloadRequired] = useState(false)
  const grant = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer = 0
    let checks = 0
    setInspection(null)
    setError('')
    const check = async () => {
      try {
        const result = await api<Inspection>('/api/preview/scripts', { body: { token }, signal: controller.signal })
        if (controller.signal.aborted) return
        if (result.status === 'pending') {
          if (++checks < 40) timer = window.setTimeout(() => void check(), Math.min(1000, checks * 250))
          else setError('Couldn’t check this report for JavaScript.')
          return
        }
        setInspection(result)
      } catch (failure) {
        if (!controller.signal.aborted && !isAborted(failure)) {
          setError(errorMessage(failure))
          if (failure instanceof APIError && failure.status === 410) setReloadRequired(true)
        }
      }
    }
    void check()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [token, attempt])

  useEffect(() => () => { grant.current?.abort() }, [])

  async function allow() {
    if (!inspection?.canAllow || busy || reloadRequired) return
    const controller = new AbortController()
    grant.current = controller
    setBusy(true)
    setError('')
    try {
      await api('/api/projects/trust', {
        body: { host: location.host, root: location.root, revision: inspection.revision },
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setAllowed(true)
      onAllowed()
    } catch (failure) {
      if (!controller.signal.aborted && !isAborted(failure)) {
        setError(errorMessage(failure))
        if (failure instanceof APIError && failure.status === 409) setReloadRequired(true)
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  if ((!inspection && !error) || inspection?.status === 'absent') return null
  const explanation = allowed ? 'JavaScript is now allowed for this project.'
    : inspection ? `${inspection.status === 'present' ? 'This report contains JavaScript.' : 'This report could not be fully checked for JavaScript.'} ${
      inspection.canAllow ? `Allow it for all HTML reports in ${inspection.projectLabel}?` : 'An administrator can enable JavaScript for this project.'}`
      : 'JavaScript is blocked for this project.'
  const dismissLabel = reloadRequired || inspection?.canAllow ? 'Keep blocked' : 'Dismiss'
  const dismiss = <button className="icon-button" disabled={busy} onClick={onDismiss} aria-label={dismissLabel} title={dismissLabel}><X size={17} /></button>
  return <div className="script-permission" role="region" aria-label="JavaScript permission">
    <Code2 size={18} aria-hidden="true" />
    <div className="script-permission-copy">
      <span className="script-permission-summary" title={explanation} aria-label={explanation}>
        {allowed ? 'JavaScript allowed'
          : inspection?.status === 'unknown' ? 'JavaScript check incomplete'
            : inspection && !inspection.canAllow ? 'JavaScript blocked · Ask an administrator'
              : 'JavaScript blocked'}
        {!allowed && inspection?.canAllow && <> · <strong>{inspection.projectLabel}</strong></>}
      </span>
      {error && <span className="script-permission-error" role="alert">{error}</span>}
    </div>
    <div className="script-permission-actions">
      {allowed ? <button className="button secondary" onClick={onReload}>Reload report</button>
        : reloadRequired ? <><button className="button secondary" onClick={onReload}>Reload report</button>
          {dismiss}</>
        : inspection ? <>
          {inspection.canAllow && <button className="button secondary" disabled={busy} onClick={() => void allow()}
            aria-label={busy ? 'Allowing…' : 'Allow JavaScript'}
            title="Applies to every HTML report in this project. Scripts can read its preview folder and contact external services.">
            {busy ? 'Allowing…' : 'Allow for project'}</button>}
          {dismiss}
        </> : <><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Check again</button>
          {dismiss}</>}
    </div>
  </div>
}
