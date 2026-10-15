import { ChevronLeft, ChevronRight } from 'lucide-react'
import '../pdfCompatibility'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useCallback, useEffect, useState } from 'react'
import workerURL from '../pdf.worker?worker&url'
import { errorMessage } from '../api'
import { ErrorState, Loading } from './Common'
import PDFPages from './PDFPages'

GlobalWorkerOptions.workerSrc = workerURL
const initialPosition = { page: 1, top: 0, left: 0 }
const ignorePosition = () => {}

export default function GitPDFPreview({ bytes }: { bytes: Uint8Array<ArrayBuffer> }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [input, setInput] = useState('1')
  const [request, setRequest] = useState(initialPosition)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  useEffect(() => {
    let cancelled = false
    const options = {
      // PDF.js transfers ownership to its worker; keep our source for remounts.
      data: bytes.slice(), isEvalSupported: false, useWasm: false, enableXfa: false,
      maxImageSize: 32 * 1024 * 1024,
      cMapUrl: new URL('/pdfjs/cmaps/', window.location.origin).href,
      standardFontDataUrl: new URL('/pdfjs/standard_fonts/', window.location.origin).href,
      wasmUrl: new URL('/pdfjs/wasm/', window.location.origin).href,
      iccUrl: new URL('/pdfjs/iccs/', window.location.origin).href,
    }
    const task = getDocument(options)
    void task.promise.then(result => { if (!cancelled) setDocument(result) }).catch(failure => {
      if (!cancelled) setError(failure?.name === 'PasswordException' ? 'This PDF is password protected. Download this version to open it in your PDF reader.' : errorMessage(failure))
    })
    return () => { cancelled = true; void task.destroy().catch(() => {}) }
  }, [bytes])
  const onPosition = useCallback((position: typeof initialPosition) => {
    setPage(position.page)
    setInput(String(position.page))
  }, [])
  const onState = useCallback((state: { loading: boolean; error?: unknown }) => {
    if (state.error) setError(errorMessage(state.error))
  }, [])
  function go(number: number) {
    const next = Math.max(1, Math.min(document?.numPages ?? 1, Math.trunc(number) || page))
    setPage(next)
    setInput(String(next))
    setRequest({ page: next, top: 0, left: 0 })
  }
  if (error) return <ErrorState title="Couldn’t display this PDF" message={error} />
  if (!document) return <Loading message="Opening PDF…" />
  return <div className="pdf-viewer git-pdf-preview">
    <div className="git-media-controls">
      <button className="icon-button" aria-label="Previous page" title="Previous page" disabled={page <= 1} onClick={() => go(page - 1)}><ChevronLeft size={17} /></button>
      <label className="git-pdf-page"><span className="sr-only">PDF page</span><input type="number" min={1} max={document.numPages} value={input}
        onChange={event => setInput(event.target.value)} onBlur={() => go(Number(input))}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); go(Number(input)) } }} /><span>of {document.numPages}</span></label>
      <button className="icon-button" aria-label="Next page" title="Next page" disabled={page >= document.numPages} onClick={() => go(page + 1)}><ChevronRight size={17} /></button>
      <select aria-label="PDF zoom" value={zoom} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}>
        <option value="fit">Fit</option>{[0.5, 0.75, 1, 1.5, 2, 3].map(value => <option key={value} value={value}>{value * 100}%</option>)}
      </select>
    </div>
    <PDFPages document={document} navigation="vertical" zoom={zoom} rotation={0} initialPosition={initialPosition}
      request={request} onPosition={onPosition} onLeave={ignorePosition} onState={onState} />
  </div>
}
