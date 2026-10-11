import '../pdfCompatibility'
import { AnnotationMode } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { errorMessage, sessionExpired } from '../api'
import { compressedPage } from '../compressedPDF'
import type { PDFSource } from './PDFPages'
import './pdfOverview.css'

const rowHeight = 216
const gap = 12
const padding = 12
const previewHeight = 150
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

// One queue per overview, retained across document changes so canceled work
// still occupies its slot until PDF.js releases it.
function renderQueue() {
  type Job = { run: () => Promise<void>; signal: AbortSignal; priority: number }
  const pending: Job[] = []
  let active = 0
  let scheduled = false
  const pump = () => {
    scheduled = false
    pending.sort((a, b) => a.priority - b.priority)
    while (active < 2 && pending.length) {
      const job = pending.shift()!
      if (job.signal.aborted) continue
      active++
      void job.run().finally(() => { active--; pump() })
    }
  }
  return (run: Job['run'], signal: AbortSignal, priority: number) => {
    const job = { run, signal, priority }
    pending.push(job)
    // Batch the mounted tiles before choosing the nearest pages.
    if (!scheduled) { scheduled = true; queueMicrotask(pump) }
    return () => {
      const index = pending.indexOf(job)
      if (index >= 0) pending.splice(index, 1)
    }
  }
}

function Thumbnail({ document, number, rotation, width, ratio, enqueue, selected }: {
  document: PDFSource; number: number; rotation: number; width: number; ratio: number
  enqueue: ReturnType<typeof renderQueue>; selected: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = canvas.current!
    const controller = new AbortController()
    const { signal } = controller
    let task: RenderTask | undefined
    const cancel = () => task?.cancel()
    signal.addEventListener('abort', cancel)
    setReady(false)
    setError('')
    const remove = enqueue(async () => {
      let pdfPage: PDFPageProxy | undefined
      let bitmap: ImageBitmap | undefined
      try {
        const maxWidth = Math.min(192, Math.max(1, width)) * ratio
        const maxHeight = previewHeight * ratio
        if ('compressed' in document) {
          const image = await compressedPage(document, number, 320, signal)
          if (signal.aborted) return
          bitmap = await createImageBitmap(image.blob)
          if (signal.aborted) return
          const turned = rotation % 180 !== 0
          const w = turned ? image.height : image.width
          const h = turned ? image.width : image.height
          const scale = Math.min(maxWidth / w, maxHeight / h)
          element.width = Math.max(1, Math.round(w * scale))
          element.height = Math.max(1, Math.round(h * scale))
          const context = element.getContext('2d')
          if (!context) throw new Error('Your browser could not create a thumbnail.')
          context.imageSmoothingQuality = 'high'
          context.translate(element.width / 2, element.height / 2)
          context.rotate(rotation * Math.PI / 180)
          context.drawImage(bitmap, -image.width * scale / 2, -image.height * scale / 2, image.width * scale, image.height * scale)
        } else {
          pdfPage = await document.getPage(number)
          if (signal.aborted) return
          const base = pdfPage.getViewport({ scale: 1, rotation: pdfPage.rotate + rotation })
          const scale = Math.min(maxWidth / base.width, maxHeight / base.height)
          const viewport = pdfPage.getViewport({ scale, rotation: pdfPage.rotate + rotation })
          element.width = Math.max(1, Math.ceil(viewport.width))
          element.height = Math.max(1, Math.ceil(viewport.height))
          const context = element.getContext('2d')
          if (!context) throw new Error('Your browser could not create a thumbnail.')
          task = pdfPage.render({ canvas: element, canvasContext: context, viewport, annotationMode: AnnotationMode.ENABLE })
          await task.promise
        }
        if (!signal.aborted) setReady(true)
      } catch (failure) {
        if (!signal.aborted) {
          if (!('compressed' in document) && failure && typeof failure === 'object' && 'status' in failure && failure.status === 401) sessionExpired()
          setError(errorMessage(failure))
        }
      } finally {
        bitmap?.close()
        pdfPage?.cleanup()
      }
    }, signal, Math.abs(number - selected))
    return () => {
      controller.abort()
      remove()
      signal.removeEventListener('abort', cancel)
      element.width = element.height = 0
    }
  }, [document, number, rotation, width, ratio, enqueue, selected])
  return <span className="pdf-overview-preview" aria-hidden="true" title={error || undefined}>
    <canvas ref={canvas} width={0} height={0} className={ready ? 'is-ready' : ''} />
    {!ready && <span className="pdf-overview-placeholder">{error ? 'Thumbnail unavailable' : 'Loading…'}</span>}
  </span>
}

export default function PDFOverview({ document, page, rotation, onPage, onClose }: {
  document: PDFSource; page: number; rotation: number
  onPage: (page: number) => void; onClose: () => void
}) {
  const count = document.numPages
  const selected = clamp(page, 1, Math.max(1, count))
  const container = useRef<HTMLDivElement>(null)
  const focusWithin = useRef(false)
  const pendingFocus = useRef<number | null>(null)
  const positioned = useRef<{ document: PDFSource; selected: number; columns: number } | null>(null)
  const [enqueue] = useState(renderQueue)
  const [focused, setFocused] = useState(selected)
  const [viewport, setViewport] = useState({ width: 0, height: 0, top: 0, ratio: 1 })
  const gridWidth = Math.min(1280, viewport.width)
  const columns = Math.max(1, Math.floor((gridWidth - padding * 2 + gap) / (136 + gap)))
  const tileWidth = Math.max(1, (gridWidth - padding * 2 - gap * (columns - 1)) / columns)
  const rows = Math.ceil(count / columns)
  // Leave context above the current page only when its whole tile still fits.
  const initialTop = Math.max(0, Math.floor((selected - 1) / columns) * rowHeight -
    Math.min(rowHeight, Math.max(0, viewport.height - rowHeight - padding)))
  const resetting = !positioned.current || positioned.current.document !== document || positioned.current.selected !== selected
  const reflowing = positioned.current && positioned.current.columns !== columns
  const anchor = focusWithin.current ? focused : Math.floor(viewport.top / rowHeight) * (positioned.current?.columns ?? columns) + 1
  const top = resetting ? initialTop
    : reflowing ? Math.floor((anchor - 1) / columns) * rowHeight : viewport.top
  const firstRow = clamp(Math.floor(top / rowHeight) - 1, 0, Math.max(0, rows - 1))
  const lastRow = Math.min(rows - 1, Math.ceil((top + viewport.height) / rowHeight) + 1)
  const first = firstRow * columns + 1
  const last = Math.min(count, (lastRow + 1) * columns)
  const active = clamp(resetting ? selected : focused, first, Math.max(first, last))
  const visible = viewport.width && viewport.height ? Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index) : []

  useLayoutEffect(() => {
    const element = container.current!
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight, top: element.scrollTop, ratio: Math.min(2, window.devicePixelRatio || 1) }
      setViewport(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  useLayoutEffect(() => {
    const element = container.current!
    if (!viewport.width || !viewport.height) return
    const previous = positioned.current
    if (!previous || previous.document !== document || previous.selected !== selected) {
      element.scrollTop = initialTop
      setFocused(selected)
      if (!previous || focusWithin.current) pendingFocus.current = selected
    } else if (previous.columns !== columns) {
      element.scrollTop = top
      if (focusWithin.current) pendingFocus.current = focused
    }
    positioned.current = { document, selected, columns }
    if (element.scrollTop !== viewport.top) setViewport(current => ({ ...current, top: element.scrollTop }))
  }, [document, selected, columns, focused, top, initialTop, viewport.width, viewport.height, viewport.top])

  useLayoutEffect(() => {
    const element = container.current!
    const target = pendingFocus.current ?? active
    const button = element.querySelector<HTMLButtonElement>(`[data-thumbnail-page="${target}"]`)
    const owner = element.ownerDocument
    if (button && (pendingFocus.current !== null || (focusWithin.current && owner.hasFocus() &&
      (owner.activeElement === owner.body || owner.activeElement === element)))) {
      pendingFocus.current = null
      button.focus({ preventScroll: true })
      setFocused(target)
    }
  })

  function focusPage(number: number) {
    const next = clamp(number, 1, count)
    const element = container.current!
    pendingFocus.current = next
    setFocused(next)
    const rowTop = padding + Math.floor((next - 1) / columns) * rowHeight
    if (rowTop < element.scrollTop) element.scrollTop = rowTop
    else if (rowTop + rowHeight - gap > element.scrollTop + element.clientHeight) {
      element.scrollTop = rowTop + rowHeight - gap - element.clientHeight
    }
    setViewport(current => ({ ...current, top: element.scrollTop }))
  }

  return <section className="pdf-overview" aria-label="PDF page overview" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }}>
    <div ref={container} className="pdf-overview-scroll" tabIndex={visible.length ? -1 : 0}
      onFocusCapture={() => { focusWithin.current = true }}
      onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusWithin.current = false }}
      onScroll={event => { const top = event.currentTarget.scrollTop; setViewport(current => ({ ...current, top })) }}
      onKeyDown={event => {
        if (!count || event.altKey || event.ctrlKey || event.metaKey) return
        const step = Math.max(1, Math.floor(viewport.height / rowHeight)) * columns
        const next = { ArrowLeft: active - 1, ArrowRight: active + 1, ArrowUp: active - columns, ArrowDown: active + columns,
          Home: 1, End: count, PageUp: active - step, PageDown: active + step }[event.key]
        if (next === undefined) return
        event.preventDefault()
        event.stopPropagation()
        focusPage(next)
      }}>
      {!count ? <p className="pdf-overview-empty">This PDF has no pages.</p> : <div className="pdf-overview-grid" role="list" aria-label={`Page thumbnails, ${count.toLocaleString()} ${count === 1 ? 'page' : 'pages'}`}
        style={{ height: rows * rowHeight + padding * 2, width: gridWidth || '100%' }}>
        {visible.map(number => <div key={number} className="pdf-overview-tile" role="listitem" aria-posinset={number} aria-setsize={count}
          style={{ top: padding + Math.floor((number - 1) / columns) * rowHeight, left: padding + ((number - 1) % columns) * (tileWidth + gap), width: tileWidth, height: rowHeight - gap }}>
          <button data-thumbnail-page={number} className="pdf-overview-page" aria-label={`Open page ${number}`}
            aria-current={number === selected ? 'page' : undefined} tabIndex={number === active ? 0 : -1}
            onFocus={() => setFocused(number)} onClick={() => onPage(number)}>
            <Thumbnail document={document} number={number} rotation={rotation} width={tileWidth - 20} ratio={viewport.ratio} enqueue={enqueue} selected={selected} />
            <span className="pdf-overview-number">{number.toLocaleString()}</span>
          </button>
        </div>)}
      </div>}
    </div>
  </section>
}
