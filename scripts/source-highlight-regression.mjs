import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileLanguage } from '../web/src/fileLanguage.ts'
import { boundedHighlight, sourceHighlightDeadline } from '../web/src/highlightLimits.ts'

assert.equal(fileLanguage('src/app.TSX'), 'typescript')
assert.equal(fileLanguage('folder/.env.test'), 'ini')
assert.equal(fileLanguage('/home/.bashrc'), 'bash')
assert.equal(fileLanguage('notes.txt'), 'plaintext')
assert(boundedHighlight('<span>x</span>'.repeat(10_000)))
assert(!boundedHighlight('<span>x</span>'.repeat(10_001)))
assert(boundedHighlight('x'.repeat(1024 * 1024)))
assert(!boundedHighlight('x'.repeat(1024 * 1024 + 1)))
assert(!boundedHighlight('𝄞'.repeat(262_145)), 'Markup byte limit ignored non-ASCII text')
assert(!boundedHighlight(null))

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { build } = await import(require.resolve('vite'))
const { chromium, expect } = require('@playwright/test')
const temporary = await mkdtemp(join(tmpdir(), 'artiface-source-highlight-'))
const snapshot = join(temporary, 'web')
let server
let browser
try {
  // Use the real Vite worker pipeline and project configuration, entirely outside shared dist.
  await cp(join(repository, 'web/src'), join(snapshot, 'src'), { recursive: true })
  await cp(join(repository, 'web/public'), join(snapshot, 'public'), { recursive: true })
  for (const name of ['package.json', 'vite.config.ts', 'index.html']) await cp(join(repository, 'web', name), join(snapshot, name))
  await symlink(join(repository, 'web/node_modules'), join(snapshot, 'node_modules'), 'dir')
  await writeFile(join(snapshot, 'src/main.tsx'), `
    import {StrictMode} from 'react'
    import {createRoot} from 'react-dom/client'
    import {flushSync} from 'react-dom'
    import SourceViewer from './components/SourceViewer'
    import './styles.css'
    const root = createRoot(document.getElementById('root'))
    let props = {text: 'const initial = "<safe>";', path: 'source.js', wrap: false}
    window.renderSource = patch => {
      props = {...props, ...patch}
      flushSync(() => root.render(<StrictMode><div style={{height: '600px', display: 'flex'}}><SourceViewer {...props} lines={props.text.split('\\n').length}/></div></StrictMode>))
    }
    window.unmountSource = () => flushSync(() => root.render(null))
    window.renderSource()
  `)
  const result = await build({ root: snapshot, configFile: join(snapshot, 'vite.config.ts'), logLevel: 'error' })
  const output = (Array.isArray(result) ? result : [result]).flatMap(item => item.output)
  const mainModules = output.filter(item => item.type === 'chunk').flatMap(item => Object.keys(item.modules))
  assert(!mainModules.some(id => id.includes('/highlight.js/') || id.endsWith('/src/highlight.ts')), 'SourceViewer imported the highlighter into the main thread')
  const workerAsset = output.find(item => /highlight\.worker-[^/]+\.js$/.test(item.fileName))
  assert(workerAsset, 'Vite did not emit a dedicated highlight worker asset')
  const distribution = join(snapshot, 'dist')
  server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host}`
    // These script/worker sources match the app's /assets/ restriction; no blob/inline scripts are needed.
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${origin}/assets/; style-src ${origin}/assets/ 'unsafe-inline'; worker-src ${origin}/assets/; object-src 'none'; base-uri 'none'`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      const path = new URL(request.url, origin).pathname
      if (path.includes('..')) throw new Error('Invalid fixture path')
      const file = path === '/' ? 'index.html' : path.slice(1)
      const body = await readFile(join(distribution, file))
      response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream')
      response.end(body)
    } catch {
      response.statusCode = 404
      response.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })

  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.addInitScript(() => {
    window.fixtureWorkers = []
    window.fixtureCSP = []
    document.addEventListener('securitypolicyviolation', event => window.fixtureCSP.push(event.violatedDirective))
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options)
        this.record = { url: String(url), type: options?.type, terminated: 0 }
        window.fixtureWorkers.push(this.record)
        this.addEventListener('message', event => { this.record.result = event.data === null ? null : 'markup' })
      }
      terminate() { this.record.terminated++; super.terminate() }
    }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // Worker startup depends on runner load; the deadline is checked with controlled time below.
  await page.clock.pauseAt(new Date('2030-01-01T00:00:00Z'))
  await page.goto(origin)
  const code = page.locator('.source-code code')
  await expect(code.locator('span').first()).toBeVisible()
  await expect(code).toHaveText('const initial = "<safe>";')
  await expect.poll(() => page.evaluate(() => window.fixtureWorkers.every(worker => worker.terminated === 1))).toBe(true)
  const workers = await page.evaluate(() => window.fixtureWorkers)
  assert(workers.every(worker => worker.type === 'module' && new URL(worker.url).pathname.startsWith('/assets/highlight.worker-')))
  const dense = '[' + '0,'.repeat(74_999) + '0]'
  await page.evaluate(text => window.renderSource({ text, path: 'dense.json' }), dense)
  await expect.poll(() => page.evaluate(() => window.fixtureWorkers.at(-1).result)).toBe(null)
  await expect(code).toHaveText(dense)
  await expect(code.locator('span')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.fixtureWorkers.at(-1).terminated)).toBe(1)
  await page.evaluate(() => window.renderSource({ text: '<img src=x onerror=alert(1)>', path: 'source.html' }))
  await expect(code.locator('span').first()).toBeVisible()
  await expect(code.locator('img')).toHaveCount(0)
  await expect(code).toHaveText('<img src=x onerror=alert(1)>')
  assert.deepEqual(await page.evaluate(() => window.fixtureCSP), [])
  assert.deepEqual(errors, [])
  await context.close()
  console.log('PASS: Real Vite module-worker asset under app-style CSP; highlighter absent from main bundle; dense 150k JSON stays plain; HTML escaped')

  const controlled = await browser.newContext({ serviceWorkers: 'block' })
  await controlled.addInitScript(() => {
    window.fixtureWorkers = []
    window.Worker = class {
      constructor(url, options) {
        this.url = String(url)
        this.options = options
        this.terminated = 0
        window.fixtureWorkers.push(this)
      }
      postMessage(request) {
        this.request = request
        // Retain callbacks to simulate an already queued event after termination.
        this.deliver = markup => this.onResult({ data: markup })
        this.onResult = this.onmessage
        this.fail = this.onerror
        this.badMessage = this.onmessageerror
      }
      terminate() { this.terminated++ }
    }
  })
  const fake = await controlled.newPage()
  fake.on('pageerror', error => errors.push(error.message))
  await fake.clock.pauseAt(new Date('2030-01-01T00:00:00Z'))
  await fake.goto(origin)
  const plain = fake.locator('.source-code code')
  await expect(plain).toHaveText('const initial = "<safe>";')
  await expect.poll(() => fake.evaluate(() => window.fixtureWorkers.length)).toBeGreaterThan(0)
  await fake.evaluate(() => { window.originalCode = document.querySelector('.source-code code') })
  assert.equal(await plain.locator('span').count(), 0, 'Source was not plain before the worker completed')
  await fake.evaluate(() => window.fixtureWorkers.at(-1).deliver('<span class="hljs-keyword">const</span> initial = "&lt;safe&gt;";'))
  await expect(plain.locator('span')).toHaveCount(1)
  assert(await fake.evaluate(() => window.originalCode === document.querySelector('.source-code code')), 'Highlighting replaced the code element')
  const completedCount = await fake.evaluate(() => window.fixtureWorkers.length)
  await fake.evaluate(() => window.renderSource({ wrap: true }))
  await fake.evaluate(() => window.renderSource())
  assert.equal(await fake.evaluate(() => window.fixtureWorkers.length), completedCount, 'Unchanged text started another worker')

  await fake.evaluate(() => {
    window.renderSource({ text: 'const old = 1;' })
    window.oldWorker = window.fixtureWorkers.at(-1)
    window.renderSource({ text: 'const current = 2;' })
  })
  await expect(plain).toHaveText('const current = 2;')
  await expect(plain.locator('span')).toHaveCount(0)
  assert.equal(await fake.evaluate(() => window.oldWorker.terminated), 1, 'Replacement did not terminate the old worker')
  await fake.evaluate(() => window.oldWorker.deliver('<span>stale source</span>'))
  await expect(plain).toHaveText('const current = 2;')
  await fake.evaluate(() => window.fixtureWorkers.at(-1).deliver('<span>const current = 2;</span>'))
  await expect(plain.locator('span')).toHaveCount(1)

  await fake.evaluate(() => {
    window.renderSource({ text: 'const selected = 3;' })
    const node = document.querySelector('.source-code code')
    const range = document.createRange()
    range.selectNodeContents(node)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    window.selectionBefore = getSelection().toString()
    window.fixtureWorkers.at(-1).deliver('<span>const selected = 3;</span>')
  })
  assert.equal(await fake.evaluate(() => getSelection().toString()), 'const selected = 3;')
  await expect(plain.locator('span')).toHaveCount(0)
  assert.equal(await fake.evaluate(() => window.fixtureWorkers.at(-1).terminated), 1)
  await fake.evaluate(() => {
    getSelection().removeAllRanges()
    window.renderSource({ text: 'const dragging = 4;' })
    document.querySelector('.source-code code').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    window.fixtureWorkers.at(-1).deliver('<span>const dragging = 4;</span>')
    window.dispatchEvent(new PointerEvent('pointerup'))
  })
  await expect(plain.locator('span')).toHaveCount(0)
  assert(await fake.evaluate(() => window.originalCode === document.querySelector('.source-code code')))
  console.log('PASS: Immediate plain text, stable code node, no repeated work, stale-worker rejection, active selection and selection gesture preservation')

  await fake.evaluate(() => {
    window.renderSource({ text: 'const slow = 5;' })
    window.slowWorker = window.fixtureWorkers.at(-1)
  })
  await fake.clock.runFor(sourceHighlightDeadline - 1)
  assert.equal(await fake.evaluate(() => window.slowWorker.terminated), 0, 'Worker terminated before its deadline')
  await fake.clock.runFor(1)
  assert.equal(await fake.evaluate(() => window.slowWorker.terminated), 1, 'Worker survived its deadline')
  await fake.evaluate(() => window.slowWorker.deliver('<span>too late</span>'))
  await expect(plain).toHaveText('const slow = 5;')
  await expect(plain.locator('span')).toHaveCount(0)
  await fake.evaluate(() => {
    window.renderSource({ text: 'const failed = 6;' })
    window.fixtureWorkers.at(-1).fail({ preventDefault() { window.errorPrevented = true } })
  })
  await expect(plain).toHaveText('const failed = 6;')
  assert(await fake.evaluate(() => window.errorPrevented))
  assert.equal(await fake.evaluate(() => window.fixtureWorkers.at(-1).terminated), 1)
  await fake.evaluate(() => {
    window.renderSource({ text: 'const unreadable = 7;' })
    window.fixtureWorkers.at(-1).badMessage(new Event('messageerror'))
  })
  assert.equal(await fake.evaluate(() => window.fixtureWorkers.at(-1).terminated), 1)
  for (const excessive of ['x'.repeat(1024 * 1024 + 1), '<span>x</span>'.repeat(10_001), '𝄞'.repeat(262_145)]) {
    await fake.evaluate(markup => {
      window.renderSource({ text: `const bounded = ${window.fixtureWorkers.length};` })
      window.fixtureWorkers.at(-1).deliver(markup)
    }, excessive)
    await expect(plain.locator('span')).toHaveCount(0)
    assert.equal(await fake.evaluate(() => window.fixtureWorkers.at(-1).terminated), 1)
  }
  const previousCount = await fake.evaluate(() => window.fixtureWorkers.length)
  await fake.evaluate(() => window.renderSource({ text: 'x'.repeat(160_001) }))
  assert.equal(await fake.evaluate(() => window.fixtureWorkers.length), previousCount, 'Input cap still started a worker')
  await fake.evaluate(() => window.renderSource({ text: 'plain text', path: 'source.txt' }))
  assert.equal(await fake.evaluate(() => window.fixtureWorkers.length), previousCount, 'Plain text started a worker')
  await fake.evaluate(() => {
    window.originalScroll = document.querySelector('.source-scroll')
    window.renderSource({text:'',wrap:false})
  })
  await expect(fake.getByRole('status')).toHaveText('This file is empty.')
  await expect(plain).toHaveText('')
  await expect(fake.locator('.line-numbers')).toBeHidden()
  for (const text of [' \n\t', 'Restored source']) {
    await fake.evaluate(text => window.renderSource({text}), text)
    await expect(fake.getByRole('status')).toHaveCount(0)
    assert.equal(await plain.textContent(), text)
    await expect(plain).toBeVisible()
    assert(await fake.evaluate(() => window.originalCode === document.querySelector('.source-code code') && window.originalScroll === document.querySelector('.source-scroll')), 'Empty state replaced source nodes')
  }
  assert.equal(await fake.evaluate(() => window.fixtureWorkers.length), previousCount, 'Empty/plain content started a worker')
  console.log('PASS: empty source is quiet, whitespace stays exact, and code/scroll nodes survive empty-content transitions')
  await fake.evaluate(() => {
    window.renderSource({ text: 'const unmounted = 8;', path: 'source.js' })
    window.unmountedWorker = window.fixtureWorkers.at(-1)
    window.unmountSource()
    window.unmountedWorker.deliver('<span>unmounted</span>')
  })
  assert.equal(await fake.evaluate(() => window.unmountedWorker.terminated), 1)
  await expect(plain).toHaveCount(0)
  await fake.evaluate(() => {
    window.Worker = undefined
    window.renderSource({ text: 'const unsupported = 9;' })
  })
  await expect(plain).toHaveText('const unsupported = 9;')
  await fake.evaluate(() => {
    window.Worker = class { constructor() { throw new Error('Synthetic unsupported module worker') } }
    window.renderSource({ text: 'const blocked = 10;' })
  })
  await expect(plain).toHaveText('const blocked = 10;')
  await expect(plain.locator('span')).toHaveCount(0)
  assert.deepEqual(errors, [])
  await controlled.close()
  console.log('PASS: Deadline, replacement/unmount/error termination, late replies, input/UTF-8/span limits, and unsupported-worker fallback')
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
