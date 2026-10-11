import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'

export const PDF_SEARCH_LIMITS = {
  pages: 5_000,
  milliseconds: 15_000,
  matches: 1_000,
  pageCharacters: 500_000,
  cacheCharacters: 2_000_000,
} as const

type SearchDocument = Pick<PDFDocumentProxy, 'getPage' | 'numPages'>
type PageText = { text: string; truncated: boolean }
type TextCache = { pages: Map<number, PageText>; characters: number }
export interface PDFSearchResult {
  matches: number[]
  scannedPages: number
  totalPages: number
  truncatedPages: number
  failedPages: number
  limit: 'pages' | 'time' | 'matches' | null
}

let documents = new WeakMap<SearchDocument, TextCache>()
if (typeof window !== 'undefined') {
  window.addEventListener('artiface:pdf-cache-cleared', () => { documents = new WeakMap() })
}

export function normalizePDFQuery(text: string) {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function matchingPDFPage(matches: number[], current: number, direction: 1 | -1) {
  if (direction === 1) return matches.find(page => page > current) ?? matches[0]
  for (let index = matches.length - 1; index >= 0; index--) if (matches[index] < current) return matches[index]
  return matches[matches.length - 1]
}

// getPage cannot be cancelled, so detach promptly and ignore its late result.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('PDF search cancelled', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted) abort()
  })
}

async function extractPage(document: SearchDocument, number: number, signal: AbortSignal): Promise<PageText> {
  const page = await abortable(document.getPage(number), signal)
  if (signal.aborted) throw new DOMException('PDF search cancelled', 'AbortError')
  const reader = (page.streamTextContent() as ReadableStream<TextContent>).getReader()
  const cancel = () => { void reader.cancel(new Error('PDF search stopped')).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const fragments: string[] = []
  let characters = 0
  let ended = false
  let lastYield = performance.now()
  try {
    while (characters < PDF_SEARCH_LIMITS.pageCharacters) {
      const chunk = await abortable(reader.read(), signal)
      if (signal.aborted) throw new DOMException('PDF search cancelled', 'AbortError')
      if (chunk.done) { ended = true; break }
      for (const item of chunk.value.items) {
        if (!('str' in item)) continue
        // PDF.js supplies word spaces itself; font changes can split a word.
        const remaining = PDF_SEARCH_LIMITS.pageCharacters - characters
        const text = item.str.slice(0, remaining)
        if (text) fragments.push(text)
        characters += text.length
        if (item.hasEOL && characters < PDF_SEARCH_LIMITS.pageCharacters) {
          fragments.push('\n')
          characters++
        }
        if (characters >= PDF_SEARCH_LIMITS.pageCharacters) break
      }
      if (performance.now() - lastYield >= 8) {
        await abortable(new Promise<void>(resolve => setTimeout(resolve, 0)), signal)
        lastYield = performance.now()
      }
    }
    const normalized = normalizePDFQuery(fragments.join(''))
    return {
      text: normalized.slice(0, PDF_SEARCH_LIMITS.pageCharacters),
      truncated: !ended || normalized.length > PDF_SEARCH_LIMITS.pageCharacters,
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!ended) cancel()
    reader.releaseLock()
    // The viewer shares this page: never call cleanup or destroy here.
  }
}

function remember(cache: TextCache, number: number, value: PageText) {
  cache.pages.set(number, value)
  cache.characters += value.text.length
  for (const [oldest, entry] of cache.pages) {
    if (cache.characters <= PDF_SEARCH_LIMITS.cacheCharacters) break
    cache.pages.delete(oldest)
    cache.characters -= entry.text.length
  }
}

export async function searchPDFPages(document: SearchDocument, query: string, signal: AbortSignal,
  onProgress?: (result: PDFSearchResult) => void): Promise<PDFSearchResult | null> {
  const needle = normalizePDFQuery(query)
  if (!needle || signal.aborted) return null
  let cache = documents.get(document)
  if (!cache) {
    cache = { pages: new Map(), characters: 0 }
    documents.set(document, cache)
  }
  const result: PDFSearchResult = {
    matches: [], scannedPages: 0, totalPages: document.numPages,
    truncatedPages: 0, failedPages: 0, limit: null,
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const started = performance.now()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, PDF_SEARCH_LIMITS.milliseconds)
  let lastProgress = started
  let lastYield = started
  const snapshot = () => ({ ...result, matches: [...result.matches] })
  try {
    const end = Math.min(document.numPages, PDF_SEARCH_LIMITS.pages)
    for (let number = 1; number <= end; number++) {
      if (controller.signal.aborted) break
      if (performance.now() - started >= PDF_SEARCH_LIMITS.milliseconds) { timedOut = true; break }
      try {
        let value = cache.pages.get(number)
        if (value) {
          cache.pages.delete(number)
          cache.pages.set(number, value)
        } else {
          value = await extractPage(document, number, controller.signal)
          if (controller.signal.aborted) break
          remember(cache, number, value)
        }
        if (value.truncated) result.truncatedPages++
        if (value.text.includes(needle)) result.matches.push(number)
      } catch {
        if (controller.signal.aborted) break
        result.failedPages++
      }
      result.scannedPages++
      if (result.matches.length >= PDF_SEARCH_LIMITS.matches && number < document.numPages) {
        result.limit = 'matches'
        break
      }
      const now = performance.now()
      if (now - lastProgress >= 150) {
        if (!signal.aborted) onProgress?.(snapshot())
        lastProgress = now
      }
      // Cached pages and fast streams must also leave time for typing/painting.
      if (now - lastYield >= 8) {
        await abortable(new Promise<void>(resolve => setTimeout(resolve, 0)), controller.signal)
        lastYield = performance.now()
      }
    }
  } catch {
    // Only the interruptible yield can reject outside an individual page.
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
  if (signal.aborted) return null
  if (timedOut) result.limit = 'time'
  else if (!result.limit && result.scannedPages < document.numPages) result.limit = 'pages'
  return snapshot()
}
