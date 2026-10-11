import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, MouseEvent, PointerEvent, RefObject } from 'react'
import { tabKey } from './workspaceTabs'
import type { OpenFile } from './workspaceTabs'

type Drop = { key: string; edge: 'before' | 'after' }
const transferType = 'application/x-artiface-tab'

export function useTabDrag(list: RefObject<HTMLDivElement | null>, tabs: OpenFile[], selection: string,
  onReorder: (tab: OpenFile, target: OpenFile, edge: Drop['edge']) => void) {
  const [enabled, setEnabled] = useState(() => matchMedia('(any-pointer: fine)').matches)
  const [feedback, setFeedback] = useState<{ source: string; target: Drop | null } | null>(null)
  const active = useRef<{ key: string; x: number; y: number; target: Drop | null; frame: number; time: number } | null>(null)
  const pointer = useRef('')
  const signature = JSON.stringify(tabs.map(tabKey))

  function clearTarget() {
    const drag = active.current
    if (!drag) return
    cancelAnimationFrame(drag.frame)
    drag.frame = 0
    drag.time = 0
    drag.target = null
    setFeedback(current => current?.target ? { ...current, target: null } : current)
  }

  function finish() {
    if (active.current) cancelAnimationFrame(active.current.frame)
    active.current = null
    pointer.current = ''
    setFeedback(null)
  }

  useEffect(() => {
    const media = matchMedia('(any-pointer: fine)')
    const changed = () => { setEnabled(media.matches); finish() }
    media.addEventListener('change', changed)
    window.addEventListener('dragend', finish)
    window.addEventListener('drop', finish)
    window.addEventListener('blur', finish)
    return () => {
      media.removeEventListener('change', changed)
      window.removeEventListener('dragend', finish)
      window.removeEventListener('drop', finish)
      window.removeEventListener('blur', finish)
      if (active.current) cancelAnimationFrame(active.current.frame)
      active.current = null
    }
  }, [])

  // Closing files or changing projects while dragging invalidates the pending drop.
  useLayoutEffect(() => { finish() }, [signature, selection])

  function updateTarget() {
    const drag = active.current, element = list.current
    if (!drag || !element) return
    const bounds = element.getBoundingClientRect()
    if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) {
      clearTarget()
      return
    }
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-tab-key]'))
      .filter(row => row.dataset.tabKey !== drag.key)
    const before = rows.find(row => {
      const bounds = row.getBoundingClientRect()
      return drag.x < bounds.left + bounds.width / 2
    })
    const row = before ?? rows.at(-1)
    const target: Drop | null = row ? { key: row.dataset.tabKey!, edge: before ? 'before' : 'after' } : null
    drag.target = target
    setFeedback(current => current && (current.target?.key !== target?.key || current.target?.edge !== target?.edge)
      ? { ...current, target } : current)
  }

  function scroll(time: number) {
    const drag = active.current, element = list.current
    if (!drag || !element) return
    drag.frame = 0
    const bounds = element.getBoundingClientRect()
    if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) { clearTarget(); return }
    const edge = Math.min(36, bounds.width / 4)
    const distance = drag.x < bounds.left + edge ? drag.x - bounds.left - edge
      : drag.x > bounds.right - edge ? drag.x - bounds.right + edge : 0
    if (!distance) { drag.time = 0; return }
    const elapsed = drag.time ? Math.min(32, time - drag.time) : 16
    drag.time = time
    const left = element.scrollLeft
    element.scrollLeft += Math.max(-1, Math.min(1, distance / edge)) * elapsed * .8
    updateTarget()
    if (active.current === drag && element.scrollLeft !== left) drag.frame = requestAnimationFrame(scroll)
  }

  function start(event: DragEvent<HTMLButtonElement>, tab: OpenFile) {
    if (!enabled || pointer.current !== 'mouse' || tabs.length < 2) { event.preventDefault(); return }
    event.dataTransfer.setData(transferType, 'reorder')
    event.dataTransfer.effectAllowed = 'move'
    const row = event.currentTarget.closest<HTMLElement>('.reader-tab')
    if (row) {
      const bounds = row.getBoundingClientRect()
      event.dataTransfer.setDragImage(row, event.clientX - bounds.left, event.clientY - bounds.top)
    }
    const key = tabKey(tab)
    active.current = { key, x: event.clientX, y: event.clientY, target: null, frame: 0, time: 0 }
    setFeedback({ source: key, target: null })
  }

  function over(event: DragEvent<HTMLDivElement>) {
    const drag = active.current
    if (!drag || !event.dataTransfer.types.includes(transferType)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    drag.x = event.clientX
    drag.y = event.clientY
    updateTarget()
    if (!drag.frame && drag.target) drag.frame = requestAnimationFrame(scroll)
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    const drag = active.current
    if (!drag || event.dataTransfer.getData(transferType) !== 'reorder') return
    event.preventDefault()
    drag.x = event.clientX
    drag.y = event.clientY
    updateTarget()
    const source = tabs.find(tab => tabKey(tab) === drag.key)
    const target = tabs.find(tab => tabKey(tab) === drag.target?.key)
    if (source && target && drag.target) onReorder(source, target, drag.target.edge)
    finish()
  }

  return {
    active, feedback, enabled: enabled && tabs.length > 1, start,
    pointerDown: (event: PointerEvent<HTMLButtonElement>) => { pointer.current = event.button === 0 ? event.pointerType : '' },
    mouseDown: (event: MouseEvent<HTMLButtonElement>) => {
      // WebKit can deliver a new mousedown without pointerdown after a native drag.
      if (event.button === 0 && pointer.current !== 'touch' && pointer.current !== 'pen') pointer.current = 'mouse'
    },
    listEvents: {
      onDragOver: over, onDrop: drop,
      onDragLeave: (event: DragEvent<HTMLDivElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clearTarget()
      },
    },
  }
}
