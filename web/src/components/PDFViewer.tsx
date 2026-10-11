import { ArrowDownToLine, BookOpen, ChevronLeft, ChevronRight, ImageDown, LayoutGrid, Minus, Plus, RotateCw, Search } from 'lucide-react'
import '../pdfCompatibility'
// Use the compatibility build in both contexts; some iPad Safari versions
// lack Iterator and other APIs required by PDF.js's modern build.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerURL from '../pdf.worker?worker&url'
import { APIError, api, apiURL, errorMessage, isAborted, sessionExpired } from '../api'
import type { FileLocation } from '../types'
import { fileName } from '../location'
import { clearPDFCache, pdfCacheGeneration, retainPDF, takeCachedPDF } from '../pdfCache'
import type { PDFDocument, PDFView } from '../pdfCache'
import { compressedCacheGeneration } from '../compressedPDF'
import type { FileMetadata } from './useFileRefresh'
import { ErrorState, Loading } from './Common'
import { usePreferences } from '../preferences'
import PDFPages from './PDFPages'
import PDFFind from './PDFFind'
import PDFNavigation from './PDFNavigation'
import PDFOverview from './PDFOverview'

GlobalWorkerOptions.workerSrc = workerURL

function pdfError(error: unknown) {
  if (error instanceof APIError && error.status === 404) return 'No PDF was found at this path. If you opened this from TeX, place a compiled PDF with the same name beside the source file.'
  if (error && typeof error === 'object' && 'status' in error && error.status === 401) sessionExpired()
  if (error instanceof Error && error.name === 'PasswordException') return 'This PDF is password protected. Download it to open it with your PDF reader.'
  return errorMessage(error)
}

function denied(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'status' in error &&
    (error.status === 401 || error.status === 403 || error.status === 404))
}
const ignorePosition = () => {}

interface Props {
  location: FileLocation
  refreshToken?: number
  forceRefreshToken?: number
  refreshSignal?: AbortSignal
  onRefreshState?: (state: { loading: boolean; error: string }) => void
  renderActions?: (extraActions: ReactNode) => ReactNode
}

export default function PDFViewer(props: Props) {
  return <PDFReader key={apiURL('file', props.location)} {...props} />
}

function PDFReader({ location, refreshToken = 0, forceRefreshToken = 0, refreshSignal, onRefreshState, renderActions }: Props) {
  const [loaded, setLoaded] = useState<PDFDocument | null>(null)
  const document = loaded?.document ?? null
  const [replacement, setReplacement] = useState<{ entry: PDFDocument; view: PDFView; onState: (state: { loading: boolean; error?: unknown }) => void } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [renderError, setRenderError] = useState('')
  const [page, setPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [renderedScale, setRenderedScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [preferences, setPreferences] = usePreferences()
  const [rendering, setRendering] = useState(true)
  const [progress, setProgress] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [availableFile, setAvailableFile] = useState<{ url: string; size: number } | null>(null)
  const [overview, setOverview] = useState(false)
  const [findSource, setFindSource] = useState<{ document: PDFDocumentProxy; url: string } | null>(null)
  const viewer = useRef<HTMLDivElement>(null)
  const findReturnFocus = useRef<HTMLElement | null>(null)
  const pageCommitFocus = useRef<{ input: HTMLInputElement; source: typeof loaded; controller: AbortController } | null>(null)
  const editingPage = useRef(false)
  const liveTasks = useRef(new Set<ReturnType<typeof getDocument>>())
  const active = useRef(loaded)
  const restorePosition = useRef<PDFView | null>(null)
  const renderCheck = useRef<AbortController | null>(null)
  const view = useRef<PDFView>({ page: 1, zoom: 'fit', rotation: 0, top: 0, left: 0 })
  const [pageRequest, setPageRequest] = useState({ page: 1, top: 0, left: 0 })
  const lastForce = useRef({ token: forceRefreshToken, attempt, pending: false })
  const lastCompression = useRef(preferences.pdfCompression)
  active.current = loaded
  view.current = { ...view.current, page, zoom, rotation }
  const url = apiURL('file', location)
  const fileSize = availableFile?.url === url ? availableFile.size : 0
  const error = loadError || renderError
  const findDocument = document && !preferences.pdfCompression && !('compressed' in document) ? document : null
  const findOpen = Boolean(findDocument && findSource?.document === findDocument && findSource.url === url)
  const destroyTask = useCallback((task?: ReturnType<typeof getDocument>) => {
    if (task && liveTasks.current.delete(task)) void task.destroy().catch(() => {})
  }, [])

  useLayoutEffect(() => {
    const request = pageCommitFocus.current
    if (!request) return
    pageCommitFocus.current = null
    const { input, source, controller } = request
    const owner = input.ownerDocument
    const restore = !controller.signal.aborted && input.isConnected && source === active.current &&
      owner.hasFocus() && owner.activeElement === owner.body
    controller.abort()
    // A page commit can also replace the overview with the reading area.
    if (restore) viewer.current?.querySelector<HTMLElement>('.pdf-canvas-area')?.focus({ preventScroll: true })
  })
  useLayoutEffect(() => () => {
    pageCommitFocus.current?.controller.abort()
    renderCheck.current?.abort()
  }, [])

  useEffect(() => {
    return () => {
      const current = active.current
      if (current && ('compressed' in current.document || liveTasks.current.delete(current.document.loadingTask))) retainPDF(current, url, view.current)
      // A load that did not become the visible document must never enter the cache.
      for (const task of liveTasks.current) destroyTask(task)
    }
  }, [destroyTask, url])

  useLayoutEffect(() => {
    const controller = new AbortController()
    let task: ReturnType<typeof getDocument> | undefined
    let adopted = false
    let finished = false
    let finishRender: ((failure?: unknown) => void) | undefined
    const force = lastForce.current.pending || forceRefreshToken !== lastForce.current.token || attempt !== lastForce.current.attempt
    lastForce.current = { token: forceRefreshToken, attempt, pending: force }
    const generation = pdfCacheGeneration()
    const imageGeneration = compressedCacheGeneration()
    if (lastCompression.current !== preferences.pdfCompression) {
      lastCompression.current = preferences.pdfCompression
      active.current = null
      restorePosition.current = null
      renderCheck.current?.abort()
      setLoaded(null)
      setRenderError('')
    }
    if (!active.current) {
      const cached = takeCachedPDF(url)
      if (cached && ('compressed' in cached.document) === preferences.pdfCompression) {
        if (!('compressed' in cached.document)) liveTasks.current.add(cached.document.loadingTask)
        active.current = cached
        view.current = cached.view
        restorePosition.current = { ...cached.view }
        setPageRequest(cached.view)
        setPage(cached.view.page)
        setPageInput(String(cached.view.page))
        setZoom(cached.view.zoom)
        setRotation(cached.view.rotation)
        setLoaded(cached)
      } else if (cached && !('compressed' in cached.document)) {
        void cached.document.loadingTask.destroy().catch(() => {})
      }
    }
    const stop = () => {
      controller.abort()
      finishRender?.(controller.signal.reason)
      setReplacement(null)
      if (!adopted) destroyTask(task)
    }
    const invalidate = () => {
      stop()
      active.current = null
      restorePosition.current = null
      renderCheck.current?.abort()
      setLoaded(null)
      setFindSource(null)
      setAvailableFile(null)
      setRenderError('')
      setLoadError('PDF access changed. Refresh this file to check access again.')
      setLoading(false)
      for (const pending of liveTasks.current) destroyTask(pending)
    }
    const closed = (event: Event) => {
      if (!(event as CustomEvent<string[]>).detail.includes(url)) invalidate()
    }
    const abortRefresh = () => {
      if (finished) return
      stop()
      setLoadError('Refresh interrupted. Resume automatic refresh or refresh this file to retry.')
      setLoading(false)
    }
    setLoadError('')
    setLoading(true)
    setProgress(0)
    setAvailableFile(active.current ? { url, size: active.current.size } : null)
    window.addEventListener('artiface:pdf-cache-cleared', invalidate)
    window.addEventListener('artiface:pdf-open-files', closed)
    refreshSignal?.addEventListener('abort', abortRefresh, { once: true })
    if (refreshSignal?.aborted) abortRefresh()
    async function adopt(entry: PDFDocument) {
      if (active.current) {
        // Keep the current pixels mounted until the replacement page renders.
        const position = { ...view.current, page: Math.min(view.current.page, entry.document.numPages) }
        await new Promise<void>((resolve, reject) => {
          finishRender = failure => failure ? reject(failure) : resolve()
          setReplacement({ entry, view: position, onState: state => {
            if (!state.loading) finishRender?.(state.error)
          } })
        })
      }
      if (controller.signal.aborted || generation !== pdfCacheGeneration()) return
      lastForce.current.pending = false
      adopted = true
      const nextPage = Math.min(view.current.page, entry.document.numPages)
      view.current = { ...view.current, page: nextPage }
      setPageRequest(view.current)
      setPage(nextPage)
      if (!editingPage.current) setPageInput(String(nextPage))
      active.current = entry
      renderCheck.current?.abort()
      setLoaded(entry)
      setReplacement(null)
      setRenderError('')
    }
    async function load() {
      try {
        if (controller.signal.aborted) return
        if (preferences.pdfCompression) {
          const result = await api<{ id: string; pages: number; width: number; height: number; version: string; size: number }>('/api/pdf/info', {
            body: { ...location, refresh: force }, signal: controller.signal,
          })
          if (controller.signal.aborted) return
          setAvailableFile({ url, size: result.size })
          const current = active.current
          if (current && 'compressed' in current.document && current.version === result.version && current.document.id === result.id) {
            lastForce.current.pending = false
            return
          }
          await adopt({ document: { ...result, compressed: true, numPages: result.pages, location: { ...location }, generation: imageGeneration },
            version: result.version, size: result.size, generation })
          return
        }
        const metadata = await api<FileMetadata>(apiURL('file-info', location), { signal: controller.signal })
        if (controller.signal.aborted) return
        setAvailableFile({ url, size: metadata.size })
        // Never stamp the new version onto old bytes, including after a failed replacement.
        if (!force && active.current?.version === metadata.version) return
        const options = {
          url: new URL(url, window.location.origin).href,
          withCredentials: true,
          disableRange: false,
          disableStream: true,
          disableAutoFetch: true,
          rangeChunkSize: 256 * 1024,
          // Explicit defense in depth for PDF.js versions that expose this option.
          isEvalSupported: false,
          // The application CSP does not permit WebAssembly compilation.
          useWasm: false,
          enableXfa: false,
          maxImageSize: 32 * 1024 * 1024,
          cMapUrl: new URL('/pdfjs/cmaps/', window.location.origin).href,
          standardFontDataUrl: new URL('/pdfjs/standard_fonts/', window.location.origin).href,
          wasmUrl: new URL('/pdfjs/wasm/', window.location.origin).href,
          iccUrl: new URL('/pdfjs/iccs/', window.location.origin).href,
        }
        task = getDocument(options)
        liveTasks.current.add(task)
        task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => { if (!controller.signal.aborted && total) setProgress(Math.min(100, Math.round(loaded / total * 100))) }
        const result = await task.promise
        if (!controller.signal.aborted) await adopt({ document: result, version: metadata.version, size: metadata.size, generation })
      } catch (failure) {
        if (!controller.signal.aborted && !isAborted(failure)) {
          if (denied(failure)) clearPDFCache()
          setLoadError(pdfError(failure))
        }
      } finally {
        finished = true
        if (!adopted) destroyTask(task)
        if (!controller.signal.aborted) {
          setReplacement(null)
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      stop()
      window.removeEventListener('artiface:pdf-cache-cleared', invalidate)
      window.removeEventListener('artiface:pdf-open-files', closed)
      refreshSignal?.removeEventListener('abort', abortRefresh)
    }
  }, [url, attempt, refreshToken, forceRefreshToken, refreshSignal, destroyTask, preferences.pdfCompression])

  useEffect(() => {
    return () => destroyTask(document && !('compressed' in document) ? document.loadingTask : undefined)
  }, [document, destroyTask])

  useEffect(() => { setFindSource(null) }, [document, url, preferences.pdfCompression])
  useEffect(() => {
    onRefreshState?.({ loading: loading || (Boolean(document) && !overview && rendering), error })
  }, [loading, rendering, error, document, onRefreshState, overview])

  const followPosition = useCallback((position: Pick<PDFView, 'page' | 'top' | 'left'>) => {
    setReplacement(current => {
      if (!current) return current
      const next = { ...current.view, ...position, page: Math.min(position.page, current.entry.document.numPages) }
      if (next.page === current.view.page && next.top === current.view.top && next.left === current.view.left) return current
      return { ...current, view: next }
    })
  }, [])
  const updatePosition = useCallback((position: Pick<PDFView, 'page' | 'top' | 'left'>) => {
    view.current = { ...view.current, ...position }
    followPosition(position)
    setPage(position.page)
    if (!editingPage.current) setPageInput(String(position.page))
  }, [followPosition])
  const savePosition = useCallback((position: Pick<PDFView, 'page' | 'top' | 'left'>) => {
    const current = active.current
    const pages = current?.document.numPages ?? position.page
    view.current = { ...view.current, ...position, page: Math.min(position.page, pages) }
  }, [])
  const updateRender = useCallback((state: { loading: boolean; scale: number; error?: unknown }) => {
    setRendering(state.loading)
    setRenderedScale(state.scale)
    setRenderError(state.error ? pdfError(state.error) : '')
    // Compression measures its viewport before mounting pages; the browser can
    // clamp the initial horizontal offset while that first layout is empty.
    if (!state.loading && !state.error && restorePosition.current) {
      setPageRequest(restorePosition.current)
      restorePosition.current = null
    }
    // A later range request can expire independently of the initial request.
    if (denied(state.error)) clearPDFCache()
    else if (state.error) {
      const source = active.current
      renderCheck.current?.abort()
      const controller = renderCheck.current = new AbortController()
      void api(url, { method: 'HEAD', signal: controller.signal }).catch(failure => {
        if (!controller.signal.aborted && active.current === source && denied(failure)) clearPDFCache()
      })
    }
  }, [url])

  function changePage(next: number) {
    if (!document) return
    const value = Math.min(document.numPages, Math.max(1, Number.isFinite(next) ? Math.round(next) : page))
    setPage(value)
    setPageInput(String(value))
    view.current = { ...view.current, page: value, top: 0, left: 0 }
    setPageRequest({ page: value, top: 0, left: 0 })
    followPosition(view.current)
    setOverview(false)
  }

  function commitPage(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !document) return
    const input = event.currentTarget
    if (input.ownerDocument.activeElement !== input) return
    event.preventDefault()
    pageCommitFocus.current?.controller.abort()
    const controller = new AbortController()
    pageCommitFocus.current = { input, source: loaded, controller }
    const cancel = () => controller.abort()
    const options = { capture: true, signal: controller.signal }
    for (const type of ['focusin', 'pointerdown', 'keydown', 'wheel', 'touchstart']) input.ownerDocument.addEventListener(type, cancel, options)
    for (const type of ['blur', 'hashchange', 'popstate', 'pagehide']) window.addEventListener(type, cancel, { signal: controller.signal })
    input.blur()
  }

  function openOverview() {
    setFindSource(null)
    setOverview(true)
  }

  function closeOverview() {
    setOverview(false)
    setPageRequest({ ...view.current })
    requestAnimationFrame(() => viewer.current?.querySelector<HTMLElement>('.pdf-canvas-area')?.focus())
  }

  function navigateToPage(next: number) {
    changePage(next)
    requestAnimationFrame(() => viewer.current?.querySelector<HTMLElement>('.pdf-canvas-area')?.focus())
  }

  function openFind() {
    if (!findDocument) return
    setOverview(false)
    setPageRequest({ ...view.current })
    findReturnFocus.current = viewer.current?.querySelector<HTMLButtonElement>('[aria-label="Reader options"]') ?? viewer.current
    setFindSource({ document: findDocument, url })
    window.requestAnimationFrame(() => viewer.current?.querySelector<HTMLInputElement>('.pdf-find input')?.focus())
  }
  function closeFind() {
    setFindSource(null)
    const target = findReturnFocus.current
    if (target?.isConnected) target.focus()
    else viewer.current?.focus()
  }

  return (
    <div ref={viewer} tabIndex={-1} className={`pdf-viewer${preferences.pdfCompression ? ' pdf-compression' : ''}`}>
      <div className={`pdf-toolbar${findOpen && findDocument ? ' pdf-find-open' : ''}`} id="reader-toolbar" role="toolbar" aria-label="Reader toolbar">
        <div className="pdf-page-controls" style={{ '--pdf-page-digits': String(document?.numPages ?? 1).length } as CSSProperties}><button className="icon-button" disabled={!document || page <= 1} onClick={() => changePage(page - 1)} aria-label="Previous page" title="Previous page"><ChevronLeft size={17} /></button><label><span className="sr-only">Page number</span><input type="number" min={1} max={document?.numPages ?? 1} disabled={!document} value={pageInput} onFocus={() => { editingPage.current = true }} onChange={(event) => setPageInput(event.target.value)} onBlur={event => { editingPage.current = false; changePage(Number(event.currentTarget.value)) }} onKeyDown={commitPage} /></label><PDFNavigation document={document} onPage={navigateToPage} onOverview={openOverview} onOriginal={() => setPreferences({ pdfCompression: false })} /><button className="icon-button" disabled={!document || page >= document.numPages} onClick={() => changePage(page + 1)} aria-label="Next page" title="Next page"><ChevronRight size={17} /></button></div>
        {overview ? <button className="button quiet pdf-return-page" title="Return to page" aria-label="Return to page" onClick={closeOverview}><BookOpen size={17} /><span>Read page</span></button>
          : <select aria-label="PDF zoom" value={zoom === 'fit' ? 'fit' : zoom} onChange={(event) => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}><option value="fit">Fit width</option>{Array.from(new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 3, ...(zoom === 'fit' ? [] : [zoom])])).sort((a, b) => a - b).map((scale) => <option value={scale} key={scale}>{Math.round(scale * 100)}%</option>)}</select>}
        {renderActions?.(<>
          <button disabled={!findDocument} onClick={openFind} title={preferences.pdfCompression ? 'Find requires Original mode. Turn off Compression to search.' : 'Find pages containing text in this PDF'}><Search size={16} />Find in PDF{preferences.pdfCompression ? ' · Original mode only' : ''}</button>
          <button disabled={!document} onClick={overview ? closeOverview : openOverview} title={overview ? 'Return to page' : 'Browse page thumbnails'}>
            {overview ? <BookOpen size={16} /> : <LayoutGrid size={16} />}{overview ? 'Return to page' : 'Page overview'}</button>
          <button className="pdf-compression-option" aria-pressed={preferences.pdfCompression} onClick={() => setPreferences({ pdfCompression: !preferences.pdfCompression })} title="Load pages as smaller images. Turn off for selectable text and full detail."><ImageDown size={16} />Compression{preferences.pdfCompression ? ' · On' : ''}</button>
          <label>Page navigation<select aria-label="PDF page navigation" value={preferences.pdfNavigation} onChange={event => {
            view.current = { ...view.current, top: 0, left: 0 }
            setPreferences({ pdfNavigation: event.target.value === 'vertical' ? 'vertical' : 'horizontal' })
          }}><option value="horizontal">Horizontal swipe</option><option value="vertical">Vertical scroll</option></select></label>
          <button data-keep-menu-open onClick={() => setZoom(Math.max(0.25, Math.round((renderedScale - 0.25) * 100) / 100))} disabled={renderedScale <= 0.25} title="Zoom out"><Minus size={16} />Zoom out</button>
          <button data-keep-menu-open onClick={() => setZoom(Math.min(4, Math.round((renderedScale + 0.25) * 100) / 100))} disabled={renderedScale >= 4} title="Zoom in"><Plus size={16} />Zoom in</button>
          <button data-keep-menu-open onClick={() => setRotation((rotation + 90) % 360)} title="Rotate clockwise"><RotateCw size={15} />Rotate page clockwise</button>
        </>)}
        {findOpen && findDocument && <PDFFind key={findDocument.loadingTask.docId} document={findDocument} page={page} onPage={changePage} onClose={closeFind} />}
      </div>
      {error && document && <div className="notice warning-notice" role="status">
        {loadError ? `Showing the previous PDF. ${error}` : error} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Refresh PDF</button>
        {preferences.pdfCompression && <button className="text-button" onClick={() => setPreferences({ pdfCompression: false })}>Use Original mode</button>}
      </div>}
      {error && !document ? <ErrorState title="Couldn’t open this PDF" message={error} retry={() => setAttempt(attempt + 1)}>
        {availableFile?.url === url && <a className="button secondary" href={apiURL('file', location, true)} download={fileName(location.path)}><ArrowDownToLine size={15} />Download original</a>}
        {preferences.pdfCompression && <button className="button secondary" onClick={() => setPreferences({ pdfCompression: false })}>Use Original mode</button>}
      </ErrorState> : !document ? <div className="pdf-initial-loading"><Loading message={preferences.pdfCompression ? 'Preparing compressed PDF…' : `Loading PDF${progress ? ` · ${progress}%` : '…'}`} />
        {!preferences.pdfCompression && fileSize >= 20 * 1024 * 1024 && <button className="button secondary" onClick={() => setPreferences({ pdfCompression: true })}><ImageDown size={16} />Use Compression</button>}
      </div> : <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        {[...(loaded ? [loaded] : []), ...(replacement ? [replacement.entry] : [])].map(entry => {
          const source = entry.document
          const pending = entry === replacement?.entry
          return <div key={`${'compressed' in source ? source.id : source.loadingTask.docId}:${preferences.pdfNavigation}`}
            aria-hidden={pending || undefined} inert={pending}
            style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, ...(pending ? { position: 'absolute', inset: 0, visibility: 'hidden' } : {}) }}>
            {overview && !pending ? <PDFOverview document={source} page={page} rotation={rotation} onPage={navigateToPage} onClose={closeOverview} />
              : <PDFPages document={source} navigation={preferences.pdfNavigation} zoom={zoom} rotation={rotation}
                initialPosition={pending ? replacement.view : view.current} request={pending ? replacement.view : pageRequest}
                onPosition={pending ? ignorePosition : updatePosition} onLeave={pending ? ignorePosition : savePosition}
                onState={pending ? replacement.onState : updateRender} />}
          </div>
        })}
      </div>}
    </div>
  )
}
