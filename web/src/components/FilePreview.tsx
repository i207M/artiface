import { AlertCircle, ArrowDownToLine, Code2, Copy, Eye, FileQuestion, FileText, FolderOpen, Maximize2, WrapText } from 'lucide-react'
import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, apiURL, errorMessage, isAborted } from '../api'
import { fileLanguage } from '../fileLanguage'
import { formatBytes, modifiedTime } from '../format'
import { sourceHighlightInputLimit } from '../highlightLimits'
import { forgetImagePreview, imageViewGeneration, retainImagePreview, reusableImagePreview } from '../imageView'
import { clearPDFCache } from '../pdfCache'
import { asFileLocation, fileName, parentPath } from '../location'
import { usePreferences } from '../preferences'
import type { Entry, Location, PreviewResponse, TextResponse } from '../types'
import { ErrorState, Loading, fileKind } from './Common'
import ReaderActions from './ReaderActions'
import MarkdownOutline from './MarkdownOutline'
import { readerType, readerTypeLabels } from './fileTypes'
import { useFileRefresh } from './useFileRefresh'
import type { FileMetadata } from './useFileRefresh'
import { ReaderPosition, useReaderView } from './useReaderView'
import { useBrowseReaderFocusTarget } from './useBrowseReaderFocus'
import type { BrowseReaderFocusRequest } from './useBrowseReaderFocus'
import { prepareSourceWrap } from './sourceWrapAnchor'
import type { SourceWrapCorrection } from './sourceWrapAnchor'
import ImageViewer, { ImageViewActions, useImageView } from './ImageViewer'
import HTMLScriptPermission from './HTMLScriptPermission'
import { useReportLinks } from './ReportLinks'

const SourceViewer = lazy(() => import('./SourceViewer'))
const MarkdownViewer = lazy(() => import('./MarkdownViewer'))
const PDFViewer = lazy(() => import('./PDFViewer'))
const CSVViewer = lazy(() => import('./CSVViewer'))

async function waitForContent(pending: Promise<void> | null, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!pending) return
  let abort = () => {}
  try {
    await Promise.race([pending, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Refresh cancelled', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

async function checkPreviewConnection(previewURL: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const origin = new URL(previewURL).origin
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = window.setTimeout(abort, 5000)
  try {
    // Check only the public health endpoint; never fetch the report or send cookies.
    const response = await fetch(`${origin}/p/healthz`, {
      method: 'HEAD', mode: 'cors', credentials: 'omit', cache: 'no-store',
      redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
    })
    if (response.status !== 204) throw new Error('Unexpected preview health response')
  } catch {
    signal.throwIfAborted()
    throw new Error(`Couldn’t connect to the HTML preview at ${origin}. Make sure this address is reachable from your browser. If you connect through SSH, forward the app port on this device, then try again.`)
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

class ViewerBoundary extends Component<{ children: ReactNode; resetKey: string; toolbar?: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: unknown) { return { error: errorMessage(error) } }
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: '' })
  }
  render() {
    return this.state.error ? <>{this.props.toolbar}<ErrorState title="This preview couldn’t be displayed" message={this.state.error} /></> : this.props.children
  }
}

function HTMLReport({ url, resolvedPath, title, scriptsEnabled, bridge, active, onLink, onLoading, onError, retry, scriptPrompt }: {
  url: string; title: string; scriptsEnabled: boolean; bridge?: boolean; active: boolean
  resolvedPath: string
  onLink: (href: string, download?: boolean, keyboard?: boolean, basePath?: string) => void; onError: () => void; retry: () => void; scriptPrompt?: ReactNode
  onLoading: (loading: boolean) => void
}) {
  const [visibleURL, setVisibleURL] = useState<string | null>(null)
  const [failedURL, setFailedURL] = useState<string | null>(null)
  useEffect(() => { onLoading(visibleURL !== url && failedURL !== url) }, [visibleURL, failedURL, url, onLoading])
  useEffect(() => () => onLoading(false), [onLoading])
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const paths = useRef(new Map<string, string>())
  paths.current.set(url, resolvedPath)
  const ready = useRef(new Set<string>())
  const loadTimers = useRef(new Set<number>())
  useEffect(() => () => {
    for (const timer of loadTimers.current) window.clearTimeout(timer)
    loadTimers.current.clear()
  }, [url])
  useLayoutEffect(() => {
    if (!bridge) return
    const receive = (event: MessageEvent) => {
      if (event.origin !== 'null') return
      const source = [...frames.current].find(([, frame]) => event.source === frame.contentWindow)?.[0]
      if (!source) return
      const token = new URL(source).pathname.split('/')[2]
      const data = event.data
      if (!data || data.token !== token) return
      if (data.type === 'artiface:preview-ready' && source === url) {
        ready.current.clear()
        ready.current.add(source)
        setVisibleURL(source)
        return
      }
      if (!active || source !== visibleURL || data.type !== 'artiface:preview-link' ||
        typeof data.href !== 'string' || data.href.length > 16384 || typeof data.download !== 'boolean') return
      onLink(data.href, data.download, data.keyboard === true, paths.current.get(source))
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [active, bridge, url, visibleURL, onLink])
  const urls = Array.from(new Set([visibleURL, failedURL === url ? null : url].filter((value): value is string => value !== null)))
  useEffect(() => {
    for (const key of paths.current.keys()) if (!urls.includes(key)) paths.current.delete(key)
  }, [url, visibleURL, failedURL])
  return (
    <div className="html-viewer">
      {active && !scriptsEnabled && scriptPrompt}
      {!visibleURL && failedURL !== url && <div className="iframe-loading"><Loading message="Opening report…" /></div>}
      {urls.map(source => <iframe key={source} ref={frame => { if (frame) frames.current.set(source, frame); else frames.current.delete(source) }}
        className={source === visibleURL ? '' : 'pending-preview'} title={source === visibleURL ? title : `${title} (loading)`} src={source}
        sandbox={scriptsEnabled || bridge ? 'allow-scripts' : ''} referrerPolicy="no-referrer" aria-hidden={source !== visibleURL}
        onLoad={() => {
          if (source !== url) return
          if (!bridge) { setVisibleURL(source); return }
          // HTTP errors still fire iframe load; only the trusted bridge acknowledges a report.
          const timer = window.setTimeout(() => {
            loadTimers.current.delete(timer)
            if (frames.current.has(source) && !ready.current.has(source)) { setFailedURL(source); onError() }
          }, 1000)
          loadTimers.current.add(timer)
        }} onError={() => { setFailedURL(source); onError() }} />)}
      {!visibleURL && failedURL === url && <ErrorState title="Couldn’t display this report" message="The report could not load. Check the preview connection and try again." retry={retry} />}
    </div>
  )
}

interface Props {
  location: Location
  active?: boolean
  projectRoot?: string
  focusRequest?: BrowseReaderFocusRequest | null
  entry?: Entry
  onNavigate: (location: Location, keyboard?: boolean) => void
  copied: boolean
  onCopyLink: () => void
  onCopyPath?: () => void
  onExpand: () => void
  autoRefreshPaused?: boolean
  onToggleAutoRefresh?: () => void
  refreshToken?: number
  projectTrustedScripts?: boolean
  onProjectScriptsAllowed?: () => void
}

export default function FilePreview(props: Props) {
  // Each file mounts its own reader and restores any retained view metadata.
  return <ActiveFilePreview key={apiURL('file-info', props.location)} {...props} />
}

function ActiveFilePreview({ location, active = true, projectRoot, focusRequest, entry, onNavigate, copied, onCopyLink, onCopyPath, onExpand, autoRefreshPaused, onToggleAutoRefresh, refreshToken = 0, projectTrustedScripts = false, onProjectScriptsAllowed }: Props) {
  const [preferences] = usePreferences()
  const kind = fileKind(location.path)
  const imageKey = apiURL('file', location)
  const imageView = useImageView(kind === 'image' ? imageKey : undefined)
  const imageAttempt = useRef<{
    preview: PreviewResponse; fresh: PreviewResponse; generation: number; signal: AbortSignal
  } | null>(null)
  const readerView = useReaderView(!['pdf', 'image', 'unsupported'].includes(kind) ? apiURL('file', location) : undefined, kind === 'code' || kind === 'tex' ? 'source' : 'render')
  const mode = readerView.view.mode
  const [text, setText] = useState<TextResponse | null>(null)
  const [textError, setTextError] = useState('')
  const [loadedPreview, setLoadedPreview] = useState<{ data: PreviewResponse; projectTrustedScripts: boolean } | null>(null)
  // A changed project policy hides the previous document in this render, even
  // when automatic refresh is paused or a new capability is still being fetched.
  const preview = loadedPreview?.projectTrustedScripts === projectTrustedScripts ? loadedPreview.data : null
  const links = useReportLinks(preview?.path ? { ...location, path: preview.path } : location, onNavigate, projectRoot, active)
  const [previewError, setPreviewError] = useState('')
  const [revision, setRevision] = useState(0)
  const [contentLoading, setContentLoading] = useState(false)
  const [htmlLoading, setHTMLLoading] = useState(false)
  const [pdfState, setPDFState] = useState({ loading: false, error: '' })
  const [pdfRefreshSignal, setPDFRefreshSignal] = useState<AbortSignal>()
  const [pdfManualRefresh, setPDFManualRefresh] = useState(0)
  const [localPaused, setLocalPaused] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [expired, setExpired] = useState(false)
  const contentController = useRef<AbortController | null>(null)
  const contentTask = useRef<Promise<void> | null>(null)
  const contentGeneration = useRef(0)
  const observedTrust = useRef<boolean | undefined>(undefined)
  const adopted = useRef<{
    text?: TextResponse; preview?: PreviewResponse
    textFailed: boolean; previewFailed: boolean; imageFailed: boolean
  }>({ textFailed: false, previewFailed: false, imageFailed: false })
  const content = useRef<HTMLDivElement>(null)
  const sourceWrap = useRef<SourceWrapCorrection | null>(null)
  useLayoutEffect(() => () => { sourceWrap.current?.cancel() }, [mode, text])
  const tableToggle = useRef<HTMLDivElement | null>(null)
  const tableToggleFocus = useRef<string | null>(null)
  const setTableToggle = useCallback((element: HTMLDivElement | null) => {
    // The CSV and Source toolbars occupy different positions; retain the mode button's focus.
    if (!element && tableToggle.current?.contains(document.activeElement)) tableToggleFocus.current = document.activeElement?.getAttribute('aria-label') ?? null
    tableToggle.current = element
    if (element && tableToggleFocus.current) {
      element.querySelector<HTMLButtonElement>(`button[aria-label="${tableToggleFocus.current}"]`)?.focus({ preventScroll: true })
      tableToggleFocus.current = null
    }
  }, [])
  const lastRefreshToken = useRef(refreshToken)
  useBrowseReaderFocusTarget(content, focusRequest)
  const needsText = kind === 'markdown' || kind === 'table' || mode === 'source'
  const needsPreview = mode === 'render' && ['markdown', 'html', 'image'].includes(kind)
  const hasToggle = kind === 'markdown' || kind === 'html' || kind === 'table'
  const renderedTable = kind === 'table' && mode === 'render' && Boolean(text)
  const hasCompiledPDF = kind === 'tex' && /\.tex$/i.test(location.path)
  const sourceLanguage = mode === 'source' ? fileLanguage(location.path) : ''
  const sourceLines = useMemo(() => {
    const value = text?.text
    if (!value) return 0
    let lines = 1
    for (let index = value.indexOf('\n'); index >= 0; index = value.indexOf('\n', index + 1)) lines++
    return lines
  }, [text?.text])
  const path = asFileLocation(location)
  const textURL = apiURL('text', path)
  const downloadURL = apiURL('file', path, true)
  const paused = autoRefreshPaused ?? localPaused
  const busy = contentLoading || htmlLoading || pdfState.loading

  function rememberScroll() {
    readerView.capture.current?.()
  }

  function toggleSourceWrap(control: HTMLElement) {
    sourceWrap.current ??= prepareSourceWrap(content.current, control, rememberScroll, () => { sourceWrap.current = null })
    const wrap = !readerView.current.current.wrap
    readerView.change({ wrap })
    sourceWrap.current?.schedule(wrap, readerView.current.current.source)
  }

  const loadContent = useCallback(async (externalSignal?: AbortSignal, parts = { text: needsText, preview: needsPreview }, reuseImage = false) => {
    sourceWrap.current?.cancel()
    contentGeneration.current++
    contentController.current?.abort()
    const controller = new AbortController()
    contentController.current = controller
    const imageGeneration = imageViewGeneration()
    if (parts.preview) imageAttempt.current = null
    // A new capability request rechecks server policy; later metadata can revoke it in flight.
    if (parts.preview) observedTrust.current = undefined
    const abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    if (externalSignal?.aborted) controller.abort()
    const failures: string[] = []
    setContentLoading(parts.text || parts.preview)
    const work: Promise<void>[] = []
    if (parts.text) {
      work.push(api<TextResponse>(textURL, { signal: controller.signal })
        .then(data => {
          if (controller.signal.aborted) return
          if (typeof data.version !== 'string' || !data.version) throw new Error('The text response did not include a file version.')
          rememberScroll()
          adopted.current.text = data
          adopted.current.textFailed = false
          setText(data)
          setTextError('')
        })
        .catch((failure: unknown) => {
          if (controller.signal.aborted || isAborted(failure)) return
          const message = errorMessage(failure)
          failures.push(message)
          adopted.current.textFailed = true
          setTextError(message)
        }))
    }
    if (parts.preview) {
      work.push(api<PreviewResponse>('/api/preview', {
        body: { host: location.host, root: location.root, path: location.path },
        signal: controller.signal,
      }).then(async data => {
        if (controller.signal.aborted) return
        if (typeof data.version !== 'string' || !data.version) throw new Error('The preview response did not include a file version.')
        if (kind === 'html') {
          // The server may know about a policy change before the workspace does.
          setLoadedPreview(current => (current?.data.scripts === true) !== (data.scripts === true) ? null : current)
          if (new URL(data.url).origin !== window.location.origin) await checkPreviewConnection(data.url, controller.signal)
        }
        if (controller.signal.aborted) return
        if (kind === 'html' && data.scripts && observedTrust.current === false) {
          throw new Error('Project trust changed while the preview was loading.')
        }
        if (kind === 'image') {
          const fresh = data
          if (reuseImage) data = reusableImagePreview(imageKey, fresh, imageGeneration) ?? fresh
          imageAttempt.current = { preview: data, fresh, generation: imageGeneration, signal: controller.signal }
        }
        rememberScroll()
        adopted.current.preview = data
        adopted.current.previewFailed = false
        adopted.current.imageFailed = false
        setLoadedPreview({ data, projectTrustedScripts })
        setPreviewError('')
        setImageFailed(false)
        setExpired(false)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted || isAborted(failure)) return
        const message = errorMessage(failure)
        failures.push(message)
        if (kind === 'image') forgetImagePreview(imageKey, imageGeneration)
        adopted.current.previewFailed = true
        setPreviewError(message)
      }))
    }
    await Promise.all(work)
    externalSignal?.removeEventListener('abort', abort)
    if (contentController.current === controller) setContentLoading(false)
    if (controller.signal.aborted) throw new DOMException('Refresh cancelled', 'AbortError')
    if (failures.length) throw new Error(failures.join(' '))
  }, [textURL, needsText, needsPreview, location.host, location.root, location.path, kind, projectTrustedScripts, imageKey])

  const readContent = useCallback((signal?: AbortSignal, parts?: { text: boolean; preview: boolean }, reuseImage = false) => {
    const task = loadContent(signal, parts, reuseImage)
    // Validation waits for settlement, then selectively retries any failed representation.
    contentTask.current = task.catch(() => {})
    return task
  }, [loadContent])

  useLayoutEffect(() => {
    contentGeneration.current++
    contentController.current?.abort()
    adopted.current.preview = undefined
    observedTrust.current = undefined
    setLoadedPreview(null)
    setPreviewError('')
  }, [projectTrustedScripts])

  useEffect(() => {
    // A cold mount authorizes first; retained readers keep their existing DOM.
    void readContent(undefined, undefined, true).catch(() => {})
    return () => { contentGeneration.current++; contentController.current?.abort() }
  }, [readContent])

  const refreshContents = useCallback(async (signal?: AbortSignal) => {
    if (kind === 'pdf') setPDFRefreshSignal(signal)
    setRevision(value => value + 1)
    await readContent(signal)
  }, [kind, readContent])

  const reconcileContent = useCallback(async (signal: AbortSignal, metadata: FileMetadata): Promise<FileMetadata | null> => {
    if (!needsText && !needsPreview) {
      await refreshContents(signal)
      return metadata
    }
    let generation = contentGeneration.current
    const checkCurrent = () => {
      signal.throwIfAborted()
      if (generation !== contentGeneration.current) throw new DOMException('Reader request superseded', 'AbortError')
    }
    const applyTrust = (current: FileMetadata) => {
      observedTrust.current = current.trustedScripts
      if (kind === 'html' && current.trustedScripts !== undefined && adopted.current.preview &&
        current.trustedScripts !== adopted.current.preview.scripts) {
        adopted.current.preview = undefined
        setLoadedPreview(null)
      }
    }
    const staleParts = (current: FileMetadata) => ({
      text: needsText && (adopted.current.textFailed || adopted.current.text?.version !== current.version),
      preview: needsPreview && (adopted.current.previewFailed || adopted.current.imageFailed ||
        adopted.current.preview?.version !== current.version ||
        (kind === 'html' && current.trustedScripts !== undefined && adopted.current.preview?.scripts !== current.trustedScripts) ||
        Date.parse(adopted.current.preview?.expiresAt ?? '') <= Date.now()),
    })
    checkCurrent()
    applyTrust(metadata)
    await waitForContent(contentTask.current, signal)
    checkCurrent()
    let target = metadata
    let stale = staleParts(target)
    if (stale.text || stale.preview) {
      // Tokens are opaque: the first stat may itself predate the completed content.
      target = await api<FileMetadata>(apiURL('file-info', location), { signal })
      checkCurrent()
      if (typeof target.version !== 'string' || !target.version) throw new Error('File metadata did not include a version.')
      applyTrust(target)
      stale = staleParts(target)
      if (stale.text || stale.preview) {
        setRevision(value => value + 1)
        const task = readContent(signal, stale)
        generation = contentGeneration.current
        await task
        checkCurrent()
      }
    }
    stale = staleParts(target)
    // A file that changed again stays pending until the next scheduled check.
    return stale.text || stale.preview ? null : target
  }, [needsText, needsPreview, kind, refreshContents, readContent, location])

  const refresh = useFileRefresh({
    location: path, intervalSeconds: preferences.autoRefreshSeconds, paused: paused || !active, busy,
    // Compare initial response versions without restarting ordinary reads.
    validateContent: needsText || needsPreview,
    retry: Boolean((needsText && textError) || (needsPreview && (previewError || imageFailed)) || pdfState.error),
    onChange: reconcileContent,
    onUnavailable: () => {
      if (kind === 'pdf') clearPDFCache()
      contentGeneration.current++
      contentController.current?.abort()
      adopted.current.text = undefined
      adopted.current.preview = undefined
      setText(null)
      setLoadedPreview(null)
      setTextError('This file is no longer available. Check your access or reopen the project.')
      setPreviewError('This file is no longer available. Check your access or reopen the project.')
    },
  })

  const manualRefresh = useCallback(() => {
    if (kind === 'pdf') setPDFManualRefresh(value => value + 1)
    void refreshContents().catch(() => {})
  }, [kind, refreshContents])

  function imageReady() {
    const attempt = imageAttempt.current
    if (!attempt || attempt.preview !== preview || attempt.signal.aborted) return
    retainImagePreview(imageKey, attempt.preview, attempt.generation, attempt.signal)
    adopted.current.imageFailed = false
    setImageFailed(false)
  }

  function imageError() {
    const attempt = imageAttempt.current
    if (!attempt || attempt.preview !== preview || attempt.signal.aborted) return
    forgetImagePreview(imageKey, attempt.generation)
    if (attempt.generation === imageViewGeneration() && attempt.preview.url !== attempt.fresh.url) {
      // The old capability may have been evicted. Use this read's fresh URL once, even paused.
      attempt.preview = attempt.fresh
      adopted.current.preview = attempt.fresh
      setLoadedPreview({ data: attempt.fresh, projectTrustedScripts })
      setExpired(false)
      return
    }
    adopted.current.imageFailed = true
    setImageFailed(true)
  }

  useEffect(() => {
    if (lastRefreshToken.current === refreshToken) return
    lastRefreshToken.current = refreshToken
    manualRefresh()
  }, [refreshToken, manualRefresh])

  useEffect(() => {
    if (!preview) return
    const timeout = Date.parse(preview.expiresAt) - Date.now()
    if (!Number.isFinite(timeout)) return
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, timeout))
    return () => window.clearTimeout(timer)
  }, [preview])

  const metadata = refresh.metadata ?? entry
  const stale = refresh.error || (needsText && textError) || (needsPreview && previewError) || pdfState.error || (needsPreview && imageFailed ? 'The image could not be refreshed.' : '')
  const togglePaused = onToggleAutoRefresh ?? (() => setLocalPaused(value => !value))
  const renderActions = (extra?: ReactNode, details?: ReactNode) => <div className="file-actions">
    {stale && <span className="refresh-stale" role="status" title={`Update pending: ${stale}`}><AlertCircle size={15} /><span className="sr-only">Update pending: {stale}</span></span>}
    <ReaderActions active={active} paused={paused} busy={busy} checking={refresh.checking} interval={preferences.autoRefreshSeconds} onPause={togglePaused} onRefresh={manualRefresh} copied={copied} onCopy={onCopyLink} downloadURL={downloadURL} name={fileName(location.path)} extra={<>
      {onCopyPath && <button onClick={onCopyPath} title="Copy this file’s path"><Copy size={16} />Copy file path</button>}
      <button onClick={event => {
        // Navigation removes the menu; keep its close handler from refocusing the departing trigger.
        event.stopPropagation()
        onNavigate({ ...location, path: parentPath(location.path), kind: 'directory' })
        document.getElementById('browse-tab')?.focus({ preventScroll: true })
      }} title={parentPath(location.path) || 'Project root'}><FolderOpen size={16} />Open containing folder</button>
      {extra}</>} details={<div className="reader-file-details" role="group" aria-label="File information">
      {stale && <span className="reader-refresh-error">Update pending: {stale}</span>}
      <span>{readerTypeLabels[readerType(location.path)]}{(metadata || text) && <> · {formatBytes(metadata?.size ?? text?.size ?? 0)}</>}</span>
      {mode === 'source' && text && <>
        <span>{sourceLanguage} · {sourceLines.toLocaleString()} {sourceLines === 1 ? 'line' : 'lines'}</span>
        {text.text.length > sourceHighlightInputLimit && <span>Highlighting paused for this large file</span>}
      </>}
      {kind === 'tex' && <span>Source preview only.{hasCompiledPDF && ' PDF opens a matching file in this folder, if available.'}</span>}
      {details}
      {metadata?.modified && <time dateTime={metadata.modified}>Modified {modifiedTime(metadata.modified)}</time>}
    </div>} />
    <button className="icon-button expand-button" aria-label="Full screen" title="Full screen" onClick={onExpand}><Maximize2 size={17} /></button>
  </div>
  const viewToggle = hasToggle && <div className="view-toggle" aria-label="Preview mode" ref={kind === 'table' ? setTableToggle : undefined}><button className={mode === 'render' ? 'active' : ''} onClick={() => readerView.change({ mode: 'render' })} aria-pressed={mode === 'render'} aria-label="Rendered" title="Rendered"><Eye size={15} /><span>Rendered</span></button><button className={mode === 'source' ? 'active' : ''} onClick={() => readerView.change({ mode: 'source' })} aria-pressed={mode === 'source'} aria-label="Source" title="Source"><Code2 size={15} /><span>Source</span></button></div>
  const truncatedNotice = needsText && text?.truncated && <div className="notice warning-notice" role="status">Showing a truncated preview of this {formatBytes(text.size)} file. <a href={downloadURL} download={fileName(location.path)}>Download the complete file.</a></div>
  const renderTableToolbar = (controls?: ReactNode, details?: ReactNode) => <><div className="preview-toolbar table-reader-toolbar" id={active ? 'reader-toolbar' : undefined} role="toolbar" aria-label="Reader toolbar">
    <div className="reader-view-actions">{viewToggle}{controls}</div>
    {renderActions(undefined, details)}
  </div>{truncatedNotice}</>

  return (
    <section className={`file-preview preview-${kind}`} aria-label={`${fileName(location.path)} preview`}>
      <h1 className="sr-only">{fileName(location.path)}</h1>
      {kind !== 'pdf' && !renderedTable && <div className="preview-toolbar" id={active ? 'reader-toolbar' : undefined} role="toolbar" aria-label="Reader toolbar">
        <div className={`reader-view-actions${mode === 'source' && text ? ' has-source-controls' : ''}`}>
          {kind === 'image' && <ImageViewActions image={imageView} />}
          {viewToggle}
          {active && kind === 'markdown' && mode === 'render' && text && preferences.readerToolbarVisible && <MarkdownOutline content={content} />}
          {hasCompiledPDF && <button className="button quiet compiled-pdf" aria-label="Open compiled PDF" title="Open matching PDF" onClick={() => onNavigate({ ...location, path: location.path.replace(/\.tex$/i, '.pdf'), kind: 'file' })}><FileText size={16} /><span>PDF</span></button>}
          {mode === 'source' && text && <div className="reader-source-controls">
            <button className={`icon-button source-wrap-toggle${readerView.view.wrap ? ' is-active' : ''}`}
              onClick={event => toggleSourceWrap(event.currentTarget)}
              aria-label="Wrap long lines" aria-pressed={readerView.view.wrap} title="Wrap long lines"><WrapText size={16} /><span>Wrap</span></button>
            <div className="source-metadata"><span className="source-language">{sourceLanguage}</span><span>{sourceLines.toLocaleString()} {sourceLines === 1 ? 'line' : 'lines'}</span></div>
          </div>}
        </div>
        {renderActions(kind === 'image' ? <ImageViewActions image={imageView} menu /> : undefined)}
      </div>}
      {!renderedTable && truncatedNotice}
      {expired && needsPreview && <div className="notice warning-notice" role="status">Preview access has expired. <button className="text-button" onClick={manualRefresh}>Reload preview</button> to refresh images and report assets.</div>}
      <div className={`preview-content content-${mode}`} ref={content} tabIndex={-1}>
        <ViewerBoundary resetKey={`${mode}/${revision}`} toolbar={renderedTable ? renderTableToolbar() : undefined}>
          <Suspense fallback={<>{renderedTable && renderTableToolbar()}<Loading message="Preparing viewer…" /></>}>
            <ReaderPosition reader={readerView} content={content} active={Boolean(text) && (mode === 'source' || kind === 'markdown' || kind === 'table')} text={text?.text} textVersion={text?.version} previewURL={preview?.url}>
            {needsText && textError && !text ? <ErrorState title="Couldn’t open this file" message={textError} retry={manualRefresh}><a className="button secondary" href={downloadURL} download={fileName(location.path)}><ArrowDownToLine size={15} /> Download file</a></ErrorState>
              : needsText && !text ? <Loading message="Reading file…" />
                : mode === 'source' && text ? <SourceViewer text={text.text} path={location.path} lines={sourceLines} wrap={readerView.view.wrap} />
                  : kind === 'table' && text ? <CSVViewer text={text.text} path={location.path} truncated={text.truncated} view={readerView.view.table} onChange={table => readerView.change({ table })} renderToolbar={renderTableToolbar} />
                  : kind === 'markdown' && text ? <MarkdownViewer text={text.text} location={preview?.path ? { ...location, path: preview.path } : location} previewURL={preview?.url} onNavigate={onNavigate} onLink={links.open} projectRoot={projectRoot} />
                    : kind === 'pdf' ? <PDFViewer location={path} refreshToken={revision} forceRefreshToken={pdfManualRefresh} refreshSignal={pdfRefreshSignal} onRefreshState={setPDFState} renderActions={renderActions} />
                      : (kind === 'html' || kind === 'image') && previewError && !preview ? <ErrorState title="Couldn’t prepare a preview" message={previewError} retry={manualRefresh} />
                        : (kind === 'html' || kind === 'image') && !preview ? <Loading message="Preparing preview…" />
                          : kind === 'html' && preview ? <HTMLReport key={preview.scripts === true ? 'trusted' : 'sandboxed'} url={preview.url} resolvedPath={preview.path ?? location.path} bridge={preview.bridge} active={active} onLink={links.open} onLoading={setHTMLLoading} title={`${fileName(location.path)} — isolated HTML report`} scriptsEnabled={preview.scripts === true} onError={() => { adopted.current.previewFailed = true; setPreviewError('The report could not load. Check the preview connection and try again.') }} retry={manualRefresh}
                            scriptPrompt={preview.scriptCheck && readerView.view.scriptPermissionDismissed !== preview.version
                              ? <HTMLScriptPermission key={preview.scriptCheck} token={preview.scriptCheck} location={path}
                                onDismiss={() => readerView.change({ scriptPermissionDismissed: preview.version })}
                                onAllowed={onProjectScriptsAllowed ?? manualRefresh} onReload={manualRefresh} /> : undefined} />
                            : kind === 'image' && preview ? <ImageViewer url={preview.url} name={fileName(location.path)} image={imageView} onError={imageError} onReady={imageReady} retry={manualRefresh} />
                              : <div className="unsupported-viewer"><div className="state-symbol"><FileQuestion size={28} /></div><h2>No browser preview</h2><p>Download the original file to open it in another app.</p><a href={downloadURL} className="button primary" download={fileName(location.path)}><ArrowDownToLine size={16} /> Download file</a></div>}
            </ReaderPosition>
          </Suspense>
        </ViewerBoundary>
      </div>
      {links.dialog}
    </section>
  )
}
