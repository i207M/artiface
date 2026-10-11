import { APIError, apiURL, sessionExpired } from './api'
import type { FileLocation } from './types'
import type { PDFView } from './pdfCache'

export interface CompressedPDF {
  compressed: true
  id: string
  numPages: number
  width: number
  height: number
  version: string
  size: number
  generation: number
  location: FileLocation
}

interface PageImage { blob: Blob; width: number; height: number }
interface CachedImage extends PageImage { file: string }
interface PageConsumer { resolve: (image: PageImage) => void; reject: (error: unknown) => void }
interface PageRequest {
  file: string
  generation: number
  documentGeneration: number
  controller: AbortController
  consumers: Set<PageConsumer>
}
const images = new Map<string, CachedImage>()
const requests = new Map<string, PageRequest>()
const views = new Map<string, { id: string; view: PDFView }>()
let bytes = 0
let generation = 0
let openFiles: Set<string> | null = null
export const compressedCacheGeneration = () => generation

function removeImage(key: string) {
  const entry = images.get(key)
  if (entry) { bytes -= entry.blob.size; images.delete(key) }
}

export function compressedView(file: string, id: string) {
  const cached = views.get(file)
  return cached?.id === id ? cached.view : undefined
}

export function retainCompressedView(file: string, document: CompressedPDF, view: PDFView) {
  if (document.generation !== generation || (openFiles && !openFiles.has(file))) return
  views.delete(file)
  views.set(file, { id: document.id, view: { ...view } })
  while (views.size > 16) views.delete(views.keys().next().value!)
}

function finishRequest(key: string, request: PageRequest, settle: (consumer: PageConsumer) => void) {
  if (requests.get(key) === request) requests.delete(key)
  for (const consumer of request.consumers) settle(consumer)
}

function cancelRequest(key: string, request: PageRequest) {
  request.controller.abort()
  finishRequest(key, request, consumer => consumer.reject(request.controller.signal.reason))
}

async function loadImage(url: string, page: number, request: PageRequest): Promise<PageImage> {
  request.controller.signal.throwIfAborted()
  const response = await fetch(url, { signal: request.controller.signal, credentials: 'same-origin', cache: 'no-store' })
  request.controller.signal.throwIfAborted()
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    request.controller.signal.throwIfAborted()
    throw new APIError(data?.error || `Could not load page ${page}`, response.status)
  }
  const width = Number(response.headers.get('X-PDF-Width'))
  const height = Number(response.headers.get('X-PDF-Height'))
  if (!response.headers.get('Content-Type')?.startsWith('image/jpeg') || !Number.isFinite(width) || !Number.isFinite(height) ||
    width < 1 || height < 1 || width > 100000 || height > 100000) throw new Error('Invalid compressed PDF page')
  const blob = await response.blob()
  if (blob.size > 8 * 1024 * 1024) throw new Error('Compressed PDF page is too large')
  request.controller.signal.throwIfAborted()
  const entry = { blob, width, height, file: request.file }
  if (request.generation === generation && request.documentGeneration === generation && (!openFiles || openFiles.has(request.file))) {
    removeImage(url)
    images.set(url, entry)
    bytes += blob.size
    while (images.size > 24 || bytes > 32 * 1024 * 1024) removeImage(images.keys().next().value!)
  }
  return entry
}

export async function compressedPage(document: CompressedPDF, page: number, size: number, signal: AbortSignal): Promise<PageImage> {
  const file = apiURL('file', document.location)
  const url = apiURL('pdf/page', document.location) + `&document=${document.id}&page=${page}&size=${size}`
  signal.throwIfAborted()
  const cached = images.get(url)
  if (cached && document.generation === generation && (!openFiles || openFiles.has(file))) {
    images.delete(url)
    images.set(url, cached)
    return cached
  }
  const key = `${generation}:${document.generation}:${url}`
  const pending = requests.get(key)
  const request: PageRequest = pending ?? {
    file, generation, documentGeneration: document.generation, controller: new AbortController(), consumers: new Set(),
  }
  if (!pending) requests.set(key, request)
  const result = new Promise<PageImage>((resolve, reject) => {
    const detach = () => { signal.removeEventListener('abort', cancel); request.consumers.delete(consumer) }
    const consumer: PageConsumer = {
      resolve: image => { detach(); resolve(image) },
      reject: error => { detach(); reject(error) },
    }
    const cancel = () => {
      consumer.reject(signal.reason)
      if (!request.consumers.size) {
        // A visible reader can take over a lookahead during this turn's microtasks.
        window.setTimeout(() => {
          if (!request.consumers.size && requests.get(key) === request) cancelRequest(key, request)
        }, 0)
      }
    }
    request.consumers.add(consumer)
    signal.addEventListener('abort', cancel, { once: true })
  })
  if (!pending) void loadImage(url, page, request).then(
    image => finishRequest(key, request, consumer => consumer.resolve(image)),
    error => {
      const expired = error instanceof APIError && error.status === 401 && request.generation === generation &&
        !request.controller.signal.aborted && request.consumers.size > 0
      finishRequest(key, request, consumer => consumer.reject(error))
      if (expired) sessionExpired()
    },
  )
  return result
}

window.addEventListener('artiface:pdf-cache-cleared', () => {
  generation++
  // A BFCache-restored reader can still own a live request from this generation.
  // Its result may finish uncached; new callers use the new generation's key.
  images.clear()
  views.clear()
  bytes = 0
})
window.addEventListener('artiface:pdf-open-files', event => {
  const previous = openFiles
  openFiles = new Set((event as CustomEvent<string[]>).detail)
  for (const [key, request] of requests) if (previous?.has(request.file) && !openFiles.has(request.file)) cancelRequest(key, request)
  for (const [key, entry] of images) if (!openFiles.has(entry.file)) removeImage(key)
  for (const file of views.keys()) if (!openFiles.has(file)) views.delete(file)
})
