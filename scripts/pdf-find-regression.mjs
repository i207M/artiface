import assert from 'node:assert/strict'
import { mock } from 'node:test'

globalThis.window = new EventTarget()
const { PDF_SEARCH_LIMITS: limits, matchingPDFPage, normalizePDFQuery, searchPDFPages } = await import('../web/src/pdfSearch.ts')
const textItem = (str, hasEOL = false) => ({ str, hasEOL })
function documentFor(pages) {
  const reads = []
  const cancelled = []
  return {
    numPages: pages.length, reads, cancelled,
    async getPage(number) {
      reads.push(number)
      return {
        cleanup() { assert.fail('Search cleaned up a page shared with the viewer') },
        streamTextContent() {
          const value = pages[number - 1]
          if (value instanceof Error) throw value
          let sent = false
          return new ReadableStream({
            pull(controller) {
              if (sent) return controller.close()
              sent = true
              controller.enqueue({ items: typeof value === 'string' ? [textItem(value)] : value })
            },
            cancel(reason) { assert(reason instanceof Error); cancelled.push(number) },
          }, { highWaterMark: 0 })
        },
      }
    },
  }
}
const search = (document, query) => searchPDFPages(document, query, new AbortController().signal)
const pages = Array.from({ length: 73 }, () => 'other text')
pages[1] = [textItem('Con'), textItem('ﬁguration', true), textItem('in\u00a0practice')]
pages[8] = 'needle a+b.*'
pages[72] = 'NEEDLE'
const original = documentFor(pages)
assert.equal(normalizePDFQuery(' ＮＥＥＤＬＥ \n text '), 'needle text')
assert.deepEqual((await search(original, 'configuration in practice')).matches, [2], 'Font fragments or line breaks changed the phrase')
assert.deepEqual((await search(original, 'needle')).matches, [9, 73], 'Unmounted pages were not searched')
assert.equal(original.reads.length, 73, 'A second query did not reuse document text')
assert.deepEqual((await search(original, 'a+b.*')).matches, [9], 'Query punctuation was treated as a regular expression')
for (const [page, direction, expected] of [[1, 1, 9], [9, 1, 73], [73, 1, 9], [73, -1, 9], [9, -1, 73], [50, -1, 9]]) {
  assert.equal(matchingPDFPage([9, 73], page, direction), expected)
}
assert.equal(matchingPDFPage([], 1, -1), undefined)

const truncated = documentFor(['x'.repeat(limits.pageCharacters) + 'excluded'])
let result = await search(truncated, 'excluded')
assert.deepEqual(result.matches, [])
assert.equal(result.truncatedPages, 1)
assert.deepEqual(truncated.cancelled, [1], 'An oversized page kept extracting text')
result = await search(truncated, 'x')
assert.equal(result.truncatedPages, 1, 'Cached truncation was not reported')
assert.equal(truncated.reads.length, 1)

const atBudget = documentFor(Array.from({ length: 4 }, () => 'x'.repeat(limits.pageCharacters)))
await search(atBudget, 'x')
await search(atBudget, 'missing')
assert.equal(atBudget.reads.length, 4, 'The two-million-character cache did not reuse its contents')
const overBudget = documentFor(Array.from({ length: 5 }, () => 'x'.repeat(limits.pageCharacters)))
await search(overBudget, 'x')
await search(overBudget, 'missing')
assert.equal(overBudget.reads.length, 10, 'The text cache exceeded its character budget instead of evicting old pages')
const changed = documentFor(['replacement'])
assert.deepEqual((await search(changed, 'needle')).matches, [], 'A replacement document reused stale text')
window.dispatchEvent(new Event('artiface:pdf-cache-cleared'))
await search(original, 'needle')
assert.equal(original.reads.length, 146, 'Session/cache clearing retained searchable text')

const failures = documentFor(['needle', new Error('Broken page'), 'needle'])
result = await search(failures, 'needle')
assert.deepEqual(result.matches, [1, 3])
assert.equal(result.failedPages, 1, 'An unreadable page was silently omitted')
assert.equal(result.scannedPages, 3)

let release
let getPages = 0
let streams = 0
const held = {
  numPages: 3,
  getPage() {
    getPages++
    return new Promise(resolve => { release = () => resolve({ streamTextContent() { streams++; throw new Error('Late stream') } }) })
  },
}
const abort = new AbortController()
let updates = 0
const pending = searchPDFPages(held, 'old', abort.signal, () => updates++)
abort.abort()
assert.equal(await pending, null, 'An uncancellable getPage prevented prompt cancellation')
assert.deepEqual((await search(documentFor(['new']), 'new')).matches, [1])
release()
await Promise.resolve()
await Promise.resolve()
assert.equal(getPages, 1, 'Cancellation started another page')
assert.equal(streams, 0, 'Late getPage completion started text extraction')
assert.equal(updates, 0, 'Cancelled search published stale progress')

let reading
const startedReading = new Promise(resolve => { reading = resolve })
let streamCancelled = 0
const streaming = {
  numPages: 2,
  async getPage() {
    return { streamTextContent: () => new ReadableStream({
      pull() { reading() },
      cancel(reason) { assert(reason instanceof Error); streamCancelled++ },
    }, { highWaterMark: 0 }) }
  },
}
const cancelStream = new AbortController()
const readingResult = searchPDFPages(streaming, 'x', cancelStream.signal)
await startedReading
cancelStream.abort()
assert.equal(await readingResult, null)
assert.equal(streamCancelled, 1, 'Cancellation did not stop the active text stream')

mock.timers.enable({ apis: ['setTimeout'] })
try {
  const deadline = searchPDFPages({ numPages: 10, getPage: () => new Promise(() => {}) }, 'x', new AbortController().signal)
  mock.timers.tick(limits.milliseconds)
  result = await deadline
  assert.equal(result.limit, 'time', 'A stuck getPage bypassed the search deadline')
  assert.equal(result.scannedPages, 0)
} finally { mock.timers.reset() }

const manyPages = documentFor(Array.from({ length: limits.pages + 1 }, () => ''))
result = await search(manyPages, 'x')
assert.equal(result.scannedPages, limits.pages)
assert.equal(result.limit, 'pages')
const manyMatches = documentFor(Array.from({ length: limits.matches + 1 }, () => 'x'))
result = await search(manyMatches, 'x')
assert.equal(result.matches.length, limits.matches)
assert.equal(result.limit, 'matches')
assert.equal(manyMatches.reads.length, limits.matches, 'Search continued beyond the result limit')
delete globalThis.window
console.log('PASS: PDF find normalization, all-page search, navigation, stream truncation, cache budgets/reuse/clearing, replacement, cancellation, and search limits')
