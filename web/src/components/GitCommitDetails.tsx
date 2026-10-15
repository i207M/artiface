import { ChevronRight, Folder } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, apiURL, errorMessage, isAborted } from '../api'
import { modifiedTime } from '../format'
import { gitFileTree } from '../gitCommit'
import type { GitCommitDetails as CommitDetails, GitFileNode } from '../gitCommit'
import type { GitCommit } from '../gitGraph'
import type { FileLocation } from '../types'
import { EntryIcon, Loading } from './Common'

export function selectedTextWithin(element: HTMLElement) {
  const selection = window.getSelection()
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(element))
}

const statuses = { A: 'Added', D: 'Deleted', M: 'Modified', T: 'Type changed' }
function FileTree({ nodes, onDiff, nested = false }: { nodes: GitFileNode[]; onDiff: (path: string) => void; nested?: boolean }) {
  return <ul className="git-commit-file-tree" aria-label={nested ? undefined : 'Changed files'}>
    {nodes.map(node => <li key={`${node.status ? 'file' : 'directory'}:${node.path}`}>
      {node.status ? <div className="git-commit-file" title={`View commit diff · ${statuses[node.status]} · ${node.path}`}
        role="button" tabIndex={0} aria-label={`View commit diff for ${node.path}`}
        onClick={event => { if (event.detail <= 1 && !selectedTextWithin(event.currentTarget)) onDiff(node.path) }}
        onKeyDown={event => {
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) onDiff(node.path) }
        }}>
        <EntryIcon entry={{ type: 'file', path: node.path }} /><span className="git-commit-file-name">{node.name}</span>
        <span className={`git-badge git-${node.status}`} aria-label={statuses[node.status]}>{node.status}</span>
      </div> : <details className="git-commit-folder" open>
        <summary onClick={event => { if (event.detail && (event.detail > 1 || selectedTextWithin(event.currentTarget))) event.preventDefault() }}>
          <ChevronRight className="git-tree-disclosure" size={14} /><Folder size={16} /><span>{node.name}</span>
        </summary>
        <FileTree nodes={node.children} onDiff={onDiff} nested />
      </details>}
    </li>)}
  </ul>
}

export default function GitCommitDetails({ commit, location, active, onDiff }: {
  commit: GitCommit
  location: FileLocation
  active: boolean
  onDiff: (path: string) => void
}) {
  const [data, setData] = useState<CommitDetails | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const url = apiURL('git/commit', { ...location, path: '' }) + `&commit=${encodeURIComponent(commit.hash)}`
  useEffect(() => {
    if (!active || data) return
    const controller = new AbortController()
    setError('')
    void api<CommitDetails>(url, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result)
    }).catch(failure => {
      if (!controller.signal.aborted && !isAborted(failure)) setError(errorMessage(failure))
    })
    return () => controller.abort()
  }, [active, url, attempt, data])
  const tree = useMemo(() => gitFileTree(data?.files ?? []), [data])
  return <div className="git-commit-content">
    {error ? <p className="git-message" role="status">{error} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Try again</button></p>
      : !data ? <Loading message="Loading changed files…" compact />
        : <>
          <header className="git-commit-files-heading"><strong>Files changed <span>({data.files.length}{data.truncated ? '+' : ''})</span></strong>
            {data.parents.length > 1 && <span>Compared with first parent</span>}
          </header>
          {tree.length ? <FileTree nodes={tree} onDiff={onDiff} /> : <p className="git-message">No file changes in this project.</p>}
          {data.truncated && <p className="git-message" role="status">Showing a partial file list.</p>}
          <details className="git-commit-metadata">
            <summary>Commit details</summary>
            <pre className="git-commit-message">{commit.message || '(No commit message)'}</pre>
            <dl>
              <dt>Commit</dt><dd><code>{data.hash}</code></dd>
              <dt>Parents</dt><dd>{data.parents.length ? data.parents.map(parent => <code key={parent}>{parent}</code>) : 'None (initial commit)'}</dd>
              <dt>Author</dt><dd>{data.author}{data.email && <> &lt;{data.email}&gt;</>}</dd>
              <dt>Authored</dt><dd><time dateTime={data.date}>{modifiedTime(data.date)}</time></dd>
              <dt>Committer</dt><dd>{data.committer}{data.committerEmail && <> &lt;{data.committerEmail}&gt;</>}</dd>
              <dt>Committed</dt><dd><time dateTime={data.commitDate}>{modifiedTime(data.commitDate)}</time></dd>
              {commit.refs.length > 0 && <><dt>Refs</dt><dd>{commit.refs.map(ref => <span className="git-ref" key={ref}>{ref}</span>)}</dd></>}
            </dl>
          </details>
        </>}
  </div>
}
