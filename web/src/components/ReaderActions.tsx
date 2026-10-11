import { ArrowDownToLine, Check, MoreHorizontal, Pause, Play, RefreshCw, Share2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAnchoredPopover } from './useAnchoredPopover'

export default function ReaderActions({ paused, busy, checking = false, active = true, interval, onPause, onRefresh, copied, onCopy, downloadURL, name, extra, details }: {
  paused: boolean; busy: boolean; checking?: boolean; active?: boolean; interval: number; onPause: () => void; onRefresh: () => void
  copied: boolean; onCopy: () => void; downloadURL: string; name: string; extra?: ReactNode; details?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useAnchoredPopover(open && active, trigger)
  useEffect(() => { if (!active) setOpen(false) }, [active])
  useEffect(() => {
    if (!open || !active) return
    const dismiss = (event: Event) => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    let blurTimer: number | undefined
    const frameFocus = () => {
      // Clicks inside an HTML report do not bubble to the app's document.
      blurTimer = window.setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME') setOpen(false)
      }, 0)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', frameFocus)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('focusin', dismiss)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', frameFocus)
      window.clearTimeout(blurTimer)
    }
  }, [open, active])
  const close = () => { setOpen(false); trigger.current?.focus() }
  // Keep Refresh focusable while its request is in progress.
  const refresh = () => { if (!busy) onRefresh() }
  return <div className="reader-actions-menu">
    <div className="reader-inline-actions">
      <button className={`icon-button preview-reload ${busy ? 'is-refreshing' : ''}`} aria-disabled={busy || undefined} onClick={refresh} aria-label="Refresh file" title={busy ? 'Refreshing file…' : checking ? 'Checking for updates…' : 'Refresh file'}><RefreshCw size={17} /></button>
      <button className={`icon-button auto-refresh-toggle ${paused ? 'is-paused' : ''}`} onClick={onPause} aria-pressed={paused} aria-label={paused ? 'Resume automatic refresh' : 'Pause automatic refresh'} title={paused ? 'Resume automatic refresh' : `Pause automatic refresh · every ${interval}s`}>{paused ? <Play size={17} /> : <Pause size={17} />}</button>
    </div>
    <div className="reader-inline-links">
      <a className="icon-button" href={downloadURL} download={name} aria-label="Download file" title="Download original"><ArrowDownToLine size={17} /></a>
      <button className="icon-button" onClick={onCopy} aria-label="Share link" title={copied ? 'Link copied' : 'Share link · copy to clipboard'}>{copied ? <Check size={17} /> : <Share2 size={17} />}</button>
    </div>
    <button ref={trigger} className={`icon-button ${paused ? 'is-paused' : ''}`} aria-label="Reader options" aria-expanded={open} title={`Reader options · ${paused ? 'Automatic refresh paused' : `Auto refresh every ${interval}s`}`} onClick={() => setOpen(!open)}>
      <MoreHorizontal size={18} />{paused && <span className="paused-dot" />}
    </button>
    {open && <div className="reader-actions-panel" ref={panel} tabIndex={-1} onClick={event => {
      const action = (event.target as Element).closest('button,a')
      if (action && !action.matches(':disabled,[aria-disabled="true"],[data-keep-menu-open]')) close()
    }} onChange={event => {
      if (!(event.target as Element).closest('[data-keep-menu-open]')) close()
    }}>
      <button className="reader-overflow-action" aria-disabled={busy || undefined} onClick={refresh} title={busy ? 'Refreshing file…' : 'Download the latest file again'}><RefreshCw size={16} />Refresh file</button>
      <button className="reader-overflow-action" onClick={onPause} aria-pressed={paused} title={paused ? 'Resume automatic refresh' : 'Pause automatic refresh'}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? 'Resume automatic refresh' : 'Pause automatic refresh'}</button>
      <a className="reader-overflow-link" href={downloadURL} download={name} title="Download original"><ArrowDownToLine size={16} />Download file</a>
      <button className="reader-overflow-link" onClick={onCopy} title={copied ? 'Link copied' : 'Share link · copy to clipboard'}>{copied ? <Check size={16} /> : <Share2 size={16} />}Share link</button>
      {extra && <div className="reader-extra-actions">{extra}</div>}
      {details}
    </div>}
  </div>
}
