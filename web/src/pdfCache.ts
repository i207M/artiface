import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { CompressedPDF } from './compressedPDF'

export interface PDFView {
  page: number
  zoom: 'fit' | number
  rotation: number
  // Relative to the current page so estimated heights above it can change.
  top: number
  left: number
}
export interface PDFDocument {
  document: PDFDocumentProxy | CompressedPDF
  version: string
  size: number
  generation: number
}
interface CachedPDF extends PDFDocument { view: PDFView }

// Only inactive readers live here; the visible reader owns its document.
// File sizes bound retained source data, not PDF.js's additional rendering memory.
// Compression retains only metadata here; its JPEG cache has a separate byte limit.
const maxDocuments = 4
const maxBytes = 64 * 1024 * 1024
const cache = new Map<string, CachedPDF>()
let openFiles = new Set<string>()
let generation = 0

const destroy = (entry: PDFDocument) => {
  if (!('compressed' in entry.document)) void entry.document.loadingTask.destroy().catch(() => {})
}
const retainedBytes = (entry: PDFDocument) => 'compressed' in entry.document ? 0 : entry.size
export const pdfCacheGeneration = () => generation

export function discardCachedPDF(key: string) {
  const entry = cache.get(key)
  if (entry) { cache.delete(key); destroy(entry) }
}

// Transfer ownership immediately; the reader revalidates access and version.
export function takeCachedPDF(key: string): CachedPDF | undefined {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  if (entry.generation !== generation) { destroy(entry); return }
  return entry
}

export function retainPDF(entry: PDFDocument, key: string, view: PDFView) {
  if (entry.generation !== generation || !openFiles.has(key) || !Number.isFinite(entry.size) || retainedBytes(entry) > maxBytes || entry.size < 0) {
    destroy(entry)
    return
  }
  discardCachedPDF(key)
  cache.set(key, { ...entry, view: { ...view } })
  let bytes = [...cache.values()].reduce((total, item) => total + retainedBytes(item), 0)
  for (const [oldest, item] of cache) {
    if (cache.size <= maxDocuments && bytes <= maxBytes) break
    bytes -= retainedBytes(item)
    discardCachedPDF(oldest)
  }
}

export function retainOpenPDFs(keys: string[]) {
  openFiles = new Set(keys)
  for (const key of cache.keys()) if (!openFiles.has(key)) discardCachedPDF(key)
  window.dispatchEvent(new CustomEvent('artiface:pdf-open-files', { detail: keys }))
}

export function clearPDFCache() {
  generation++
  for (const key of cache.keys()) discardCachedPDF(key)
  window.dispatchEvent(new Event('artiface:pdf-cache-cleared'))
}

window.addEventListener('artiface:unauthorized', clearPDFCache)
window.addEventListener('artiface:configuration-changed', clearPDFCache)
window.addEventListener('pagehide', clearPDFCache)
