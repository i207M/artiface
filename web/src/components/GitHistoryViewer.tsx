import { Check, Copy, GitBranch, Maximize2, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { api, apiURL, APIError, errorMessage, isAborted } from '../api'
import { copyText } from '../clipboard'
import { modifiedTime, relativeTime } from '../format'
import { gitGraph } from '../gitGraph'
import type { GitHistory, GraphRow } from '../gitGraph'
import type { FileLocation } from '../types'
import { ErrorState, Loading, ShareButton } from './Common'
import { useBrowseReaderFocusTarget } from './useBrowseReaderFocus'
import type { BrowseReaderFocusRequest } from './useBrowseReaderFocus'
import './gitHistory.css'

function Graph({ row, width }: { row: GraphRow; width: number }) {
  const x = (column: number) => 14 + column * 18
  return <span className="git-graph" style={{ width }} aria-hidden="true"><svg width={width} height="100%" viewBox={`0 0 ${width} 40`} preserveAspectRatio="none">
    {row.edges.map((edge, index) => {
      const top = edge.start === 'top' ? 0 : 20
      const bottom = edge.end === 'bottom' ? 40 : 20
      const middle = (top + bottom) / 2
      return <path key={index} className={`git-lane-${edge.color}`}
        d={`M${x(edge.from)},${top} C${x(edge.from)},${middle} ${x(edge.to)},${middle} ${x(edge.to)},${bottom}`} />
    })}
  </svg><span className={`git-graph-node git-lane-${row.color}`} style={{ left: x(row.column) }} /></span>
}

export default function GitHistoryViewer({ location, active, focusRequest, copied, onCopyLink, onExpand }: {
  location: FileLocation
  active: boolean
  focusRequest?: BrowseReaderFocusRequest | null
  copied: boolean
  onCopyLink: () => void
  onExpand: () => void
}) {
  const content = useRef<HTMLDivElement>(null)
  const loaded = useRef('')
  const [data, setData] = useState<GitHistory | null>(null)
  const snapshot = useRef<GitHistory | null>(null)
  const [error, setError] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [busy, setBusy] = useState(true)
  const [request, setRequest] = useState({ offset: 0, attempt: 0 })
  const [selected, setSelected] = useState<string | null>(null)
  const [copiedHash, setCopiedHash] = useState('')
  const [copyError, setCopyError] = useState('')
  const url = apiURL('git/history', { ...location, path: '' })
  useBrowseReaderFocusTarget(content, active ? focusRequest : null)
  useEffect(() => {
    const key = JSON.stringify([url, request])
    if (!active || loaded.current === key) { setBusy(false); return }
    const controller = new AbortController()
    const previous = snapshot.current
    setBusy(true)
    setError('')
    setNeedsRefresh(false)
    const query = request.offset ? `&offset=${request.offset}&revision=${encodeURIComponent(previous?.revision ?? '')}` : ''
    void api<GitHistory>(url + query, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      const next = request.offset && previous ? { ...result, commits: [...previous.commits, ...result.commits] } : result
      snapshot.current = next
      setData(next)
      loaded.current = key
    }).catch(failure => {
      if (controller.signal.aborted || isAborted(failure)) return
      loaded.current = key
      setError(errorMessage(failure))
      setNeedsRefresh(failure instanceof APIError && failure.status === 409)
      if (failure instanceof APIError && [401, 403, 404].includes(failure.status)) {
        snapshot.current = null
        setData(null)
      }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [active, url, request])
  const graph = useMemo(() => gitGraph(data?.commits ?? []), [data])
  const graphWidth = graph.columns * 18 + 12
  const commit = data?.commits.find(item => item.hash === selected)
  const retry = () => setRequest(value => ({ offset: needsRefresh ? 0 : value.offset, attempt: value.attempt + 1 }))
  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing ||
      !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.git-history-row'))
    const index = rows.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    rows[next].focus()
    setSelected(data!.commits[next].hash)
  }
  async function copyHash(hash: string) {
    setCopyError('')
    try { await copyText(hash); setCopiedHash(hash) } catch { setCopyError('Could not copy. Select the commit ID below to copy it.') }
  }
  return <section className="file-preview git-history-preview" aria-label="Git history">
    <h1 className="sr-only">Git history</h1>
    <div className="preview-toolbar" id={active ? 'reader-toolbar' : undefined} role="toolbar" aria-label="Reader toolbar">
      <span className="git-history-caption"><GitBranch size={16} />All branches{data?.scoped && <span> · This project</span>}</span>
      <div className="file-actions">
        <button className={`icon-button preview-reload${busy ? ' is-refreshing' : ''}`} aria-label="Refresh history" title="Refresh history"
          aria-disabled={busy} onClick={() => { if (!busy) setRequest(value => ({ offset: 0, attempt: value.attempt + 1 })) }}><RefreshCw size={17} /></button>
        <ShareButton copied={copied} onClick={onCopyLink} compact />
        <button className="icon-button" aria-label="Full screen" title="Full screen" onClick={onExpand}><Maximize2 size={17} /></button>
      </div>
    </div>
    <div ref={content} className="git-history-content" tabIndex={-1}>
      {!data ? error ? <ErrorState title="Couldn’t load Git history" message={error} retry={retry} /> : <Loading message="Loading Git history…" />
        : <>
          {error && <div className="notice warning-notice" role="status">{error}<button className="text-button" disabled={busy} onClick={retry}>{needsRefresh ? 'Refresh history' : 'Try again'}</button></div>}
          <div className="git-history-list" tabIndex={0} aria-label="Commit history" aria-busy={busy} onKeyDown={move}
            style={{ '--git-graph-width': `${graphWidth}px` } as CSSProperties}>
            {!data.commits.length ? <p className="git-history-empty">No commits in this project yet.</p> : <>
              <div className="git-history-columns" aria-hidden="true"><span title="Graph"><GitBranch size={15} /></span><span>Commit</span><span className="git-history-author">Author</span><span className="git-history-date">Date</span><span>ID</span></div>
              <ol className="git-history-commits">
                {data.commits.map((item, index) => <li key={item.hash}>
                  <button className="git-history-row" data-commit={item.hash} aria-pressed={selected === item.hash}
                    tabIndex={selected === item.hash || (!commit && index === 0) ? 0 : -1}
                    onClick={() => { setSelected(item.hash); setCopyError('') }}
                    title={`${item.message.split('\n')[0]}\n${item.author} · ${modifiedTime(item.date)}\n${item.hash}`}>
                    <Graph row={graph.rows[index]} width={graphWidth} />
                    <span className="git-history-subject">{item.refs.length > 0 && <span className="git-history-refs">{item.refs.map(ref => <span className={`git-ref${ref.startsWith('HEAD') ? ' is-head' : ''}`} key={ref}>{ref}</span>)}</span>}<span>{item.message.split('\n')[0] || '(No commit message)'}</span></span>
                    <span className="git-history-author">{item.author}</span>
                    <time className="git-history-date" dateTime={item.date}>{relativeTime(item.date)}</time>
                    <code className="git-history-hash">{item.hash.slice(0, 8)}</code>
                  </button>
                </li>)}
              </ol>
            </>}
            <div className="git-history-footer"><span>{data.commits.length} commits{data.hasMore ? ' loaded' : ''}</span>
              {data.hasMore && <button className="button secondary" disabled={busy || needsRefresh} onClick={() => setRequest(value => ({ offset: data.commits.length, attempt: value.attempt + 1 }))}>{busy ? 'Loading…' : 'Load older commits'}</button>}
            </div>
          </div>
          {commit && <section className="git-commit-details" aria-label="Commit details">
            <header><strong>{commit.message.split('\n')[0] || '(No commit message)'}</strong>
              <button className="icon-button" aria-label="Close commit details" title="Close commit details" onClick={() => {
                content.current?.querySelector<HTMLButtonElement>(`[data-commit="${commit.hash}"]`)?.focus()
                setSelected(null)
              }}><X size={17} /></button></header>
            <div className="git-commit-identity"><code>{commit.hash}</code>
              <button className="icon-button" aria-label="Copy commit ID" title={copiedHash === commit.hash ? 'Copied' : 'Copy commit ID'} onClick={() => void copyHash(commit.hash)}>{copiedHash === commit.hash ? <Check size={16} /> : <Copy size={16} />}</button></div>
            {copyError && <p role="status">{copyError}</p>}
            <p>{commit.author}{commit.email && <> &lt;{commit.email}&gt;</>} · {modifiedTime(commit.date)}</p>
            {commit.refs.length > 0 && <div className="git-commit-refs">{commit.refs.map(ref => <span className="git-ref" key={ref}>{ref}</span>)}</div>}
            {commit.parents.length > 0 && <p className="git-commit-parents">Parents: {commit.parents.map(hash => <code key={hash} title={hash}>{hash.slice(0, 8)}</code>)}</p>}
            {commit.message.includes('\n') && <pre>{commit.message.slice(commit.message.indexOf('\n') + 1).trim()}</pre>}
          </section>}
        </>}
    </div>
  </section>
}
