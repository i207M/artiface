import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { captureSourceFontPoint, restoreSourceFontPoint } from './sourceWrapAnchor'
import type { SourceFontPoint } from './sourceWrapAnchor'
import { captureMarkdownFontPoint, restoreMarkdownFontPoint } from './markdownFontAnchor'
import type { MarkdownFontPoint } from './markdownFontAnchor'

type ReaderMode = 'render' | 'source'
interface Position { top: number; left: number }
interface SourcePosition extends Position, Partial<SourceFontPoint> { version?: string; wrapped?: boolean }
interface MarkdownPosition extends Position, Partial<MarkdownFontPoint> { version?: string }
export interface TableSort { column: number; direction: 'asc' | 'desc' }
export interface TableView { header: boolean; page: number; sort: TableSort | null }
export interface ReaderView {
  mode: ReaderMode
  wrap: boolean
  render: MarkdownPosition
  source: SourcePosition
  table: TableView
  scriptPermissionDismissed?: string
}

// Device-local view metadata only: no file contents or preview capabilities.
const views = new Map<string, ReaderView>()
let openFiles = new Set<string>()
let generation = 0
export const readerViewGeneration = () => generation
const copyView = (view: ReaderView): ReaderView => ({ ...view, render: { ...view.render }, source: { ...view.source },
  table: { ...view.table, sort: view.table.sort ? { ...view.table.sort } : null } })

export function readReaderView(key: string) {
  const view = views.get(key)
  if (!view) return
  views.delete(key)
  views.set(key, view)
  return copyView(view)
}

export function retainReaderView(key: string, view: ReaderView, ownerGeneration: number) {
  if (ownerGeneration !== generation || !openFiles.has(key)) return
  views.delete(key)
  views.set(key, copyView(view))
  if (views.size > 64) views.delete(views.keys().next().value!)
}

export function retainOpenReaderViews(keys: string[]) {
  openFiles = new Set(keys)
  for (const key of views.keys()) if (!openFiles.has(key)) views.delete(key)
}

export function clearReaderViews() {
  generation++
  views.clear()
}

window.addEventListener('artiface:unauthorized', clearReaderViews)
window.addEventListener('artiface:configuration-changed', clearReaderViews)
window.addEventListener('pagehide', clearReaderViews)

export function useReaderView(key: string | undefined, defaultMode: ReaderMode) {
  const [view, setView] = useState<ReaderView>(() => (key && readReaderView(key)) || {
    mode: defaultMode, wrap: false, render: { top: 0, left: 0 }, source: { top: 0, left: 0 },
    table: { header: true, page: 0, sort: null },
  })
  const current = useRef(view)
  const ownerGeneration = useRef(generation)
  const capture = useRef<(() => void) | null>(null)
  useLayoutEffect(() => () => {
    capture.current?.()
    if (key) retainReaderView(key, current.current, ownerGeneration.current)
  }, [key])

  function change(patch: Partial<Pick<ReaderView, 'mode' | 'wrap' | 'table' | 'scriptPermissionDismissed'>>) {
    capture.current?.()
    current.current = { ...current.current, ...patch }
    setView(current.current)
  }
  return { view, current, capture, change, key, ownerGeneration }
}

// Mount inside Suspense so restoration waits for the actual lazy viewer.
export function ReaderPosition({ reader, content, active, text, textVersion, previewURL, children }: {
  reader: ReturnType<typeof useReaderView>
  content: RefObject<HTMLDivElement | null>
  active: boolean
  text?: string
  textVersion?: string
  previewURL?: string
  children: ReactNode
}) {
  const { current, capture, view: { mode, wrap } } = reader
  const sourceVersion = mode === 'source' ? textVersion : undefined
  const committedVersion = useRef(textVersion)
  // Version-only updates must not restart CSV or pending-image scroll restoration.
  useLayoutEffect(() => { committedVersion.current = textVersion }, [textVersion])
  const navigation = useRef({ mode, text, cancelled: false })
  useLayoutEffect(() => {
    const root = content.current
    if (!active || !root) return
    const element = mode === 'source' ? root.querySelector<HTMLElement>('.source-scroll')
      : root.querySelector<HTMLElement>('.csv-scroll') ?? root
    if (!element) return
    if (navigation.current.mode !== mode || navigation.current.text !== text) {
      navigation.current = { mode, text, cancelled: false }
    }
    const article = mode === 'render' ? root.querySelector('.markdown-viewer') : null
    const position = current.current[mode]
    const ownsReader = () => reader.ownerGeneration.current === generation && Boolean(reader.key && openFiles.has(reader.key))
    let pending = false
    let frame = 0
    let applied = { top: element.scrollTop, left: element.scrollLeft }
    const assetsPending = () => Boolean(article && (
      (!previewURL && article.querySelector('.missing-image')) ||
      [...article.querySelectorAll('img')].some(image => !image.complete)
    ))
    const positionFits = () => position.top <= Math.max(0, element.scrollHeight - element.clientHeight) + 1 &&
      position.left <= Math.max(0, element.scrollWidth - element.clientWidth) + 1
    const remember = () => {
      // Suspense can hide a mounted reader; hidden layout must not overwrite its position.
      if (pending || current.current.mode !== mode || !element.isConnected || !element.getClientRects().length) return
      current.current = { ...current.current, [mode]: { top: element.scrollTop, left: element.scrollLeft } }
    }
    const restore = () => {
      frame = 0
      // A newer offset may precede its queued scroll event.
      if (pending) {
        scrolled()
        if (!pending) return
      }
      if (navigation.current.cancelled) {
        pending = false
        if (positionFits() || !assetsPending()) navigation.current.cancelled = false
        remember()
        return
      }
      // The capability can arrive after text, before there are even img elements.
      element.scrollLeft = position.left
      element.scrollTop = position.top
      const source = current.current.source
      if (mode === 'source' && ownsReader() && sourceVersion && source.version === sourceVersion && source.wrapped === wrap) {
        // Complete before input can arrive; late color decoration needs no replay.
        restoreSourceFontPoint(root, source, wrap)
      }
      const markdown = current.current.render
      if (article && ownsReader() && committedVersion.current && markdown.version === committedVersion.current) {
        // Image-free articles settle synchronously; remember consumes the point below.
        restoreMarkdownFontPoint(root, markdown)
      }
      applied = { top: element.scrollTop, left: element.scrollLeft }
      pending = !positionFits() && assetsPending()
      remember() // A reachable offset need not wait for unrelated lazy images.
    }
    const cancel = () => {
      if (pending || navigation.current.cancelled) navigation.current.cancelled = !positionFits() && assetsPending()
      pending = false
      cancelAnimationFrame(frame)
      frame = 0
      remember()
    }
    const scrolled = () => {
      // Ignore our own scroll events and layout clamps; honor other scroll navigation.
      if (pending) {
        const top = Math.min(applied.top, Math.max(0, element.scrollHeight - element.clientHeight))
        const left = Math.min(applied.left, Math.max(0, element.scrollWidth - element.clientWidth))
        if (Math.abs(element.scrollTop - top) > 1 || Math.abs(element.scrollLeft - left) > 1) cancel()
      }
      remember()
    }
    const assetSettled = (event: Event) => {
      if ((pending || navigation.current.cancelled) && !frame && event.target instanceof HTMLImageElement && article?.contains(event.target)) {
        // React's error placeholder must replace the failed image before measuring.
        frame = requestAnimationFrame(restore)
      }
    }
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Enter', 'Tab'].includes(event.key)) cancel()
    }
    const anchor = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a[href]')) cancel()
    }
    const capturePosition = () => {
      scrolled()
      if (article && committedVersion.current && ownsReader()) {
        const point = captureMarkdownFontPoint(root)
        if (point) current.current = { ...current.current,
          render: { ...current.current.render, ...point, version: committedVersion.current } }
      }
      if (mode !== 'source' || !sourceVersion || !ownsReader()) return
      const point = captureSourceFontPoint(root)
      if (point) current.current = { ...current.current,
        source: { ...current.current.source, ...point, version: sourceVersion, wrapped: wrap } }
    }
    restore()
    capture.current = capturePosition
    element.addEventListener('scroll', scrolled, { passive: true })
    element.addEventListener('wheel', cancel, { passive: true })
    element.addEventListener('touchstart', cancel, { passive: true })
    element.addEventListener('pointerdown', cancel, { passive: true })
    element.addEventListener('keydown', key)
    element.addEventListener('click', anchor, true)
    root.addEventListener('load', assetSettled, true)
    root.addEventListener('error', assetSettled, true)
    return () => {
      // The owner/pre-update capture runs before DOM replacement; cleanup can see a temporary clamp.
      cancelAnimationFrame(frame)
      element.removeEventListener('scroll', scrolled)
      element.removeEventListener('wheel', cancel)
      element.removeEventListener('touchstart', cancel)
      element.removeEventListener('pointerdown', cancel)
      element.removeEventListener('keydown', key)
      element.removeEventListener('click', anchor, true)
      root.removeEventListener('load', assetSettled, true)
      root.removeEventListener('error', assetSettled, true)
      if (capture.current === capturePosition) capture.current = null
    }
  }, [active, mode, wrap, text, sourceVersion, previewURL, content, current, capture, reader.key, reader.ownerGeneration])
  return children
}
