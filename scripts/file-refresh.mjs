import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, webkit, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const web = fileURLToPath(new URL('../web', import.meta.url))

// Exercise the real reader and hook without a server, builds on disk, or private files.
// PDF rendering is outside this regression; its refresh token must remain untouched.
async function buildReader() {
  const bundle = await rolldown({
    cwd: web, input: 'fixture:reader', platform: 'browser',
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
    onLog(level, log, next) { if (log.code !== 'MODULE_LEVEL_DIRECTIVE') next(level, log) },
    plugins: [{
      name: 'reader-fixture',
      resolveId(id) {
        if (id === 'fixture:reader') return '\0reader'
        if (id === './PDFViewer') return '\0pdf'
        if (id.endsWith('.css')) return '\0css'
        if (id.endsWith('.svg?no-inline')) return '\0asset'
      },
      load(id) {
        if (id === '\0css') return ''
        if (id === '\0asset') return 'export default ""'
        if (id === '\0pdf') return `import React, {useState, useEffect} from 'react'
        import {Loading} from ${JSON.stringify(`${web}/src/components/Common.tsx`)}
        export default function PDF({ refreshToken, renderActions, onRefreshState }) {
          const [mode,setMode]=useState(window.initialReaderProps?.fixturePDFMode || 'idle')
          window.fixturePDFMode=setMode
          useEffect(()=>onRefreshState?.({loading:mode!=='idle',error:''}),[mode,onRefreshState])
          return React.createElement('div', { 'data-pdf-refresh': refreshToken, className:'pdf-viewer' },
            React.createElement('div',{className:'pdf-toolbar'},renderActions(null)),
            mode==='initial' ? React.createElement('div',{className:'pdf-initial-loading'},React.createElement(Loading,{message:'Loading PDF…'})) : React.createElement('p',null,'Cached PDF page'),
            mode==='rendering' ? React.createElement('div',{className:'pdf-rendering'},React.createElement(Loading,{message:'Rendering page…',compact:true})) : null,
            mode==='replacement' ? React.createElement('div',{inert:true,style:{visibility:'hidden'}},React.createElement(Loading,{message:'Replacement PDF…'})) : null)
        }`
        if (id === '\0reader') return `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import FilePreview from ${JSON.stringify(`${web}/src/components/FilePreview.tsx`)}
        function Fixture() {
          const [props, setProps] = useState({
            location: { host: 'fixture-a', root: 'root', path: 'notes.py', kind: 'file' },
            autoRefreshPaused: false,
            copied: false, onNavigate() {}, onCopyLink() {}, onExpand() {},
            ...window.initialReaderProps
          })
          window.updateReader = patch => flushSync(() => setProps(current => ({ ...current, ...patch })))
          return React.createElement(FilePreview, {
            ...props,
            onProjectScriptsAllowed: window.initialReaderProps?.permissionCallback ? () => {
              window.permissionCallbacks++
              setProps(current => ({ ...current, projectTrustedScripts: true }))
            } : undefined,
            onToggleAutoRefresh: () => setProps(current => ({ ...current, autoRefreshPaused: !current.autoRefreshPaused }))
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

async function fixture(browser, code, run, initial = {}) {
  // The fixture loads no service worker; Playwright's blocking shim throws in opaque sandbox frames.
  const context = await browser.newContext({ hasTouch: process.env.ARTIFACE_TOUCH === '1' })
  const errors = []
  let htmlDownloads = 0
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  context.on('request', request => {
    if (request.resourceType() === 'document' && new URL(request.url()).pathname.startsWith('/p/')) htmlDownloads++
  })
  const page = await context.newPage()
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.href === 'https://file-refresh.invalid/') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><div id="root"></div>',
    })
    if (url.origin === 'https://file-refresh.invalid' && url.pathname.startsWith('/p/')) return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><p>Isolated preview fixture</p>',
    })
    errors.push(`Unexpected network request: ${url.pathname}`)
    return route.abort()
  })
  try {
    await page.goto('https://file-refresh.invalid/')
    await page.evaluate(initial => {
      window.initialReaderProps = initial
      localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 2 }))
      // Control only the two-second poll; React's lazy-reader timers remain real.
      const setTimer = window.setTimeout.bind(window)
      const clearTimer = window.clearTimeout.bind(window)
      const polls = new Map()
      let timerID = 0
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 2000) return setTimer(callback, delay, ...args)
        const id = --timerID
        polls.set(id, () => callback(...args))
        return id
      }
      window.clearTimeout = id => { if (!polls.delete(id)) clearTimer(id) }
      window.pollScheduled = () => polls.size > 0
      window.poll = () => {
        const pending = [...polls.values()]
        polls.clear()
        for (const callback of pending) callback()
      }
      let hidden = false
      Object.defineProperty(document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
      window.setHidden = value => {
        hidden = value
        document.dispatchEvent(new Event('visibilitychange'))
      }
      window.requests = []
      window.permissionCallbacks = 0
      // Deliberately allow late responses after abort to test the reader's adoption guards.
      window.fetch = (input, options = {}) => new Promise(resolve => {
        const url = new URL(input, location.href)
        if (url.pathname === '/p/healthz') { resolve({ status: 204, ok: true }); return }
        window.requests.push({
          endpoint: url.pathname, host: url.searchParams.get('host'),
          method: options.method, body: options.body ? JSON.parse(options.body) : undefined,
          signal: options.signal, settled: false,
          finish(body, status = 200) {
            this.settled = true
            resolve({ status, ok: status >= 200 && status < 300, json: async () => body })
          },
        })
      })
    }, initial)
    await page.addScriptTag({ content: code })
    await page.waitForFunction(() => Boolean(window.updateReader))
    await run(page, () => htmlDownloads)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

const requests = (page, endpoint) => page.evaluate(endpoint => window.requests.flatMap((request, id) =>
  request.endpoint === `/api/${endpoint}` ? [{ id, host: request.host, method: request.method, body: request.body, aborted: request.signal?.aborted, settled: request.settled }] : []), endpoint)
async function request(page, endpoint, number) {
  await expect.poll(async () => (await requests(page, endpoint)).length).toBe(number)
  return (await requests(page, endpoint))[number - 1].id
}
async function finish(page, id, body, status = 200) {
  await page.evaluate(({ id, body, status }) => window.requests[id].finish(body, status), { id, body, status })
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
}
async function poll(page, scheduled = true) {
  // A delivered response can still be parsing or reconciling before the hook schedules its next check.
  if (scheduled) await expect.poll(() => page.evaluate(() => window.pollScheduled())).toBe(true)
  await page.evaluate(() => window.poll())
}
const metadata = (version, trustedScripts = false) => ({ name: 'notes.py', path: 'notes.py', type: 'file', size: 6, modified: '2026-09-21T12:00:00Z', version, trustedScripts })
const text = (value, version = 'v2') => ({ text: value, size: value.length, truncated: false, version })
const preview = (version, scripts = false, token = version) => ({
  version, scripts, url: `https://file-refresh.invalid/p/${token}/report.html`,
  path: 'reports/notes.md', expiresAt: new Date(Date.now() + 900_000).toISOString(),
})
const readerText = page => page.locator('.source-code')
const refreshButton = page => page.getByRole('button', { name: 'Refresh file', exact: true })

async function beginRace(page) {
  const original = await request(page, 'text', 1)
  const stat = await request(page, 'file-info', 1)
  await finish(page, stat, metadata('v2'))
  assert.equal((await requests(page, 'text')).length, 1, 'First stat aborted and duplicated a pending initial read')
  await finish(page, original, text('OLD v1', 'v1'))
  await finish(page, await request(page, 'file-info', 2), metadata('v2'))
  return request(page, 'text', 2)
}

export async function checkFileRefresh({ browser }) {
  const code = await buildReader()
  const run = (check, initial) => fixture(browser, code, check, initial)
  const styles = (await Promise.all(['viewers.css', 'styles.css'].map(path => readFile(`${web}/src/${path}`, 'utf8'))))
    .join('\n').replace(/@import[^;]+;/g, '') + '#root { height: 100dvh; display: flex; }'
  const spinners = page => page.locator('.file-preview svg').evaluateAll(icons => icons.filter(icon =>
    icon.getClientRects().length && getComputedStyle(icon).visibility !== 'hidden' && getComputedStyle(icon).animationName !== 'none').length)
  await run(async page => {
    await page.addStyleTag({ content: styles })
    await expect(page.getByText('Reading file…', { exact: true })).toBeVisible()
    await expect.poll(() => spinners(page)).toBe(1)
    await finish(page, await request(page, 'text', 1), text('READY', 'v1'))
    await expect(readerText(page)).toContainText('READY')
    await expect.poll(() => spinners(page)).toBe(0) // Metadata checks stay quiet.
    await finish(page, await request(page, 'file-info', 1), metadata('v1'))
    await refreshButton(page).click()
    await expect.poll(() => spinners(page)).toBe(1) // Cached content uses the toolbar.
    await expect(readerText(page)).toContainText('READY')
    await expect(page.locator('.loading-state')).toHaveCount(0)
    await finish(page, await request(page, 'text', 2), text('REFRESHED', 'v2'))
    await expect(readerText(page)).toContainText('REFRESHED')
    await expect.poll(() => spinners(page)).toBe(0)
  })
  await run(async page => {
    await page.addStyleTag({ content: styles })
    const initial = page.getByText('Preparing preview…', { exact: true })
    await expect(initial).toBeVisible()
    await expect.poll(() => spinners(page)).toBe(1)
    const before = await page.locator('.loading-state svg').boundingBox()
    let heldFrame
    await page.route('**/p/slow/report.html', route => { heldFrame = route })
    await finish(page, await request(page, 'preview', 1), preview('v1', false, 'slow'))
    await expect.poll(() => Boolean(heldFrame)).toBe(true)
    await expect(page.getByText('Opening report…', { exact: true })).toBeVisible()
    await expect.poll(() => spinners(page)).toBe(1)
    const after = await page.locator('.loading-state svg').boundingBox()
    assert(Math.abs(before.x + before.width / 2 - after.x - after.width / 2) < 1 &&
      Math.abs(before.y + before.height / 2 - after.y - after.height / 2) < 1, 'HTML loading spinner moved between preparation and frame loading')
    await heldFrame.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Ready</p>' })
    await expect(page.locator('iframe:not(.pending-preview)')).toBeVisible()
    await expect.poll(() => spinners(page)).toBe(0)
  }, { location: { host: 'fixture-a', root: 'root', path: 'report.html', kind: 'file' }, autoRefreshPaused: true })
  console.log('PASS: one stationary content spinner during initial load, quiet metadata checks, and one toolbar spinner while cached content refreshes')
  await run(async page => {
    await page.addStyleTag({ content: styles })
    await expect(page.getByText('Loading PDF…', { exact: true })).toBeVisible()
    const animation = () => refreshButton(page).locator('svg').evaluate(icon => getComputedStyle(icon).animationName)
    await expect.poll(() => spinners(page)).toBe(1)
    await expect.poll(animation).toBe('none')
    await page.evaluate(() => window.fixturePDFMode('replacement'))
    await expect(page.getByText('Cached PDF page')).toBeVisible()
    await expect.poll(animation).toBe('reader-refresh-spin')
    await expect.poll(() => spinners(page)).toBe(1)
    await page.evaluate(() => window.fixturePDFMode('rendering'))
    await expect(page.getByText('Rendering page…')).toBeVisible()
    await expect.poll(animation).toBe('none')
    await expect.poll(() => spinners(page)).toBe(1)
    await page.evaluate(() => window.fixturePDFMode('idle'))
    await expect.poll(() => spinners(page)).toBe(0)
  }, { location: { host: 'fixture-a', root: 'root', path: 'report.pdf', kind: 'file' }, autoRefreshPaused: true, fixturePDFMode: 'initial' })
  console.log('PASS: visible PDF loading owns the spinner while hidden replacement rendering leaves toolbar feedback active')
  const htmlLocation = { host: 'fixture-a', root: 'root', path: 'report.html', kind: 'file' }
  const blockedReader = { location: htmlLocation, autoRefreshPaused: true, permissionCallback: true }
  const prompt = page => page.getByRole('region', { name: 'JavaScript permission', exact: true })
  const allow = page => page.getByRole('button', { name: /^(Allow JavaScript|Allowing…)$/ })
  const inspection = (status = 'present', canAllow = true) => ({ status, canAllow, projectLabel: 'Synthetic project', revision: 'captured-revision' })
  const blockedPreview = (version = 'v1', token = 'opaque-check') => ({ ...preview(version, false, token), scriptCheck: token })
  const openBlocked = async (page, token = 'opaque-check') => {
    await finish(page, await request(page, 'preview', 1), blockedPreview('v1', token))
    await expect(page.locator('iframe[sandbox=""]:not(.pending-preview)')).toHaveCount(1)
    return request(page, 'preview/scripts', 1)
  }

  await run(async page => {
    await page.addStyleTag({ content: styles })
    const projectLabel = 'Research project with a very long descriptive name'
    await finish(page, await openBlocked(page), { ...inspection(), projectLabel })
    for (const width of [1440, 800, 390, 320]) for (const density of ['compact', 'comfortable']) for (const scale of [1, 1.4]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(({ density, scale }) => {
        document.documentElement.dataset.density = density
        document.documentElement.style.setProperty('--font-scale', String(scale))
      }, { density, scale })
      const toolbar = await page.getByRole('toolbar', { name: 'Reader toolbar' }).boundingBox()
      const banner = await prompt(page).boundingBox()
      assert(Math.abs(banner.height - toolbar.height) < 1, `${width}px/${density}/${scale}: JavaScript prompt ${banner.height}px differs from toolbar ${toolbar.height}px`)
      const controls = await prompt(page).locator('button').evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect()
        return { x: box.x, right: box.right, y: box.y + box.height / 2 }
      }))
      assert(controls.every(button => button.x >= banner.x && button.right <= banner.x + banner.width), 'JavaScript controls overflow the prompt')
      assert(controls.every(button => Math.abs(button.y - banner.y - banner.height / 2) < 1), 'JavaScript controls do not share the prompt center')
      await expect(allow(page)).toBeVisible()
      await expect(prompt(page).getByRole('button', { name: 'Keep blocked', exact: true })).toBeVisible()
      await expect(prompt(page).locator('.script-permission-summary')).toHaveAttribute('title', `This report contains JavaScript. Allow it for all HTML reports in ${projectLabel}?`)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'JavaScript prompt widened the page')
    }
    await allow(page).focus()
    await page.keyboard.press('Tab')
    await expect(prompt(page).getByRole('button', { name: 'Keep blocked', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(prompt(page)).toHaveCount(0)
    assert.equal((await requests(page, 'projects/trust')).length, 0)
  }, blockedReader)
  console.log('PASS: JavaScript prompt matches toolbar height across desktop/phone widths, densities and font sizes, with project scope and keyboard dismissal intact')

  await run(async (page, htmlDownloads) => {
    let heldFrame
    await page.route('**/p/opaque-check/report.html', route => { heldFrame = route })
    await finish(page, await request(page, 'preview', 1), blockedPreview())
    await expect.poll(() => Boolean(heldFrame)).toBe(true)
    const first = await request(page, 'preview/scripts', 1)
    assert.deepEqual((await requests(page, 'preview/scripts')).map(({ method, body }) => ({ method, body })),
      [{ method: 'POST', body: { token: 'opaque-check' } }])
    await finish(page, first, inspection('pending'))
    await expect(prompt(page)).toHaveCount(0)
    await finish(page, await request(page, 'preview/scripts', 2), inspection())
    await expect(prompt(page)).toContainText('Synthetic project')
    await heldFrame.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Blocked synthetic report</p>' })
    assert.equal((await requests(page, 'preview')).length, 1)
    assert.equal(htmlDownloads(), 1, 'Inspection downloaded the HTML again')
    await allow(page).click()
    const grant = await request(page, 'projects/trust', 1)
    await expect(allow(page)).toBeDisabled()
    await allow(page).evaluate(button => button.click())
    assert.deepEqual((await requests(page, 'projects/trust')).map(({ method, body }) => ({ method, body })),
      [{ method: 'POST', body: { host: 'fixture-a', root: 'root', revision: 'captured-revision' } }])
    await finish(page, grant, { revision: 'trusted-revision' })
    await expect.poll(() => page.evaluate(() => window.permissionCallbacks)).toBe(1)
    await finish(page, await request(page, 'preview', 2), preview('trusted-v2', true))
    await expect(page.locator('iframe[sandbox="allow-scripts"]:not(.pending-preview)')).toHaveCount(1)
    await expect(prompt(page)).toHaveCount(0)
    assert.equal((await requests(page, 'file-info')).length, 0, 'Grant unexpectedly resumed polling')
  }, blockedReader)
  console.log('PASS: HTML inspection can prompt before a slow iframe finishes without duplicate downloads; a single explicit grant uses captured project/revision and refreshes a paused reader through its callback')

  await run(async page => {
    await finish(page, await openBlocked(page), inspection())
    await page.getByRole('button', { name: 'Keep blocked', exact: true }).click()
    await expect(prompt(page)).toHaveCount(0)
    await refreshButton(page).click()
    await finish(page, await request(page, 'preview', 2), blockedPreview('v1', 'renewed-check'))
    await expect(page.locator('iframe:not(.pending-preview)')).toHaveAttribute('src', /renewed-check/)
    assert.equal((await requests(page, 'preview/scripts')).length, 1, 'Unchanged refresh repeated a dismissed prompt')
    assert.equal((await requests(page, 'projects/trust')).length, 0)
    await expect(prompt(page)).toHaveCount(0)
    await refreshButton(page).click()
    await finish(page, await request(page, 'preview', 3), blockedPreview('v2', 'changed-check'))
    await finish(page, await request(page, 'preview/scripts', 2), inspection())
    await expect(allow(page)).toBeVisible()
    assert.equal((await requests(page, 'projects/trust')).length, 0)
  }, blockedReader)
  console.log('PASS: Keep blocked grants nothing and suppresses unchanged refresh; a new report version is checked again')

  for (const status of ['absent', 'unknown', 'readonly', 'trusted']) {
    await run(async (page, htmlDownloads) => {
      if (status === 'trusted') {
        await finish(page, await request(page, 'preview', 1), { ...preview('trusted', true), scriptCheck: 'unused-check' })
        await expect(page.locator('iframe[sandbox="allow-scripts"]:not(.pending-preview)')).toHaveCount(1)
        assert.equal((await requests(page, 'preview/scripts')).length, 0)
      } else {
        await finish(page, await openBlocked(page), inspection(status === 'readonly' ? 'present' : status, status !== 'readonly'))
      }
      if (status === 'unknown') {
        await expect(prompt(page)).toContainText('JavaScript check incomplete')
        await expect(prompt(page).locator('.script-permission-summary')).toHaveAttribute('title', /could not be fully checked for JavaScript/)
        await expect(prompt(page)).not.toContainText('This report contains JavaScript.')
        await expect(allow(page)).toBeVisible()
        assert.equal((await requests(page, 'projects/trust')).length, 0, 'Unknown inspection granted permission automatically')
        await page.getByRole('button', { name: 'Keep blocked', exact: true }).click()
      } else {
        await expect(allow(page)).toHaveCount(0)
        if (status === 'readonly') {
          await expect(prompt(page)).toContainText('administrator')
          await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
        }
      }
      await expect(prompt(page)).toHaveCount(0)
      assert.equal((await requests(page, 'projects/trust')).length, 0)
      assert.equal(htmlDownloads(), 1)
    }, blockedReader)
  }
  console.log('PASS: absent/trusted/read-only reports cannot grant; unknown inspection is honest and leaves permission to explicit choice')

  for (const status of [503, 409]) {
    await run(async (page, htmlDownloads) => {
      await finish(page, await openBlocked(page), inspection())
      await allow(page).click()
      await finish(page, await request(page, 'projects/trust', 1), { error: 'Synthetic grant failure' }, status)
      await expect(prompt(page).getByRole('alert')).toContainText('Synthetic grant failure')
      await expect(page.locator('iframe[sandbox=""]:not(.pending-preview)')).toHaveCount(1)
      assert.equal(await page.evaluate(() => window.permissionCallbacks), 0)
      assert.equal(htmlDownloads(), 1)
      if (status === 409) {
        await expect(allow(page)).toHaveCount(0)
        await page.getByRole('button', { name: 'Reload report', exact: true }).click()
        await finish(page, await request(page, 'preview', 2), blockedPreview('v2', 'fresh-check'))
        await finish(page, await request(page, 'preview/scripts', 2), { ...inspection(), revision: 'fresh-revision' })
        await allow(page).click()
        const retry = await request(page, 'projects/trust', 2)
        assert.deepEqual((await requests(page, 'projects/trust'))[1].body,
          { host: 'fixture-a', root: 'root', revision: 'fresh-revision' })
        await finish(page, retry, { error: 'Still blocked' }, 503)
      } else await expect(allow(page)).toBeEnabled()
    }, blockedReader)
  }
  console.log('PASS: failed grants retain the sandbox; stale revision requires a new preview/inspection before a grant with its fresh revision')

  for (const change of ['tab', 'host', 'source-view', 'trust', 'pending-grant']) {
    await run(async page => {
      let late = await openBlocked(page)
      if (change === 'pending-grant') {
        await finish(page, late, inspection())
        await allow(page).click()
        late = await request(page, 'projects/trust', 1)
      }
      if (change === 'source-view') {
        await page.getByRole('button', { name: 'Source', exact: true }).click()
        await finish(page, await request(page, 'text', 1), text('Synthetic HTML source', 'v1'))
        await expect(readerText(page)).toBeVisible()
      } else {
        await page.evaluate(({ change, location }) => window.updateReader(change === 'trust'
          ? { projectTrustedScripts: true }
          : { location: { ...location, ...(change === 'host' ? { host: 'fixture-b' } : { path: 'other.html' }) } }), { change, location: htmlLocation })
        await finish(page, await request(page, 'preview', 2), preview('new-owner', change === 'trust'))
        await expect(page.locator('iframe:not(.pending-preview)')).toHaveCount(1)
      }
      assert(await page.evaluate(id => window.requests[id].signal.aborted, late), `${change} did not cancel the old permission request`)
      await finish(page, late, change === 'pending-grant' ? { revision: 'late-grant' } : inspection())
      await expect(prompt(page)).toHaveCount(0)
      assert.equal((await requests(page, 'projects/trust')).length, change === 'pending-grant' ? 1 : 0)
      assert.equal(await page.evaluate(() => window.permissionCallbacks), 0, 'Obsolete permission request invoked the new reader callback')
    }, blockedReader)
  }
  console.log('PASS: late inspection/grant replies cannot cross tab, host, source-view or trust changes')

  for (const metadataFirst of [true, false]) {
    await run(async page => {
      const initial = await request(page, 'text', 1)
      const stat = await request(page, 'file-info', 1)
      if (metadataFirst) await finish(page, stat, metadata('v2'))
      await finish(page, initial, text('UNCHANGED v2'))
      if (!metadataFirst) await finish(page, stat, metadata('v2'))
      await expect(readerText(page)).toHaveText('UNCHANGED v2')
      for (let count = 2; count <= 4; count++) {
        await poll(page)
        await finish(page, await request(page, 'file-info', count), metadata('v2'))
      }
      assert.equal((await requests(page, 'text')).length, 1)
      await refreshButton(page).focus()
      await page.keyboard.press('Enter')
      await request(page, 'text', 2)
      await expect(refreshButton(page)).toBeDisabled()
      await expect(refreshButton(page)).toBeFocused()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await refreshButton(page).evaluate(button => button.click())
      assert.equal((await requests(page, 'text')).length, 2, 'Busy Refresh started another content request')
      await page.getByRole('button', { name: 'Reader options', exact: true }).click()
      const panel = page.locator('.reader-actions-panel')
      const overflow = panel.getByRole('button', { name: 'Refresh file', exact: true })
      await expect(overflow).toBeDisabled()
      await overflow.focus()
      await page.keyboard.press('Enter')
      await expect(panel).toBeVisible()
      await expect(overflow).toBeFocused()
      assert.equal((await requests(page, 'text')).length, 2, 'Busy overflow Refresh started another request')
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
      await refreshButton(page).focus()
      await finish(page, await request(page, 'text', 2), text('MANUAL v2'))
      await expect(readerText(page)).toHaveText('MANUAL v2')
      await expect(refreshButton(page)).toBeFocused()
    })
  }
  console.log('PASS: unchanged initial content loads once in either response order; stable polls reuse it and manual refresh forces a read')

  await run(async page => {
    const initial = await request(page, 'text', 1)
    const stat = await request(page, 'file-info', 1)
    await finish(page, initial, text('NEW v2'))
    await finish(page, stat, metadata('v1'))
    await finish(page, await request(page, 'file-info', 2), metadata('v2'))
    await expect(readerText(page)).toHaveText('NEW v2')
    assert.equal((await requests(page, 'text')).length, 1, 'An older stat caused a duplicate read of newer content')
    await poll(page)
    await finish(page, await request(page, 'file-info', 3), metadata('v2'))
    assert.equal((await requests(page, 'text')).length, 1)
  })
  console.log('PASS: opaque tokens are reconciled with a fresh stat when the first stat predates adopted content')

  await run(async page => {
    const replacement = await beginRace(page)
    await finish(page, replacement, text('NEW v2'))
    await expect(readerText(page)).toHaveText('NEW v2')
    await expect(refreshButton(page)).toBeEnabled()
    for (let count = 3; count <= 5; count++) {
      await poll(page)
      await finish(page, await request(page, 'file-info', count), metadata('v2'))
      await expect(refreshButton(page)).toBeEnabled()
    }
    assert.equal((await requests(page, 'text')).length, 2, 'Settled metadata caused a refresh loop')
    await refreshButton(page).click()
    await finish(page, await request(page, 'text', 3), text('MANUAL v2'))
    await expect(readerText(page)).toHaveText('MANUAL v2')
  })
  console.log('PASS: late initial v1 is replaced by v2 without a refresh loop')

  await run(async page => {
    const replacement = await beginRace(page)
    await finish(page, replacement, text('NEW v3', 'v3'))
    await expect(readerText(page)).toHaveText('NEW v3')
    // The previous target v2 must not be acknowledged for adopted v3 bytes.
    await poll(page)
    await finish(page, await request(page, 'file-info', 3), metadata('v2'))
    await finish(page, await request(page, 'file-info', 4), metadata('v3'))
    assert.equal((await requests(page, 'text')).length, 2)
    await poll(page)
    await finish(page, await request(page, 'file-info', 5), metadata('v3'))
    assert.equal((await requests(page, 'text')).length, 2)
  })
  console.log('PASS: a replacement that changes again stays pending until its actual version is validated')

  for (const mixed of [false, true]) {
    await run(async page => {
      await finish(page, await request(page, 'file-info', 1), metadata('v2'))
      await finish(page, await request(page, 'text', 1), text(mixed ? 'OLD markdown' : 'NEW markdown', mixed ? 'v1' : 'v2'))
      await finish(page, await request(page, 'preview', 1), preview('v2'))
      if (mixed) {
        await finish(page, await request(page, 'file-info', 2), metadata('v2'))
        await finish(page, await request(page, 'text', 2), text('NEW markdown'))
      }
      await expect(page.locator('.markdown-viewer')).toHaveText('NEW markdown')
      await poll(page)
      await finish(page, await request(page, 'file-info', mixed ? 3 : 2), metadata('v2'))
      assert.equal((await requests(page, 'text')).length, mixed ? 2 : 1)
      assert.equal((await requests(page, 'preview')).length, 1, 'Healthy Markdown capability was needlessly replaced')
    }, { location: { host: 'fixture-a', root: 'root', path: 'reports/notes.md', kind: 'file' } })
  }
  console.log('PASS: unchanged Markdown uses one text/preview pair; mixed versions reload only stale text')

  await run(async page => {
    await finish(page, await request(page, 'file-info', 1), metadata('v2'))
    await finish(page, await request(page, 'text', 1), text('HEALTHY markdown'))
    await finish(page, await request(page, 'preview', 1), { error: 'Temporary preview failure' }, 503)
    await finish(page, await request(page, 'file-info', 2), metadata('v2'))
    await finish(page, await request(page, 'preview', 2), preview('v2'))
    await expect(page.locator('.markdown-viewer')).toHaveText('HEALTHY markdown')
    await poll(page)
    await finish(page, await request(page, 'file-info', 3), metadata('v2'))
    assert.equal((await requests(page, 'text')).length, 1)
    assert.equal((await requests(page, 'preview')).length, 2)
  }, { location: { host: 'fixture-a', root: 'root', path: 'reports/notes.md', kind: 'file' } })
  console.log('PASS: a failed Markdown capability retries independently of healthy text')

  await run(async page => {
    await finish(page, await request(page, 'file-info', 1), metadata('v2'))
    await finish(page, await request(page, 'text', 1), { text: 'UNVERSIONED', size: 11, truncated: false })
    await expect(page.getByRole('heading', { name: 'Couldn’t open this file' })).toBeVisible()
    await finish(page, await request(page, 'file-info', 2), metadata('v2'))
    await finish(page, await request(page, 'text', 2), text('VERSIONED'))
    await expect(readerText(page)).toHaveText('VERSIONED')
  })
  console.log('PASS: unversioned responses are rejected instead of using an API compatibility fallback')

  await run(async page => {
    await finish(page, await request(page, 'file-info', 1), metadata('v2'))
    await finish(page, await request(page, 'text', 1), text('OLD v1', 'v1'))
    const staleStat = await request(page, 'file-info', 2)
    await expect(refreshButton(page)).toBeEnabled()
    await refreshButton(page).click()
    const manual = await request(page, 'text', 2)
    await finish(page, staleStat, metadata('v2'))
    assert.equal((await requests(page, 'text'))[1].aborted, false, 'Old validation cancelled a newer manual request')
    await finish(page, manual, text('MANUAL v3', 'v3'))
    await expect(readerText(page)).toHaveText('MANUAL v3')
    await poll(page)
    await finish(page, await request(page, 'file-info', 3), metadata('v3'))
    assert.equal((await requests(page, 'text')).length, 2)
  })
  console.log('PASS: manual refresh supersedes a delayed reconciliation without being cancelled or overwritten')

  await run(async page => {
    const initial = await request(page, 'text', 1)
    await finish(page, await request(page, 'file-info', 1), metadata('v2'))
    await page.getByRole('button', { name: 'Pause automatic refresh', exact: true }).click()
    await finish(page, initial, text('INITIAL COMPLETED', 'v1'))
    await expect(readerText(page)).toHaveText('INITIAL COMPLETED')
    for (let i = 0; i < 3; i++) await poll(page, false)
    assert.equal((await requests(page, 'file-info')).length, 1)
    assert.equal((await requests(page, 'text')).length, 1)
    await page.getByRole('button', { name: 'Resume automatic refresh', exact: true }).click()
    await finish(page, await request(page, 'file-info', 2), metadata('v2'))
    await finish(page, await request(page, 'file-info', 3), metadata('v2'))
    await finish(page, await request(page, 'text', 2), text('NEW v2'))
    await expect(readerText(page)).toHaveText('NEW v2')
  })
  console.log('PASS: cancelling validation while it waits does not cancel the independent initial read or acknowledge stale bytes')

  await run(async page => {
    await finish(page, await request(page, 'file-info', 1), metadata('trusted', true))
    await finish(page, await request(page, 'preview', 1), preview('trusted', true))
    await expect(page.locator('iframe[sandbox="allow-scripts"]:not(.pending-preview)')).toHaveCount(1)
    // A mounted iframe can still be loading; polling deliberately waits for it.
    await expect(refreshButton(page)).toBeEnabled()
    await poll(page)
    await finish(page, await request(page, 'file-info', 2), metadata('untrusted', false))
    await expect(page.locator('iframe[sandbox="allow-scripts"]')).toHaveCount(0)
    await finish(page, await request(page, 'file-info', 3), metadata('untrusted', false))
    const revoked = await request(page, 'preview', 2)
    await page.evaluate(() => window.updateReader({ projectTrustedScripts: false, autoRefreshPaused: true }))
    assert.equal((await requests(page, 'preview'))[1].aborted, true)
    await finish(page, revoked, preview('trusted', true, 'late'))
    await expect(page.locator('iframe[sandbox="allow-scripts"]')).toHaveCount(0)
    await finish(page, await request(page, 'preview', 3), preview('untrusted', false))
    await expect(page.locator('iframe[sandbox=""]:not(.pending-preview)')).toHaveCount(1)
    await expect(refreshButton(page)).toBeEnabled()
    for (let i = 0; i < 3; i++) await poll(page, false)
    assert.equal((await requests(page, 'file-info')).length, 3)
    await page.getByRole('button', { name: 'Resume automatic refresh', exact: true }).click()
    await finish(page, await request(page, 'file-info', 4), metadata('untrusted', false))
    assert.equal((await requests(page, 'preview')).length, 3)
  }, { projectTrustedScripts: true, location: { host: 'fixture-a', root: 'root', path: 'report.html', kind: 'file' } })

  await run(async page => {
    await finish(page, await request(page, 'file-info', 1), metadata('untrusted', false))
    await finish(page, await request(page, 'preview', 1), preview('trusted', true))
    await expect(page.locator('iframe')).toHaveCount(0)
    await finish(page, await request(page, 'file-info', 2), metadata('untrusted', false))
    await finish(page, await request(page, 'preview', 2), preview('untrusted', false))
    await expect(page.locator('iframe[sandbox=""]:not(.pending-preview)')).toHaveCount(1)
    await expect(refreshButton(page)).toBeEnabled()
    await page.getByRole('button', { name: 'Pause automatic refresh', exact: true }).click()
    await refreshButton(page).click()
    await finish(page, await request(page, 'preview', 3), preview('new-grant', true))
    await expect(page.locator('iframe[sandbox="allow-scripts"]:not(.pending-preview)')).toHaveCount(1)
    await expect(refreshButton(page)).toBeEnabled()
    assert.equal((await requests(page, 'file-info')).length, 2)
    await page.getByRole('button', { name: 'Resume automatic refresh', exact: true }).click()
    await finish(page, await request(page, 'file-info', 3), metadata('new-grant', true))
    assert.equal((await requests(page, 'preview')).length, 3)
  }, { projectTrustedScripts: true, location: { host: 'fixture-a', root: 'root', path: 'report.html', kind: 'file' } })
  console.log('PASS: trust revocation removes old frames immediately and late trusted capabilities cannot reappear')

  for (const cancelledStatus of [200, 401]) await run(async page => {
    const replacement = await beginRace(page)
    await page.evaluate(() => {
      window.expirations = 0
      window.addEventListener('artiface:unauthorized', () => window.expirations++)
    })
    await page.getByRole('button', { name: 'Pause automatic refresh', exact: true }).click()
    assert.equal((await requests(page, 'text'))[1].aborted, true)
    await finish(page, replacement, text('CANCELLED v2'), cancelledStatus)
    assert.equal(await page.evaluate(() => window.expirations), 0, 'A canceled response expired the active session')
    await expect(refreshButton(page)).toBeEnabled()
    for (let i = 0; i < 5; i++) await poll(page, false)
    assert.equal((await requests(page, 'file-info')).length, 2)
    assert.equal((await requests(page, 'text')).length, 2)
    await expect(page.locator('.preview-content')).not.toContainText('CANCELLED v2')
    await refreshButton(page).click()
    await finish(page, await request(page, 'text', 3), text('MANUAL WHILE PAUSED'))
    await expect(readerText(page)).toHaveText('MANUAL WHILE PAUSED')
    await page.getByRole('button', { name: 'Resume automatic refresh', exact: true }).click()
    await finish(page, await request(page, 'file-info', 3), metadata('v2'))
    await expect(readerText(page)).toHaveText('MANUAL WHILE PAUSED')
    assert.equal((await requests(page, 'text')).length, 3, 'Resume duplicated the successful paused manual read')
  })
  console.log('PASS: pausing aborts revalidation, late responses stay discarded, and resume establishes a fresh baseline')

  await run(async page => {
    await finish(page, await request(page, 'text', 1), text('INITIAL WHILE PAUSED', 'v1'))
    await expect(readerText(page)).toHaveText('INITIAL WHILE PAUSED')
    for (let i = 0; i < 5; i++) await poll(page, false)
    assert.equal((await requests(page, 'file-info')).length, 0)
    assert.equal((await requests(page, 'text')).length, 1)
    await page.getByRole('button', { name: 'Resume automatic refresh', exact: true }).click()
    await finish(page, await request(page, 'file-info', 1), metadata('v2'))
    await finish(page, await request(page, 'file-info', 2), metadata('v2'))
    await finish(page, await request(page, 'text', 2), text('NEW v2'))
    await expect(readerText(page)).toHaveText('NEW v2')
  }, { autoRefreshPaused: true })
  console.log('PASS: an initially paused tab still loads once without polling and catches up when resumed')

  await run(async page => {
    const replacement = await beginRace(page)
    await finish(page, replacement, { error: 'Temporary fixture failure' }, 503)
    await expect(page.locator('.refresh-stale')).toHaveCount(1)
    await expect(readerText(page)).toHaveText('OLD v1')
    await page.getByRole('button', { name: 'Reader options', exact: true }).click()
    await expect(page.getByRole('group', { name: 'File information', exact: true }).locator('.reader-refresh-error'))
      .toHaveText('Update pending: Temporary fixture failure')
    await expect(page.getByRole('button', { name: 'Open containing folder', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await poll(page)
    await finish(page, await request(page, 'file-info', 3), metadata('v2'))
    await finish(page, await request(page, 'file-info', 4), metadata('v2'))
    const retry = await request(page, 'text', 3)
    await page.evaluate(() => window.setHidden(true))
    assert.equal((await requests(page, 'text'))[2].aborted, true)
    await finish(page, retry, text('HIDDEN RESPONSE'))
    await expect(refreshButton(page)).toBeEnabled()
    for (let i = 0; i < 5; i++) await poll(page, false)
    assert.equal((await requests(page, 'file-info')).length, 4)
    await page.evaluate(() => window.setHidden(false))
    await finish(page, await request(page, 'file-info', 5), metadata('v2'))
    await finish(page, await request(page, 'file-info', 6), metadata('v2'))
    const visible = await request(page, 'text', 4)
    await page.evaluate(() => window.updateReader({
      location: { host: 'fixture-b', root: 'root', path: 'notes.py', kind: 'file' },
    }))
    await finish(page, visible, text('WRONG HOST'))
    const secondOriginal = await request(page, 'text', 5)
    await finish(page, await request(page, 'file-info', 7), metadata('v2'))
    await finish(page, secondOriginal, text('SECOND HOST v2'))
    await expect(readerText(page)).toHaveText('SECOND HOST v2')
    assert.equal((await requests(page, 'text')).length, 5)
    await page.getByRole('button', { name: 'Reader options', exact: true }).click()
    await expect(page.getByRole('group', { name: 'File information', exact: true }).locator('.reader-refresh-error')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
  console.log('PASS: failed revalidation retries, hidden readers stay idle, and late responses cannot cross file identities')

  await run(async page => {
    await finish(page, await request(page, 'file-info', 1), metadata('v1'))
    await expect(page.locator('[data-pdf-refresh]')).toHaveAttribute('data-pdf-refresh', '0')
    await poll(page)
    await finish(page, await request(page, 'file-info', 2), metadata('v1'))
    await expect(page.locator('[data-pdf-refresh]')).toHaveAttribute('data-pdf-refresh', '0')
    assert.equal((await requests(page, 'text')).filter(item => item.host === 'pdf-fixture').length, 0)
    assert.equal((await requests(page, 'preview')).length, 0)
  }, { location: { host: 'pdf-fixture', root: 'root', path: 'report.pdf', kind: 'file' } })
  console.log('PASS: initial PDF metadata does not invalidate its independently validated cached reader')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await (process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
  try { await checkFileRefresh({ browser }) } finally { await browser.close() }
}
