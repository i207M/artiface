import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, MouseEvent, PointerEvent, RefObject } from 'react'

type Drop = { key: string; edge: 'before' | 'after' }
interface Options<T> {
  key: (item: T) => string
  attribute: string
  image: string
  transferType: string
  axis: 'horizontal' | 'vertical'
}

export function useReorderDrag<T>(list: RefObject<HTMLElement | null>, items: T[], selection: string,
  onReorder: (item: T, target: T, edge: Drop['edge']) => void, options: Options<T>) {
  const { key: itemKey, attribute, image, transferType } = options
  const vertical = options.axis === 'vertical'
  const [enabled, setEnabled] = useState(() => matchMedia('(any-pointer: fine)').matches)
  const [feedback, setFeedback] = useState<{ source: string; target: Drop | null } | null>(null)
  const active = useRef<{ key: string; x: number; y: number; target: Drop | null; frame: number; time: number } | null>(null)
  const pointer = useRef('')
  const signature = JSON.stringify(items.map(itemKey))

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

  // A changed list or navigation invalidates the pending drop.
  useLayoutEffect(() => { finish() }, [signature, selection])

  function updateTarget() {
    const drag = active.current, element = list.current
    if (!drag || !element) return
    const bounds = element.getBoundingClientRect()
    if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) {
      clearTarget()
      return
    }
    const rows = Array.from(element.querySelectorAll<HTMLElement>(`[${attribute}]`))
      .filter(row => row.getAttribute(attribute) !== drag.key)
    const before = rows.find(row => {
      const bounds = row.getBoundingClientRect()
      return vertical ? drag.y < bounds.top + bounds.height / 2 : drag.x < bounds.left + bounds.width / 2
    })
    const row = before ?? rows.at(-1)
    const target: Drop | null = row ? { key: row.getAttribute(attribute)!, edge: before ? 'before' : 'after' } : null
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
    const edge = Math.min(36, (vertical ? bounds.height : bounds.width) / 4)
    const position = vertical ? drag.y : drag.x
    const start = vertical ? bounds.top : bounds.left, end = vertical ? bounds.bottom : bounds.right
    const distance = position < start + edge ? position - start - edge : position > end - edge ? position - end + edge : 0
    if (!distance) { drag.time = 0; return }
    const elapsed = drag.time ? Math.min(32, time - drag.time) : 16
    drag.time = time
    const property = vertical ? 'scrollTop' : 'scrollLeft'
    const previous = element[property]
    element[property] += Math.max(-1, Math.min(1, distance / edge)) * elapsed * .8
    updateTarget()
    if (active.current === drag && element[property] !== previous) drag.frame = requestAnimationFrame(scroll)
  }

  function start(event: DragEvent<HTMLButtonElement>, item: T) {
    if (!enabled || pointer.current !== 'mouse' || items.length < 2) { event.preventDefault(); return }
    event.dataTransfer.setData(transferType, 'reorder')
    event.dataTransfer.effectAllowed = 'move'
    const row = event.currentTarget.closest<HTMLElement>(image)
    if (row) {
      const bounds = row.getBoundingClientRect()
      event.dataTransfer.setDragImage(row, event.clientX - bounds.left, event.clientY - bounds.top)
    }
    const key = itemKey(item)
    active.current = { key, x: event.clientX, y: event.clientY, target: null, frame: 0, time: 0 }
    setFeedback({ source: key, target: null })
  }

  function over(event: DragEvent<HTMLElement>) {
    const drag = active.current
    if (!drag || !event.dataTransfer.types.includes(transferType)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    drag.x = event.clientX
    drag.y = event.clientY
    updateTarget()
    if (!drag.frame && drag.target) drag.frame = requestAnimationFrame(scroll)
  }

  function drop(event: DragEvent<HTMLElement>) {
    const drag = active.current
    if (!drag || event.dataTransfer.getData(transferType) !== 'reorder') return
    event.preventDefault()
    drag.x = event.clientX
    drag.y = event.clientY
    updateTarget()
    const source = items.find(item => itemKey(item) === drag.key)
    const target = items.find(item => itemKey(item) === drag.target?.key)
    if (source && target && drag.target) onReorder(source, target, drag.target.edge)
    finish()
  }

  return {
    active, feedback, enabled: enabled && items.length > 1, start,
    pointerDown: (event: PointerEvent<HTMLButtonElement>) => { pointer.current = event.button === 0 ? event.pointerType : '' },
    mouseDown: (event: MouseEvent<HTMLButtonElement>) => {
      // WebKit can deliver a new mousedown without pointerdown after a native drag.
      if (event.button === 0 && pointer.current !== 'touch' && pointer.current !== 'pen') pointer.current = 'mouse'
    },
    listEvents: {
      onDragOver: over, onDrop: drop,
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clearTarget()
      },
    },
  }
}
