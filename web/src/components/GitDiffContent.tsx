import { useMemo } from 'react'
import { parseGitDiff, splitDiffLines } from '../gitDiff'
import type { DiffLine } from '../gitDiff'
import './gitDiff.css'

function Code({ line }: { line?: DiffLine }) {
  return <pre className="git-diff-code">{line?.text ?? ''}{line?.noNewline && <span className="git-no-newline">No newline at end of file</span>}</pre>
}

function SplitCell({ line, side }: { line?: DiffLine; side: 'old' | 'new' }) {
  return <div className={`git-split-cell ${line ? `diff-${line.kind}` : 'diff-empty'}`}>
    <span className="git-line-number">{side === 'old' ? line?.oldNumber : line?.newNumber}</span>
    <span className="git-line-marker" aria-hidden="true">{line?.kind === 'remove' ? '−' : line?.kind === 'add' ? '+' : ''}</span>
    <Code line={line} />
  </div>
}

export default function GitDiffContent({ patch, layout, commit }: { patch: string; layout: 'inline' | 'split'; commit?: string }) {
  const diff = useMemo(() => parseGitDiff(patch), [patch])
  const split = useMemo(() => diff.hunks.map(hunk => splitDiffLines(hunk.lines)), [diff])
  if (!patch) return <p className="git-message">No textual changes to display.</p>
  return <div className={`git-diff-table git-diff-${layout}`} aria-label="File diff" data-layout={layout}>
    {diff.metadata.length > 0 && <pre className="git-diff-metadata">{diff.metadata.join('\n')}</pre>}
    {diff.hunks.length > 0 && <div className={`git-diff-labels ${layout === 'split' ? 'git-split-row' : ''}`}>
      {layout === 'split' ? <><span>Before</span><span>{commit ? `After · ${commit.slice(0, 8)}` : 'After · Working tree'}</span></> : <span>{commit ? `Commit ${commit.slice(0, 8)} · Before / After` : 'Before / After · Line numbers'}</span>}
    </div>}
    {diff.hunks.map((hunk, index) => <section key={index} aria-label={`Changes ${hunk.header}`}>
      <div className="git-diff-hunk">{hunk.header}</div>
      {layout === 'inline' ? hunk.lines.map((line, number) => <div key={number} className={`git-inline-row diff-${line.kind}`}>
        <span className="git-line-number">{line.oldNumber}</span><span className="git-line-number">{line.newNumber}</span>
        <span className="git-line-marker" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</span><Code line={line} />
      </div>) : split[index].map((row, number) => <div key={number} className="git-split-row"><SplitCell line={row.left} side="old" /><SplitCell line={row.right} side="new" /></div>)}
    </section>)}
    {!diff.hunks.length && !diff.metadata.length && <pre className="git-diff-metadata">{patch}</pre>}
  </div>
}
