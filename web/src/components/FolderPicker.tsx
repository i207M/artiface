import { ArrowRight, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Folder, Home, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { api, errorMessage, isAborted } from '../api'
import { usePreferences } from '../preferences'
import type { Entry, FolderListing, Host } from '../types'
import './settings.css'

interface Props {
  host?: Host
  target?: string
  kind?: 'ssh' | 'local'
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}
interface Branch { entries?: Entry[]; path?: string; loading?: boolean; error?: string }
interface TreeFocus { path: string; ancestors: string[] }
const folderPageSize = 200

function focusPage(entries: Entry[], focus: TreeFocus, fallback = 0) {
  for (const path of [focus.path, ...focus.ancestors]) {
    const index = entries.findIndex(entry => entry.path === path)
    if (index >= 0) return Math.floor(index / folderPageSize)
  }
  return fallback
}

export default function FolderPicker({ host, target = '', kind = 'ssh', initialPath, onPick, onClose }: Props) {
  const [preferences] = usePreferences()
  const pagingHelp = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const tree = useRef<HTMLDivElement>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const treeHasFocus = useRef(false)
  const preferredFocus = useRef<TreeFocus>({ path: '', ancestors: [] })
  const enterBranch = useRef<string | null>(null)
  const pageFocus = useRef<string | null>(null)
  const navigationControl = useRef<HTMLElement | null>(null)
  const controllers = useRef(new Set<AbortController>())
  const rootRequest = useRef<AbortController | null>(null)
  const pendingRootPath = useRef<string | null>(null)
  const addressEdits = useRef(0)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [address, setAddress] = useState(initialPath || '')
  const [selected, setSelected] = useState('')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [branches, setBranches] = useState<Record<string, Branch>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [activePath, setActivePath] = useState('')
  const [pages, setPages] = useState<Record<string, number>>({})
  const unfilteredPage = useRef(0)

  function focusItem(element: HTMLElement) {
    element.focus({ preventScroll: true })
    const area = tree.current
    if (!area) return
    const row = element.querySelector<HTMLElement>(':scope > .folder-tree-row') ?? element
    const bounds = row.getBoundingClientRect()
    const viewport = area.getBoundingClientRect()
    if (bounds.top < viewport.top) area.scrollTop += bounds.top - viewport.top
    else if (bounds.bottom > viewport.bottom) area.scrollTop += bounds.bottom - viewport.bottom
  }

  function focusPath(path: string) {
    const element = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
      .find(item => item.dataset.folderPath === path)
    if (element) focusItem(element)
  }

  function rememberFocus(element: HTMLElement) {
    const path = element.dataset.treeKey!
    const ancestors: string[] = []
    let parent = element.parentElement?.closest<HTMLElement>('[role="treeitem"]')
    while (parent) {
      ancestors.push(parent.dataset.treeKey!)
      parent = parent.parentElement?.closest<HTMLElement>('[role="treeitem"]')
    }
    preferredFocus.current = { path, ancestors }
    if (enterBranch.current !== path) enterBranch.current = null
    setActivePath(path)
  }

  function request(path?: string) {
    const controller = new AbortController()
    controllers.current.add(controller)
    const promise = api<FolderListing>('/api/folders', {
      body: {
        ...(host ? { host: host.id } : {}),
        target: host?.target ?? target, kind: host?.kind || kind,
        ...(path ? { path } : {}),
      },
      signal: controller.signal,
    }).finally(() => controllers.current.delete(controller))
    return { controller, promise }
  }

  function navigate(path?: string) {
    if (pendingRootPath.current === (path || '') && rootRequest.current && !rootRequest.current.signal.aborted) return
    const editsAtRequest = addressEdits.current
    const previousFocus = preferredFocus.current
    const previousPage = pages[listing?.path || ''] || 0
    const nextFocus = listing && path === listing.parent ? { path: listing.path, ancestors: [] }
      : path === listing?.path ? previousFocus : { path: '', ancestors: [] }
    enterBranch.current = null
    pageFocus.current = null
    navigationControl.current = !treeHasFocus.current && document.activeElement instanceof HTMLElement &&
      dialog.current?.contains(document.activeElement) ? document.activeElement : null
    if (treeHasFocus.current) tree.current?.focus({ preventScroll: true })
    for (const controller of controllers.current) controller.abort()
    rootRequest.current?.abort()
    const { controller, promise } = request(path)
    rootRequest.current = controller
    pendingRootPath.current = path || ''
    setBusy(true)
    setError('')
    setFilter('')
    setBranches({})
    setExpanded(new Set())
    setActivePath('')
    setPages({})
    unfilteredPage.current = 0
    void promise.then(data => {
      if (controller.signal.aborted || rootRequest.current !== controller) return
      preferredFocus.current = nextFocus
      setListing(data)
      if (addressEdits.current === editsAtRequest) setAddress(data.path)
      setSelected(data.path)
      const entries = data.entries.filter(entry => preferences.showHidden || !entry.name.startsWith('.'))
      setPages({ [data.path]: Math.min(focusPage(entries, nextFocus, path === listing?.path ? previousPage : 0),
        Math.max(0, Math.ceil(entries.length / folderPageSize) - 1)) })
    }).catch(failure => {
      if (!controller.signal.aborted && rootRequest.current === controller && !isAborted(failure)) {
        preferredFocus.current = previousFocus
        setError(errorMessage(failure))
      }
    }).finally(() => {
      if (!controller.signal.aborted && rootRequest.current === controller) {
        pendingRootPath.current = null
        setBusy(false)
      }
    })
  }

  useEffect(() => {
    const element = dialog.current
    const previousFocus = document.activeElement
    const opener = previousFocus instanceof HTMLElement && previousFocus.isConnected &&
      previousFocus !== document.body && !element?.contains(previousFocus) ? previousFocus : null
    const focusChanged = (event: Event) => {
      treeHasFocus.current = Boolean(tree.current?.contains(event.target as Node))
      if (!treeHasFocus.current) enterBranch.current = null
      if (event.target !== navigationControl.current && event.target !== document.body && event.target !== dialog.current) navigationControl.current = null
    }
    const pointerChanged = (event: PointerEvent) => {
      if (!navigationControl.current?.contains(event.target as Node)) navigationControl.current = null
      if (!tree.current?.contains(event.target as Node)) {
        treeHasFocus.current = false
        enterBranch.current = null
      }
    }
    document.addEventListener('focusin', focusChanged)
    document.addEventListener('pointerdown', pointerChanged, true)
    element?.showModal()
    navigate(initialPath || undefined)
    return () => {
      for (const controller of controllers.current) controller.abort()
      rootRequest.current?.abort()
      document.removeEventListener('focusin', focusChanged)
      document.removeEventListener('pointerdown', pointerChanged, true)
      element?.close()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
    // A new picker is mounted whenever its source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadBranch(entry: Entry) {
    if (branches[entry.path]?.entries || branches[entry.path]?.loading) return
    setBranches(current => ({ ...current, [entry.path]: { loading: true } }))
    const { controller, promise } = request(entry.path)
    try {
      const result = await promise
      if (!controller.signal.aborted) setBranches(current => ({ ...current, [entry.path]: { entries: result.entries, path: result.path } }))
    } catch (failure) {
      if (!controller.signal.aborted && !isAborted(failure)) setBranches(current => ({ ...current, [entry.path]: { error: errorMessage(failure) } }))
    }
  }

  function toggle(entry: Entry) {
    if (expanded.has(entry.path)) {
      enterBranch.current = null
      setExpanded(current => { const next = new Set(current); next.delete(entry.path); return next })
    } else {
      setExpanded(current => new Set(current).add(entry.path))
      void loadBranch(entry)
    }
  }

  useLayoutEffect(() => {
    const area = tree.current
    if (!area) return
    if (!busy && navigationControl.current) {
      const control = navigationControl.current
      navigationControl.current = null
      if (control.isConnected && !control.matches(':disabled') &&
        (document.activeElement === document.body || document.activeElement === dialog.current)) control.focus({ preventScroll: true })
    }
    const items = [...area.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const byPath = new Map(items.map(element => [element.dataset.treeKey, element]))
    const paged = pageFocus.current ? byPath.get(pageFocus.current) : undefined
    pageFocus.current = null
    if (paged && treeHasFocus.current && document.activeElement === paged) focusItem(paged)
    const pending = enterBranch.current ? byPath.get(enterBranch.current) : undefined
    const child = pending?.querySelector<HTMLElement>(':scope > [role="group"] > [data-folder-path]')
    if (pending && child && expanded.has(pending.dataset.folderPath!) && treeHasFocus.current && pending === document.activeElement) {
      enterBranch.current = null
      focusItem(child)
      return
    }
    const preferred = preferredFocus.current
    const next = byPath.get(preferred.path) ?? preferred.ancestors.map(path => byPath.get(path)).find(Boolean) ??
      byPath.get(activePath) ?? items[0]
    const nextPath = next?.dataset.treeKey ?? ''
    if (nextPath !== activePath) setActivePath(nextPath)
    if (treeHasFocus.current && (!document.activeElement || !area.contains(document.activeElement) || document.activeElement === area)) {
      if (next) focusItem(next)
      else area.focus({ preventScroll: true })
    }
  }, [listing, branches, expanded, filter, preferences.showHidden, busy, activePath, pages])

  function changePage(group: string, page: number, last: number, control: HTMLElement) {
    enterBranch.current = null
    const row = control.closest<HTMLElement>('[role="treeitem"]')
    if (row) {
      focusItem(row)
      pageFocus.current = row.dataset.treeKey!
    }
    setPages(current => ({ ...current, [group]: Math.max(0, Math.min(page, last)) }))
  }

  function changeFilter(value: string) {
    pageFocus.current = null
    if (!filter) unfilteredPage.current = pages[listing?.path || ''] || 0
    setFilter(value)
    if (listing) {
      const page = value ? 0 : focusPage(listing.entries.filter(entry => preferences.showHidden || !entry.name.startsWith('.')),
        preferredFocus.current, unfilteredPage.current)
      setPages(current => ({ ...current, [listing.path]: page }))
    }
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')
    if (!item || !tree.current) return
    const items = [...tree.current.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const index = items.indexOf(item)
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) return
    if (item.dataset.folderPager !== undefined && !['ArrowUp', 'ArrowDown'].includes(event.key)) {
      // Native activation still applies when assistive technology focuses a button.
      if ((event.target as HTMLElement).closest('button') && (event.key === 'Enter' || event.key === ' ')) return
      event.preventDefault()
      event.stopPropagation()
      const page = Number(item.dataset.page)
      const last = Number(item.dataset.lastPage)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowLeft' ? page - 1 : page + 1
      changePage(item.dataset.folderPager, next, last, item)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.key !== 'ArrowRight') enterBranch.current = null
    if (event.key === 'ArrowUp') focusItem(items[Math.max(0, index - 1)])
    else if (event.key === 'ArrowDown') focusItem(items[Math.min(items.length - 1, index + 1)])
    else if (event.key === 'Home') focusItem(items[0])
    else if (event.key === 'End') focusItem(items[items.length - 1])
    else {
      const path = item.dataset.folderPath!
      const entry: Entry = { name: item.getAttribute('aria-label') || '', path, type: 'directory', size: 0, modified: '' }
      if (event.key === 'Enter' || event.key === ' ') setSelected(path)
      else if (event.key === 'ArrowLeft') {
        if (expanded.has(path)) toggle(entry)
        else {
          const parent = item.parentElement?.closest<HTMLElement>('[role="treeitem"]')
          if (parent) focusItem(parent)
        }
      } else if (!expanded.has(path)) toggle(entry)
      else {
        const child = item.querySelector<HTMLElement>(':scope > [role="group"] > [data-folder-path]')
        if (child) focusItem(child)
        else if (branches[path]?.loading || branches[path]?.error) {
          enterBranch.current = path
          if (branches[path]?.error) void loadBranch(entry)
        }
      }
    }
  }

  function rows(entries: Entry[], depth = 0, ancestors = new Set([listing?.path || '']), group = listing?.path || ''): ReactNode {
    const visible = entries.filter(entry => preferences.showHidden || !entry.name.startsWith('.'))
      .filter(entry => depth || entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
    if (!visible.length) return <p className="folder-empty">{filter && !depth ? 'No matching folders' : 'No visible subfolders'}</p>
    const last = Math.ceil(visible.length / folderPageSize) - 1
    const page = Math.min(pages[group] || 0, last)
    const start = page * folderPageSize
    const pager = (edge: 'start' | 'end') => {
      if (!last) return null
      // Folder paths are absolute, so this focus key cannot collide with a folder.
      const key = `pager:${edge}:${group}`
      const range = `${(start + 1).toLocaleString()}–${Math.min(start + folderPageSize, visible.length).toLocaleString()} of ${visible.length.toLocaleString()} folders`
      return <div key={key} role="treeitem" className="folder-tree-item folder-page-item" data-tree-key={key}
        data-folder-pager={group} data-page-edge={edge} data-page={page} data-last-page={last}
        aria-label={`Folder pages for ${group}${edge === 'end' ? ' at end' : ''}: ${range}`}
        aria-describedby={pagingHelp} aria-level={depth + 1} tabIndex={activePath === key ? 0 : -1}
        onFocus={event => { if ((event.target as HTMLElement).closest('[role="treeitem"]') === event.currentTarget) rememberFocus(event.currentTarget) }}>
        <div className="folder-tree-row folder-page-row" style={{ paddingInlineStart: `${8 + depth * 20}px` }}>
          <span className="folder-page-count" role={edge === 'start' ? 'status' : undefined} aria-atomic={edge === 'start' || undefined}>
            {range}<small>Page {page + 1} of {last + 1}</small>
          </span>
          <span className="folder-page-buttons">
            {([{ label: 'First', next: 0, Icon: ChevronsLeft }, { label: 'Previous', next: page - 1, Icon: ChevronLeft },
              { label: 'Next', next: page + 1, Icon: ChevronRight }, { label: 'Last', next: last, Icon: ChevronsRight }]).map(({ label, next, Icon }) =>
              <button key={label} type="button" className="icon-button" tabIndex={-1} aria-label={`${label} folder page for ${group}`}
                title={`${label} page`} disabled={next < 0 || next > last || next === page}
                onClick={event => changePage(group, next, last, event.currentTarget)}><Icon size={16} /></button>)}
          </span>
        </div>
      </div>
    }
    return <>{pager('start')}{visible.slice(start, start + folderPageSize).map((entry, index) => {
      const branch = branches[entry.path]
      const open = expanded.has(entry.path)
      const repeated = branch?.path && ancestors.has(branch.path)
      return <div key={entry.path} role="treeitem" className="folder-tree-item" data-folder-path={entry.path} data-tree-key={entry.path}
        data-folder-group={group}
        aria-label={entry.name} aria-selected={selected === entry.path} aria-expanded={open} aria-busy={branch?.loading || undefined}
        aria-level={depth + 1} aria-posinset={start + index + 1} aria-setsize={visible.length} tabIndex={activePath === entry.path ? 0 : -1}
        onFocus={event => { if ((event.target as HTMLElement).closest('[role="treeitem"]') === event.currentTarget) rememberFocus(event.currentTarget) }}>
        <div className={`folder-tree-row ${selected === entry.path ? 'selected' : ''}`}
          style={{ paddingInlineStart: `${8 + depth * 20}px` }}>
          <button className="icon-button" type="button" tabIndex={-1} aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.name}`} title={`${open ? 'Collapse' : 'Expand'} ${entry.name}`} onClick={() => { focusPath(entry.path); toggle(entry) }}>
            {branch?.loading ? <LoaderCircle className="spin" size={15} /> : open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          <button type="button" tabIndex={-1} className="folder-tree-name" onClick={() => { focusPath(entry.path); setSelected(entry.path) }}
            onDoubleClick={() => navigate(entry.path)} title={entry.path}>
            <Folder size={17} /><span>{entry.name}</span>
          </button>
          <button type="button" tabIndex={-1} className="icon-button folder-tree-open" aria-label={`Open ${entry.name}`} title={`Open ${entry.name}`} onClick={() => { focusPath(entry.path); navigate(entry.path) }}><ArrowRight size={15} /></button>
        </div>
        {open && branch?.error && <p className="folder-branch-error" role="alert">{branch.error}</p>}
        {open && branch?.entries && <div role="group">{repeated || depth >= 15
          ? <p className="folder-branch-empty">Open this folder to continue navigating.</p>
          : branch.entries.length ? rows(branch.entries, depth + 1, new Set(ancestors).add(branch.path || entry.path), entry.path)
            : <p className="folder-branch-empty">No subfolders</p>}</div>}
      </div>
    })}{pager('end')}</>
  }

  return (
    <dialog ref={dialog} className="folder-picker" aria-labelledby="folder-picker-title"
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => {
        if (event.target !== dialog.current) return
        const bounds = dialog.current.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
      }}>
      <header className="folder-picker-header"><div><h2 id="folder-picker-title">Choose a folder</h2><p>{host?.kind === 'local' || kind === 'local' ? 'localhost' : host?.label || target}</p></div><button className="icon-button" aria-label="Close folder picker" title="Close folder picker" onClick={onClose}><X size={19} /></button></header>
      <form className="folder-address" onSubmit={event => { event.preventDefault(); navigate(address) }}>
        <button type="button" className="icon-button" aria-label="Home folder" title="Home folder" onClick={() => navigate(listing?.home)} disabled={busy}><Home size={17} /></button>
        <button type="button" className="icon-button" aria-label="Parent folder" title="Parent folder" onClick={() => navigate(listing?.parent || undefined)} disabled={busy || !listing?.parent}><ArrowUp size={17} /></button>
        <input aria-label="Folder path" value={address} onChange={event => { addressEdits.current++; setAddress(event.target.value) }} placeholder="Home directory" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" />
        <button type="submit" className="button secondary" disabled={busy && address === pendingRootPath.current}>Go</button>
        <button type="button" className="icon-button" aria-label="Refresh folders" title="Refresh folders" onClick={() => navigate(listing?.path)} disabled={busy}><RefreshCw size={16} /></button>
      </form>
      <div className="folder-filter"><Search size={16} /><input ref={filterInput} aria-label="Filter folders" value={filter} onChange={event => changeFilter(event.target.value)} placeholder="Filter folders…" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        {filter && <button type="button" className="icon-button" aria-label="Clear folder filter" title="Clear folder filter" onClick={() => { changeFilter(''); filterInput.current?.focus() }}><X size={15} /></button>}
      </div>
      <p id={pagingHelp} className="sr-only">On folder page controls, Left and Right change pages. Home and End choose the first and last page. Enter or Space opens the next page. Up and Down move through the tree.</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div ref={tree} className="folder-tree" role="tree" aria-label="Folder structure" aria-busy={busy} tabIndex={activePath ? -1 : 0} onKeyDown={keyboard}>
        {busy ? <div className="settings-loading"><LoaderCircle className="spin" size={19} /> Loading folders…</div>
          : listing ? listing.entries.length ? rows(listing.entries) : <p className="folder-empty">No subfolders. You can select this folder.</p> : null}
      </div>
      <footer className="folder-picker-footer"><div><span>Selected folder</span><code title={selected}>{selected || 'Choose a folder'}</code></div><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !selected || Boolean(error)} onClick={() => onPick(selected)}>Select folder</button></footer>
    </dialog>
  )
}
