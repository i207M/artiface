import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, Table2 } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { parseDelimited } from '../csv'
import { columnSortKeys, sortedRowIndices } from '../csvSort'
import type { TableView } from './useReaderView'

const pageSize = 50
const numericCell = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export default function CSVViewer({ text, path, truncated, view, onChange, renderToolbar }: {
  text: string; path: string; truncated: boolean; view: TableView; onChange: (view: TableView) => void
  renderToolbar: (controls: ReactNode, details: ReactNode) => ReactNode
}) {
  const parsed = useMemo(() => parseDelimited(text, /\.tsv$/i.test(path) ? '\t' : ',', truncated), [text, path, truncated])
  const { header, page } = view
  const scroll = useRef<HTMLDivElement>(null)
  const columns = useMemo(() => parsed.rows.reduce((count, row) => Math.max(count, row.length), 0), [parsed])
  const offset = header && parsed.rows.length ? 1 : 0
  const sort = view.sort && view.sort.column < columns ? view.sort : null
  const invalidSort = Boolean(view.sort && !sort)
  const rows = useMemo(() => parsed.rows.slice(offset), [parsed, offset])
  const keys = useMemo(() => sort ? columnSortKeys(rows, sort.column) : null, [rows, sort?.column])
  const order = useMemo(() => keys ? sortedRowIndices(keys, sort?.direction === 'desc') : rows.map((_, index) => index),
    [rows, keys, sort?.direction])
  // Classify the whole preview so alignment stays stable between pages.
  const numericColumns = useMemo(() => Array.from({ length: columns }, (_, column) =>
    parsed.rows.length > offset && parsed.rows.every((row, index) => {
      if (index < offset) return true
      const value = row[column]
      return value !== undefined && value === value.trim() && numericCell.test(value)
    })), [parsed, columns, offset])
  const count = parsed.rows.length - offset
  const lastPage = Math.max(0, Math.ceil(count / pageSize) - 1)
  const currentPage = invalidSort ? 0 : Math.min(page, lastPage)
  const start = currentPage * pageSize
  const range = count ? `${start + 1}–${Math.min(start + pageSize, count)} of ${count.toLocaleString()} rows` : '0 rows'
  const summary = `${range} · ${columns} ${columns === 1 ? 'column' : 'columns'}`
  useEffect(() => {
    if (invalidSort) { scroll.current?.scrollTo({ top: 0 }); onChange({ ...view, sort: null, page: 0 }) }
    else if (page > lastPage) onChange({ ...view, page: lastPage })
  }, [page, lastPage, invalidSort, view, onChange])
  const changePage = (next: number, nextHeader = header) => {
    scroll.current?.scrollTo({ top: 0 })
    onChange({ ...view, header: nextHeader, page: next, sort: nextHeader === header ? sort : null })
  }
  const changeSort = (column: number) => {
    const next = sort?.column !== column ? { column, direction: 'asc' as const }
      : sort.direction === 'asc' ? { ...sort, direction: 'desc' as const } : null
    scroll.current?.scrollTo({ top: 0 })
    if (!next && count <= 1) scroll.current?.focus({ preventScroll: true })
    onChange({ ...view, page: 0, sort: next })
  }

  return <div className={`csv-viewer ${lastPage > 0 ? 'csv-paginated' : 'csv-single-page'}`}>
    {renderToolbar(<div className="csv-controls">
      <label className="csv-header" title="Use the first record as column headings"><input type="checkbox" aria-label="First row is header" checked={header} onChange={event => changePage(0, event.target.checked)} /><Table2 size={16} aria-hidden="true" /><span>Header</span></label>
      <div className="csv-pagination">
        {lastPage > 0 && <button className="icon-button" aria-label="Previous rows" title="Previous rows" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={17} /></button>}
        {lastPage > 0 && <span className="csv-page-picker"><select className="csv-page-select" aria-label="Table page" title={`Page ${currentPage + 1} of ${lastPage + 1}`} value={currentPage} onChange={event => changePage(Number(event.target.value))}>
          {Array.from({ length: lastPage + 1 }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}
        </select><ChevronDown size={12} aria-hidden="true" /></span>}
        <span className="csv-range" role="status" aria-label={lastPage > 0 ? `Page ${currentPage + 1} of ${lastPage + 1}. ${summary}` : summary} title={summary}>
          <span className="csv-row-count" aria-hidden="true">{range}<span> · {columns} {columns === 1 ? 'column' : 'columns'}</span></span>
          <span className="csv-page-count" aria-hidden="true">{lastPage > 0 ? <span className="csv-page-total">/{lastPage + 1}</span> : `${count} ${count === 1 ? 'row' : 'rows'}`}</span>
        </span>
        {lastPage > 0 && <button className="icon-button" aria-label="Next rows" title="Next rows" disabled={currentPage === lastPage} onClick={() => changePage(currentPage + 1)}><ChevronRight size={17} /></button>}
      </div>
    </div>, <span>{summary}</span>)}
    {parsed.limited && <div className="notice" role="status">Table preview limit reached. Showing up to 10,000 rows, 100 columns, and 50,000 cells. Download the file for the complete table.</div>}
    {parsed.error && <div className="notice warning-notice" role="status">{parsed.error} Switch to Source to inspect the original text.</div>}
    <div className="csv-scroll" ref={scroll} tabIndex={0} role="region" aria-label="Table contents">
      {columns ? <table className="csv-table" aria-label="File data">
        <thead><tr><th scope="col" className="csv-row-number" title="Original data record number">Row</th>{Array.from({ length: columns }, (_, column) => {
          const active = sort?.column === column
          const sortable = count > 1 || active
          const title = header ? parsed.rows[0]?.[column] || `Column ${column + 1}` : `Column ${column + 1}`
          const next = !active ? 'Sort preview ascending' : sort.direction === 'asc' ? 'Sort preview descending' : 'Restore file order'
          const ordering = active ? `${keys?.numeric ? 'Numeric' : 'Text'} order, ${sort.direction === 'asc' ? 'ascending' : 'descending'}. ` : ''
          const Icon = active ? sort.direction === 'asc' ? ArrowUp : ArrowDown : ArrowUpDown
          return <th scope="col" key={column} aria-label={title} className={`${sortable ? 'csv-sortable' : ''}${numericColumns[column] ? ' csv-numeric' : ''}`}
            aria-sort={active ? sort.direction === 'asc' ? 'ascending' : 'descending' : undefined}>
            {sortable ? <><button className="csv-sort-button" onClick={() => changeSort(column)}
              aria-label={`${title}, column ${column + 1}: ${ordering}${next}`} title={active ? `${ordering}${next}` : `${next}; then descending, then file order`}>
              <span>{title}</span><Icon size={12} aria-hidden="true" />
            </button><span className="csv-sort-label" aria-hidden="true"><span>{title}</span><Icon size={12} /></span></> : title}
          </th>
        })}</tr></thead>
        <tbody>{order.slice(start, start + pageSize).map(index => <tr key={index}>
          <th scope="row" className="csv-row-number">{index + 1}</th>
          {Array.from({ length: columns }, (_, column) => <td key={column} className={numericColumns[column] ? 'csv-numeric' : undefined}>{rows[index][column] ?? ''}</td>)}
        </tr>)}</tbody>
      </table> : <p className="csv-empty">{parsed.error ? 'No complete rows could be displayed.' : 'This file has no complete table rows.'}</p>}
      {columns > 0 && count === 0 && <p className="csv-empty">No data rows in this preview. The first record is used as headings.</p>}
    </div>
  </div>
}
