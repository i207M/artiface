export interface DelimitedTable {
  rows: string[][]
  limited: boolean
  error: string
}

// The text API is byte-bounded; also bound allocations for delimiter-heavy files.
const maxRows = 10_000
const maxColumns = 100
const maxCells = 50_000

export function parseDelimited(text: string, delimiter: ',' | '\t', inputTruncated = false): DelimitedTable {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closedQuote = false
  let started = false
  let cells = 0
  const result = (error = '', limited = false) => ({ rows, error, limited })
  const finishField = () => {
    if (row.length >= maxColumns || cells >= maxCells) return false
    row.push(field)
    cells++
    field = ''
    closedQuote = false
    return true
  }
  const limit = () => {
    if (row.length) rows.push(row)
    return result('', true)
  }

  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else { quoted = false; closedQuote = true }
      } else field += char
      continue
    }
    if (char === delimiter) {
      started = true
      if (!finishField()) return limit()
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      if (started) {
        if (!finishField()) return limit()
        rows.push(row)
        if (rows.length >= maxRows && i + 1 < text.length) return result('', true)
      }
      row = []
      field = ''
      closedQuote = false
      started = false
    } else if (closedQuote) {
      // Accept spaces after a closing quote, but never silently join malformed cells.
      if (char !== ' ' && !(delimiter === ',' && char === '\t')) return result(`Unexpected text after a closing quote in row ${rows.length + 1}.`)
    } else if (char === '"') {
      if (field.length) return result(`Unexpected quote in row ${rows.length + 1}.`)
      quoted = true
      started = true
    } else {
      started = true
      field += char
    }
  }
  // A byte-limited response can end midway through a record, including a quoted newline.
  if (inputTruncated) return result()
  if (quoted) return result(`Unclosed quoted field in row ${rows.length + 1}.`)
  if (started) {
    if (!finishField()) return limit()
    rows.push(row)
  }
  return result()
}
