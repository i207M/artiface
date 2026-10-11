import assert from 'node:assert/strict'

globalThis.window = new EventTarget()
const { clearPDFCache, pdfCacheGeneration, retainOpenPDFs, retainPDF, takeCachedPDF } = await import('../web/src/pdfCache.ts')
const disposed = new Set()
const view = { page: 3, zoom: 1.25, rotation: 90, top: 200, left: 10 }
const entry = (name, size = 1024, version = 'v1') => ({
  document: { loadingTask: { destroy: async () => { disposed.add(name) } } },
  size, version, generation: pdfCacheGeneration(),
})
const store = (name, size, version) => retainPDF(entry(name, size, version), name, view)

retainOpenPDFs(['a', 'b', 'c', 'd', 'e', 'large', 'oversized'])
for (const name of ['a', 'b', 'c', 'd']) store(name)
const reused = takeCachedPDF('a')
assert.deepEqual(reused.view, view)
assert.equal(reused.version, 'v1', 'Immediate reuse lost the version that belongs to its bytes')
assert.equal(takeCachedPDF('a'), undefined, 'Active and cached readers shared ownership')
retainPDF(reused, 'a', view)
store('e')
assert(disposed.has('b'), 'Least recently used document was not evicted')
assert(!disposed.has('a'), 'Recently used document was evicted')
const stale = takeCachedPDF('a')
assert.equal(stale.version, 'v1', 'Reentry must not wait for remote metadata')
retainPDF(stale, 'a', view)
clearPDFCache()
store('large', 40 * 1024 * 1024)
store('a', 40 * 1024 * 1024)
assert(disposed.has('large'), 'Combined byte limit did not evict a document')
store('oversized', 65 * 1024 * 1024)
assert(disposed.has('oversized'), 'Oversized inactive PDF was retained')
const active = entry('active-before-logout')
window.dispatchEvent(new Event('artiface:unauthorized'))
retainOpenPDFs(['a', 'active-before-logout'])
retainPDF(active, 'active-before-logout', view)
assert(disposed.has('active-before-logout'), 'Unmounting after sign-out repopulated the cache')
store('a')
window.dispatchEvent(new Event('artiface:configuration-changed'))
assert.equal(takeCachedPDF('a'), undefined, 'Source changes retained cached content')
store('a')
retainOpenPDFs([])
assert.equal(takeCachedPDF('a'), undefined, 'Closing a tab retained cached content')
retainPDF(entry('closed-active'), 'closed-active', view)
assert(disposed.has('closed-active'), 'A late unmount recached a closed tab')
clearPDFCache()
retainOpenPDFs(['compressed', 'a'])
const compressed = { document: { compressed: true, id: 'snapshot', numPages: 10 }, version: 'v1',
  size: 200 * 1024 * 1024, generation: pdfCacheGeneration() }
retainPDF(compressed, 'compressed', view)
assert.equal(takeCachedPDF('compressed').document.id, 'snapshot', 'Large compressed files lost their lightweight snapshot metadata')
let duringClear
window.addEventListener('artiface:pdf-cache-cleared', () => { duringClear = pdfCacheGeneration(); retainPDF(compressed, 'compressed', view) }, { once: true })
clearPDFCache()
assert.equal(duringClear, pdfCacheGeneration(), 'Invalidation notified listeners before advancing its generation')
assert.equal(takeCachedPDF('compressed'), undefined, 'Invalidation callback repopulated stale metadata')
delete globalThis.window
console.log('PASS: immediate PDF ownership/version/view transfer, LRU/count/byte limits, lightweight Compression snapshots, closed tabs, and session/configuration clearing')
