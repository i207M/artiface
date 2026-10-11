import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useRef } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from 'react'
import { formatBytes, modifiedTime, relativeTime } from '../format'
import { locationHash, parentPath } from '../location'
import type { Entry, Location } from '../types'
import { EntryIcon } from './Common'
import { GitBadge } from './GitChanges'
import type { GitMark } from './useGitStatus'
import { entryTypeLabel } from './fileTypes'
import type { FileSort, SortColumn } from './fileTypes'

type OpenEntry = (entry: Entry, background?: boolean, keyboardOrigin?: HTMLAnchorElement) => void
export const browsePageSize = 200

function matchedName(text: string, query: string, start = 0, end = text.length) {
  const folded = text.toLocaleLowerCase()
  // Case mappings that change length cannot safely share the original offsets.
  const match = query && folded.length === text.length ? folded.indexOf(query) : -1
  const from = Math.max(start, match), to = Math.min(end, match + query.length)
  return match < 0 || from >= to ? text.slice(start, end)
    : <>{text.slice(start, from)}<mark className="file-match">{text.slice(from, to)}</mark>{text.slice(to, end)}</>
}

function TileName({ path, file, query }: { path: string; file: boolean; query: string }) {
  const start = path.lastIndexOf('/') + 1
  const dot = path.lastIndexOf('.')
  const extension = file && dot > start && path.length - dot <= 12
  return <span className="tile-name">{extension
    ? <>{matchedName(path, query, start, dot)}<span className="tile-extension">{matchedName(path, query, dot)}</span></>
    : matchedName(path, query, start)}</span>
}

export function EntryLink({ entry, location, onOpen, className, children, current }: {
  entry: Entry; location: Location; onOpen: OpenEntry; className?: string; children: ReactNode; current?: boolean
}) {
  const available = entry.type === 'file' || entry.type === 'directory'
  const target = { ...location, path: entry.resolvedPath ?? entry.path, kind: entry.type === 'directory' ? 'directory' as const : 'file' as const }
  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.shiftKey || event.altKey || (event.button !== 0 && event.button !== 1)) return
    if (entry.type === 'directory' && (event.ctrlKey || event.metaKey || event.button === 1)) return
    event.preventDefault()
    onOpen(entry, event.ctrlKey || event.metaKey || event.button === 1)
  }
  const activateKeyboard = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (entry.type !== 'file' || event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (event.repeat) return
    const background = event.ctrlKey || event.metaKey
    onOpen(entry, background, background ? undefined : event.currentTarget)
  }
  return available
    ? <a href={locationHash(target)} className={className} onKeyDown={activateKeyboard} onClick={activate} onAuxClick={activate} aria-current={current ? 'page' : undefined} title={`${entry.path}${entry.symlink ? ` → ${entry.resolvedPath || '/'}` : ''}\n${entryTypeLabel(entry)} · Modified ${modifiedTime(entry.modified)}`}>{children}</a>
    : <span className={`${className || ''} unavailable-entry`} aria-disabled="true" title={entry.type === 'symlink' ? `${entry.name}: link unavailable or outside this project` : `${entry.name}: ${entry.type} entries cannot be opened`}>{children}</span>
}

export default function FileList({ entries, location, onOpen, view, sort, onSort, page, onPageChange, pageJump, sortControl, flat = false, compactHeader = false, query = '', gitMark, onGitDiff }: {
  entries: Entry[]; location: Location; onOpen: OpenEntry; view: 'list' | 'icons'; sort: FileSort; onSort: (column: SortColumn) => void
  page: number; onPageChange: (page: number) => void; pageJump?: RefObject<HTMLSelectElement | null>; sortControl?: ReactNode; flat?: boolean; compactHeader?: boolean; query?: string
  gitMark?: (entry: Entry) => GitMark | undefined; onGitDiff?: (path: string) => void
}) {
  const results = useRef<HTMLDivElement>(null)
  const topPager = useRef<HTMLElement | null>(null)
  const bottomPager = useRef<HTMLElement | null>(null)
  const attachPager = useCallback((element: HTMLElement | null) => {
    if (!element && topPager.current?.contains(document.activeElement)) {
      requestAnimationFrame(() => (pageJump?.current ?? results.current)?.focus({ preventScroll: true }))
    }
    topPager.current = element
  }, [pageJump])
  const attachFooter = useCallback((element: HTMLElement | null) => {
    if (!element && bottomPager.current?.contains(document.activeElement)) results.current?.focus({ preventScroll: true })
    bottomPager.current = element
  }, [])
  const pages = Math.ceil(entries.length / browsePageSize)
  const start = page * browsePageSize
  const visible = entries.slice(start, start + browsePageSize)
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const origin = event.target
    if (!(origin instanceof HTMLAnchorElement) || !origin.matches('.table-name > a, .file-tile')) return
    const icons = view === 'icons'
    if (!(icons ? ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
      : ['ArrowUp', 'ArrowDown', 'Home', 'End']).includes(event.key)) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) return
    const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>('.table-name > a[href], a.file-tile[href]'))
    const index = links.indexOf(origin)
    if (index < 0) return
    let next = origin
    if (event.key === 'Home') next = links[0]
    else if (event.key === 'End') next = links[links.length - 1]
    else if (!icons) next = links[Math.max(0, Math.min(links.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    else {
      const here = origin.getBoundingClientRect()
      const x = here.left + here.width / 2
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
      const choices = links.map(link => {
        const box = link.getBoundingClientRect()
        return { link, dx: box.left + box.width / 2 - x, dy: box.top - here.top }
      }).filter(item => horizontal ? Math.abs(item.dy) < 1 && item.dx * direction > 1 : item.dy * direction > 1)
      choices.sort((a, b) => horizontal ? Math.abs(a.dx) - Math.abs(b.dx)
        : Math.abs(a.dy) - Math.abs(b.dy) || Math.abs(a.dx) - Math.abs(b.dx))
      next = choices[0]?.link ?? origin
    }
    event.preventDefault()
    next.focus()
  }
  function changePage(next: number, control: string) {
    onPageChange(next)
    requestAnimationFrame(() => {
      const button = topPager.current?.querySelector<HTMLButtonElement | HTMLSelectElement>(`[data-page-control="${control}"]`)
      const target = button && !button.disabled ? button : topPager.current?.querySelector<HTMLSelectElement>('[data-page-control="select"]')
      const focus = (compactHeader ? pageJump?.current : target) ?? results.current
      focus?.focus({ preventScroll: true })
    })
  }
  const pager = (footer = false) => pages > 1 && <nav className="browse-pagination" aria-label={footer ? 'File pages footer' : 'File pages'} ref={footer ? attachFooter : attachPager}>
    <span className="browse-page-range" role={footer ? undefined : 'status'}>{footer ? `${entries.length.toLocaleString()} entries` : <><span>{(start + 1).toLocaleString()}–{Math.min(start + browsePageSize, entries.length).toLocaleString()}</span>{' '}<span>of {entries.length.toLocaleString()}</span></>}</span>
    <div className="browse-page-controls">
      <button className="icon-button" aria-label={footer ? 'Previous page at end of list' : 'Previous page'} title="Previous page" data-page-control="previous" disabled={page === 0} onClick={() => changePage(page - 1, 'previous')}><ChevronLeft size={17} /></button>
      <select aria-label={footer ? 'File page at end of list' : 'File page'} title={`Page ${page + 1} of ${pages}`} data-page-control="select" value={page} onChange={event => changePage(Number(event.target.value), 'select')}>
        {Array.from({ length: pages }, (_, index) => <option key={index} value={index}>{index + 1} / {pages}</option>)}
      </select>
      <button className="icon-button" aria-label={footer ? 'Next page at end of list' : 'Next page'} title="Next page" data-page-control="next" disabled={page === pages - 1} onClick={() => changePage(page + 1, 'next')}><ChevronRight size={17} /></button>
    </div>
    {!footer && sortControl}
  </nav>
  const displayName = (entry: Entry) => flat && location.path && entry.path.startsWith(`${location.path}/`)
    ? entry.path.slice(location.path.length + 1) : flat ? entry.path : entry.name
  const renderName = (entry: Entry, tile = false) => {
    const relative = displayName(entry)
    const parent = flat ? parentPath(relative) : ''
    const name = tile ? <TileName path={relative} file={entry.type === 'file'} query={query} />
      : matchedName(relative, query, parent ? parent.length + 1 : 0)
    if (!parent) return tile ? name : <span>{name}</span>
    return <span className="flat-entry-name">
      <span className="sr-only">{relative}</span>
      <span className="flat-entry-basename" aria-hidden="true">{name}</span>
      <span className="flat-entry-parent" aria-hidden="true" title={parent}><bdi dir="ltr">{matchedName(relative, query, 0, parent.length)}</bdi></span>
    </span>
  }
  return <div ref={results} tabIndex={-1} role="region" aria-label="Directory results" onKeyDown={moveFocus}>
    {!compactHeader && pager()}
    {view === 'icons' ? (
      <ul className="file-grid" aria-label="Directory contents">
        {visible.map(entry => <li key={entry.path} data-browse-entry={entry.path}>
          <EntryLink entry={entry} location={location} onOpen={onOpen} className="file-tile">
            <EntryIcon entry={entry} />
            {renderName(entry, true)}
            <span className="tile-meta"><span className="tile-details"><span>{entryTypeLabel(entry)}</span>{entry.type === 'file' && <> <span className="tile-size">{formatBytes(entry.size)}</span></>}</span><time dateTime={entry.modified} title={`Last edited ${modifiedTime(entry.modified)}`}>{relativeTime(entry.modified)}</time></span>
          </EntryLink>
          <GitBadge mark={gitMark?.(entry)} path={entry.path} onClick={entry.type === 'file' && onGitDiff ? () => onGitDiff(entry.path) : undefined} />
        </li>)}
      </ul>
    ) : (
      <div className="file-table-wrap">
        <table className={`file-table${compactHeader ? ' file-table-stacked' : ''}`} aria-label="Directory contents">
          <colgroup><col className="name-column" /><col className="type-column" /><col className="size-column" /><col className="modified-column" /></colgroup>
          <thead className={compactHeader ? 'sr-only' : undefined}><tr>{(['name', 'type', 'size', 'modified'] as const).map(column => {
            const Icon = sort.column === column ? sort.direction === 'asc' ? ArrowUp : ArrowDown : ArrowUpDown
            return <th key={column} id={`directory-${column}-heading`} scope="col" aria-sort={sort.column === column ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
              {compactHeader ? column[0].toUpperCase() + column.slice(1) : <button onClick={() => onSort(column)} title={`Sort by ${column}${sort.column === column ? `, ${sort.direction === 'asc' ? 'descending' : 'ascending'}` : ''}`}><span>{column[0].toUpperCase() + column.slice(1)}</span><Icon size={13} aria-hidden="true" /></button>}
            </th>
          })}</tr></thead>
          <tbody>{visible.map(entry => <tr key={entry.path} data-browse-entry={entry.path} className={entry.type === 'directory' ? 'directory-row' : entry.type !== 'file' ? 'disabled-row' : undefined}>
            <td className="table-name" headers="directory-name-heading"><EntryLink entry={entry} location={location} onOpen={onOpen}><EntryIcon entry={entry} />{renderName(entry)}{entry.type === 'directory' && <ChevronRight size={14} />}</EntryLink><GitBadge mark={gitMark?.(entry)} path={entry.path} onClick={entry.type === 'file' && onGitDiff ? () => onGitDiff(entry.path) : undefined} /></td>
            <td className="table-type" headers="directory-type-heading" title={entryTypeLabel(entry)}>{entryTypeLabel(entry)}</td>
            <td className="table-size" headers="directory-size-heading">{entry.type === 'directory' ? '—' : formatBytes(entry.size)}</td>
            <td className="table-modified" headers="directory-modified-heading" title={modifiedTime(entry.modified)}>{relativeTime(entry.modified)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    )}
    {pager(true)}
  </div>
}
