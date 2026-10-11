import { LayoutGrid, ListTree, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { api, apiURL, errorMessage, isAborted, sessionExpired } from '../api'
import { flattenOutline, outlinePage } from '../pdfOutline'
import type { PDFOutlineItem } from '../pdfOutline'
import type { PDFSource } from './PDFPages'
import { useAnchoredPopover } from './useAnchoredPopover'
import './pdfNavigation.css'

export default function PDFNavigation({ document: source, onPage, onOverview, onOriginal }: {
  document: PDFSource | null
  onPage: (page: number) => void
  onOverview: () => void
  onOriginal: () => void
}) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<{ document: PDFSource; items: PDFOutlineItem[]; truncated: boolean } | null>(null)
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useAnchoredPopover(open, trigger)
  const request = useRef<AbortController | null>(null)
  const id = useId()
  const document = source && !('compressed' in source) ? source : null
  const outline = result?.document === source ? result : null

  useEffect(() => { setOpen(false); setResult(null); setFailure('') }, [source])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    request.current = controller
    let timer: number | undefined
    setFailure('')
    setBusy(null)
    if (source && !outline) {
      timer = window.setTimeout(() => {
        controller.abort()
        setFailure('The outline took too long to load. Close it and try again.')
      }, 'compressed' in source ? 45_000 : 10_000)
      const load = async () => {
        if (!('compressed' in source)) return flattenOutline(await source.getOutline())
        const data = await api<{ items: { title: string; depth: number; page: number | null }[]; truncated: boolean }>(
          apiURL('pdf/outline', source.location) + `&document=${encodeURIComponent(source.id)}`, { signal: controller.signal })
        return {
          items: data.items.slice(0, 500).map(item => ({
            title: item.title.slice(0, 4096), depth: Math.min(31, Math.max(0, item.depth)),
            destination: item.page && Number.isInteger(item.page) && item.page > 0 && item.page <= source.numPages ? [item.page - 1] : null,
          })),
          truncated: data.truncated || data.items.length > 500,
        }
      }
      void load().then(value => {
        if (!controller.signal.aborted) setResult({ document: source, ...value })
      }).catch(error => {
        if (!controller.signal.aborted) {
          if (error && typeof error === 'object' && 'status' in error && error.status === 401) sessionExpired()
          setFailure(errorMessage(error))
        }
      }).finally(() => window.clearTimeout(timer))
    }
    const dismiss = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    window.document.addEventListener('pointerdown', dismiss, true)
    window.document.addEventListener('focusin', dismiss)
    window.document.addEventListener('keydown', escape, true)
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('button')?.focus())
    return () => {
      controller.abort()
      request.current?.abort()
      window.clearTimeout(timer)
      cancelAnimationFrame(frame)
      window.document.removeEventListener('pointerdown', dismiss, true)
      window.document.removeEventListener('focusin', dismiss)
      window.document.removeEventListener('keydown', escape, true)
    }
    // A loaded result must not refocus the panel or restart its active request.
  }, [open, source, panel])

  async function select(item: PDFOutlineItem, index: number) {
    if (!source) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(index)
    setFailure('')
    const timer = window.setTimeout(() => {
      if (controller.signal.aborted) return
      controller.abort()
      setBusy(null)
      setFailure('This bookmark took too long to open. Try again.')
    }, 10_000)
    try {
      const page = document ? await outlinePage(document, item.destination, controller.signal)
        : Array.isArray(item.destination) ? Number(item.destination[0]) + 1 : 0
      controller.signal.throwIfAborted()
      if (!Number.isInteger(page) || page < 1 || page > source.numPages) throw new Error('This bookmark does not point to a page.')
      setOpen(false)
      onPage(page)
    } catch (error) {
      if (!controller.signal.aborted && !isAborted(error)) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 401) sessionExpired()
        setFailure(errorMessage(error))
      }
    } finally {
      window.clearTimeout(timer)
      if (!controller.signal.aborted) setBusy(null)
    }
  }

  function moveOutlineFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const origin = event.target
    if (!(origin instanceof HTMLButtonElement)) return
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const index = rows.indexOf(origin)
    if (index < 0) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    rows[next].focus()
  }

  return <div className="pdf-navigation">
    <button ref={trigger} className="pdf-outline-trigger" disabled={!source} aria-label="PDF outline and pages" title="PDF outline and pages"
      aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><span className="pdf-page-count"><span className="pdf-page-total">of {source?.numPages.toLocaleString() ?? '…'}</span><span className="pdf-page-total-compact">/{source?.numPages ?? '…'}</span></span><ListTree size={16} /></button>
    {open && createPortal(<div ref={panel} id={id} className="pdf-navigation-panel" role="dialog" aria-label="PDF navigation">
      <header><strong>Outline</strong><button className="icon-button" aria-label="Close PDF navigation" title="Close PDF navigation"
        onClick={() => { setOpen(false); trigger.current?.focus() }}><X size={16} /></button></header>
      <button className="pdf-overview-action" onClick={() => { setOpen(false); onOverview() }}><LayoutGrid size={17} />Page overview</button>
      <nav aria-label="PDF outline" className="pdf-outline-list" onKeyDown={moveOutlineFocus}>
          {!outline && !failure && <p className="pdf-outline-message" role="status">Loading outline…</p>}
          {outline && !outline.items.length && <p className="pdf-outline-message">This PDF has no outline. Use Page overview to browse its pages.</p>}
          {outline?.items.map((item, index) => <button key={index} disabled={!item.destination || busy !== null}
            aria-busy={busy === index || undefined} title={item.destination ? item.title : 'No page destination'} data-outline-depth={item.depth}
            style={{ '--outline-depth': Math.min(item.depth, 6) } as CSSProperties} onClick={() => { void select(item, index) }}>{item.title}</button>)}
          {outline?.truncated && <p className="pdf-outline-message" role="status">Showing the first 500 outline entries, up to 32 levels deep.</p>}
      </nav>
      {failure && <div className="pdf-outline-message" role="status"><p>{failure}</p>
        {source && 'compressed' in source && <button className="text-button" onClick={() => { setOpen(false); onOriginal() }}>Use Original mode</button>}
      </div>}
    </div>, trigger.current?.closest('.pdf-viewer') ?? window.document.body)}
  </div>
}
