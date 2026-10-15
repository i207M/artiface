import { Columns2, Copy, Maximize2, RefreshCw, Rows3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, apiURL, APIError, errorMessage, isAborted } from '../api'
import { fileTabName } from '../location'
import type { FileLocation } from '../types'
import { ErrorState, Loading, ShareButton } from './Common'
import { useBrowseReaderFocusTarget } from './useBrowseReaderFocus'
import type { BrowseReaderFocusRequest } from './useBrowseReaderFocus'
import GitDiffContent from './GitDiffContent'
import GitMediaDiff from './GitMediaDiff'
import type { GitMedia } from './GitMediaDiff'
import './git.css'

interface Diff { patch: string; truncated: boolean; media?: GitMedia }

export default function GitDiffViewer({ location, active, focusRequest, copied, onCopyLink, onCopyPath, onExpand }: {
  location: FileLocation
  active: boolean
  focusRequest?: BrowseReaderFocusRequest | null
  copied: boolean
  onCopyLink: () => void
  onCopyPath: () => void
  onExpand: () => void
}) {
  const content = useRef<HTMLDivElement>(null)
  const loaded = useRef('')
  const [data, setData] = useState<Diff | null>(null)
  const [error, setError] = useState('')
  const [retryable, setRetryable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [layout, setLayout] = useState<'inline' | 'split' | null>(null)
  const [wide, setWide] = useState(false)
  const shownLayout = layout ?? (wide ? 'split' : 'inline')
  const url = apiURL('git/diff', location) + (location.commit ? `&commit=${encodeURIComponent(location.commit)}` : '')
  useBrowseReaderFocusTarget(content, active ? focusRequest : null)
  useEffect(() => {
    const element = content.current
    if (!element) return
    const observer = new ResizeObserver(() => setWide(element.clientWidth >= 720))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const key = JSON.stringify([url, attempt])
    if (!active || loaded.current === key) { setBusy(false); return }
    const controller = new AbortController()
    setBusy(true)
    setError('')
    setRetryable(true)
    void api<Diff>(url, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      loaded.current = key
      setData(result)
    }).catch(failure => {
      if (controller.signal.aborted || isAborted(failure)) return
      loaded.current = key
      setData(null)
      setError(errorMessage(failure))
      setRetryable(!(failure instanceof APIError && failure.status === 413))
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [url, attempt, active])
  return <section className="file-preview git-diff-preview" aria-label={fileTabName(location)}>
    <h1 className="sr-only">{fileTabName(location)}</h1>
    <div className="preview-toolbar" id={active ? 'reader-toolbar' : undefined} role="toolbar" aria-label="Reader toolbar">
      <div className="view-toggle git-diff-layout" aria-label="Diff layout">
        <button className={shownLayout === 'inline' ? 'active' : ''} aria-label="Inline diff" title="Inline diff" aria-pressed={shownLayout === 'inline'} onClick={() => setLayout('inline')}><Rows3 size={15} /><span>Inline</span></button>
        <button className={shownLayout === 'split' ? 'active' : ''} aria-label="Side-by-side diff" title="Side-by-side diff" aria-pressed={shownLayout === 'split'} onClick={() => setLayout('split')}><Columns2 size={15} /><span>Side by side</span></button>
      </div>
      <div className="file-actions">
        <button className={`icon-button preview-reload${busy ? ' is-refreshing' : ''}`} aria-label="Refresh diff" title="Refresh diff" aria-disabled={busy}
          onClick={() => { if (!busy) setAttempt(value => value + 1) }}><RefreshCw size={17} /></button>
        <button className="icon-button" aria-label="Copy file path" title="Copy file path" onClick={onCopyPath}><Copy size={17} /></button>
        <ShareButton copied={copied} onClick={onCopyLink} compact />
        <button className="icon-button" aria-label="Full screen" title="Full screen" onClick={onExpand}><Maximize2 size={17} /></button>
      </div>
    </div>
    {data?.truncated && <p className="notice git-diff-notice" role="status">Partial diff: preview limited to 128 KiB, 2,000 lines, or 8 seconds.</p>}
    <div ref={content} className={`preview-content content-diff${data?.media ? ' content-media-diff' : ''}`} tabIndex={-1}>
      {error ? <ErrorState title="Couldn’t load this diff" message={error} retry={retryable ? () => setAttempt(value => value + 1) : undefined} />
        : !data ? <Loading message="Loading diff…" />
          : data.media ? <GitMediaDiff key={loaded.current} media={data.media} name={location.path} layout={shownLayout} commit={location.commit} active={active} />
            : <div className="git-diff-content" tabIndex={0} aria-label="Git diff" aria-busy={busy}><GitDiffContent patch={data.patch} layout={shownLayout} commit={location.commit} /></div>}
    </div>
  </section>
}
