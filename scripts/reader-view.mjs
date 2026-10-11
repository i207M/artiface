import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const web = fileURLToPath(new URL('../web', import.meta.url))
const origin = 'https://reader-view.invalid'
const first = { host: 'fixture-a', root: 'reports', path: 'notes.md', kind: 'file' }
const otherHost = { ...first, host: 'fixture-b' }
const otherRoot = { ...first, root: 'other' }
const source = { ...first, path: 'notes.txt' }
const anchoredSource = { ...first, path: 'anchor.txt' }
const fontSource = { ...first, path: 'font-source.md' }
const fontMarkdown = { ...first, path: 'font-markdown.md' }
const table = { ...first, path: 'table.csv' }
const pages = { ...first, path: 'pages.csv' }
const tabSeparated = { ...first, path: 'table.tsv' }
const numericTable = { ...first, path: 'numeric.csv' }
const sortedTable = { ...first, path: 'sorted.csv' }
const figures = { ...first, path: 'figures.md' }
const markdown = '# Synthetic report\n\n' + Array.from({ length: 120 }, (_, index) =>
  `Paragraph ${index} ${'synthetic reading material '.repeat(12)}\n\n`).join('')
const plain = Array.from({ length: 160 }, (_, index) => `Line ${index} ${'long source column '.repeat(30)}`).join('\n')

// Real reader/viewers and metadata, with delayed viewer mounts and synthetic responses.
// Highlight-worker behavior has its own regression; decoration is controlled here.
async function buildReader() {
  const bundle = await rolldown({
    cwd: web, input: 'fixture:reader-view', platform: 'browser',
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
    onLog(level, log, next) { if (log.code !== 'MODULE_LEVEL_DIRECTIVE') next(level, log) },
    plugins: [{
      name: 'reader-view-fixture',
      resolveId(id) {
        if (id === 'fixture:reader-view') return '\0fixture'
        if (id === './SourceViewer' || id === './MarkdownViewer' || id === './CSVViewer') return `\0gate:${id.slice(2)}`
        if (id === './useSourceHighlight') return '\0highlight'
        if (id === './PDFViewer') return '\0pdf'
        if (id.endsWith('.css')) return '\0css'
        if (id.includes('.svg?')) return '\0logo'
      },
      load(id) {
        if (id === '\0css') return ''
        if (id === '\0logo') return 'export default ""'
        if (id === '\0highlight') return `import {useState} from 'react'
          export function useSourceHighlight(text) {
            const [result, setResult] = useState(null)
            window.readerDecorate = markup => setResult({text, markup})
            return result?.text === text ? result.markup : null
          }`
        if (id === '\0pdf') return 'export default function PDF(){ return null }'
        if (id.startsWith('\0gate:')) {
          const viewer = id.slice('\0gate:'.length)
          return `import React from 'react'
            import Viewer from ${JSON.stringify(`${web}/src/components/${viewer}.tsx`)}
            export default function GatedViewer(props) {
              const gate = window.viewerGates[${JSON.stringify(viewer)}]
              if (gate) throw gate.promise
              return React.createElement(Viewer, props)
            }`
        }
        if (id === '\0fixture') return `
          import React, {useState} from 'react'
          import {createRoot} from 'react-dom/client'
          import {flushSync} from 'react-dom'
          import FilePreview from ${JSON.stringify(`${web}/src/components/FilePreview.tsx`)}
          import * as views from ${JSON.stringify(`${web}/src/components/useReaderView.tsx`)}
          import {apiURL} from ${JSON.stringify(`${web}/src/api.ts`)}
          import {setPreferences} from ${JSON.stringify(`${web}/src/preferences.ts`)}
          import * as markdownAnchor from ${JSON.stringify(`${web}/src/components/markdownFontAnchor.ts`)}
          window.markdownAnchor = markdownAnchor
          window.readerPreferences = setPreferences
          window.viewCache = views
          window.viewKey = location => apiURL('file', location)
          window.keepReaders = locations => views.retainOpenReaderViews(locations.map(window.viewKey))
          function Fixture() {
            const [location, setLocation] = useState(null)
            const [refreshToken, setRefreshToken] = useState(0)
            window.showReader = next => flushSync(() => setLocation(next))
            window.forceReaderRefresh = () => flushSync(() => setRefreshToken(value => value + 1))
            window.clickWrap = () => flushSync(() => document.querySelector('[aria-label="Wrap long lines"]').click())
            return location && React.createElement(FilePreview, {
              location, copied:false, onCopyLink(){}, onNavigate(){}, onExpand(){},
              autoRefreshPaused:true, refreshToken
            })
          }
          createRoot(document.getElementById('root')).render(React.createElement(Fixture))
        `
      },
    }],
  })
  try {
    const { output } = await bundle.generate({ format: 'iife', codeSplitting: false })
    return output.find(item => item.type === 'chunk').code
  } finally { await bundle.close() }
}

export async function checkReaderView({ browser }) {
  const code = await buildReader()
  const css = (await Promise.all(['styles.css', 'viewers.css'].map(path => readFile(`${web}/src/${path}`, 'utf8'))))
    .join('\n').replace(/@import[^;]+;/g, '')
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 800 } })
  context.setDefaultTimeout(5000)
  const page = await context.newPage()
  const errors = []
  let holdImages = false
  const pendingImages = []
  const imageResponse = { contentType: 'image/svg+xml', headers: { 'Cache-Control': 'no-store' },
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="5000"><rect width="300" height="5000" fill="teal"/></svg>' }
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.href === `${origin}/`) return route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root" style="height:600px"></div>` })
    if (url.origin === origin && /^\/p\/figures-\d+\/plot.svg$/.test(url.pathname)) {
      if (holdImages) { pendingImages.push(route); return }
      return route.fulfill(imageResponse)
    }
    // Leave the separate lazy asset unresolved; restoration must not depend on every image.
    if (url.origin === origin && /^\/p\/figures-\d+\/later.svg$/.test(url.pathname)) return
    return route.abort()
  })
  try {
    await page.goto(`${origin}/`)
    await page.evaluate(({ markdown, plain }) => {
      localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300 }))
      window.fixtureTable = (count, delimiter = ',', prefix = 'record', extraColumns = 8) => [
        ['Record', 'Score', 'Score', 'Notes', ...Array.from({ length: extraColumns }, (_, column) => `Column ${column + 5}`)],
        ...Array.from({ length: count }, (_, index) => [
          `${prefix}-${String(index + 1).padStart(3, '0')}`, String(70 + index), String(80 + index),
          `left, right; He said "hello"\nSecond line ${index + 1}`,
          ...Array.from({ length: extraColumns }, (_, column) => `Row ${index + 1} column ${column + 5} synthetic cell`),
        ]),
      ].map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(delimiter)).join('\n')
      window.fixtureText = {
        'notes.md': { text: markdown, version: 'markdown-1' },
        'font-markdown.md': { text: markdown, version: 'font-markdown-1' },
        'notes.txt': { text: plain, version: 'plain-1' },
        'table.csv': { text: window.fixtureTable(130), version: 'table-1' },
        'pages.csv': { text: window.fixtureTable(9999, ',', 'page', 0), version: 'pages-1' },
        'table.tsv': { text: window.fixtureTable(75, '\t', 'tsv'), version: 'tsv-1' },
        'figures.md': { text: '# Figures\n\n[Jump to end](#end)\n\n![Delayed plot](plot.svg)\n\n## End\n\nThe end.', version: 'figures-1' },
      }
      window.numericRows = [
        ['ID', 'Amount', 'Amount', 'Exponent', 'Padded', 'Nullable', 'Mixed', 'Maybe', 'Empty', 'Quoted', 'Newline', 'Missing'],
        ...Array.from({ length: 60 }, (_, index) => [
          String(index + 1).padStart(4, '0'), ['0', '-12', '+3', '42'][index % 4], ['0.02', '98.20', '-3.5'][index % 3],
          ['1e3', '-2.5E-4', '+3e+2'][index % 3], ' 42 ', index === 59 ? '' : '5', index === 59 ? 'end' : '7',
          index === 59 ? 'NA' : '9', '', 'left, right', '7\n', ...(index === 59 ? [] : ['8']),
        ]),
      ]
      window.numericText = window.numericRows.map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n')
      window.fixtureText['numeric.csv'] = { text: window.numericText, version: 'numeric-1' }
      window.fixtureSort = count => [
        ['Record', 'Score', 'Score', 'Notes', 'Measurements', 'Conditions'],
        ...Array.from({ length: count }, (_, index) => [
          `sort-${String(index + 1).padStart(3, '0')}`, String(index === 104 ? -1 : Math.floor(index / 2)),
          String(500 - index), 'left, right; "quoted"\n' + 'Long original cell content '.repeat(15),
          'Additional synthetic measurements '.repeat(4), 'Additional synthetic conditions '.repeat(4),
        ]),
      ].map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n')
      window.fixtureText['sorted.csv'] = { text: window.fixtureSort(130), version: 'sort-1' }
      window.anchorText = Array.from({ length: 800 }, (_, index) =>
        `Record ${index + 1}: ${index % 4 ? 'completed' : 'mixed-length source reading material '.repeat(20)}`).join('\n')
      window.fixtureText['anchor.txt'] = { text: window.anchorText, version: 'anchor-1' }
      window.fontText = Array.from({ length: 800 }, (_, index) =>
        `**record_${String(index + 1).padStart(4, '0')} ${index % 4 ? 'short' : 'wrapped café 😀 material '.repeat(8)}**\tπ\tend`).join('\r\n')
      window.fontMarkup = window.fontText.split('\r\n').map(line =>
        `<span class="hljs-strong">${line}</span>`).join('\r\n')
      window.fixtureText['font-source.md'] = { text: window.fontText, version: 'font-1' }
      window.fontRange = (start, end = start + 1) => {
        const code = document.querySelector('.source-code code')
        const point = offset => {
          const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
          let node, last
          while (node = walker.nextNode()) {
            last = node
            if (offset < node.length) return { node, offset }
            offset -= node.length
          }
          return { node: last, offset: last.length }
        }
        const a = point(start), b = point(end), range = document.createRange()
        range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset)
        return range
      }
      window.fontGeometry = target => {
        const area = document.querySelector('.source-scroll'), code = area.querySelector('code'), text = code.textContent
        if (target) {
          const offset = text.indexOf('record_0401') + (target === 'wrapped' ? 120 : 0)
          area.scrollTop += window.fontRange(offset).getBoundingClientRect().top - area.getBoundingClientRect().top - 4
          area.scrollLeft = target === 'panned' ? 260 : 0
        }
        const records = [...text.matchAll(/record_(\d{4})/g)]
        const rect = index => {
          const start = records[index].index
          let end = text.indexOf('\n', start)
          if (end < 0) end = text.length
          if (text[end - 1] === '\r') end--
          return window.fontRange(start, end).getBoundingClientRect()
        }
        let lo = 0, hi = records.length - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (rect(mid).bottom <= area.getBoundingClientRect().top + 1) lo = mid + 1
          else hi = mid
        }
        return { record: Number(records[lo][1]), top: area.scrollTop, left: area.scrollLeft }
      }
      const nativeFrame = window.requestAnimationFrame.bind(window)
      const nativeCancel = window.cancelAnimationFrame.bind(window)
      let frameID = 0
      window.wrapFrames = new Map()
      window.wrapSignals = new Set()
      window.requestAnimationFrame = callback => {
        if (!window.holdWrapFrames) return nativeFrame(callback)
        const id = --frameID
        window.wrapFrames.set(id, callback)
        return id
      }
      window.cancelAnimationFrame = id => { window.wrapFrames.delete(id); nativeCancel(id) }
      window.releaseWrapFrames = () => {
        window.holdWrapFrames = false
        const callbacks = [...window.wrapFrames.values()]
        window.wrapFrames.clear()
        for (const callback of callbacks) callback(performance.now())
      }
      for (const target of [document, window]) {
        const add = target.addEventListener.bind(target)
        target.addEventListener = (type, listener, options) => {
          if (window.holdWrapFrames && options?.signal) window.wrapSignals.add(options.signal)
          return add(type, listener, options)
        }
      }
      const hitTest = document.caretRangeFromPoint.bind(document)
      window.sourceHitTests = 0
      document.caretRangeFromPoint = (...args) => { window.sourceHitTests++; return hitTest(...args) }
      window.sourceLineGeometry = target => {
        const area = document.querySelector('.source-scroll'), code = area.querySelector('code')
        const node = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode()
        const starts = [0]
        for (let i = node.data.indexOf('\n'); i >= 0; i = node.data.indexOf('\n', i + 1)) starts.push(i + 1)
        const rect = line => {
          const range = document.createRange()
          range.setStart(node, starts[line])
          range.setEnd(node, Math.min(node.length, (starts[line + 1] ?? node.length) - 1))
          return range.getBoundingClientRect()
        }
        const top = area.getBoundingClientRect().top
        if (target) area.scrollTop += rect(target - 1).top - top - 4
        let low = 0, high = starts.length - 1
        while (low < high) {
          const mid = (low + high) >> 1
          if (rect(mid).bottom <= top + 1) low = mid + 1
          else high = mid
        }
        return { line: low + 1, top: area.scrollTop, maxTop: area.scrollHeight - area.clientHeight }
      }
      window.viewerGates = {}
      window.holdViewer = name => {
        let release
        const promise = new Promise(resolve => { release = resolve })
        window.viewerGates[name] = { promise, release }
      }
      window.releaseViewer = name => {
        const gate = window.viewerGates[name]
        delete window.viewerGates[name]
        gate.release()
      }
      window.textReads = 0
      window.heldText = []
      window.heldPreviews = []
      window.settledImages = []
      for (const type of ['load', 'error']) document.addEventListener(type, event => {
        if (event.target instanceof HTMLImageElement) window.settledImages.push(event.target.src)
      }, true)
      let previewID = 0
      window.fetch = async (address, options = {}) => {
        const url = new URL(address, location.href)
        const path = url.pathname === '/api/preview' ? JSON.parse(options.body).path : url.searchParams.get('path')
        const file = window.fixtureText[path]
        let body
        if (url.pathname === '/api/text') {
          window.textReads++
          if (window.holdText) await new Promise(resolve => window.heldText.push(resolve))
          body = { ...file, size: file.text.length, truncated: file.truncated ?? false }
        } else if (url.pathname === '/api/preview') {
          if (['figures.md', 'font-markdown.md'].includes(path) && window.holdPreview) await new Promise(resolve => window.heldPreviews.push(resolve))
          body = { version: file.version, url: ['figures.md', 'font-markdown.md'].includes(path) ? `https://reader-view.invalid/p/figures-${++previewID}/report` : 'https://reader-view.invalid/p/report',
            expiresAt: '2099-01-01T00:00:00Z', scripts: false }
        } else if (url.pathname === '/api/file-info') {
          body = { version: file.version, size: file.text.length, modified: '2026-09-21T12:00:00Z' }
        } else throw new Error(`Unexpected synthetic fetch: ${address}`)
        return new Response(JSON.stringify(body))
      }
    }, { markdown, plain })
    await page.addScriptTag({ content: code })
    await page.waitForFunction(() => Boolean(window.showReader))

    const cacheChecks = await page.evaluate(() => {
      const { retainOpenReaderViews, retainReaderView, readReaderView, clearReaderViews, readerViewGeneration } = window.viewCache
      const keys = Array.from({ length: 66 }, (_, i) => `key-${i}`)
      const snapshot = { mode: 'source', wrap: true, source: { top: 720, left: 140, offset: 123, font: '18px', version: 'v1' }, render: { top: 640, left: 0, offset: 321, font: '18px', version: 'md1' },
        table: { header: false, page: 2, sort: { column: 1, direction: 'desc' } } }
      retainOpenReaderViews(keys)
      for (const key of keys.slice(0, 65)) retainReaderView(key, snapshot, readerViewGeneration())
      const bounded = keys.filter(key => readReaderView(key)).length === 64 && !readReaderView(keys[0])
      readReaderView(keys[1])
      retainReaderView(keys[65], snapshot, readerViewGeneration())
      const lru = Boolean(readReaderView(keys[1])) && !readReaderView(keys[2])
      readReaderView(keys[1]).source.top = -100
      readReaderView(keys[1]).source.offset = -1
      readReaderView(keys[1]).table.page = -1
      readReaderView(keys[1]).table.sort.column = 8
      readReaderView(keys[1]).render.offset = -1
      snapshot.render.top = -200
      snapshot.render.offset = 987
      snapshot.source.offset = 456
      snapshot.table.header = true
      snapshot.table.sort.direction = 'asc'
      const copied = readReaderView(keys[1]).source.top === 720 && readReaderView(keys[1]).source.offset === 123 && readReaderView(keys[1]).render.top === 640 && readReaderView(keys[1]).render.offset === 321 &&
        readReaderView(keys[1]).table.page === 2 && readReaderView(keys[1]).table.header === false &&
        readReaderView(keys[1]).table.sort.column === 1 && readReaderView(keys[1]).table.sort.direction === 'desc'
      retainOpenReaderViews([keys[1]])
      retainReaderView(keys[3], snapshot, readerViewGeneration())
      const closed = !readReaderView(keys[3])
      const previous = readerViewGeneration()
      clearReaderViews()
      retainReaderView(keys[1], snapshot, previous)
      const generationGuard = !readReaderView(keys[1])
      return { bounded, lru, copied, closed, generationGuard }
    })
    assert.deepEqual(cacheChecks, { bounded: true, lru: true, copied: true, closed: true, generationGuard: true })
    await page.evaluate(locations => window.keepReaders(locations), [first, otherHost, otherRoot, source, anchoredSource, fontSource, fontMarkdown, table, pages, tabSeparated, numericTable, sortedTable, figures])

    const show = location => page.evaluate(location => window.showReader(location), location)
    const position = selector => page.locator(selector).evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))
    const scroll = (selector, top, left = 0) => page.locator(selector).evaluate((element, { top, left }) => {
      element.scrollTop = top
      element.scrollLeft = left
    }, { top, left })
    const expectPosition = async (selector, top, left = 0) => {
      await expect.poll(() => position(selector)).toEqual({ top, left })
    }
    const rendered = '.preview-content'
    const sourceArea = '.source-scroll'
    const sourceMode = page.getByRole('button', { name: 'Source', exact: true })
    const renderMode = page.getByRole('button', { name: 'Rendered', exact: true })
    const wrap = page.getByRole('toolbar', { name: 'Reader toolbar', exact: true }).getByRole('button', { name: 'Wrap long lines', exact: true })
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    const startAnchor = async (wrapped = false, line = 400) => {
      await show(null)
      await page.evaluate(({ location, wrapped }) => {
        window.fixtureText['anchor.txt'] = { text: window.anchorText, version: 'anchor-1' }
        window.viewCache.retainReaderView(window.viewKey(location), {
          mode: 'source', wrap: wrapped, source: { top: 0, left: 0 }, render: { top: 0, left: 0 },
          table: { header: true, page: 0, sort: null },
        }, window.viewCache.readerViewGeneration())
        window.wrapSignals.clear()
      }, { location: anchoredSource, wrapped })
      await show(anchoredSource)
      await expect(page.locator('.source-code code')).toContainText('Record 800:')
      await page.evaluate(line => window.sourceLineGeometry(line), line)
      await settle()
      return page.evaluate(() => window.sourceLineGeometry())
    }
    const releaseAnchor = async () => {
      await page.evaluate(() => window.releaseWrapFrames())
      await settle()
      assert(await page.evaluate(() => window.wrapFrames.size === 0 && [...window.wrapSignals].every(signal => signal.aborted)),
        'Wrap correction retained a frame or input listeners')
    }
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.evaluate(() => window.readerPreferences({ density: 'compact', theme: 'light', readerFontSize: 18, fontScale: 1 }))
    const pannedBefore = await startAnchor(false, 401)
    await scroll(sourceArea, pannedBefore.top, 600); await settle()
    const gutter = await page.locator(sourceArea).evaluate(area => {
      const box = area.getBoundingClientRect(), gutter = area.querySelector('.line-numbers').getBoundingClientRect()
      return { left: gutter.left - box.left, bottom: gutter.bottom - box.top, height: area.clientHeight }
    })
    assert(Math.abs(gutter.left) <= 1 && gutter.bottom >= gutter.height - 1, 'Source gutter escaped the viewport or lost its full-height backing')
    await wrap.click(); await settle()
    assert.equal((await page.evaluate(() => window.sourceLineGeometry())).line, pannedBefore.line, 'Horizontally panned Wrap lost the visible logical line')
    await wrap.click(); await settle()
    assert.equal((await page.evaluate(() => window.sourceLineGeometry())).line, pannedBefore.line, 'Unwrap lost the visible logical line')
    await scroll(sourceArea, pannedBefore.top, 600); await settle()
    const bounds = await page.locator(sourceArea).evaluate(area => {
      const box = area.getBoundingClientRect(), gutter = area.querySelector('.line-numbers').getBoundingClientRect()
      return { x: gutter.right + 16, y: box.top + 14, right: box.right - 20 }
    })
    await page.mouse.move(bounds.x, bounds.y); await page.mouse.down()
    await page.mouse.move(bounds.right, bounds.y, { steps: 8 }); await page.mouse.up()
    const selected = await page.evaluate(() => {
      const selection = getSelection(), code = document.querySelector('.source-code code')
      window.sourceCopied = null
      document.addEventListener('copy', () => { window.sourceCopied = getSelection()?.toString() }, { once: true })
      return { text: selection?.toString(), inCode: code.contains(selection?.anchorNode) && code.contains(selection?.focusNode) }
    })
    assert(selected.text && selected.inCode, 'Panned source selection moved into the gutter')
    await page.keyboard.press('Control+c')
    assert.equal(await page.evaluate(() => window.sourceCopied), selected.text, 'Native copy did not retain the source selection')
    await page.evaluate(() => getSelection()?.removeAllRanges())
    await page.locator(sourceArea).focus()
    const keyboardBefore = await position(sourceArea)
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await position(sourceArea)).left).toBeGreaterThan(keyboardBefore.left)
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await position(sourceArea)).top).toBeGreaterThan(keyboardBefore.top)
    await expect(page.locator(sourceArea)).toBeFocused()
    console.log('PASS: sticky gutter retains panned logical lines, full-height backing, focused keyboard scrolling, source selection and native copy events')
    for (const wrapped of [false, true]) for (const toggles of [1, 2, 3]) {
      const before = await startAnchor(wrapped)
      await page.evaluate(toggles => {
        window.holdWrapFrames = true
        for (let i = 0; i < toggles; i++) window.clickWrap()
      }, toggles)
      assert.equal(await page.evaluate(() => window.wrapFrames.size), 1, 'Rapid toggles queued more than one correction')
      await releaseAnchor()
      assert.equal((await page.evaluate(() => window.sourceLineGeometry())).line, before.line)
      const corrected = await position(sourceArea)
      await show(source); await show(anchoredSource)
      await expectPosition(sourceArea, corrected.top, corrected.left)
    }
    for (const action of ['wheel', 'keydown', 'pointerdown', 'touchstart', 'focus', 'focusout', 'click', 'blur', 'hashchange', 'scroll', 'decoration', 'text', 'unmount']) {
      await startAnchor()
      const expected = await page.evaluate(({ action, other }) => {
        window.holdWrapFrames = true
        window.clickWrap()
        const area = document.querySelector('.source-scroll'), code = area.querySelector('code')
        if (action === 'wheel') area.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
        else if (action === 'keydown') area.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
        else if (action === 'pointerdown') area.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        else if (action === 'touchstart') area.dispatchEvent(new Event('touchstart', { bubbles: true }))
        else if (action === 'focus') area.focus()
        else if (action === 'focusout') {
          const control = document.querySelector('[aria-label="Wrap long lines"]')
          control.focus()
          control.blur()
        }
        else if (action === 'click') area.click()
        else if (action === 'blur' || action === 'hashchange') window.dispatchEvent(new Event(action))
        else if (action === 'decoration') {
          const span = document.createElement('span')
          span.className = 'hljs-string'
          span.textContent = code.textContent
          code.replaceChildren(span)
        } else if (action === 'text') code.firstChild.data = code.firstChild.data.replace('Record', 'Edited')
        else if (action === 'unmount') window.showReader(other)
        if (!['decoration', 'text', 'unmount'].includes(action)) area.scrollTop = 730
        return action === 'unmount' ? null : area.scrollTop
      }, { action, other: source })
      if (!['scroll', 'decoration', 'text'].includes(action)) {
        assert.equal(await page.evaluate(() => window.wrapFrames.size), 0, `${action} did not immediately cancel its frame`)
      }
      await releaseAnchor()
      if (expected !== null) assert.equal((await position(sourceArea)).top, expected, `${action} lost to a stale Wrap correction`)
      else await expectPosition(sourceArea, 0, 0)
    }
    for (const held of [false, true]) {
      await startAnchor()
      await page.evaluate(held => {
        window.holdWrapFrames = true
        window.clickWrap()
        window.holdText = held
        window.fixtureText['anchor.txt'] = { text: window.anchorText.split('\n').slice(0, 60).join('\n'), version: 'anchor-short' }
        window.forceReaderRefresh()
      }, held)
      if (held) await expect.poll(() => page.evaluate(() => window.heldText.length)).toBe(1)
      assert.equal(await page.evaluate(() => window.wrapFrames.size), 0, 'Refresh left a pending Wrap correction')
      await releaseAnchor()
      await page.evaluate(() => {
        window.holdText = false
        for (const release of window.heldText.splice(0)) release()
      })
      await expect(page.locator('.source-code code')).not.toContainText('Record 61:')
      await settle()
      const result = await page.evaluate(() => window.sourceLineGeometry())
      assert.equal(result.top, result.maxTop, 'Short refresh did not keep its legitimate clamp')
    }
    for (const pending of [false, true]) {
      await startAnchor()
      const pixels = await page.evaluate(pending => {
        window.holdWrapFrames = true
        if (pending) window.clickWrap()
        window.readerPreferences({ readerFontSize: 28 })
        return document.querySelector('.source-scroll').scrollTop
      }, pending)
      await releaseAnchor()
      assert.equal((await position(sourceArea)).top, pixels, 'Wrap anchoring changed font-size restoration')
      await page.evaluate(() => window.readerPreferences({ readerFontSize: 18 }))
    }
    await startAnchor()
    const fallbackTop = await page.evaluate(() => {
      const hitTest = document.caretRangeFromPoint
      document.caretRangeFromPoint = () => null
      window.holdWrapFrames = true
      window.clickWrap()
      document.caretRangeFromPoint = hitTest
      return document.querySelector('.source-scroll').scrollTop
    })
    await releaseAnchor()
    assert.equal((await position(sourceArea)).top, fallbackTop, 'Missing caret anchor changed the pixel fallback')
    await startAnchor(true, 800)
    await page.evaluate(() => { window.holdWrapFrames = true; window.clickWrap() })
    await releaseAnchor()
    const end = await page.evaluate(() => window.sourceLineGeometry())
    assert.equal(end.top, end.maxTop)
    const queries = await page.evaluate(() => window.sourceHitTests)
    await scroll(sourceArea, 400); await settle()
    assert.equal(await page.evaluate(() => window.sourceHitTests), queries, 'Ordinary scrolling repeated caret scans')
    await show(null)
    console.log('PASS: Wrap retains logical lines and corrected cache through rapid toggles; input, navigation, refresh, decoration/text replacement, and unmount cancel pending work; end clamps and cleanup remain bounded')

    const startFont = async (target = 'wrapped', decorated = true) => {
      await show(null)
      await page.evaluate(({ location, target }) => {
        window.readerPreferences({ readerFontSize: 18 })
        window.fixtureText['font-source.md'] = { text: window.fontText, version: 'font-1' }
        window.viewCache.retainReaderView(window.viewKey(location), {
          mode: 'source', wrap: target === 'wrapped', render: { top: 0, left: 0 }, source: { top: 0, left: 0 },
          table: { header: true, page: 0, sort: null },
        }, window.viewCache.readerViewGeneration())
      }, { location: fontSource, target })
      await show(fontSource)
      await expect(page.locator('.source-code code')).toContainText('record_0401')
      if (decorated) {
        await page.evaluate(() => window.readerDecorate(window.fontMarkup))
        await expect(page.locator('.source-code .hljs-strong')).toHaveCount(800)
      }
      const before = await page.evaluate(target => window.fontGeometry(target), target)
      assert.equal(before.record, 401)
      await settle()
      return before
    }
    const changeFontAway = async size => {
      await show(null)
      await page.evaluate(size => window.readerPreferences({ readerFontSize: size }), size)
      await show(fontSource)
      await expect(page.locator('.source-code code')).toContainText('record_0401')
      await settle()
    }
    for (const target of ['panned', 'wrapped']) {
      await startFont(target)
      assert.equal(await page.locator('.source-code code').evaluate(code => code.textContent.includes('\r')), false)
      await changeFontAway(28)
      assert.equal(await page.locator('.source-code code').evaluate(code => code.textContent.includes('\r')), true)
      assert.equal((await page.evaluate(() => window.fontGeometry())).record, 401, 'Font restoration lost the actual record across CRLF/plain DOM')
      const plainPosition = await position(sourceArea)
      await page.evaluate(() => window.readerDecorate(window.fontMarkup))
      await expect(page.locator('.source-code .hljs-strong')).toHaveCount(800)
      assert.equal((await page.evaluate(() => window.fontGeometry())).record, 401)
      await expectPosition(sourceArea, plainPosition.top, plainPosition.left)
      await show(null); await show(fontSource)
      await expectPosition(sourceArea, plainPosition.top, plainPosition.left)
      await changeFontAway(18)
      assert.equal((await page.evaluate(() => window.fontGeometry())).record, 401)
    }
    const mismatched = await startFont('panned')
    await show(null)
    await page.evaluate(() => {
      window.readerPreferences({ readerFontSize: 28 })
      window.fixtureText['font-source.md'].version = 'font-new-version'
    })
    await show(fontSource)
    await expectPosition(sourceArea, mismatched.top, mismatched.left)
    const unavailable = await startFont('panned', false)
    await page.evaluate(() => {
      const hitTest = document.caretRangeFromPoint
      document.caretRangeFromPoint = () => null
      window.showReader(null)
      document.caretRangeFromPoint = hitTest
      window.readerPreferences({ readerFontSize: 28 })
    })
    await show(fontSource)
    await expectPosition(sourceArea, unavailable.top, unavailable.left)
    for (const newer of ['font', 'wrap', 'generation']) {
      const old = await startFont()
      await show(null)
      await page.evaluate(() => {
        window.readerPreferences({ readerFontSize: 28 })
        window.holdViewer('SourceViewer')
      })
      await show(fontSource)
      await expect(page.getByText('Preparing viewer…')).toBeVisible()
      if (newer === 'font') await page.evaluate(() => window.readerPreferences({ readerFontSize: 22 }))
      else if (newer === 'wrap') await wrap.click()
      else await page.evaluate(() => window.viewCache.clearReaderViews())
      await page.evaluate(() => window.releaseViewer('SourceViewer'))
      await expect(page.locator(sourceArea)).toBeVisible()
      if (newer === 'font') {
        assert.equal((await page.evaluate(() => window.fontGeometry())).record, 401)
        assert.equal(await page.locator(sourceArea).evaluate(area => getComputedStyle(area).fontSize), '22px')
      } else {
        const max = await page.locator(sourceArea).evaluate(area => area.scrollHeight - area.clientHeight)
        await expectPosition(sourceArea, Math.min(old.top, max), 0)
      }
      await show(null)
      if (newer === 'generation') assert.equal(await page.evaluate(location =>
        window.viewCache.readReaderView(window.viewKey(location)), fontSource), undefined)
    }
    for (const action of ['wheel', 'keydown', 'pointerdown', 'font', 'wrap']) {
      await startFont()
      await changeFontAway(28)
      if (action === 'wrap') { await wrap.click(); await settle() }
      await page.evaluate(action => {
        const area = document.querySelector('.source-scroll')
        if (action === 'font') window.readerPreferences({ readerFontSize: 22 })
        else if (action !== 'wrap') area.dispatchEvent(action === 'wheel' ? new WheelEvent('wheel', { bubbles: true })
          : action === 'keydown' ? new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })
            : new PointerEvent('pointerdown', { bubbles: true }))
        area.scrollTop = 500
      }, action)
      const newer = await position(sourceArea)
      await page.evaluate(() => window.readerDecorate(window.fontMarkup))
      await expect(page.locator('.source-code .hljs-strong')).toHaveCount(800)
      await expectPosition(sourceArea, newer.top, newer.left)
    }
    const fontHitTests = await page.evaluate(() => window.sourceHitTests)
    await scroll(sourceArea, 710); await settle()
    assert.equal(await page.evaluate(() => window.sourceHitTests), fontHitTests, 'Font support added a per-scroll caret query')
    await startFont()
    await changeFontAway(28)
    await page.evaluate(() => { window.oldFontDecoration = window.readerDecorate })
    await renderMode.click()
    await expect(page.locator('.markdown-viewer')).toBeVisible()
    await scroll(rendered, 190)
    await page.evaluate(() => window.oldFontDecoration(window.fontMarkup))
    await expectPosition(rendered, 190)
    await sourceMode.click()
    await expect(page.locator(sourceArea)).toBeVisible()
    await page.evaluate(() => { window.oldFontDecoration = window.readerDecorate })
    await show(source)
    await expect(page.locator(sourceArea)).toBeVisible()
    await scroll(sourceArea, 700, 140)
    await page.evaluate(() => window.oldFontDecoration(window.fontMarkup))
    await expectPosition(sourceArea, 700, 140)
    await expect(page.locator('.source-code')).not.toContainText('record_0401')
    await show(null)
    await page.evaluate(() => window.readerPreferences({ readerFontSize: 18 }))
    console.log('PASS: Source 18↔28 retains panned/wrapped records across CRLF, Unicode, tabs and late decoration; same-font pixels and strict version fallback stay exact; newer input/layout/mode/identity wins without late replay')

    const markdownPassage = () => page.locator(rendered).evaluate(area => {
      const paragraph = [...area.querySelectorAll('.markdown-viewer p')].find(p => p.getBoundingClientRect().bottom > area.getBoundingClientRect().top + 1)
      return Number(paragraph?.textContent.match(/^Paragraph (\d+)/)?.[1])
    })
    const startMarkdownFont = async () => {
      await show(null)
      await page.evaluate(({ location, markdown }) => {
        window.readerPreferences({ readerFontSize: 18 })
        window.fixtureText['font-markdown.md'] = { text: markdown, version: 'font-markdown-1' }
        window.viewCache.retainReaderView(window.viewKey(location), {
          mode: 'render', wrap: false, render: { top: 0, left: 0 }, source: { top: 0, left: 0 },
          table: { header: true, page: 0, sort: null },
        }, window.viewCache.readerViewGeneration())
      }, { location: fontMarkdown, markdown })
      await show(fontMarkdown)
      await expect(page.locator('.markdown-viewer p')).toHaveCount(120)
      await page.locator(rendered).evaluate(area => {
        const node = area.querySelectorAll('.markdown-viewer p')[70].firstChild, range = document.createRange()
        range.setStart(node, 90); range.setEnd(node, 91)
        area.scrollTop += range.getBoundingClientRect().top - area.getBoundingClientRect().top - 4
      })
      await settle()
      assert.equal(await markdownPassage(), 70)
      return position(rendered)
    }
    const returnMarkdownFont = async size => {
      await show(null)
      await page.evaluate(size => window.readerPreferences({ readerFontSize: size }), size)
      await show(fontMarkdown)
      await expect(page.locator('.markdown-viewer p')).toHaveCount(120)
      await settle()
    }
    await startMarkdownFont()
    const clippedMarkdown = await page.locator(rendered).evaluate(area => {
      const originalStyle = area.style.cssText, hitTest = document.caretRangeFromPoint
      try {
        area.style.flex = 'none'; area.style.height = '1px'
        const range = document.createRange(), node = area.querySelectorAll('.markdown-viewer p')[70].firstChild
        range.setStart(node, 90); range.setEnd(node, 91)
        const outside = range.getBoundingClientRect().top >= area.getBoundingClientRect().bottom
        document.caretRangeFromPoint = () => range.cloneRange()
        return { outside, point: window.markdownAnchor.captureMarkdownFontPoint(area) }
      } finally { area.style.cssText = originalStyle; document.caretRangeFromPoint = hitTest }
    })
    assert.deepEqual(clippedMarkdown, { outside: true, point: null }, 'A short reader pane captured text below its bottom edge')
    await returnMarkdownFont(28)
    assert.equal(await markdownPassage(), 70, 'Rendered Markdown lost its actual paragraph after font growth')
    const sameMarkdownFont = await position(rendered)
    await returnMarkdownFont(28)
    await expectPosition(rendered, sameMarkdownFont.top, sameMarkdownFont.left)
    await returnMarkdownFont(18)
    assert.equal(await markdownPassage(), 70, 'Rendered Markdown lost its actual paragraph after font shrink')
    const mdQueries = await page.evaluate(() => window.sourceHitTests)
    await scroll(rendered, 800); await settle()
    assert.equal(await page.evaluate(() => window.sourceHitTests), mdQueries, 'Markdown font anchoring sampled on scroll')
    for (const action of ['wheel', 'keydown', 'pointerdown']) {
      await page.locator(rendered).evaluate((area, action) => {
        area.dispatchEvent(action === 'wheel' ? new WheelEvent('wheel', { bubbles: true }) : action === 'keydown'
          ? new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }) : new PointerEvent('pointerdown', { bubbles: true }))
        area.scrollTop = 500
        area.dispatchEvent(new Event('load', { bubbles: true }))
      }, action)
      await settle(); await expectPosition(rendered, 500)
    }
    const oldMarkdown = await startMarkdownFont()
    await show(null)
    const savedMarkdown = await page.evaluate(location => window.viewCache.readReaderView(window.viewKey(location)).render, fontMarkdown)
    assert.equal(typeof savedMarkdown.offset, 'number')
    await page.evaluate(() => {
      window.readerPreferences({ readerFontSize: 28 })
      window.fixtureText['font-markdown.md'].version = 'new-md-version'
    })
    await show(fontMarkdown); await expectPosition(rendered, oldMarkdown.top, oldMarkdown.left)
    await startMarkdownFont(); await show(null)
    await page.evaluate(() => { window.readerPreferences({ readerFontSize: 28 }); window.holdViewer('MarkdownViewer') })
    await show(fontMarkdown); await expect(page.getByText('Preparing viewer…')).toBeVisible()
    await page.evaluate(() => { window.viewCache.clearReaderViews(); window.releaseViewer('MarkdownViewer') })
    await expectPosition(rendered, oldMarkdown.top, oldMarkdown.left)
    await show(null)
    assert.equal(await page.evaluate(location => window.viewCache.readReaderView(window.viewKey(location)), fontMarkdown), undefined)
    // Both image phases reject capture and even a supplied stale point at restore.
    for (const placeholder of [true, false]) {
      await page.evaluate(({ markdown, placeholder }) => {
        window.readerPreferences({ readerFontSize: 28 })
        window.fixtureText['font-markdown.md'] = { text: '![Late plot](plot.svg)\n\n' + markdown, version: 'md-image' }
        window.holdPreview = placeholder
      }, { markdown, placeholder })
      await show(fontMarkdown)
      if (placeholder) await expect(page.locator('.missing-image')).toBeVisible()
      else await expect.poll(() => page.locator('.markdown-viewer img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
      await scroll(rendered, 600); await settle()
      const exclusion = await page.evaluate(point => {
        const area = document.querySelector('.preview-content'), before = area.scrollTop
        const captured = window.markdownAnchor.captureMarkdownFontPoint(area)
        window.markdownAnchor.restoreMarkdownFontPoint(area, point)
        return { captured, unchanged: area.scrollTop === before }
      }, savedMarkdown)
      assert.deepEqual(exclusion, { captured: null, unchanged: true })
      await show(null)
      const retained = await page.evaluate(location => window.viewCache.readReaderView(window.viewKey(location)).render, fontMarkdown)
      assert.equal(retained.offset, undefined, 'Image-bearing Markdown retained a semantic point')
      await page.evaluate(() => { window.holdPreview = false; for (const release of window.heldPreviews.splice(0)) release() })
    }
    await page.evaluate(() => window.readerPreferences({ readerFontSize: 18 }))
    console.log('PASS: image-free Markdown retains the actual paragraph across 18↔28; same-font pixels, version/generation fallback, newer input and scalar copying remain intact; images and placeholders reject capture and restore')

    // Seed a previous visit and delay the first actual Markdown mount.
    await page.evaluate(first => {
      window.viewCache.retainReaderView(window.viewKey(first), {
        mode: 'render', wrap: false, render: { top: 640, left: 0 }, source: { top: 0, left: 0 },
        table: { header: true, page: 0, sort: null },
      }, window.viewCache.readerViewGeneration())
      window.holdViewer('MarkdownViewer')
    }, first)
    await show(first)
    await expect(page.getByText('Preparing viewer…')).toBeVisible()
    await page.evaluate(() => window.releaseViewer('MarkdownViewer'))
    await expect(page.locator('.markdown-viewer')).toBeVisible()
    await expectPosition(rendered, 640)
    await page.evaluate(() => window.holdViewer('SourceViewer'))
    await sourceMode.click()
    await expect(page.getByText('Preparing viewer…')).toBeVisible()
    // Toolbar controls remain usable while the lazy source module is pending.
    await wrap.click()
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.releaseViewer('SourceViewer'))
    await expect(page.locator(sourceArea)).toBeVisible()
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    // Navigate in the same task as a scroll assignment, before any scroll event.
    await page.evaluate(other => {
      document.querySelector('.source-scroll').scrollTop = 740
      window.showReader(other)
    }, otherHost)
    await expect(page.locator('.markdown-viewer')).toBeVisible()
    await expect(renderMode).toHaveAttribute('aria-pressed', 'true')
    await expectPosition(rendered, 0)
    await show(first)
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await expectPosition(sourceArea, 740)
    await renderMode.click()
    await expectPosition(rendered, 640)
    await sourceMode.click()
    await expectPosition(sourceArea, 740)
    await show(otherRoot)
    await expect(renderMode).toHaveAttribute('aria-pressed', 'true')
    await expectPosition(rendered, 0)
    await show(first)
    await expectPosition(sourceArea, 740)
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    console.log('PASS: delayed lazy mounts restore mode/wrap and separate render/source positions; host/root tabs remain isolated')

    await renderMode.click()
    await page.evaluate(() => window.readerPreferences({ readerFontSize: 28 }))
    await settle()
    await scroll(rendered, 2100)
    await page.evaluate(() => window.readerPreferences({ readerFontSize: 22 }))
    await settle()
    const outgoing = await position(rendered)
    await show(otherHost)
    assert.deepEqual(await page.evaluate(first => {
      const { top, left } = window.viewCache.readReaderView(window.viewKey(first)).render
      return { top, left }
    }, first), outgoing)
    await show(first)
    await expectPosition(rendered, outgoing.top, outgoing.left)
    await page.evaluate(() => window.readerPreferences({ readerFontSize: 18 }))
    console.log('PASS: font shrink retains the observed outgoing offset through capture and tab return')

    await show(source)
    await expect(wrap).toHaveAttribute('aria-pressed', 'false')
    await scroll(sourceArea, 880, 240)
    await show(first)
    await show(source)
    await expectPosition(sourceArea, 880, 240)
    // A return interrupted while its text is pending must not save a loading zero.
    await show(first)
    await page.evaluate(() => { window.holdText = true })
    await show(source)
    await expect(page.getByText('Reading file…')).toBeVisible()
    await show(first)
    await page.evaluate(() => {
      window.holdText = false
      for (const release of window.heldText.splice(0)) release()
    })
    await show(source)
    await expectPosition(sourceArea, 880, 240)
    await page.evaluate(() => { window.holdText = true })
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.heldText.length)).toBe(1)
    await scroll(sourceArea, 1180, 360)
    await page.evaluate(() => {
      window.fixtureText['notes.txt'].text += '\nA newly appended line'
      window.fixtureText['notes.txt'].version = 'plain-appended'
      window.holdText = false
      for (const release of window.heldText.splice(0)) release()
    })
    await expect(page.locator('.source-code code')).toContainText('A newly appended line')
    await expectPosition(sourceArea, 1180, 360)
    // The exact latest scroll is captured before a refresh replaces shorter text.
    await page.evaluate(() => {
      window.fixtureText['notes.txt'] = { text: 'Shortened text', version: 'plain-2' }
    })
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await expect(page.locator('.source-code code')).toHaveText('Shortened text')
    await expectPosition(sourceArea, 0, 0)
    await show(first)
    await show(source)
    await expectPosition(sourceArea, 0, 0)
    await show(first)
    await renderMode.click()
    await scroll(rendered, 1000)
    await show(source)
    await page.evaluate(() => { window.fixtureText['notes.md'] = { text: '# Short report', version: 'markdown-2' } })
    await show(first)
    await expect(page.locator('.markdown-viewer')).toHaveText('Short report')
    await expectPosition(rendered, 0)
    console.log('PASS: pending/cancelled initial reads and scrolling during refresh retain positions; shorter text clamps scroll')

    await show(table)
    await expect(page.locator('.csv-scroll')).toBeVisible()
    const header = page.getByRole('checkbox', { name: 'First row is header', exact: true })
    const nextRows = page.getByRole('button', { name: 'Next rows', exact: true })
    const previousRows = page.getByRole('button', { name: 'Previous rows', exact: true })
    const tablePage = page.getByRole('combobox', { name: 'Table page', exact: true })
    const toolbar = page.getByRole('toolbar', { name: 'Reader toolbar', exact: true })
    const alignments = () => page.locator('.csv-table tbody tr').first().locator('td').evaluateAll(cells => cells.map(cell => getComputedStyle(cell).textAlign))
    const numericAlignment = ['left', 'right', 'right', 'right', ...Array(8).fill('left')]
    await show(numericTable)
    await expect.poll(alignments).toEqual(numericAlignment)
    assert.deepEqual(await page.locator('.csv-table thead th').evaluateAll(cells => cells.slice(1).map(cell => getComputedStyle(cell).textAlign)), numericAlignment)
    assert.deepEqual(await page.locator('.csv-table tbody tr').first().locator('td').allTextContents(), await page.evaluate(() => window.numericRows[1]))
    await nextRows.click()
    await expect(tablePage).toHaveValue('1')
    await expect.poll(alignments).toEqual(numericAlignment)
    assert.equal(await page.locator('.csv-table tbody tr').first().locator('td').first().textContent(), '0051')
    await header.uncheck()
    await expect.poll(alignments).toEqual(Array(12).fill('left'))
    await expect(tablePage).toHaveValue('0')
    await header.check()
    await expect.poll(alignments).toEqual(numericAlignment)
    await sourceMode.click()
    await expect(page.locator('.source-code code')).toHaveText(await page.evaluate(() => window.numericText))
    await renderMode.click()
    await expect.poll(alignments).toEqual(numericAlignment)
    await show(table)
    console.log('PASS: numeric columns align consistently across pages and Header/Source changes; raw values, leading-zero IDs, whitespace, blanks, NA, mixed and missing cells remain intact')
    await expect(toolbar).toHaveCount(1)
    await expect(toolbar.getByRole('checkbox', { name: 'First row is header', exact: true })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: 'Next rows', exact: true })).toBeVisible()
    await expect(tablePage).toHaveValue('0')
    await expect(page.locator('.csv-toolbar')).toHaveCount(0)
    const tableContext = () => page.locator('.csv-scroll').evaluate(element => {
      const top = element.getBoundingClientRect().top + element.querySelector('thead').getBoundingClientRect().height
      const rows = [...element.querySelectorAll('tbody tr')]
      return {
        header: document.querySelector('[aria-label="First row is header"]').checked,
        range: document.querySelector('.csv-row-count').childNodes[0].textContent,
        firstRecord: rows[0]?.querySelector('td')?.textContent,
        visibleRecord: rows.find(row => row.getBoundingClientRect().bottom > top)?.querySelector('td')?.textContent,
        top: element.scrollTop, left: element.scrollLeft,
      }
    })
    const expectTableContext = expected => expect.poll(tableContext).toEqual(expected)
    await expect(page.locator('.csv-table tbody tr')).toHaveCount(50)
    await expect(page.getByRole('button', { name: /^Score, column [23]: Sort preview ascending$/ })).toHaveCount(2)
    assert.deepEqual(await page.locator('.csv-table tbody tr').first().locator('td').evaluateAll(cells => cells.slice(1, 4).map(cell => cell.textContent)),
      ['70', '80', 'left, right; He said "hello"\nSecond line 1'])
    await header.uncheck()
    await nextRows.click()
    await expect(tablePage).toHaveValue('1')
    await scroll('.csv-scroll', 420, 320); await settle()
    const tableVisit = await tableContext()
    assert.equal(tableVisit.header, false)
    assert.equal(tableVisit.range, '51–100 of 131 rows')
    assert.equal(tableVisit.firstRecord, 'record-050')
    assert.match(tableVisit.visibleRecord, /^record-0[5-9]\d$/)
    await page.getByRole('button', { name: 'Reader options', exact: true }).click()
    await expect(page.getByRole('group', { name: 'File information', exact: true })).toContainText('51–100 of 131 rows · 12 columns')
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.holdViewer('SourceViewer'))
    await sourceMode.focus(); await page.keyboard.press('Enter')
    await expect(page.getByText('Preparing viewer…')).toBeVisible()
    await expect(sourceMode).toBeFocused()
    await expect(toolbar).toHaveCount(1)
    await page.evaluate(() => window.releaseViewer('SourceViewer'))
    await expect(page.locator(sourceArea)).toBeVisible()
    await expect(sourceMode).toBeFocused()
    await expect(toolbar).toHaveCount(1)
    await expect(header).toHaveCount(0)
    await expect(tablePage).toHaveCount(0)
    await wrap.click(); await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await wrap.click(); await expect(wrap).toHaveAttribute('aria-pressed', 'false')
    await scroll(sourceArea, 600, 140)
    await page.evaluate(() => window.holdViewer('CSVViewer'))
    await renderMode.focus(); await page.keyboard.press('Enter')
    await expect(page.getByText('Preparing viewer…')).toBeVisible()
    await expect(toolbar).toHaveCount(1)
    await expect(renderMode).toBeFocused()
    await page.evaluate(() => window.releaseViewer('CSVViewer'))
    await expectTableContext(tableVisit)
    await expect(renderMode).toBeFocused()
    await expect(toolbar).toHaveCount(1)
    await show(first)
    await show(table)
    await expectTableContext(tableVisit)
    await sourceMode.click()
    await expectPosition(sourceArea, 600, 140)
    await renderMode.click()
    await expectTableContext(tableVisit)

    await show(tabSeparated)
    await expect(header).toBeChecked()
    await expect(page.getByRole('button', { name: /^Score, column [23]: Sort preview ascending$/ })).toHaveCount(2)
    assert.equal(await page.locator('.csv-table tbody tr').first().locator('td').nth(3).textContent(), 'left, right; He said "hello"\nSecond line 1')
    await header.uncheck(); await nextRows.click()
    await scroll('.csv-scroll', 100, 210); await settle()
    const tsvVisit = await tableContext()
    assert.equal(tsvVisit.firstRecord, 'tsv-050')
    await show(table); await expectTableContext(tableVisit)
    await show(tabSeparated); await expectTableContext(tsvVisit)
    await show(table); await expectTableContext(tableVisit)
    console.log('PASS: CSV/TSV Header/page and the actual visible record survive Source, delayed viewer mounts, and independent file visits; duplicate headers and quoted cells stay intact')

    await show(pages)
    await expect(tablePage.locator('option')).toHaveCount(200)
    for (const [keys, value, record] of [
      [['End'], '199', 'page-9951'],
      [['Home'], '0', 'page-001'],
      [['4', '2'], '41', 'page-2051'],
    ]) {
      await tablePage.focus()
      for (const key of keys) await tablePage.press(key)
      await tablePage.press('Enter')
      await expect(tablePage).toHaveValue(value)
      assert.equal((await tableContext()).visibleRecord, record)
    }
    await scroll('.csv-scroll', 180, 150); await settle()
    const selectedPageVisit = await tableContext()
    await sourceMode.focus(); await page.keyboard.press('Enter')
    await expect(sourceMode).toBeFocused()
    await expect(wrap).toBeVisible()
    await renderMode.focus(); await page.keyboard.press('Enter')
    await expect(renderMode).toBeFocused()
    await expectTableContext(selectedPageVisit)
    await show(table); await expectTableContext(tableVisit)
    await show(pages); await expectTableContext(selectedPageVisit)
    await expect(tablePage).toHaveValue('41')
    await header.uncheck()
    await expect(tablePage).toHaveValue('0')
    await expectPosition('.csv-scroll', 0, selectedPageVisit.left)
    await header.check()
    await tablePage.selectOption({ value: '199' })
    await page.evaluate(() => {
      window.fixtureText['pages.csv'] = { text: window.fixtureTable(60, ',', 'page', 0), version: 'pages-short' }
    })
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await expect(tablePage).toHaveValue('1')
    await expect(tablePage.locator('option')).toHaveCount(2)
    assert.equal((await tableContext()).visibleRecord, 'page-051')
    await show(table); await expectTableContext(tableVisit)
    console.log('PASS: native page Home/End/type-ahead reaches the actual record; selected pages retain Source focus and per-file scroll, reset with Header, and clamp on shorter content')

    await header.check()
    await expect(tablePage).toHaveValue('0')
    await expectPosition('.csv-scroll', 0, 320)
    assert.equal((await tableContext()).visibleRecord, 'record-001')
    await header.uncheck()
    assert.equal((await tableContext()).visibleRecord, 'Record')
    await nextRows.click()
    await scroll('.csv-scroll', 420, 320)
    await nextRows.click()
    await expectPosition('.csv-scroll', 0, 320)
    assert.equal((await tableContext()).visibleRecord, 'record-100')
    await scroll('.csv-scroll', 420, 320); await settle()
    const beforeRefresh = await tableContext()
    const refreshTable = async count => {
      await page.evaluate(count => {
        window.fixtureText['table.csv'] = { text: window.fixtureTable(count).replaceAll('Second line', 'Updated line'), version: `table-${count}` }
      }, count)
      const reads = await page.evaluate(() => window.textReads)
      await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.textReads)).toBeGreaterThan(reads)
      await expect(page.getByRole('button', { name: 'Refresh file', exact: true })).toBeEnabled()
      await settle()
    }
    await refreshTable(130)
    await expectTableContext(beforeRefresh)
    await refreshTable(75)
    const shortened = await tableContext()
    assert.equal(shortened.header, false)
    assert.equal(shortened.range, '51–76 of 76 rows')
    assert.equal(shortened.firstRecord, 'record-050')
    await expect(tablePage).toHaveValue('1')
    await expect(tablePage.locator('option')).toHaveCount(2)
    await expect(nextRows).toBeDisabled()
    await sourceMode.click(); await renderMode.click()
    await expectTableContext(shortened)
    await previousRows.click()
    await expectPosition('.csv-scroll', 0, 320)
    await nextRows.click()
    await scroll('.csv-scroll', 420, 320)
    await refreshTable(3)
    await expectPosition('.csv-scroll', 0, 320)
    const tiny = await tableContext()
    assert.equal(tiny.header, false)
    assert.equal(tiny.range, '1–4 of 4 rows')
    assert.equal(tiny.visibleRecord, 'Record')
    await expect(tablePage).toHaveCount(0)
    await show(source); await show(table)
    await expectTableContext(tiny)
    await page.evaluate(() => { window.fixtureText['table.csv'] = {text:'',version:'empty-table'} })
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await expect(page.locator('.csv-empty')).toBeVisible()
    await expectPosition('.csv-scroll', 0, 0)
    await expect(header).not.toBeChecked()
    await refreshTable(130)
    assert.equal((await tableContext()).visibleRecord, 'Record')
    await expect(header).not.toBeChecked()
    await page.evaluate(() => { window.fixtureText['table.csv'].truncated = true; window.fixtureText['table.csv'].version = 'truncated-table' })
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    const truncated = page.locator('.warning-notice').filter({ hasText: 'Showing a truncated preview' })
    await expect(truncated).toBeVisible()
    for (const mode of [sourceMode, renderMode]) {
      const bar = await toolbar.boundingBox(), notice = await truncated.boundingBox()
      assert(bar.y + bar.height <= notice.y, 'Truncation notice moved above the reader toolbar')
      await mode.click()
    }
    await refreshTable(130)
    console.log('PASS: changed content retains table context; shorter/empty content clamps page and scroll; explicit Header/page actions restart vertical scroll deliberately')

    await show(sortedTable)
    const sortHeading = page.locator('.csv-table thead th').nth(2)
    const sortButton = sortHeading.getByRole('button')
    const ordinals = () => page.locator('.csv-table tbody th').allTextContents()
    await expect(sortButton).toBeVisible()
    const originalCells = await page.locator('.csv-table tbody td').allTextContents()
    const download = await toolbar.getByRole('link', { name: 'Download file', exact: true }).getAttribute('href')
    await nextRows.click(); await scroll('.csv-scroll', 180, 80)
    await sortButton.focus(); await page.keyboard.press('Enter')
    await expect(sortButton).toBeFocused()
    await expect(sortHeading).toHaveAttribute('aria-sort', 'ascending')
    await expect(tablePage).toHaveValue('0')
    await expectPosition('.csv-scroll', 0, 80)
    assert.deepEqual((await ordinals()).slice(0, 5), ['105', '1', '2', '3', '4'], 'Sorting must include records beyond the displayed page and retain tie order')
    const fullScreenRows = await ordinals()
    const headingHeight = await sortHeading.evaluate(element => element.getBoundingClientRect().height)
    await page.locator('#root').evaluate(element => element.classList.add('reader-expanded'))
    await expect(page.locator('.csv-table button:visible')).toHaveCount(0)
    await expect(page.getByRole('columnheader', { name: 'Score', exact: true })).toHaveCount(2)
    await expect(sortHeading).toHaveAttribute('aria-sort', 'ascending')
    assert.equal(await sortHeading.evaluate(element => element.getBoundingClientRect().height), headingHeight)
    assert.deepEqual(await ordinals(), fullScreenRows, 'Full screen changed the displayed record order')
    await page.locator('#root').evaluate(element => element.classList.remove('reader-expanded'))
    await expect(sortButton).toBeVisible()
    await nextRows.click(); await scroll('.csv-scroll', 220, 80); await settle()
    const sortedVisit = await tableContext()
    await sourceMode.focus(); await page.keyboard.press('Enter')
    await expect(sourceMode).toBeFocused()
    assert.equal(await page.locator('.source-code code').textContent(), await page.evaluate(() => window.fixtureText['sorted.csv'].text))
    await renderMode.focus(); await page.keyboard.press('Enter')
    await expect(renderMode).toBeFocused()
    await expectTableContext(sortedVisit)
    await expect(sortHeading).toHaveAttribute('aria-sort', 'ascending')
    await show(table); await show(sortedTable)
    await expectTableContext(sortedVisit)
    await sortButton.click()
    await expect(sortHeading).toHaveAttribute('aria-sort', 'descending')
    assert.deepEqual((await ordinals()).slice(0, 4), ['129', '130', '127', '128'], 'Descending ties must also retain original order')
    await sortButton.click()
    await expect(page.locator('.csv-table th[aria-sort]')).toHaveCount(0)
    assert.deepEqual(await ordinals(), Array.from({ length: 50 }, (_, index) => String(index + 1)))
    assert.deepEqual(await page.locator('.csv-table tbody td').allTextContents(), originalCells)
    assert.equal(await toolbar.getByRole('link', { name: 'Download file', exact: true }).getAttribute('href'), download)
    await sortButton.click(); await header.uncheck()
    await expect(page.locator('.csv-table th[aria-sort]')).toHaveCount(0)
    assert.equal((await tableContext()).firstRecord, 'Record')
    await expect(tablePage).toHaveValue('0')
    await header.check()
    const refreshSorted = async text => {
      await page.evaluate(text => { window.fixtureText['sorted.csv'] = { text, version: `sort-${++window.sortRevision}` } }, text)
      const reads = await page.evaluate(() => window.textReads)
      await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.textReads)).toBeGreaterThan(reads)
      await expect(page.getByRole('button', { name: 'Refresh file', exact: true })).toBeEnabled()
      await settle()
    }
    await page.evaluate(() => { window.sortRevision = 1 })
    await sortButton.click(); await sortButton.click()
    await tablePage.selectOption({ value: '2' })
    await scroll('.csv-scroll', 220, 80); await settle()
    const sortedRefreshVisit = await tableContext()
    await refreshSorted(await page.evaluate(() => window.fixtureSort(130).replace('"-1"', '"-2"')))
    await expectTableContext(sortedRefreshVisit)
    await expect(sortHeading).toHaveAttribute('aria-sort', 'descending')
    await refreshSorted(await page.evaluate(() => window.fixtureSort(60)))
    await expect(tablePage).toHaveValue('1')
    assert.equal((await tableContext()).firstRecord, 'sort-009', 'Shorter data must re-sort before clamping the page')
    const beforeTinySort = await position('.csv-scroll')
    await refreshSorted(await page.evaluate(() => window.fixtureSort(3)))
    await expect(tablePage).toHaveCount(0)
    const tinySortMax = await page.locator('.csv-scroll').evaluate(area => area.scrollHeight - area.clientHeight)
    await expectPosition('.csv-scroll', Math.min(beforeTinySort.top, tinySortMax), 80)
    assert.deepEqual(await ordinals(), ['3', '1', '2'])
    for (const count of [1, 0]) {
      if (count === 0) {
        await refreshSorted(await page.evaluate(() => window.fixtureSort(3)))
        await sortButton.click(); await sortButton.click()
      }
      await refreshSorted(await page.evaluate(count => window.fixtureSort(count), count))
      await expect(sortHeading).toHaveAttribute('aria-sort', 'descending')
      await expect(sortButton).toBeVisible()
      await expect(sortButton).toHaveAccessibleName(/Restore file order$/)
      await sortButton.focus(); await page.keyboard.press('Enter')
      await expect(page.locator('.csv-table th[aria-sort]')).toHaveCount(0)
      await expect(page.locator('.csv-scroll')).toBeFocused()
    }
    await refreshSorted(await page.evaluate(() => window.fixtureSort(60)))
    await page.getByRole('button', { name: /^Score, column 3: Sort preview ascending$/ }).click()
    await nextRows.click(); await scroll('.csv-scroll', 200, 80)
    await refreshSorted('Record\nonly')
    await expect(page.locator('.csv-table th[aria-sort]')).toHaveCount(0)
    await expect(tablePage).toHaveCount(0)
    await expectPosition('.csv-scroll', 0)
    assert.equal((await tableContext()).firstRecord, 'only')
    await show(table)
    assert.equal(await page.evaluate(location => window.viewCache.readReaderView(window.viewKey(location)).table.sort, sortedTable), null)
    console.log('PASS: whole-preview stable sorting preserves original records/raw text; Source/tab context, refresh/clamping, Header reset, <=1-record clearing, and disappeared-column reset')

    const figure = page.getByRole('img', { name: 'Delayed plot', exact: true })
    const finishImages = async (fail = false) => {
      holdImages = false
      const images = pendingImages.splice(0)
      const urls = images.map(route => route.request().url())
      await Promise.all(images.map(route => route.fulfill(fail
        ? { status: 404, contentType: 'text/plain', body: 'Synthetic missing image' } : imageResponse)))
      // Fulfilling a response does not mean the image loaded or its navigation listeners ran.
      await expect.poll(() => page.evaluate(urls => urls.every(url => window.settledImages.includes(url)), urls)).toBe(true)
      await settle()
    }
    const finishPreview = async () => {
      await page.evaluate(() => {
        window.holdPreview = false
        for (const release of window.heldPreviews.splice(0)) release()
      })
      await expect.poll(() => pendingImages.length).toBe(1)
    }
    const returnToPendingFigure = async () => {
      await show(figures)
      await expect.poll(() => figure.evaluate(image => image.naturalHeight)).toBe(5000)
      await scroll(rendered, 2000)
      await show(source)
      assert.equal(await page.evaluate(figures => window.viewCache.readReaderView(window.viewKey(figures)).render.top, figures), 2000)
      holdImages = true
      await page.evaluate(() => { window.holdPreview = true })
      await show(figures)
      await expect.poll(() => page.evaluate(() => window.heldPreviews.length)).toBe(1)
      await expect(page.locator('.markdown-viewer')).toBeVisible()
      await expectPosition(rendered, 0)
    }
    await returnToPendingFigure()
    // Leaving before the capability arrives must keep the requested offset, not zero.
    await show(source)
    assert.equal(await page.evaluate(figures => window.viewCache.readReaderView(window.viewKey(figures)).render.top, figures), 2000)
    await page.evaluate(() => {
      window.holdPreview = false
      for (const release of window.heldPreviews.splice(0)) release()
    })
    await show(figures)
    await expect.poll(() => pendingImages.length).toBe(1)
    await expectPosition(rendered, 0)
    await finishImages()
    await expect.poll(() => figure.evaluate(image => image.naturalHeight)).toBe(5000)
    await expectPosition(rendered, 2000)
    console.log('PASS: delayed preview and image loading preserve the desired offset, including interrupted returns')

    for (const depart of [false, true]) {
      await show(source)
      await returnToPendingFigure()
      await finishPreview()
      await figure.evaluate((image, { depart, source }) => image.addEventListener('load', () => {
        document.querySelector('.preview-content').scrollTop = 1750
        if (depart) window.showReader(source)
      }, { once: true }), { depart, source })
      await finishImages()
      if (depart) {
        assert.equal(await page.evaluate(figures => window.viewCache.readReaderView(window.viewKey(figures)).render.top, figures), 1750)
        await show(figures)
        await expect.poll(() => figure.evaluate(image => image.naturalHeight)).toBe(5000)
      }
      await expectPosition(rendered, 1750)
    }
    console.log('PASS: a newer offset wins before queued scroll events, during both image retry and immediate departure')

    await show(source)
    await returnToPendingFigure()
    await finishPreview()
    await figure.evaluate(image => {
      // Document capture precedes the reader; image load does not reach window capture.
      const loaded = event => {
        if (event.target !== image) return
        document.removeEventListener('load', loaded, true)
        requestAnimationFrame(() => {
          document.querySelector('.preview-content').scrollTop = 1650
          window.precedingReaderFrame = true
        })
      }
      window.precedingReaderFrame = false
      document.addEventListener('load', loaded, true)
    })
    await finishImages()
    assert.equal(await page.evaluate(() => window.precedingReaderFrame), true)
    await expectPosition(rendered, 1650)
    console.log('PASS: a user RAF preceding the image retry wins before its scroll event is dispatched')

    // A same-text renewal starts from the latest view, even after earlier user navigation.
    await page.locator(rendered).dispatchEvent('wheel')
    await scroll(rendered, 1800)
    holdImages = true
    await page.evaluate(() => { window.holdPreview = true })
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.heldPreviews.length)).toBe(1)
    await page.locator(rendered).dispatchEvent('wheel')
    await scroll(rendered, 2300)
    await finishPreview()
    await expectPosition(rendered, 0)
    await finishImages()
    await expectPosition(rendered, 2300)

    holdImages = true
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await expect.poll(() => pendingImages.length).toBe(1)
    await page.locator(rendered).dispatchEvent('wheel')
    await finishImages()
    await expectPosition(rendered, 0)
    // Cancelling one load must not permanently suppress restoration on future refreshes.
    await scroll(rendered, 2000)
    holdImages = true
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await expect.poll(() => pendingImages.length).toBe(1)
    await finishImages()
    await expectPosition(rendered, 2000)
    console.log('PASS: same-text manual renewal keeps the latest pre-response scroll; cancellation ends with that load')

    await page.evaluate(() => {
      window.fixtureText['figures.md'].text += '\n\n![Later plot](later.svg)'
      window.fixtureText['figures.md'].version = 'figures-later'
    })
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Later plot', exact: true })).toBeAttached()
    await expect.poll(() => figure.evaluate(image => image.naturalHeight)).toBe(5000)
    for (const top of [1900, 2100]) {
      await page.locator(rendered).dispatchEvent('wheel')
      await scroll(rendered, top)
      holdImages = true
      await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
      await expect.poll(() => pendingImages.length).toBe(1)
      await finishImages()
      await expectPosition(rendered, top)
    }
    await page.evaluate(() => {
      window.fixtureText['figures.md'].text = window.fixtureText['figures.md'].text.replace('\n\n![Later plot](later.svg)', '')
      window.fixtureText['figures.md'].version = 'figures-1'
    })
    console.log('PASS: a reachable offset settles without waiting for unrelated lazy images')

    for (const action of ['wheel', 'touchstart', 'keydown', 'anchor']) {
      await show(source)
      await returnToPendingFigure()
      if (action === 'anchor') {
        await page.getByRole('link', { name: 'Jump to end' }).click()
      } else if (action === 'keydown') {
        await page.locator('.markdown-viewer').press('ArrowDown')
      } else if (action === 'touchstart') {
        // Firefox desktop has no TouchEvent constructor; only the intent signal matters here.
        await page.locator(rendered).evaluate(element => element.dispatchEvent(new Event('touchstart', { bubbles: true })))
      } else {
        await page.locator(rendered).dispatchEvent(action)
      }
      await settle()
      const chosen = await position(rendered)
      await finishPreview()
      await finishImages()
      await expect.poll(() => figure.evaluate(image => image.naturalHeight)).toBe(5000)
      await expectPosition(rendered, chosen.top, chosen.left)
      if (action === 'anchor') await expect(page.getByRole('heading', { name: 'End', exact: true })).toBeFocused()
    }
    await show(source)
    await returnToPendingFigure()
    await finishPreview()
    await page.locator(rendered).dispatchEvent('wheel')
    await finishImages()
    await expectPosition(rendered, 0)
    console.log('PASS: wheel/touch/key/anchor navigation cancels late restoration before and after the capability arrives')

    await show(source)
    await returnToPendingFigure()
    await finishPreview()
    await finishImages(true)
    await expect(page.locator('.missing-image')).toBeVisible()
    await expectPosition(rendered, 0)
    await show(source)
    assert.equal(await page.evaluate(figures => window.viewCache.readReaderView(window.viewKey(figures)).render.top, figures), 0)
    console.log('PASS: a settled failed image finalizes the legitimate shorter-content clamp')

    // Event clearing must defeat a still-mounted reader's later unmount write.
    for (const event of ['artiface:configuration-changed', 'artiface:unauthorized', 'pagehide']) {
      await show(source)
      await wrap.click()
      await expect(wrap).toHaveAttribute('aria-pressed', 'true')
      await page.evaluate(event => window.dispatchEvent(new Event(event)), event)
      await show(null)
      assert.equal(await page.evaluate(source => window.viewCache.readReaderView(window.viewKey(source)), source), undefined)
      await show(source)
      await expect(wrap).toHaveAttribute('aria-pressed', 'false')
    }
    for (const reset of ['artiface:configuration-changed', 'artiface:unauthorized', 'pagehide', 'source identity']) {
      await show(table)
      await header.check(); await header.uncheck()
      await page.getByRole('button', { name: /^Column 1, column 1: Sort preview ascending$/ }).click()
      await expect(page.locator('.csv-table th[aria-sort]')).toHaveCount(1)
      await nextRows.click()
      await scroll('.csv-scroll', 420, 320); await settle()
      assert((await tableContext()).top > 0)
      await page.evaluate(reset => {
        if (reset === 'source identity') window.viewCache.clearReaderViews()
        else window.dispatchEvent(new Event(reset))
      }, reset)
      await show(null)
      assert.equal(await page.evaluate(table => window.viewCache.readReaderView(window.viewKey(table)), table), undefined)
      await show(table)
      await expect(header).toBeChecked()
      await expect(page.locator('.csv-table th[aria-sort]')).toHaveCount(0)
      await expect(tablePage).toHaveValue('0')
      await expectPosition('.csv-scroll', 0, 0)
      assert.equal((await tableContext()).visibleRecord, 'record-001')
    }
    await header.uncheck()
    await page.getByRole('button', { name: /^Column 1, column 1: Sort preview ascending$/ }).click()
    await expect(page.locator('.csv-table th[aria-sort]')).toHaveCount(1)
    await nextRows.click()
    await scroll('.csv-scroll', 420, 320)
    await page.evaluate(locations => window.keepReaders(locations), [source])
    await show(null)
    await page.evaluate(locations => window.keepReaders(locations), [source, table])
    await show(table)
    await expect(header).toBeChecked()
    await expect(page.locator('.csv-table th[aria-sort]')).toHaveCount(0)
    await expect(tablePage).toHaveValue('0')
    await expectPosition('.csv-scroll', 0, 0)
    assert.equal((await tableContext()).visibleRecord, 'record-001')
    console.log('PASS: closed table tabs and source/configuration/session/page lifecycle resets discard Header/sort/page/scroll together and cannot be repopulated by stale unmounts')
    await show(source)
    await wrap.click()
    await page.evaluate(() => window.keepReaders([]))
    await show(null)
    await page.evaluate(locations => window.keepReaders(locations), [source])
    await show(source)
    await expect(wrap).toHaveAttribute('aria-pressed', 'false')
    assert.deepEqual(errors, [])
    console.log('PASS: memory cache is capped at 64 with LRU eviction; close/access/config/pagehide prevent stale repopulation')
  } finally { await context.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ headless: true })
  try { await checkReaderView({ browser }) } finally { await browser.close() }
}
