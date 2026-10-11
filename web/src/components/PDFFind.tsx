import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { matchingPDFPage, normalizePDFQuery, searchPDFPages } from '../pdfSearch'
import type { PDFSearchResult } from '../pdfSearch'
import './pdfFind.css'

export default function PDFFind({ document, page, onPage, onClose }: {
  document: PDFDocumentProxy; page: number; onPage: (page: number) => void; onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef<AbortController | null>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<{ document: PDFDocumentProxy; query: string; result: PDFSearchResult; running: boolean } | null>(null)
  const normalized = normalizePDFQuery(query)
  const current = search?.query === normalized && search.document === document ? search : null
  const matches = current?.result.matches ?? []

  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    const controller = new AbortController()
    pending.current = controller
    const timer = window.setTimeout(() => {
      if (!normalized) return
      const update = (result: PDFSearchResult, running: boolean) => {
        if (!controller.signal.aborted) setSearch({ document, query: normalized, result, running })
      }
      void searchPDFPages(document, normalized, controller.signal, result => update(result, true))
        .then(result => { if (result) update(result, false) })
    }, 220)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [document, normalized])

  function navigate(direction: 1 | -1) {
    const next = matchingPDFPage(matches, page, direction)
    if (next !== undefined) onPage(next)
  }
  const running = Boolean(normalized) && (!current || current.running)
  const result = current?.result
  const partial = result && (result.limit || result.truncatedPages || result.failedPages)
  const limit = result?.limit === 'time' ? '15-second search limit reached.'
    : result?.limit === 'pages' ? '5,000-page search limit reached.'
      : result?.limit === 'matches' ? '1,000 matching-page limit reached.' : ''
  const notice = partial ? [
    'Partial results.', limit,
    result?.truncatedPages ? `${result.truncatedPages} ${result.truncatedPages === 1 ? 'page reached' : 'pages reached'} the text limit.` : '',
    result?.failedPages ? `${result.failedPages} ${result.failedPages === 1 ? 'page' : 'pages'} could not be searched.` : '',
  ].filter(Boolean).join(' ') : ''

  return <div className="pdf-find" role="search" aria-label="Find pages in PDF" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      pending.current?.abort()
      onClose()
    } else if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault()
      navigate(event.shiftKey ? -1 : 1)
    }
  }}>
    <div className="pdf-find-controls">
      <input ref={input} type="search" aria-label="Find text in PDF" placeholder="Find text in PDF" title="Search selectable text in the Original PDF." maxLength={256}
        autoComplete="off" spellCheck={false} value={query} onChange={event => {
          if (normalizePDFQuery(event.target.value) !== normalized) {
            pending.current?.abort()
            setSearch(null)
          }
          setQuery(event.target.value)
        }} />
      <button className="icon-button" aria-label="Previous matching page" title="Previous matching page (Shift+Enter)" disabled={!matches.length} onClick={() => navigate(-1)}><ChevronUp size={17} /></button>
      <button className="icon-button" aria-label="Next matching page" title="Next matching page (Enter)" disabled={!matches.length} onClick={() => navigate(1)}><ChevronDown size={17} /></button>
      <button className="icon-button" aria-label="Close PDF find" title="Close PDF find (Escape)" onClick={() => { pending.current?.abort(); onClose() }}><X size={17} /></button>
    </div>
    <div className="pdf-find-status" role="status" aria-live="polite" aria-atomic="true">
      {normalized ? <>{matches.length.toLocaleString()} matching pages{running ? ' · Searching…' : ''}
        {result && <> · {result.scannedPages.toLocaleString()}/{result.totalPages.toLocaleString()} pages searched</>}
        {notice && <span className="pdf-find-notice">{notice}</span>}
      </> : 'Find matching pages in Original PDF text.'}
    </div>
  </div>
}
