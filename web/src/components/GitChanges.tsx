import { GitBranch, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { gitMark } from './useGitStatus'
import type { GitMark, useGitStatus } from './useGitStatus'
import { useAnchoredPopover } from './useAnchoredPopover'
import './git.css'

export function GitBadge({ mark, onClick, path }: { mark?: GitMark; onClick?: () => void; path: string }) {
  if (!mark) return null
  const props = { className: `git-badge git-${mark.code === '?' ? 'untracked' : mark.code}`, title: mark.label }
  return onClick
    ? <button {...props} aria-label={`View Git diff for ${path}: ${mark.label}`} onClick={onClick}>{mark.code}</button>
    : <span {...props} aria-label={mark.label}>{mark.code}</span>
}

export default function GitChanges({ git, onDiff, onSettings }: { git: ReturnType<typeof useGitStatus>; onDiff: (path: string) => void; onSettings: () => void }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useAnchoredPopover(open, trigger)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('focusin', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const { data, checking, error } = git
  if (data?.state === 'none' && !error) return null
  const changes = data?.changes ?? []
  const query = filter.toLocaleLowerCase()
  const matching = query ? changes.filter(change => change.path.toLocaleLowerCase().includes(query)) : changes
  return <div className="git-changes">
    <button ref={trigger} className={`button quiet git-trigger ${data?.state === 'paused' ? 'git-paused' : ''}`} aria-label="Git status" aria-expanded={open}
      title={data?.state === 'paused' ? 'Git checks paused' : error ? 'Last known Git status' : checking ? 'Checking Git status…' : `${data?.branch || 'Git'} · ${changes.length} changes`}
      onClick={() => setOpen(value => !value)}>
      <GitBranch size={16} /><span className="git-branch">{data?.state === 'paused' ? 'Paused' : data?.branch || 'Git'}</span>
      <span className="git-count">{data?.state === 'ready' ? changes.length : data?.state === 'paused' ? 'Ⅱ' : '·'}</span>
    </button>
    {open && <div ref={panel} className="git-changes-panel" tabIndex={-1}>
      <div className="git-panel-heading"><strong>{data?.branch || 'Git status'}</strong>
        <button className="icon-button" aria-label="Refresh Git status" title={checking ? 'Checking Git status…' : 'Check Git now'} aria-disabled={checking || undefined} onClick={() => { if (!checking) git.retry() }}><RefreshCw size={16} /></button>
      </div>
      {error && <p className="git-message" role="status">{error}</p>}
      {data?.message && <p className="git-message" role="status">{data.message}{data.state === 'paused' && <> Automatic retry at {new Date(data.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</>}</p>}
      {!data && !error && <p className="git-message" role="status">Checking Git status…</p>}
      {data?.state === 'ready' && <>
        {changes.length > 12 && <input className="git-filter" aria-label="Filter changed files" placeholder="Filter changed files" value={filter} onChange={event => setFilter(event.target.value)} />}
        {changes.length === 0 ? <p className="git-message">No changes in this project.</p> : <ul className="git-file-changes" aria-label="Git changes">
          {matching.slice(0, 100).map(change => <li key={change.path}>
            {change.directory ? <span title="Open this folder in Browse to compare individual files"><GitBadge mark={gitMark(change)} path={change.path} /><span>{change.path}/</span></span>
              : <button title={`View diff · ${change.path}`} onClick={() => { trigger.current?.focus(); setOpen(false); onDiff(change.path) }}><GitBadge mark={gitMark(change)} path={change.path} /><span>{change.path}</span></button>}
          </li>)}
        </ul>}
        {matching.length > 100 && <p className="git-message">Showing 100 of {matching.length} changes. Filter to find a file.</p>}
      </>}
      <div className="git-panel-footer">
        {data?.state !== 'ready' && <button className="text-button" disabled={checking} onClick={git.retry}>Try again</button>}
        <button className="text-button" onClick={onSettings}>Project Git settings</button>
      </div>
    </div>}
  </div>
}
