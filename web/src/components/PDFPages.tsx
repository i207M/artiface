import '../pdfCompatibility'
import { AnnotationMode, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PDFView } from '../pdfCache'
import { compressedCacheGeneration, compressedPage } from '../compressedPDF'
import type { CompressedPDF } from '../compressedPDF'
import { Loading } from './Common'

type Position = Pick<PDFView, 'page' | 'top' | 'left'>
type Size = { width: number; height: number }
type Layout = Size & { top: number; scale: number }
type PageState = { loading: boolean; scale: number; error?: unknown; renderKey?: string }
export type PDFSource = PDFDocumentProxy | CompressedPDF

function rasterScale(width: number, height: number, pixelRatio: number) {
  // Supersample text on standard displays, honor dense screens, and keep each
  // canvas within the existing eight-megapixel budget.
  return Math.min(Math.max(2, pixelRatio), 3, Math.sqrt(8_000_000 / (width * height)))
}

function compressedSize({ width, height }: Size, pixelRatio: number) {
  const pixels = Math.max(width, height) * rasterScale(width, height, pixelRatio)
  return [960, 1440, 1920, 2560, 3200, 3840].find(size => size >= pixels) ?? 3840
}

function compressedRenderKey(document: CompressedPDF, layout: Layout, pixelRatio: number, rotation: number) {
  return [document.id, document.generation, rotation, pixelRatio, compressedSize(layout, pixelRatio), layout.width, layout.height].join(':')
}

// Find a page without walking or mounting every page in a long document.
function pageAt(layout: Layout[], top: number) {
  let low = 0
  let high = layout.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (layout[middle].top <= top) low = middle
    else high = middle - 1
  }
  return low
}

function visiblePage(layout: Layout[], top: number, height: number) {
  let selected = pageAt(layout, top)
  let mostVisible = 0
  for (let index = selected; index < layout.length && layout[index].top < top + height; index++) {
    const item = layout[index]
    const visible = Math.min(item.top + item.height, top + height) - Math.max(item.top, top)
    if (visible > mostVisible) { mostVisible = visible; selected = index }
  }
  return selected + 1
}

function PDFPage({ document, number, layout, left, pixelRatio, rotation, onSize, onState, canRender }: {
  document: PDFDocumentProxy; number: number; layout: Layout; rotation: number; canRender: boolean
  left: number; pixelRatio: number
  onSize: (number: number, size: Size) => void
  onState: (number: number, state: PageState) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const allowed = useRef(canRender)
  const resume = useRef<(() => void) | null>(null)
  useLayoutEffect(() => { allowed.current = canRender }, [canRender])
  useEffect(() => {
    if (canRender && resume.current) { const next = resume.current; resume.current = null; next() }
  }, [canRender])
  const { width, height, scale } = layout
  useEffect(() => {
    const element = canvas.current!
    return () => { element.width = element.height = 0 }
  }, [])
  useEffect(() => {
    let cancelled = false
    let scratch: HTMLCanvasElement | undefined
    let task: RenderTask | undefined
    let layer: TextLayer | undefined
    let pdfPage: PDFPageProxy | undefined
    const canvasElement = canvas.current!
    const textElement = text.current!
    onState(number, { loading: true, scale })
    async function render() {
      try {
        pdfPage = await document.getPage(number)
        if (cancelled) { pdfPage.cleanup(); return }
        const base = pdfPage.getViewport({ scale: 1 })
        onSize(number, { width: base.width, height: base.height })
        const viewport = pdfPage.getViewport({ scale, rotation: pdfPage.rotate + rotation })
        const outputScale = rasterScale(viewport.width, viewport.height, pixelRatio)
        // Keep the previous image readable while a zoom or rotation renders.
        const next = scratch = canvasElement.ownerDocument.createElement('canvas')
        next.width = Math.max(1, Math.floor(viewport.width * outputScale))
        next.height = Math.max(1, Math.floor(viewport.height * outputScale))
        const context = next.getContext('2d')
        if (!context) throw new Error('Your browser could not create a PDF canvas.')
        task = pdfPage.render({ canvas: next, canvasContext: context, viewport,
          transform: [next.width / viewport.width, 0, 0, next.height / viewport.height, 0, 0],
          // Paint saved annotation appearances without an interactive annotation layer.
          annotationMode: AnnotationMode.ENABLE })
        task.onContinue = (next: () => void) => {
          if (cancelled) return
          if (allowed.current) next()
          else resume.current = next
        }
        await task.promise
        if (cancelled) return
        canvasElement.width = next.width
        canvasElement.height = next.height
        canvasElement.style.width = `${viewport.width}px`
        canvasElement.style.height = `${viewport.height}px`
        canvasElement.getContext('2d')?.drawImage(next, 0, 0)
        next.width = next.height = 0
        textElement.replaceChildren()
        layer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: textElement, viewport })
        await layer.render().catch(() => {})
        if (!cancelled) onState(number, { loading: false, scale })
      } catch (error) {
        if (!cancelled) onState(number, { loading: false, scale, error })
      } finally {
        if (scratch) scratch.width = scratch.height = 0
      }
    }
    void render()
    return () => {
      cancelled = true
      resume.current = null
      task?.cancel()
      layer?.cancel()
      // Page cleanup is safe during a replacement render: PDF.js defers it
      // until the page has no active render tasks.
      pdfPage?.cleanup()
    }
  }, [document, number, scale, pixelRatio, rotation, onSize, onState])
  return <div className="pdf-paper" data-page={number} style={{ top: Math.round(layout.top), left, width, height, '--total-scale-factor': scale } as CSSProperties}>
    <canvas ref={canvas} aria-label={`Page ${number}`} /><div className="pdf-text-layer" ref={text} />
  </div>
}

function CompressedPage({ document, number, layout, left, pixelRatio, rotation, onSize, onState, canRender }: {
  document: CompressedPDF; number: number; layout: Layout; rotation: number; canRender: boolean
  left: number; pixelRatio: number
  onSize: (number: number, size: Size) => void
  onState: (number: number, state: PageState | null) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const allowed = useRef(canRender)
  const resume = useRef<(() => void) | null>(null)
  useLayoutEffect(() => { allowed.current = canRender }, [canRender])
  useEffect(() => { if (canRender) resume.current?.() }, [canRender])
  useEffect(() => () => onState(number, null), [number, onState])
  const { width, height, scale } = layout
  const size = compressedSize(layout, pixelRatio)
  const renderKey = compressedRenderKey(document, layout, pixelRatio, rotation)
  useEffect(() => {
    const element = canvas.current!
    return () => { element.width = element.height = 0 }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    onState(number, { loading: true, scale, renderKey })
    function waitForPriority() {
      if (allowed.current || controller.signal.aborted) return Promise.resolve()
      return new Promise<void>(resolve => {
        const proceed = () => {
          if (resume.current === proceed) resume.current = null
          controller.signal.removeEventListener('abort', proceed)
          resolve()
        }
        resume.current = proceed
        controller.signal.addEventListener('abort', proceed, { once: true })
      })
    }
    async function render() {
      let bitmap: ImageBitmap | undefined
      try {
        while (!allowed.current && !controller.signal.aborted) await waitForPriority()
        if (controller.signal.aborted) return
        const image = await compressedPage(document, number, size, controller.signal)
        if (controller.signal.aborted) return
        onSize(number, { width: image.width, height: image.height })
        const turned = rotation % 180 !== 0
        const w = (turned ? image.height : image.width) * scale
        const h = (turned ? image.width : image.height) * scale
        // Adopt newly measured geometry before spending work decoding its JPEG.
        if (Math.abs(w - width) > 0.01 || Math.abs(Math.max(24, h) - height) > 0.01) return
        while (!allowed.current && !controller.signal.aborted) await waitForPriority()
        if (controller.signal.aborted) return
        bitmap = await createImageBitmap(image.blob)
        if (controller.signal.aborted) return
        const outputScale = Math.min(rasterScale(w, h, pixelRatio), (turned ? bitmap.height : bitmap.width) / w, (turned ? bitmap.width : bitmap.height) / h)
        const element = canvas.current!
        element.width = Math.max(1, Math.floor(w * outputScale))
        element.height = Math.max(1, Math.floor(h * outputScale))
        element.style.width = `${w}px`
        element.style.height = `${h}px`
        const context = element.getContext('2d')
        if (!context) throw new Error('Your browser could not display this PDF page.')
        context.imageSmoothingQuality = 'high'
        context.scale(element.width / w, element.height / h)
        context.translate(w / 2, h / 2)
        context.rotate(rotation * Math.PI / 180)
        context.drawImage(bitmap, -image.width * scale / 2, -image.height * scale / 2, image.width * scale, image.height * scale)
        onState(number, { loading: false, scale, renderKey })
      } catch (error) {
        if (!controller.signal.aborted) onState(number, { loading: false, scale, renderKey, error })
      } finally { bitmap?.close() }
    }
    void render()
    return () => controller.abort()
  }, [document, number, width, height, scale, pixelRatio, rotation, size, renderKey, onSize, onState])
  return <div className="pdf-paper compressed-paper" data-page={number} style={{ top: Math.round(layout.top), left, width, height }}>
    <canvas ref={canvas} aria-label={`Page ${number} (compressed image)`} />
  </div>
}

export default function PDFPages({ document, navigation, zoom, rotation, initialPosition, request, onPosition, onLeave, onState }: {
  document: PDFSource; navigation: 'vertical' | 'horizontal'; zoom: 'fit' | number; rotation: number
  initialPosition: Position; request: Position
  onPosition: (position: Position) => void
  onLeave: (position: Position) => void
  onState: (state: PageState) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const position = useRef(initialPosition)
  const lastRequest = useRef(request)
  const [viewport, setViewport] = useState({ width: 800, height: 600, top: 0, measured: false })
  const [pixelRatio, setPixelRatio] = useState(window.devicePixelRatio || 1)
  const [sizes, setSizes] = useState(new Map<number, Size>())
  const [pageStates, setPageStates] = useState(new Map<number, PageState>())
  const [page, setPage] = useState(initialPosition.page)
  const lastPage = useRef(initialPosition.page)
  const direction = useRef(1)
  useLayoutEffect(() => {
    if (page !== lastPage.current) {
      direction.current = page > lastPage.current ? 1 : -1
      lastPage.current = page
    }
  }, [page])
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const vertical = navigation === 'vertical'
  const layout = useMemo(() => {
    // Unvisited pages use the first measured page's dimensions. Only pages
    // near the viewport are fetched and measured; mixed sizes refine the layout.
    const fallback = sizes.values().next().value ?? ('compressed' in document ? { width: document.width, height: document.height } : { width: 595, height: 842 })
    let top = 0
    return Array.from({ length: document.numPages }, (_, index) => {
      const size = sizes.get(index + 1) ?? fallback
      const turned = rotation % 180 !== 0
      const width = turned ? size.height : size.width
      const height = turned ? size.width : size.height
      const scale = zoom === 'fit' ? Math.max(0.01, Math.min(3, viewport.width / width)) : zoom
      const item = { top: vertical ? top : 0, width: width * scale, height: Math.max(24, height * scale), scale }
      top += item.height + 12
      return item
    })
  }, [document, sizes, rotation, zoom, viewport.width, vertical])
  const onSize = useCallback((number: number, size: Size) => {
    setSizes(previous => {
      // Unmeasured pages already use the first measured size.
      const old = previous.get(number) ?? previous.values().next().value
      return old?.width === size.width && old.height === size.height ? previous : new Map(previous).set(number, size)
    })
  }, [])
  const onPageState = useCallback((number: number, state: PageState | null) => {
    setPageStates(previous => {
      if (state) return new Map(previous).set(number, state)
      if (!previous.has(number)) return previous
      const next = new Map(previous)
      next.delete(number)
      return next
    })
  }, [])
  const latestLayout = useRef(layout)
  latestLayout.current = layout

  useLayoutEffect(() => {
    const element = container.current!
    return () => {
      // A tab can close before the browser dispatches its pending scroll event.
      // Capture the DOM position before removal, ahead of the document cache cleanup.
      const items = latestLayout.current
      const number = vertical ? visiblePage(items, element.scrollTop, element.clientHeight) : position.current.page
      onLeave({ page: number, top: element.scrollTop - items[number - 1].top, left: element.scrollLeft })
    }
  }, [onLeave, vertical])

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setViewport(previous => ({ ...previous, width: entry.contentRect.width, height: entry.contentRect.height, measured: true }))
    })
    observer.observe(container.current!)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const media = window.matchMedia(`(resolution: ${pixelRatio}dppx)`)
    const update = () => setPixelRatio(window.devicePixelRatio || 1)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [pixelRatio])

  useLayoutEffect(() => {
    const requested = lastRequest.current !== request
    if (requested) {
      position.current = request
      lastRequest.current = request
    }
    const current = position.current
    const index = Math.max(0, Math.min(layout.length - 1, current.page - 1))
    const element = container.current!
    const top = Math.min(vertical ? current.top : Math.max(0, current.top), layout[index].height - 1)
    if (requested || Math.abs(element.scrollTop - layout[index].top - top) > 1 || Math.abs(element.scrollLeft - current.left) > 1) {
      element.scrollTo({ top: layout[index].top + top, left: current.left })
    }
    setPage(index + 1)
    setViewport(previous => ({ ...previous, top: element.scrollTop }))
  }, [layout, request, vertical])

  const first = vertical ? pageAt(layout, Math.max(0, viewport.top - 250)) : page - 1
  const last = vertical ? pageAt(layout, viewport.top + viewport.height + 250) : page - 1
  const visible = 'compressed' in document && !viewport.measured ? [] : layout.slice(first, last + 1)
  const state = pageStates.get(page)
  const renderKey = 'compressed' in document ? compressedRenderKey(document, layout[page - 1], pixelRatio, rotation) : undefined
  const ready = state && state.scale === layout[page - 1].scale && state.renderKey === renderKey
    ? state : { loading: true, scale: layout[page - 1].scale, renderKey }
  useEffect(() => { onState(ready) }, [onState, ready.loading, ready.scale, ready.error, ready.renderKey])
  useEffect(() => {
    if (!('compressed' in document) || document.generation !== compressedCacheGeneration() || vertical || ready.loading || ready.error) return
    const next = page + direction.current
    const item = layout[next - 1]
    if (!item) return
    const controller = new AbortController()
    void compressedPage(document, next, compressedSize(item, pixelRatio), controller.signal).catch(() => {})
    return () => controller.abort()
  }, [document, vertical, page, layout, pixelRatio, ready.loading, ready.error, ready.renderKey])
  const totalHeight = vertical ? layout.at(-1)!.top + layout.at(-1)!.height : layout[page - 1].height
  // Wide pages remain pannable at fixed zoom without producing a negative left edge.
  const contentWidth = Math.max(viewport.width, ...visible.map(item => item.width))

  function movePage(next: number) {
    const number = Math.max(1, Math.min(document.numPages, next))
    position.current = { page: number, top: 0, left: 0 }
    setPage(number)
    container.current?.scrollTo({ top: layout[number - 1].top, left: 0 })
    setViewport(previous => ({ ...previous, top: layout[number - 1].top }))
    onPosition(position.current)
  }

  return <div className="pdf-canvas-area" ref={container} tabIndex={0} role="region" aria-label={`PDF page ${page} of ${document.numPages}`} aria-busy={ready.loading}
    onScroll={event => {
      const element = event.currentTarget
      const number = vertical ? visiblePage(layout, element.scrollTop, viewport.height) : page
      position.current = { page: number, top: element.scrollTop - layout[number - 1].top, left: element.scrollLeft }
      setViewport(previous => ({ ...previous, top: element.scrollTop }))
      setPage(number)
      onPosition(position.current)
    }}
    onTouchStart={event => { touchStart.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null }}
    onTouchEnd={event => {
      const start = touchStart.current
      touchStart.current = null
      if (vertical || !start || !event.changedTouches.length || event.currentTarget.scrollWidth > event.currentTarget.clientWidth + 2) return
      const dx = event.changedTouches[0].clientX - start.x
      const dy = event.changedTouches[0].clientY - start.y
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) movePage(page + (dx < 0 ? 1 : -1))
    }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        movePage(page + (event.key === 'ArrowLeft' ? -1 : 1))
      }
    }}>
    {ready.loading && <div className="pdf-rendering"><Loading message={`Rendering page ${page}…`} compact /></div>}
    <div className="pdf-pages" style={{ height: totalHeight, width: contentWidth }}>
      {visible.map((item, index) => 'compressed' in document
        ? <CompressedPage canRender={first + index + 1 === page || !ready.loading} key={first + index + 1} document={document} number={first + index + 1} layout={item} left={Math.round((contentWidth - item.width) / 2)} pixelRatio={pixelRatio} rotation={rotation} onSize={onSize} onState={onPageState} />
        : <PDFPage canRender={first + index + 1 === page || !ready.loading} key={first + index + 1} document={document} number={first + index + 1} layout={item} left={Math.round((contentWidth - item.width) / 2)} pixelRatio={pixelRatio} rotation={rotation} onSize={onSize} onState={onPageState} />)}
    </div>
  </div>
}
