import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const engineName = process.env.ARTIFACE_BROWSER || 'chromium'
const engine = engineName === 'webkit' ? webkit : chromium
const artifacts = process.env.ARTIFACE_PDF_OVERVIEW_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const entry = join(repository, 'web/src/__pdf_overview_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'pdf-overview-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css') || id.includes('.svg?')) return '\0fixture-empty'
    },
    load(id) {
      if (id === '\0fixture-empty') return 'export default ""'
      if (id === entry) return `
        import {useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
        import {WorkerMessageHandler} from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
        import PDFOverview from './components/PDFOverview'
        import PDFPages from './components/PDFPages'
        import {compressedPage, compressedCacheGeneration} from './compressedPDF'
        globalThis.pdfjsWorker = {WorkerMessageHandler}
        const f = window.fixture = {
          reads: [], renders: [], canceled: [], cleanups: [], canvases: [], picks: [],
          gets: [], rendering: [], active: 0, maxActive: 0, closes: 0, destroys: 0,
          holdGet: false, holdRender: true, bitmapOpened: 0, bitmapClosed: 0,
          unauthorized: 0, rejectUnauthorized: null,
          readerHeld: false, readerPending: [], readerWrites: [], readerReleaseTop: null,
          waitForReaderPage() { return this.readerHeld ? new Promise(resolve => this.readerPending.push(resolve)) : Promise.resolve() },
          releaseReaderPage() { this.readerHeld = false; this.readerPending.splice(0).forEach(resolve => resolve()) },
          readerPriority: false, readerJobs: [], readerSerial: 0, readerStates: [], readerDecoded: [], shared: {},
          resetReaderImages() {
            window.dispatchEvent(new Event('artiface:pdf-cache-cleared'))
            documents.readerCompressed = {...documents.readerCompressed, generation: compressedCacheGeneration()}
          },
          startShared(name, page = 1) {
            const job = this.shared[name] = {controller: new AbortController(), state: 'pending'}
            const document = {...documents.compressed, id: 'shared-request-fixture', generation: compressedCacheGeneration()}
            void compressedPage(document, page, 320, job.controller.signal).then(
              image => { job.state = 'ready'; job.image = image },
              error => { job.state = error.name },
            )
          },
          readerPosition() {}, readerLeave() {}, readerState(state) { f.readerStates.push({...state, error: state.error?.message}) },
          readerJob(number) { return this.readerJobs.filter(job => job.number === number).at(-1) },
          finishReader(number, fail = false) { this.readerJob(number).finish(fail) },
          yieldReader(number) { this.readerJob(number).offer() },
          releaseGets() { this.holdGet = false; this.gets.splice(0).forEach(release => release()) },
          releaseRenders() { this.holdRender = false; this.rendering.splice(0).forEach(release => release()) },
        }
        window.addEventListener('artiface:unauthorized', () => f.unauthorized++)
        const unauthorized = () => new Promise((resolve, reject) => {
          f.rejectUnauthorized = () => { f.rejectUnauthorized = null; reject({status: 401}) }
        })
        const bitmapPages = new WeakMap()
        const decode = window.createImageBitmap.bind(window)
        window.createImageBitmap = async (...args) => {
          if (bitmapPages.has(args[0])) f.readerDecoded.push(bitmapPages.get(args[0]))
          const bitmap = await decode(...args)
          f.bitmapOpened++
          const close = bitmap.close.bind(bitmap)
          bitmap.close = () => { f.bitmapClosed++; close() }
          return bitmap
        }
        const nativeScrollTo = Element.prototype.scrollTo
        Element.prototype.scrollTo = function(...args) {
          if (this.matches('.pdf-canvas-area')) f.readerWrites.push({before: this.scrollTop, top: args[0]?.top, left: args[0]?.left})
          return nativeScrollTo.apply(this, args)
        }
        const nativeFetch = window.fetch.bind(window)
        window.fetch = async (...args) => {
          const response = await nativeFetch(...args)
          const url = new URL(String(args[0]), location.href)
          if (url.searchParams.get('document') === 'reader-compressed-fixture' && url.searchParams.get('page') === '2') await f.waitForReaderPage()
          if (url.searchParams.get('document') === 'reader-compressed-fixture') {
            const blob = response.blob.bind(response)
            response.blob = async () => {
              const image = await blob()
              bitmapPages.set(image, Number(url.searchParams.get('page')))
              return image
            }
          }
          return response
        }
        function raw(id) {
          return {numPages: 10000, destroy() { f.destroys++ }, async getPage(number) {
            const key = id + ':' + number
            f.reads.push(key); f.active++; f.maxActive = Math.max(f.maxActive, f.active)
            if (f.holdGet) await new Promise(resolve => f.gets.push(resolve))
            const nativeRotation = number % 3 === 0 ? 90 : 0
            const width = number % 2 ? 600 : 900
            const height = number % 2 ? 900 : 600
            return {
              rotate: nativeRotation,
              getViewport({scale, rotation}) {
                return {width: (rotation % 180 ? height : width) * scale, height: (rotation % 180 ? width : height) * scale}
              },
              render({canvas, canvasContext, viewport}) {
                f.renders.push(key); f.canvases.push(canvas)
                let done = false, reject
                const promise = new Promise((resolve, fail) => {
                  reject = fail
                  const finish = () => {
                    if (done) return
                    done = true
                    canvasContext.fillStyle = number % 2 ? '#d4eade' : '#ecd7a6'
                    canvasContext.fillRect(0, 0, viewport.width, viewport.height)
                    canvasContext.fillStyle = '#183f35'
                    canvasContext.fillRect(12, 12, viewport.width / 2, 18)
                    resolve()
                  }
                  if (f.holdRender) f.rendering.push(finish)
                  else setTimeout(finish, 0)
                })
                return {promise, cancel() {
                  if (done) return
                  done = true; f.canceled.push(key)
                  reject(new DOMException('Canceled fixture render', 'AbortError'))
                }}
              },
              cleanup() { f.active--; f.cleanups.push(key) },
            }
          }}
        }
        const documents = {
          a: raw('a'), b: raw('b'), c: raw('c'),
          unauthorizedGet: {numPages: 1, getPage: unauthorized},
          unauthorizedRender: {numPages: 1, async getPage() {
            return {rotate: 0, getViewport: ({scale}) => ({width: 100 * scale, height: 150 * scale}),
              render: () => ({promise: unauthorized(), cancel() {}}), cleanup() {}}
          }},
          compressed: {compressed: true, id: 'compressed-fixture', numPages: 10000, width: 600, height: 900,
            version: 'v1', size: 1024, generation: 0, location: {host: 'fixture', root: 'pages', path: 'fixture.pdf', kind: 'file'}},
        }
        function priorityRender(number, {canvas, canvasContext}) {
          f.renders.push('reader:' + number); f.canvases.push(canvas)
          let resolve, reject
          const job = {id: ++f.readerSerial, number, offers: 0, resumeCalls: 0, continued: 0, canceled: false, done: false}
          const task = {promise: new Promise((yes, no) => {resolve = yes; reject = no}), cancel() {
            if (job.done) return
            job.done = job.canceled = true
            f.canceled.push('reader:' + number)
            reject(new DOMException('Canceled reader render', 'AbortError'))
          }}
          job.offer = () => {
            job.offers++
            const next = () => { job.resumeCalls++; if (!job.done) job.continued++ }
            if (task.onContinue) task.onContinue(next)
            else next()
          }
          job.finish = fail => {
            if (job.done) return
            if (!job.continued) throw new Error('Fixture tried to finish a parked page')
            job.done = true
            if (fail) reject(new Error('Synthetic reader render failure'))
            else { canvasContext.fillStyle = '#183f35'; canvasContext.fillRect(0, 0, canvas.width, canvas.height); resolve() }
          }
          f.readerJobs.push(job)
          queueMicrotask(() => { if (!job.done) job.offer() })
          return task
        }
        const readerRaw = raw('reader')
        documents.readerOriginal = {numPages: 6, async getPage(number) {
          if (number === 2) await f.waitForReaderPage()
          const page = await readerRaw.getPage(number)
          return {...page, rotate: 0, render: options => f.readerPriority ? priorityRender(number, options) : page.render(options), getViewport({scale, rotation = 0}) {
            return {width: (rotation % 180 ? 800 : 600) * scale, height: (rotation % 180 ? 600 : 800) * scale, scale, rotation,
              rawDims: {pageWidth: 600, pageHeight: 800, pageX: 0, pageY: 0}}
          }, streamTextContent() { return new ReadableStream({start(controller) {controller.close()}}) }}
        }}
        documents.readerCompressed = {...documents.compressed, id: 'reader-compressed-fixture', numPages: 6, width: 600, height: 800}
        f.real = async data => {
          documents.real = await getDocument({data: new Uint8Array(data), isEvalSupported: false}).promise
          f.show({document: 'real', page: 1, rotation: 0})
        }
        function App() {
          const [options, setOptions] = useState({document: 'a', page: 5000, rotation: 0})
          f.show = next => setOptions(previous => ({...previous, ...next}))
          f.showReader = (compression, priority = false, view = {}) => {
            f.readerPriority = priority; f.readerJobs = []; f.readerStates = []; f.readerDecoded = [];
            // Arm page 2 before mount so an immediate lookahead cannot escape the gate.
            f.holdRender = false; f.readerHeld = !priority; f.readerPending = []; f.readerWrites = []; f.readerReleaseTop = null
            setOptions({document: compression ? 'readerCompressed' : 'readerOriginal', reader: true, rotation: 0,
              navigation: view.navigation || 'vertical', request: {page: view.page || 1, top: 0, left: 0}})
          }
          f.requestReader = page => setOptions(previous => ({...previous, request: {page, top: 0, left: 0}}))
          f.rotateReader = () => setOptions(previous => ({...previous, rotation: (previous.rotation + 90) % 360}))
          return <main>{options.document && (options.reader
            ? <PDFPages key={options.document} document={documents[options.document]} navigation={options.navigation || 'vertical'} zoom={1.2} rotation={options.rotation}
                initialPosition={options.request} request={options.request} onPosition={f.readerPosition} onLeave={f.readerLeave} onState={f.readerState}/>
            : <PDFOverview document={documents[options.document]}
            page={options.page} rotation={options.rotation} onPage={number => f.picks.push(number)}
            onClose={() => f.closes++}/> )}</main>
        }
        createRoot(document.getElementById('root')).render(<App/>)
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'viewers.css', 'components/pdfOverview.css']
  .map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://pdf-overview-fixture.invalid'
const browser = await engine.launch({ headless: true })
const errors = []
const measurements = []

// Real vector pages with mixed MediaBoxes and an intrinsic /Rotate.
function smallPDF() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 900] /Resources << >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 600] /Resources << >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 900] /Rotate 90 /Resources << >> /Contents 6 0 R >>',
  ]
  const content = '0.1 0.4 0.3 rg 0 0 600 900 re f 0.9 0.7 0.3 rg 40 40 300 300 re f\n'
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return [...Buffer.from(pdf)]
}

try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' })
  context.setDefaultTimeout(8000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.stack ?? error.message)))
  await context.addInitScript(() => {
    window.fixtureUnhandled = []
    window.addEventListener('unhandledrejection', event => window.fixtureUnhandled.push(String(event.reason)))
  })
  const requests = []
  let jpeg, readerJPEG, readerWideJPEG, readerMixed = false
  let holdCompressed = false
  const heldCompressed = []
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${css} main {display:flex;height:100dvh;min-width:0;min-height:0}</style>
      <div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    requests.push(url.pathname + url.search)
    if (url.pathname !== '/api/pdf/page') return route.abort()
    if (holdCompressed) await new Promise(resolve => heldCompressed.push(resolve))
    const reader = url.searchParams.get('document') === 'reader-compressed-fixture'
    const wide = reader && readerMixed && url.searchParams.get('page') === '2'
    return route.fulfill({ contentType: 'image/jpeg', headers: { 'X-PDF-Width': wide ? '640' : '600', 'X-PDF-Height': reader ? '800' : '900' }, body: reader ? wide ? readerWideJPEG : readerJPEG : jpeg })
  })
  const page = await context.newPage()
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const stats = () => page.evaluate(() => {
    const {reads, renders, canceled, cleanups, active, maxActive, picks, closes, destroys, bitmapOpened, bitmapClosed} = window.fixture
    return {reads, renders, canceled, cleanups, active, maxActive, picks, closes, destroys, bitmapOpened, bitmapClosed}
  })
  const tile = number => page.locator(`[data-thumbnail-page="${number}"]`)
  const scroll = page.locator('.pdf-overview-scroll')
  const focused = () => page.evaluate(() => Number(document.activeElement?.getAttribute('data-thumbnail-page')))
  const show = options => page.evaluate(options => window.fixture.show(options), options)
  const bounded = async label => {
    const result = await scroll.evaluate(element => ({
      width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth,
      tiles: element.querySelectorAll('[data-thumbnail-page]').length,
      tabStops: element.querySelectorAll('[data-thumbnail-page][tabindex="0"]').length,
      overflow: document.documentElement.scrollWidth > innerWidth,
      detachedCanvas: window.fixture.canvases.some(canvas => !canvas.isConnected && (canvas.width || canvas.height)),
    }))
    assert(result.tiles > 0 && result.tiles <= 56, `${label}: unbounded mounted pages ${JSON.stringify(result)}`)
    assert.equal(result.tabStops, 1, `${label}: thumbnail grid must have one tab stop`)
    assert(result.scrollWidth <= result.width && !result.overflow, `${label}: horizontal overflow`)
    assert(!result.detachedCanvas, `${label}: detached canvas retained pixels`)
    measurements.push({label, ...result})
  }

  await page.goto(origin)
  await expect(tile(5000)).toBeFocused()
  await expect(tile(5000)).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await stats()).renders.length).toBe(2)
  let result = await stats()
  assert.equal(result.maxActive, 2)
  assert.equal(result.reads.length, 2)
  assert(result.reads.every(key => Math.abs(Number(key.split(':')[1]) - 5000) <= 1), 'Current page was not prioritized')
  await bounded('10k initial')
  const oldCanvases = await page.evaluate(() => window.fixture.canvases.length)
  await scroll.evaluate(element => { element.scrollTop = 0 })
  await expect.poll(async () => (await stats()).canceled.length).toBe(2)
  await expect.poll(async () => (await stats()).renders.length).toBe(4)
  result = await stats()
  assert(result.reads.slice(2).every(key => Number(key.split(':')[1]) < 50), 'Stale queued pages rendered after scrolling')
  assert(await page.evaluate(length => window.fixture.canvases.slice(0, length).every(canvas => canvas.width === 0 && canvas.height === 0), oldCanvases))
  await bounded('10k scroll cancellation')

  // An unabortable getPage must keep its render slot and never draw into a replacement document.
  await page.evaluate(() => { window.fixture.holdGet = true; window.fixture.holdRender = false })
  await show({document: 'b', page: 7500})
  await expect.poll(async () => (await stats()).reads.filter(key => key.startsWith('b:')).length).toBe(2)
  await show({document: 'c', page: 9000})
  await settle()
  assert.equal((await stats()).reads.filter(key => key.startsWith('c:')).length, 0, 'Document replacement bypassed occupied slots')
  await page.evaluate(() => window.fixture.releaseGets())
  await expect(tile(9000).locator('canvas')).toHaveClass('is-ready')
  result = await stats()
  assert(!result.renders.some(key => key.startsWith('b:')), 'A stale getPage response rendered')
  assert.equal(result.maxActive, 2)
  assert.equal(result.destroys, 0)
  await bounded('document replacement')

  await expect(tile(9000)).toBeFocused()
  const columns = await page.locator('.pdf-overview-tile').evaluateAll(elements => {
    const first = elements[0].style.top
    return elements.filter(element => element.style.top === first).length
  })
  for (const [key, number] of [['ArrowRight', 9001], ['ArrowLeft', 9000], ['ArrowDown', 9000 + columns], ['ArrowUp', 9000], ['End', 10000], ['Home', 1]]) {
    await page.keyboard.press(key)
    await expect.poll(focused).toBe(number)
    await bounded(key)
  }
  await page.keyboard.press('PageDown')
  const nextPage = await focused()
  assert(nextPage > 1 && nextPage <= columns * 4 + 1)
  await page.keyboard.press('PageUp')
  await expect.poll(focused).toBe(1)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  assert.deepEqual((await stats()).picks, [1, 1])
  await page.keyboard.press('Escape')
  assert.equal((await stats()).closes, 1)
  await expect(page.getByRole('list', {name: 'Page thumbnails, 10,000 pages'})).toHaveCount(1)
  assert.equal(await page.getByRole('button', {name: 'Close page overview'}).count(), 0, 'Overview duplicated parent toolbar controls')

  for (const width of [320, 390, 768]) {
    for (const density of ['compact', 'comfortable']) {
      await show({page: 5040, rotation: 90})
      await page.setViewportSize({width, height: 740})
      await page.evaluate(density => {
        document.documentElement.dataset.density = density
        document.documentElement.style.setProperty('--font-scale', '1.4')
      }, density)
      await tile(5040).focus()
      await settle()
      await expect(tile(5040)).toBeInViewport()
      await expect(tile(5040)).toBeFocused()
      await bounded(`${width} ${density} 140%`)
      await expect(tile(5040).locator('canvas')).toHaveClass('is-ready')
      if (artifacts) await page.screenshot({path: join(artifacts, `${engineName}-${width}-${density}.png`)})
    }
  }
  await page.setViewportSize({width: 320, height: 740})
  await settle()
  await expect(tile(5040)).toBeFocused()
  await expect(tile(5040)).toBeInViewport()
  await bounded('orientation resize preserves focused page')

  await page.setViewportSize({width: 740, height: 360})
  await settle()
  await show({page: 5000})
  await expect(tile(5000)).toBeFocused()
  await expect(tile(5000)).toBeInViewport({ratio: 1})
  await bounded('short overview opens with the current page fully visible')
  if (artifacts) await page.screenshot({path: join(artifacts, `${engineName}-short-current-page.png`)})
  await page.setViewportSize({width: 320, height: 740})
  await settle()

  // Exercise the real compressedPage fetch/decode path without requesting the original PDF.
  jpeg = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 60; canvas.height = 90
    const context = canvas.getContext('2d'); context.fillStyle = '#183f35'; context.fillRect(0, 0, 60, 90)
    return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'))).arrayBuffer())]
  }))
  holdCompressed = true
  await show({document: 'compressed', page: 8000, rotation: 0})
  await expect.poll(() => requests.length).toBe(2)
  await scroll.evaluate(element => { element.scrollTop = 0 })
  await expect.poll(() => requests.length).toBe(4)
  assert(requests.every(url => url.startsWith('/api/pdf/page?') && url.includes('size=320') && url.includes('document=compressed-fixture')), 'Compression downloaded an original or changed its requested bucket')
  holdCompressed = false
  heldCompressed.splice(0).forEach(release => release())
  await expect(tile(1).locator('canvas')).toHaveClass('is-ready')
  await expect.poll(async () => {
    const current = await stats()
    return current.bitmapOpened > 0 && current.bitmapOpened === current.bitmapClosed
  }).toBe(true)
  const geometry = number => tile(number).locator('canvas').evaluate(canvas => ({width: canvas.width, height: canvas.height}))
  let size = await geometry(1)
  assert(Math.abs(size.width / size.height - 2 / 3) < 0.015, 'Compressed page lost intrinsic ratio')
  await show({page: 1, rotation: 90})
  await expect(tile(1).locator('canvas')).toHaveClass('is-ready')
  size = await geometry(1)
  assert(Math.abs(size.width / size.height - 1.5) < 0.015, 'Compressed page rotation lost geometry')
  await bounded('compressed rotated')
  // Finish the previous generation before counting requests from the next one.
  await expect(page.locator('.pdf-overview-placeholder')).toHaveCount(0)

  // Closing with pending requests aborts the two in-flight fetches without starting queued pages.
  holdCompressed = true
  const beforeCloseRequests = requests.length
  const failedRequests = []
  page.on('requestfailed', request => { if (request.url().includes('/api/pdf/page?')) failedRequests.push(request.url()) })
  await show({page: 9500})
  await expect.poll(() => requests.length).toBe(beforeCloseRequests + 2)
  await show({document: null})
  await expect.poll(() => failedRequests.length).toBe(2)
  holdCompressed = false
  heldCompressed.splice(0).forEach(release => release())
  await settle()
  assert.equal(requests.length, beforeCloseRequests + 2, 'Unmount started queued compressed requests')

  await page.evaluate(data => window.fixture.real(data), smallPDF())
  await expect(page.locator('.pdf-overview-preview canvas.is-ready')).toHaveCount(3)
  for (const [number, ratio] of [[1, 2 / 3], [2, 1.5], [3, 1.5]]) {
    size = await geometry(number)
    assert(Math.abs(size.width / size.height - ratio) < 0.015, `Real PDF page ${number}: incorrect intrinsic geometry`)
    assert(await tile(number).locator('canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
      return data[3] > 0 && data[1] > data[0]
    }), `Real PDF page ${number}: missing vector pixels`)
  }
  await show({rotation: 90})
  await expect.poll(async () => (await geometry(1)).width > (await geometry(1)).height).toBe(true)
  await expect(page.locator('.pdf-overview-preview canvas.is-ready')).toHaveCount(3)
  for (const [number, ratio] of [[1, 1.5], [2, 2 / 3], [3, 2 / 3]]) {
    size = await geometry(number)
    assert(Math.abs(size.width / size.height - ratio) < 0.015, `Real PDF page ${number}: view rotation ignored`)
  }
  if (artifacts) await page.screenshot({path: join(artifacts, `${engineName}-real-pdf.png`)})
  await page.evaluate(() => { window.removedCanvases = [...document.querySelectorAll('.pdf-overview canvas')] })
  await show({document: null})
  await expect(page.locator('.pdf-overview')).toHaveCount(0)
  assert(await page.evaluate(() => [...window.fixture.canvases, ...window.removedCanvases].every(canvas => canvas.width === 0 && canvas.height === 0)), 'Unmount retained raw canvas pixels')
  result = await stats()
  assert.equal(result.active, 0)
  assert.equal(result.maxActive, 2)
  assert.equal(result.destroys, 0)
  assert.equal(result.bitmapOpened, result.bitmapClosed)
  assert.equal(await page.evaluate(() => window.fixture.unauthorized), 0, 'Cancellation invalidated the session')
  for (const document of ['unauthorizedGet', 'unauthorizedRender']) {
    for (const canceled of [false, true]) {
      const before = await page.evaluate(() => window.fixture.unauthorized)
      await show({document, page: 1, rotation: 0})
      await page.waitForFunction(() => window.fixture.rejectUnauthorized !== null)
      if (canceled) {
        await show({document: null})
        await expect(page.locator('.pdf-overview')).toHaveCount(0)
      }
      await page.evaluate(() => window.fixture.rejectUnauthorized())
      if (canceled) {
        await settle()
        assert.equal(await page.evaluate(() => window.fixture.unauthorized), before, `Canceled ${document} invalidated the session`)
      } else {
        await expect.poll(() => page.evaluate(() => window.fixture.unauthorized)).toBe(before + 1)
        await expect(page.locator('.pdf-overview-placeholder')).toHaveText('Thumbnail unavailable')
        await show({document: null})
        await expect(page.locator('.pdf-overview')).toHaveCount(0)
      }
    }
  }
  // A same-size page arrival must not interrupt the browser's native wheel animation.
  await page.setViewportSize({width: 1000, height: 800})
  await page.evaluate(() => {
    document.documentElement.dataset.density = 'comfortable'
    document.documentElement.style.setProperty('--font-scale', '1')
  })
  readerJPEG = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 60; canvas.height = 80
    const context = canvas.getContext('2d'); context.fillStyle = '#183f35'; context.fillRect(0, 0, 60, 80)
    return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'))).arrayBuffer())]
  }))
  const area = page.locator('.pdf-canvas-area')
  const readerReady = async number => {
    await expect(area).toHaveAttribute('aria-label', `PDF page ${number} of 6`)
    await expect.poll(() => page.locator(`.pdf-paper[data-page="${number}"] canvas`).evaluate(canvas => Boolean(canvas.style.width))).toBe(true)
    await expect(area).toHaveAttribute('aria-busy', 'false')
  }
  for (const compression of [false, true]) {
    await page.evaluate(compression => window.fixture.showReader(compression), compression)
    try {
      await readerReady(1)
      await page.waitForFunction(() => window.fixture.readerPending.length > 0)
      await area.evaluate(element => {
        const f = window.fixture
        f.readerWrites = []
        const release = () => {
          if (element.scrollTop <= 0) return
          element.removeEventListener('scroll', release)
          f.readerReleaseTop = element.scrollTop
          f.releaseReaderPage()
        }
        element.addEventListener('scroll', release, {passive: true})
      })
      const box = await area.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 1150)
      await expect.poll(() => area.evaluate(element => Math.abs(element.scrollTop - 1150))).toBeLessThanOrEqual(1)
      await readerReady(2)
      assert(await page.evaluate(() => window.fixture.readerReleaseTop > 0), 'Held metadata did not arrive after native scrolling started')
      assert.deepEqual(await page.evaluate(() => window.fixture.readerWrites), [], 'Same-size metadata caused a redundant scroll write')
      await page.evaluate(() => window.fixture.requestReader(3))
      await readerReady(3)
      await expect.poll(() => area.evaluate(element => element.scrollTop)).toBe(1944)
      const before = await page.evaluate(() => window.fixture.readerWrites.length)
      await page.evaluate(() => window.fixture.requestReader(3))
      await expect.poll(() => page.evaluate(() => window.fixture.readerWrites.length)).toBe(before + 1)
      assert.equal(await page.evaluate(() => window.fixture.readerWrites.at(-1).before), 1944, 'Explicit same-position request did not preserve scrollTo semantics')
      await page.evaluate(() => window.fixture.requestReader(1))
      await readerReady(1)
      await expect.poll(() => area.evaluate(element => element.scrollTop)).toBe(0)
      await page.mouse.wheel(0, 1150)
      await expect.poll(() => area.evaluate(element => Math.abs(element.scrollTop - 1150))).toBeLessThanOrEqual(1)
      await readerReady(2)
      console.log(`PASS ${engineName} ${compression ? 'Compression' : 'Original'}: held same-size metadata preserves native 1150px wheel scroll and explicit page requests`)
    } finally {
      if (artifacts) await writeFile(join(artifacts, `${engineName}-${compression ? 'compression' : 'original'}-reader-scroll.json`), JSON.stringify(await page.evaluate(() => ({
        releaseTop: window.fixture.readerReleaseTop, finalTop: document.querySelector('.pdf-canvas-area')?.scrollTop,
        writes: window.fixture.readerWrites,
      })), null, 2))
      await show({document: null})
    }
  }
  const readerResources = {}
  try {
    // A page proxy can arrive after unmount because getPage itself is not abortable.
    await page.evaluate(() => window.fixture.showReader(false))
    await readerReady(1)
    await page.waitForFunction(() => window.fixture.readerPending.length > 0)
    const cleanupStart = await page.evaluate(() => window.fixture.cleanups.length)
    await show({document: null})
    await expect(area).toHaveCount(0)
    const rendersAtUnmount = await page.evaluate(() => window.fixture.renders.length)
    await page.evaluate(() => window.fixture.releaseReaderPage())
    await settle()
    readerResources.latePage = await page.evaluate(start => ({
      cleaned: window.fixture.cleanups.slice(start), active: window.fixture.active,
      renders: window.fixture.renders.length,
    }), cleanupStart)
    assert(readerResources.latePage.cleaned.includes('reader:2'), 'Late unmounted reader page was not cleaned up')
    assert.equal(readerResources.latePage.active, 0)
    assert.equal(readerResources.latePage.renders, rendersAtUnmount, 'Late unmounted page started rendering')
    console.log(`PASS ${engineName}: actual PDFPages cleans up a late page proxy without rendering after unmount`)

    // Canceled raster tasks must release detached staging pixels, not just DOM canvases.
    await page.evaluate(() => window.fixture.showReader(false))
    await readerReady(1)
    await page.evaluate(() => window.fixture.releaseReaderPage())
    await expect.poll(() => page.locator('.pdf-paper[data-page="2"] canvas').evaluate(canvas => Boolean(canvas.style.width))).toBe(true)
    const canvasStart = await page.evaluate(() => window.fixture.canvases.length)
    const renderStart = await page.evaluate(() => window.fixture.renders.length)
    await page.evaluate(() => { window.fixture.holdRender = true; window.fixture.requestReader(4) })
    await page.waitForFunction(start => window.fixture.renders.slice(start).includes('reader:4'), renderStart)
    const allocated = await page.evaluate(start => window.fixture.canvases.slice(start).map(canvas => canvas.width * canvas.height), canvasStart)
    assert(allocated.length > 0 && allocated.every(pixels => pixels > 0 && pixels <= 8_000_000), 'Reader staging canvas exceeded its pixel budget')
    await show({document: null})
    await expect(area).toHaveCount(0)
    await settle()
    readerResources.canceledRender = await page.evaluate(start => ({
      remaining: window.fixture.canvases.slice(start).map(canvas => canvas.width * canvas.height),
      active: window.fixture.active,
    }), canvasStart)
    readerResources.canceledRender.allocated = allocated
    assert(readerResources.canceledRender.remaining.every(pixels => pixels === 0), 'Canceled reader staging canvases retained pixels')
    assert.equal(readerResources.canceledRender.active, 0)
    await page.evaluate(() => window.fixture.releaseRenders())
    await expect(area).toHaveCount(0)
    console.log(`PASS ${engineName}: actual PDFPages cancels raster jobs and clears all detached staging canvases`)
  } finally {
    if (artifacts) await writeFile(join(artifacts, `${engineName}-reader-resources.json`), JSON.stringify(readerResources, null, 2))
  }
  const readerJob = number => page.evaluate(number => {
    const job = window.fixture.readerJob(number)
    return job && {id: job.id, offers: job.offers, resumeCalls: job.resumeCalls, continued: job.continued, canceled: job.canceled}
  }, number)
  for (const fail of [false, true]) {
    await page.evaluate(() => window.fixture.showReader(false, true))
    try {
      await expect.poll(async () => (await readerJob(1))?.continued).toBe(1)
      await expect.poll(async () => (await readerJob(2))?.offers).toBe(1)
      assert.equal((await readerJob(2)).continued, 0, 'Neighbor rendered ahead of the loading current page')
      const oldNeighbor = (await readerJob(2)).id
      if (fail) {
        // Keep the replacement getPage pending while the old parked continuation is canceled.
        await page.evaluate(() => { window.fixture.readerHeld = true; window.fixture.rotateReader() })
        await page.waitForFunction(id => window.fixture.readerJobs.find(job => job.id === id)?.canceled, oldNeighbor)
        await page.waitForFunction(() => window.fixture.readerPending.length > 0)
      }
      await page.evaluate(() => window.fixture.requestReader(2))
      await expect(area).toHaveAttribute('aria-label', 'PDF page 2 of 6')
      if (fail) {
        await settle()
        assert.equal(await page.evaluate(id => window.fixture.readerJobs.find(job => job.id === id).resumeCalls, oldNeighbor), 0, 'Replaced parked continuation was resumed')
        await page.evaluate(() => window.fixture.releaseReaderPage())
      }
      await expect.poll(async () => (await readerJob(2))?.continued).toBe(1)
      await page.evaluate(() => window.fixture.yieldReader(1))
      await expect.poll(async () => (await readerJob(1))?.offers).toBe(2)
      assert.equal((await readerJob(1)).continued, 1, 'Previous page did not park at its next continuation')
      await page.evaluate(fail => window.fixture.finishReader(2, fail), fail)
      await expect(area).toHaveAttribute('aria-busy', 'false')
      await expect.poll(async () => (await readerJob(1))?.continued).toBe(2)
      if (fail) assert.equal(await page.evaluate(() => window.fixture.readerStates.at(-1)?.error), 'Synthetic reader render failure')
      else await readerReady(2)
      await page.evaluate(() => window.fixture.finishReader(1))
      await settle()
      if (fail) assert.equal(await page.evaluate(() => window.fixture.readerStates.at(-1)?.error), 'Synthetic reader render failure', 'Background success cleared the current-page error')
      else {
        await page.evaluate(() => window.fixture.requestReader(4))
        await expect.poll(async () => (await readerJob(5))?.offers).toBe(1)
        assert.equal((await readerJob(5)).continued, 0)
        await show({document: null})
        await expect(area).toHaveCount(0)
        await settle()
        assert.equal((await readerJob(5)).canceled, true, 'Unmount did not cancel a parked render')
        assert.equal((await readerJob(5)).resumeCalls, 0, 'Unmount resumed a parked render')
      }
      console.log(`PASS ${engineName}: parked Original continuations resume on current-page ${fail ? 'error' : 'success'}, preserve priority, and cancel safely`)
    } finally {
      await show({document: null})
      await settle()
      if (artifacts) await writeFile(join(artifacts, `${engineName}-reader-priority-${fail ? 'error' : 'success'}.json`), JSON.stringify(await page.evaluate(() => ({
        jobs: window.fixture.readerJobs.map(({id, number, offers, resumeCalls, continued, canceled}) => ({id, number, offers, resumeCalls, continued, canceled})),
        states: window.fixture.readerStates,
      })), null, 2))
    }
  }
  const sharedRequests = number => requests.filter(address => {
    const url = new URL(address, origin)
    return url.searchParams.get('document') === 'shared-request-fixture' && Number(url.searchParams.get('page')) === number
  }).length
  holdCompressed = true
  await page.evaluate(() => { window.fixture.startShared('leader'); window.fixture.startShared('waiter') })
  await expect.poll(() => sharedRequests(1)).toBe(1)
  const failedBeforeShared = failedRequests.length
  await page.evaluate(() => window.fixture.shared.leader.controller.abort())
  await expect.poll(() => page.evaluate(() => window.fixture.shared.leader.state)).toBe('AbortError')
  await settle()
  assert.equal(failedRequests.length, failedBeforeShared, 'One consumer aborted the shared transfer')
  assert.equal(await page.evaluate(() => window.fixture.shared.waiter.state), 'pending')
  holdCompressed = false
  heldCompressed.splice(0).forEach(release => release())
  await expect.poll(() => page.evaluate(() => window.fixture.shared.waiter.state)).toBe('ready')
  await page.evaluate(() => window.fixture.startShared('cached'))
  await expect.poll(() => page.evaluate(() => window.fixture.shared.cached.state)).toBe('ready')
  assert.equal(sharedRequests(1), 1, 'Shared completion was not cached')
  assert(await page.evaluate(() => window.fixture.shared.waiter.image === window.fixture.shared.cached.image))
  holdCompressed = true
  await page.evaluate(() => window.fixture.startShared('last', 2))
  await expect.poll(() => sharedRequests(2)).toBe(1)
  await page.evaluate(() => window.fixture.shared.last.controller.abort())
  await expect.poll(() => failedRequests.length).toBe(failedBeforeShared + 1)
  holdCompressed = false
  heldCompressed.splice(0).forEach(release => release())
  await page.evaluate(() => window.fixture.startShared('retry', 2))
  await expect.poll(() => page.evaluate(() => window.fixture.shared.retry.state)).toBe('ready')
  assert.equal(sharedRequests(2), 2, 'Last-consumer abort poisoned the retry cache')
  console.log(`PASS ${engineName}: shared Compression consumers cancel independently, cache one result, and abort/retry the last consumer`)

  // Large JPEGs make density meaningful; page 2 changes width within the same size bucket.
  const readerImages = await page.evaluate(async () => {
    const images = []
    for (const width of [1440, 1536]) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 1920
      const context = canvas.getContext('2d'); context.fillStyle = '#183f35'; context.fillRect(0, 0, width, 1920)
      context.fillStyle = '#ecd7a6'; context.fillRect(width / 4, 480, width / 2, 960)
      images.push([...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9))).arrayBuffer())])
      canvas.width = canvas.height = 0
    }
    return images
  })
  readerJPEG = Buffer.from(readerImages[0])
  readerWideJPEG = Buffer.from(readerImages[1])
  readerMixed = true
  await page.setViewportSize({width: 390, height: 844})
  const readerRequests = number => requests.filter(address => {
    const url = new URL(address, origin)
    return url.searchParams.get('document') === 'reader-compressed-fixture' && Number(url.searchParams.get('page')) === number
  }).length
  const beforeNeighbor = readerRequests(2), beforeThird = readerRequests(3)
  await page.evaluate(() => { window.fixture.resetReaderImages(); window.fixture.showReader(true, false, {navigation: 'horizontal'}) })
  await readerReady(1)
  await page.waitForFunction(() => window.fixture.readerPending.length > 0)
  assert.equal(readerRequests(2), beforeNeighbor + 1, 'Reader did not start one lookahead')
  assert.equal(readerRequests(3), beforeThird, 'Lookahead walked beyond one page')
  assert.deepEqual(await page.evaluate(() => window.fixture.readerDecoded), [1], 'Lookahead decoded offscreen pixels')
  await page.evaluate(() => window.fixture.requestReader(2))
  await settle()
  assert.equal(readerRequests(2), beforeNeighbor + 1, 'Promotion restarted the held JPEG')
  holdCompressed = true // Keep the next lookahead in flight for the unmount check.
  await page.evaluate(() => window.fixture.releaseReaderPage())
  await readerReady(2)
  assert.equal(readerRequests(2), beforeNeighbor + 1)
  assert.deepEqual(await page.evaluate(() => window.fixture.readerDecoded), [1, 2], 'Geometry adoption decoded the same JPEG twice')
  const compressionQuality = await page.locator('.compressed-paper canvas').evaluate(canvas => {
    const width = parseFloat(canvas.style.width), height = parseFloat(canvas.style.height)
    const expected = Math.min(Math.max(2, devicePixelRatio), 3, Math.sqrt(8_000_000 / (width * height)))
    return {width, height, density: canvas.width / width, expected, pixels: canvas.width * canvas.height,
      center: [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data]}
  })
  assert.equal(compressionQuality.width, 640 * 1.2, 'Fixed zoom did not adopt measured page width')
  assert(compressionQuality.density >= compressionQuality.expected - .01 && compressionQuality.pixels <= 8_000_000, 'Compression changed density or its pixel budget')
  assert(compressionQuality.center[0] > 200 && compressionQuality.center[3] === 255, 'JPEG pixels were lost during promotion')
  await expect.poll(() => readerRequests(3)).toBe(beforeThird + 1)
  const failedBeforeLookaheadClose = failedRequests.length
  await page.evaluate(() => { window.readerRemovedCanvases = [...document.querySelectorAll('.compressed-paper canvas')] })
  await show({document: null})
  await expect.poll(() => failedRequests.length).toBe(failedBeforeLookaheadClose + 1)
  holdCompressed = false
  heldCompressed.splice(0).forEach(release => release())
  await settle()
  assert(await page.evaluate(() => window.readerRemovedCanvases.every(canvas => canvas.width === 0 && canvas.height === 0)))
  assert.equal((await stats()).bitmapOpened, (await stats()).bitmapClosed)
  measurements.push({label: 'compressed promotion quality', ...compressionQuality})
  console.log(`PASS ${engineName}: one encoded lookahead promotes without restart/decode duplication, preserves quality, and cancels on unmount`)

  const coldStart = requests.length
  holdCompressed = true
  await page.evaluate(() => { window.fixture.resetReaderImages(); window.fixture.showReader(true, true, {page: 4}) })
  await expect.poll(() => requests.length).toBe(coldStart + 1)
  assert.equal(new URL(requests[coldStart], origin).searchParams.get('page'), '4', 'Offscreen page started before the cold current page')
  holdCompressed = false
  heldCompressed.splice(0).forEach(release => release())
  await readerReady(4)
  assert.equal(await page.evaluate(() => window.fixture.readerDecoded[0]), 4, 'Offscreen decode preceded current-page decode')
  await show({document: null})
  await expect(area).toHaveCount(0)

  // A cache clear can leave a BFCache-restored document active; read it, but do not warm uncachable bytes.
  await page.evaluate(() => { window.fixture.resetReaderImages(); window.fixture.showReader(true, false, {navigation: 'horizontal'}) })
  await readerReady(1)
  await page.waitForFunction(() => window.fixture.readerPending.length > 0)
  await page.evaluate(() => { window.dispatchEvent(new Event('artiface:pdf-cache-cleared')); window.fixture.releaseReaderPage() })
  const beforeOldGenerationNeighbor = readerRequests(5)
  await page.evaluate(() => window.fixture.requestReader(4))
  await readerReady(4)
  await settle()
  assert.equal(readerRequests(5), beforeOldGenerationNeighbor, 'Old-generation reader warmed bytes it cannot retain')
  await show({document: null})
  console.log(`PASS ${engineName}: Compression prioritizes cold current work and keeps old-generation readers usable without lookahead`)

  assert.deepEqual(errors, [])
  assert.deepEqual(await page.evaluate(() => window.fixtureUnhandled), [])
  if (artifacts) await writeFile(join(artifacts, `${engineName}-measurements.json`), JSON.stringify({measurements, stats: result, requests, errors}, null, 2))
  console.log(`PASS ${engineName}: bounded 10k overview, two render slots, cancellation/replacement/cleanup, keyboard focus, 320/390/768px at 140% both densities, compressed fetch/bitmap cleanup, real PDF.js mixed sizes and rotations, original PDF 401 session invalidation and canceled 401 suppression`)
} finally {
  await browser.close()
}
