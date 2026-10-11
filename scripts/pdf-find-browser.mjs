import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, expect } = require('@playwright/test')
const entry = join(repository, 'web/src/__pdf_find_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'pdf-find-fixture',
    resolveId(id, importer) {
      if (importer?.startsWith('\0') && (id === 'react' || id === 'react/jsx-runtime')) return require.resolve(id)
      if (id === entry) return id
      if (id.endsWith('.css') || id.includes('?worker') || id.includes('.svg?') || id.endsWith('pdfCompatibility')) return '\0fixture-empty'
      if (id === 'pdfjs-dist/legacy/build/pdf.mjs') return '\0fixture-pdf'
      if (id === '../api') return '\0fixture-api'
      if (id === './PDFPages') return '\0fixture-pages.tsx'
    },
    load(id) {
      if (id === '\0fixture-empty') return 'export default ""'
      if (id === '\0fixture-pages.tsx') return `
        import {createElement, useEffect} from 'react'
        export default function PDFPages({request,onState}) {
          useEffect(() => {onState({loading:false,scale:1})}, [onState])
          return createElement('div', {className: 'pdf-canvas-area', tabIndex: 0, 'data-current-page': request.page}, 'Mounted page ' + request.page)
        }
      `
      if (id === '\0fixture-api') return `
        export class APIError extends Error {}
        export const apiURL = (kind, location) => '/api/' + kind + '?path=' + encodeURIComponent(location.path)
        export const errorMessage = error => String(error)
        export const isAborted = error => error?.name === 'AbortError'
        export const sessionExpired = () => {}
        export async function api(url) {
          window.pdfFixture.requests.push(url)
          if (url === '/api/pdf/info') return {id: 'compressed', pages: 73, width: 600, height: 800, version: 'v1', size: 1024}
          if (url.startsWith('/api/file-info?')) return {size: 1024, version: String(window.pdfFixture.version)}
          throw new Error('Unexpected API request: ' + url)
        }
      `
      if (id === '\0fixture-pdf') return `
        export const GlobalWorkerOptions = {}
        export const AnnotationMode = {ENABLE: 1}
        export function getDocument(options) {
          const fixture = window.pdfFixture
          fixture.originalLoads.push(options.url)
          const docId = 'document-' + fixture.originalLoads.length
          const version = fixture.version
          const task = {docId, destroy: async () => {}}
          const document = {numPages: 73, loadingTask: task, async getPage(number) {
            fixture.reads.push({docId, number})
            const page = {streamTextContent() {
              fixture.streams.push({docId, number})
              return new ReadableStream({start(controller) {
                const text = number === 9 || number === 73 ? (version === 0 ? 'needle' : 'replacement needle') : 'other text'
                controller.enqueue({items: [{str: text, hasEOL: false}]})
                controller.close()
              }})
            }}
            if (number === 2 && fixture.holdNext) {
              fixture.holdNext = false
              return new Promise(resolve => { fixture.release = () => resolve(page) })
            }
            return page
          }}
          task.promise = Promise.resolve(document)
          return task
        }
      `
      if (id === entry) return `
        import {useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import PDFViewer from './components/PDFViewer'
        import ReaderActions from './components/ReaderActions'
        import {useReaderFullscreen} from './components/useReaderFullscreen'
        import {setPreferences} from './preferences'
        window.pdfFixture = {version: 0, requests: [], originalLoads: [], reads: [], streams: [], holdNext: false, release: null}
        function App() {
          const [revision, setRevision] = useState(0)
          const [path, setPath] = useState('/one.pdf')
          const [hidden, setHidden] = useState(false)
          const {element, expanded, enter, exit} = useReaderFullscreen()
          return <div ref={element} className={expanded ? 'reader-expanded' : ''}>
            <div className="fixture-controls">
              <button onClick={() => setHidden(value => !value)}>Toggle toolbars</button>
              <button onClick={expanded ? exit : enter}>Toggle fullscreen</button>
              <button onClick={() => {window.pdfFixture.version++; setRevision(value => value + 1)}}>Replace PDF</button>
              <button onClick={() => setPath('/two.pdf')}>Change source</button>
              <button onClick={() => setPreferences({pdfCompression: true})}>Enable compression</button>
            </div>
            <main className={hidden ? 'reader-toolbars-hidden' : ''}>
              <PDFViewer location={{host:'fixture', path}} forceRefreshToken={revision}
                renderActions={extra => <div className="file-actions"><ReaderActions paused={false} busy={false} interval={10}
                  onPause={() => {}} onRefresh={() => {}} copied={false} onCopy={() => {}}
                  downloadURL="/original.pdf" name="fixture.pdf" extra={extra}/></div>} />
            </main>
          </div>
        }
        createRoot(document.getElementById('root')).render(<App/>)
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'viewers.css', 'components/pdfFind.css', 'components/pdfNavigation.css', 'components/pdfOverview.css']
  .map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://pdf-find-fixture.invalid'
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(5000)
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.stack ?? error.message))
  const network = []
  await page.route('**/*', route => {
    network.push(route.request().url())
    if (route.request().url() !== origin + '/') return route.abort()
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>${css}
      main {height: 600px; display: flex} .fixture-controls {display: flex; flex-wrap: wrap}</style>
      <div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
  })
  await page.goto(origin)
  const input = page.getByRole('searchbox', { name: 'Find text in PDF' })
  const status = page.locator('.pdf-find-status')
  const options = page.getByRole('button', { name: 'Reader options', exact: true })
  const open = async () => {
    await options.click()
    await page.getByRole('button', { name: 'Find in PDF', exact: true }).click()
    await expect(input).toBeFocused()
  }
  const currentPage = number => expect(page.locator('[data-current-page]')).toHaveAttribute('data-current-page', String(number))
  await open()
  await input.fill('needle')
  await expect(status).toHaveText('2 matching pages · 73/73 pages searched')
  assert.equal(await page.evaluate(() => window.pdfFixture.reads.length), 73)
  await open()
  await expect(input).toHaveValue('needle')
  await page.getByRole('button', { name: 'Next matching page', exact: true }).click()
  await currentPage(9)
  await page.getByRole('button', { name: 'Next matching page', exact: true }).click()
  await currentPage(73)
  await page.getByRole('button', { name: 'Previous matching page', exact: true }).click()
  await currentPage(9)
  await input.press('Shift+Enter')
  await currentPage(73)
  await input.press('Enter')
  await currentPage(9)
  await input.fill('missing')
  await expect(status).toContainText('0 matching pages · 73/73 pages searched')
  assert.equal(await page.evaluate(() => window.pdfFixture.reads.length), 73, 'Typing another query re-extracted cached pages')

  await page.setViewportSize({ width: 320, height: 740 })
  assert.equal(await page.locator('.pdf-toolbar > .pdf-find').count(), 1, 'Find escaped the existing toolbar')
  assert(await page.evaluate(() => {
    const toolbar = document.querySelector('.pdf-toolbar').getBoundingClientRect()
    const controls = [...document.querySelectorAll('.pdf-find-controls > *')].map(element => element.getBoundingClientRect())
    return document.documentElement.scrollWidth <= innerWidth && controls.every(rect => rect.left >= toolbar.left && rect.right <= toolbar.right && rect.width > 0)
  }), 'Find controls overflowed the narrow toolbar')
  await page.getByRole('button', { name: 'Toggle toolbars', exact: true }).click()
  await expect(input).toBeHidden()
  await page.getByRole('button', { name: 'Toggle toolbars', exact: true }).click()
  await expect(input).toBeVisible()
  await page.getByRole('button', { name: 'Toggle fullscreen', exact: true }).click()
  await expect(input).toBeHidden()
  await page.getByRole('button', { name: 'Toggle fullscreen', exact: true }).click()
  await expect(input).toBeVisible()
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await page.waitForFunction(() => !document.fullscreenElement)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  // A late native exit notification must not override Find's return focus.
  await page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
  await expect(options).toBeFocused()

  const fullscreen = page.getByRole('button', { name: 'Toggle fullscreen', exact: true })
  await fullscreen.focus()
  await fullscreen.click()
  await expect(page.locator('.pdf-toolbar')).toBeHidden()
  await fullscreen.click()
  await page.waitForFunction(() => !document.fullscreenElement)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(fullscreen).toBeFocused()

  await open()
  await input.fill('needle')
  await expect(status).toContainText('2 matching pages')
  await page.getByRole('button', { name: 'Replace PDF', exact: true }).click()
  await expect(input).toHaveCount(0)
  await open()
  await expect(input).toHaveValue('')
  await input.fill('replacement')
  await expect(status).toHaveText('2 matching pages · 73/73 pages searched')
  await page.getByRole('button', { name: 'Change source', exact: true }).click()
  await expect(input).toHaveCount(0)

  // A late page from the previous query must not publish or start a stream.
  await page.evaluate(() => { window.pdfFixture.holdNext = true })
  await open()
  await input.fill('other')
  await page.waitForFunction(() => window.pdfFixture.release !== null)
  await input.fill('needle')
  await expect(status).toHaveText('2 matching pages · 73/73 pages searched')
  const streamCount = await page.evaluate(() => window.pdfFixture.streams.length)
  await page.evaluate(() => { window.pdfFixture.release(); window.pdfFixture.release = null })
  await expect(status).toHaveText('2 matching pages · 73/73 pages searched')
  assert.equal(await page.evaluate(() => window.pdfFixture.streams.length), streamCount)

  for (const action of ['Close PDF find', 'Replace PDF']) {
    await page.getByRole('button', { name: 'Replace PDF', exact: true }).click()
    await expect(input).toHaveCount(0)
    await page.evaluate(() => { window.pdfFixture.holdNext = true })
    await open()
    await input.fill('needle')
    await page.waitForFunction(() => window.pdfFixture.release !== null)
    await page.getByRole('button', { name: action, exact: true }).click()
    await expect(input).toHaveCount(0)
    const streamsBeforeRelease = await page.evaluate(() => window.pdfFixture.streams.length)
    await page.evaluate(() => { window.pdfFixture.release(); window.pdfFixture.release = null })
    await expect(input).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.pdfFixture.streams.length), streamsBeforeRelease, `${action} allowed late extraction`)
  }
  await open()
  await input.fill('replacement')
  await expect(status).toHaveText('2 matching pages · 73/73 pages searched')
  await page.getByRole('button', { name: 'Enable compression', exact: true }).click()
  await expect(input).toHaveCount(0)

  // Start directly in Compression: Find must not load an Original document.
  await page.reload()
  await options.click()
  await expect(page.getByRole('button', { name: 'Find in PDF · Original mode only', exact: true })).toBeDisabled()
  assert.equal(await page.evaluate(() => window.pdfFixture.originalLoads.length), 0)
  assert.deepEqual(await page.evaluate(() => window.pdfFixture.requests), ['/api/pdf/info'])
  assert(network.every(url => url === origin + '/'), 'Find made an unexpected network request')
  assert.deepEqual(errors, [])
  console.log('PASS: PDF find UI, all-page navigation, query cancellation, replacement/source reset, focus, narrow toolbar, toolbar/fullscreen hiding, and Compression isolation')
} catch (error) {
  if (errors.length) console.error('PDF fixture errors:', errors)
  throw error
} finally { await browser.close() }
