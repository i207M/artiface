import { FolderOpen, Pause, X } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { fileTabName } from '../location'
import type { FileLocation } from '../types'
import { FileTabIcon } from './Common'
import { projectKey, tabKey } from './workspaceTabs'
import type { OpenFile } from './workspaceTabs'
import { useTabDrag } from './useTabDrag'

export default function Tabs({ tabs, active, onBrowse, onSelect, onClose, onReorder }: {
  tabs: OpenFile[]; active: string | null; onBrowse: () => void; onSelect: (tab: FileLocation) => void; onClose: (tab: FileLocation) => void
  onReorder: (tab: FileLocation, target: FileLocation, edge: 'before' | 'after') => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const layout = useRef<(follow?: boolean, target?: HTMLElement) => void>(() => {})
  const selection = active ?? `browse:${tabs[0] ? projectKey(tabs[0]) : ''}`
  const previousSelection = useRef<string | null>(null)
  const pendingFocus = useRef<{ key: string; index: number; origin: HTMLElement; selected: boolean } | null>(null)
  const rememberViewport = useRef(() => {})
  const reordered = useRef(false)
  const drag = useTabDrag(list, tabs, selection, (tab, target, edge) => {
    reordered.current = true
    onReorder(tab, target, edge)
  })

  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    let following = true
    let left = element.scrollLeft
    let width = element.clientWidth
    let contentWidth = element.scrollWidth
    let anchor: { row: HTMLElement; index: number; fraction: number } | null = null
    const selectedRow = () => element.querySelector<HTMLElement>('[aria-selected="true"]')?.closest<HTMLElement>('.reader-tab')
    const selectedVisible = () => {
      const viewport = element.getBoundingClientRect()
      const bounds = selectedRow()?.getBoundingClientRect()
      return Boolean(bounds && bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1)
    }
    const remember = (capture = true) => {
      left = element.scrollLeft
      width = element.clientWidth
      contentWidth = element.scrollWidth
      if (!capture) return
      const edge = element.getBoundingClientRect().left
      const rows = Array.from(element.children) as HTMLElement[]
      const index = rows.findIndex(row => row.getBoundingClientRect().right > edge)
      const bounds = rows[index]?.getBoundingClientRect()
      anchor = bounds ? { row: rows[index], index, fraction: (bounds.left - edge) / Math.max(1, bounds.width) } : null
    }
    const reveal = (row: HTMLElement | null | undefined) => {
      if (!row) return
      const viewport = element.getBoundingClientRect()
      const bounds = row.getBoundingClientRect()
      if (bounds.left < viewport.left) element.scrollLeft += bounds.left - viewport.left
      else if (bounds.right > viewport.right) element.scrollLeft += bounds.right - viewport.right
    }
    const sync = (follow = false, target?: HTMLElement) => {
      if (drag.active.current) return
      if (follow) following = true
      // A closing dock can briefly consume the entire phone viewport.
      if (!element.clientWidth) return
      const preserving = !target && !following && anchor !== null
      if (target) reveal(target.closest<HTMLElement>('.reader-tab'))
      else if (following) reveal(selectedRow())
      else if (anchor) {
        const row = anchor.row.parentElement === element ? anchor.row
          : element.children[Math.min(anchor.index, element.children.length - 1)]
        if (row instanceof HTMLElement) {
          const bounds = row.getBoundingClientRect()
          element.scrollLeft += bounds.left - element.getBoundingClientRect().left - anchor.fraction * bounds.width
          anchor.row = row
          anchor.index = Array.from(element.children).indexOf(row)
        }
      }
      // Keep the same fraction through intermediate widths in the dock transition.
      remember(!preserving)
    }
    const scrolled = () => {
      if (Math.abs(element.scrollLeft - left) < 1) return
      if (drag.active.current) { following = false; remember(); return }
      // A size change can coincide with manual scrolling; recognize only a clamped offset.
      const clamped = Math.min(left, Math.max(0, element.scrollWidth - element.clientWidth))
      if ((width !== element.clientWidth || contentWidth !== element.scrollWidth)
        && Math.abs(element.scrollLeft - clamped) < 1) { sync(); return }
      following = selectedVisible()
      remember()
    }
    layout.current = sync
    rememberViewport.current = () => { following = selectedVisible(); remember() }
    const observer = new ResizeObserver(() => sync())
    observer.observe(element)
    element.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', scrolled)
      layout.current = () => {}
      rememberViewport.current = () => {}
    }
  }, [])

  useLayoutEffect(() => {
    // Workspace creates a fresh tabs array on each render; only selection resets following.
    if (reordered.current) { rememberViewport.current(); reordered.current = false }
    else layout.current(previousSelection.current !== selection)
    previousSelection.current = selection
    const pending = pendingFocus.current
    if (!pending || tabs.some(tab => tabKey(tab) === pending.key)) return
    pendingFocus.current = null
    if (document.activeElement !== pending.origin &&
      (pending.origin.isConnected || document.activeElement !== document.body)) return
    const target = pending.selected
      ? list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      : list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[tabs.length ? Math.min(pending.index, tabs.length - 1) + 1 : 0]
    target?.focus({ preventScroll: true })
    if (target) layout.current(pending.selected, target)
  })

  function closeWithFocus(tab: FileLocation, index: number, origin: HTMLElement, selected: boolean) {
    pendingFocus.current = { key: tabKey(tab), index, origin, selected }
    onClose(tab)
  }

  function closeButton(event: MouseEvent<HTMLButtonElement>, tab: FileLocation, index: number) {
    if (event.detail === 0 && document.activeElement === event.currentTarget) {
      closeWithFocus(tab, index, event.currentTarget, active === tabKey(tab))
    } else onClose(tab)
  }

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % (tabs.length + 1)
    else if (event.key === 'ArrowLeft') next = (index + tabs.length) % (tabs.length + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length
    else if (event.key === 'Delete') {
      event.preventDefault()
      if (!index) return
      closeWithFocus(tabs[index - 1], index - 1, event.currentTarget, active === tabKey(tabs[index - 1]))
      return
    } else return
    event.preventDefault()
    if (next === 0) onBrowse()
    else onSelect(tabs[next - 1])
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className="reader-tabs" role="tablist" aria-label="Project tabs" ref={list} {...drag.listEvents}>
      <div className={`reader-tab browse-tab ${!active ? 'is-selected' : ''}`} role="presentation">
        <button role="tab" id="browse-tab" aria-selected={!active} aria-controls={!active ? 'browse-panel' : undefined}
          tabIndex={!active ? 0 : -1} onClick={onBrowse} onKeyDown={event => move(event, 0)}><FolderOpen size={17} /><span>Browse</span></button>
      </div>
      {tabs.map((tab, index) => {
        const key = tabKey(tab)
        const selected = active === key
        const marker = drag.feedback?.target?.key === key ? ` is-drop-${drag.feedback.target.edge}` : ''
        return <div className={`reader-tab ${selected ? 'is-selected' : ''}${drag.feedback?.source === key ? ' is-dragging' : ''}${marker}`} role="presentation" key={key} data-tab-key={key}>
          <button role="tab" id={`file-tab-${encodeURIComponent(tabKey(tab))}`} aria-label={fileTabName(tab)} aria-selected={selected} aria-controls={selected ? 'reader-panel' : undefined} tabIndex={selected ? 0 : -1} onClick={() => onSelect(tab)} onKeyDown={event => move(event, index + 1)}
            draggable={drag.enabled} onPointerDown={drag.pointerDown} onDragStart={event => drag.start(event, tab)}
            onMouseDown={event => { drag.mouseDown(event); if (event.button === 1) event.preventDefault() }}
            onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(tab) } }} title={`${fileTabName(tab, true)}${tab.autoRefreshPaused && !tab.view ? '\nAutomatic refresh paused' : ''}`}><FileTabIcon file={tab} /><span>{fileTabName(tab)}</span>{tab.autoRefreshPaused && !tab.view && <Pause size={12} aria-hidden="true" />}</button>
          <button className="icon-button tab-close" tabIndex={selected ? 0 : -1} aria-label={`Close ${fileTabName(tab)}`} title={`Close ${fileTabName(tab)}`}
            onMouseDown={event => { if (event.button === 0) event.preventDefault() }}
            onClick={event => closeButton(event, tab, index)}><X size={14} /></button>
        </div>
      })}
    </div>
  )
}
