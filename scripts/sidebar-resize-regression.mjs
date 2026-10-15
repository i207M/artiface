import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../web', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const engine = process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium
const touch = process.env.ARTIFACE_TOUCH === '1'
const artifacts = await mkdtemp(join(tmpdir(), 'artiface-sidebar-resize-'))
const origin = 'https://sidebar-resize.invalid'
const project = { host: 'fixture', root: 'reports' }
const paths = ['experiment-with-a-long-descriptive-name.txt', 'dashboard.html']
const text = Array.from({ length: 1200 }, (_, i) => i + ' synthetic source column'.repeat(20)).join('\n')
const logo = await readFile(join(web, 'public/favicon.svg'), 'utf8')
// Exercise real Workspace/readers/preferences against synthetic responses, without a server.
const bundle = await rolldown({
  cwd: web, input: 'fixture:sidebar-resize', platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'sidebar-resize-fixture',
    resolveId(id) {
      if (id === 'fixture:sidebar-resize') return '\0fixture'
      if (id.endsWith('.css')) return '\0css'
      if (id.includes('.svg?')) return '\0logo'
      if (id === './PDFViewer') return '\0pdf'
      if (id === './useSourceHighlight') return '\0highlight'
    },
    async load(id) {
      if (id === '\0css') return ''
      if (id === '\0logo') return `export default ${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(logo)}`)}`
      if (id === '\0highlight') return 'export const useSourceHighlight = () => null'
      if (id === '\0pdf') return 'export default function PDF(){return null}'
      if (id === join(web, 'src/components/OverviewColumns.tsx')) {
        const source = await readFile(id, 'utf8')
        return source.replace('  const columns = useRef', '  window.fixtureOverviewRenders++\n  const columns = useRef')
      }
      if (id === join(web, 'src/components/Workspace.tsx')) {
        const source = await readFile(id, 'utf8')
        const marker = '  const [preferences, setPreferences] = usePreferences()'
        assert(source.includes(marker))
        return source.replace(marker, `  window.fixtureRenders++\n${marker}`)
      }
      if (id === join(web, 'src/components/workspaceTabs.ts')) {
        const source = await readFile(id, 'utf8')
        const idlePoll = 'succeeded && (pending.current.size || pendingMoves.current.length) ? 0 : 5000'
        assert(source.includes(idlePoll), 'Update the fixture for the current shared-project polling schedule')
        // Background sync is covered separately; keep it outside the resize/focus measurements.
        // Initial, explicit, and pending-write synchronization still run normally.
        return source.replace(idlePoll, 'succeeded && (pending.current.size || pendingMoves.current.length) ? 0 : 300_000')
      }
      if (id === '\0fixture') return `
        import React, {StrictMode} from 'react'
        import {createRoot} from 'react-dom/client'
        import {flushSync} from 'react-dom'
        import Workspace from ${JSON.stringify(join(web, 'src/components/Workspace.tsx'))}
        import {useLocation} from ${JSON.stringify(join(web, 'src/location.ts'))}
        import {setPreferences} from ${JSON.stringify(join(web, 'src/preferences.ts'))}
        window.fixturePreferences = patch => flushSync(() => setPreferences(patch))
        const root = createRoot(document.getElementById('root'))
        window.fixtureUnmount = () => flushSync(() => root.unmount())
        function Fixture() {
          const [location, navigate] = useLocation()
          window.fixtureNavigate = next => flushSync(() => navigate(next))
          return React.createElement(Workspace, {location, navigate, onLogout(){}})
        }
        root.render(React.createElement(StrictMode, null, React.createElement(Fixture)))
      `
    },
  }],
})
const { output } = await bundle.generate({ format: 'iife', codeSplitting: false })
await bundle.close()
const script = output.find(item => item.type === 'chunk').code
// Match main.tsx: component styles precede viewers.css and the global controls.
const css = (await Promise.all(['components/settings.css', 'components/workspace.css', 'viewers.css', 'styles.css']
  .map(path => readFile(join(web, 'src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const browser = await engine.launch({ headless: true })
const errors = []
const downloads = { text: 0, preview: 0, frame: 0, listing: 0 }
let apiReads = 0
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: touch })
  context.setDefaultTimeout(5000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.addInitScript(({ origin, project, paths }) => {
    if (window.top !== window || location.origin !== origin) return
    if (!localStorage.getItem('artiface.preferences.v1')) {
      localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300, gitStatus: false }))
      sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({
        projects: [{ ...project, directory: '', activePath: paths[0], expanded: true }],
        tabs: paths.map(path => ({ ...project, path, autoRefreshPaused: true })),
      }))
    }
    window.fixtureWrites = 0
    window.fixtureRenders = 0
    window.fixtureOverviewRenders = 0
    window.fixtureNavigations = 0
    const pushState = history.pushState
    history.pushState = function (...args) {
      window.fixtureNavigations++
      return pushState.apply(this, args)
    }
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === 'artiface.preferences.v1') window.fixtureWrites++
      return setItem.call(this, key, value)
    }
  }, { origin, project, paths })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname.startsWith('/api/') && route.request().method() === 'GET') apiReads++
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    if (url.pathname === '/p/healthz') return route.fulfill({ status: 204 })
    if (url.pathname === '/frame') {
      downloads.frame++
      return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><style>body{font:20px system-ui;background:#edf1ee;padding:32px}</style><h1>Synthetic dashboard</h1><input aria-label="Dashboard state"><script>window.pointerUps=0;addEventListener("pointerup",()=>pointerUps++)</script>' })
    }
    let body
    if (url.pathname === '/api/hosts') body = { revision: 'fixture', setupEnabled: false, hosts: [
      { id: project.host, kind: 'local', label: 'Synthetic machine', roots: [
        { id: project.root, label: 'Long project name for resize review', path: '/synthetic/reports', trustedScripts: true },
      ] },
    ] }
    if (url.pathname === '/api/workspace/projects') body = { projects: [project], sourcesRevision: 'fixture' }
    if (url.pathname === '/api/list') {
      downloads.listing++
      body = { entries: Array.from({ length: 180 }, (_, i) => {
        const name = `experiment-${String(i).padStart(3, '0')}-results.txt`
        return { name, path: name, type: 'file', size: 1234, modified: '2026-09-21T12:00:00Z' }
      }) }
    }
    if (url.pathname === '/api/text') { downloads.text++; body = { text, size: text.length, version: 'fixture', truncated: false } }
    if (url.pathname === '/api/preview') {
      downloads.preview++
      body = { url: `${origin}/frame`, version: 'fixture', scripts: true, expiresAt: new Date(Date.now() + 3600_000).toISOString() }
    }
    if (url.pathname === '/api/file-info') body = { size: 1234, modified: '2026-09-21T12:00:00Z', version: 'fixture', trustedScripts: true }
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? {}) })
  })
  const page = await context.newPage()
  await page.goto(`${origin}/#${new URLSearchParams({ ...project, path: paths[0], kind: 'file' })}`)
  const handle = page.getByRole('separator', { name: 'Project sidebar width' })
  const sidebar = page.locator('#project-sidebar')
  const settle = () => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const width = () => sidebar.evaluate(element => element.getBoundingClientRect().width)
  const writes = () => page.evaluate(() => window.fixtureWrites)
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('artiface.preferences.v1')).sidebarWidth)
  const expectWidth = async value => {
    await expect.poll(width).toBe(value)
    await expect(handle).toHaveAttribute('aria-valuenow', String(value))
    await expect.poll(() => page.locator('.workspace-main').evaluate(element => element.getBoundingClientRect().left)).toBe(value)
  }
  const begin = async () => {
    const box = await handle.boundingBox()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    assert(await handle.evaluate(element => element.hasPointerCapture(1)), 'Drag did not capture the mouse')
    return { x, y }
  }
  const clean = async () => {
    assert(await page.evaluate(() => !document.body.classList.contains('resizing-project-sidebar') &&
      !document.querySelector('.is-resizing-sidebar')), 'Resize styles leaked after the gesture')
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).cursor), 'crosshair')
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'text')
  }
  await expect(page.locator('.source-code')).toBeVisible()
  await settle()
  await expectWidth(260)
  // Layout bounds alone miss a half-pixel shift caused by snapping a 1px fill.
  const expectGuidePaint = async () => {
    const clip = await page.locator('.project-group').evaluate(group => {
      const folder = group.querySelector('.project-disclosure svg').getBoundingClientRect()
      const children = group.querySelector('.project-children').getBoundingClientRect()
      return { x: folder.x + folder.width / 2 - 2, y: Math.floor(children.y + 8), width: 4, height: 1 }
    })
    const paint = await page.screenshot({ clip, scale: 'css' })
    const pixels = await page.evaluate(encoded => new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = 4; canvas.height = 1
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        resolve(Array.from(context.getImageData(0, 0, 4, 1).data))
      }
      image.onerror = () => reject(new Error('Could not inspect the tree-guide screenshot'))
      image.src = `data:image/png;base64,${encoded}`
    }), paint.toString('base64'))
    assert.deepEqual(pixels.slice(4, 8), pixels.slice(8, 12), 'Painted tree guide is not centered below the folder icon')
    assert.deepEqual(pixels.slice(0, 4), pixels.slice(12, 16), 'Tree-guide test crossed another painted element')
    assert.notDeepEqual(pixels.slice(0, 4), pixels.slice(4, 8), 'Tree guide is missing')
    // The SVG box can be centered while the actual folder base leans to one side.
    const icon = await sidebar.locator('.project-disclosure svg').first().boundingBox()
    const bounds = { x: Math.floor(icon.x), y: Math.floor(icon.y),
      width: Math.ceil(icon.x + icon.width) - Math.floor(icon.x), height: Math.ceil(icon.y + icon.height) - Math.floor(icon.y) }
    const ink = await page.screenshot({ clip: bounds, scale: 'css' })
    const center = await page.evaluate(({ encoded, start, end }) => new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, image.width, image.height).data
        let weight = 0, position = 0
        for (let y = start; y < end; y++) for (let x = 0; x < image.width; x++) {
          const index = (y * image.width + x) * 4
          const background = y * image.width * 4
          const strength = [0, 1, 2].reduce((sum, channel) => sum + Math.abs(pixels[index + channel] - pixels[background + channel]), 0)
          weight += strength
          position += (x + .5) * strength
        }
        resolve(weight ? position / weight : null)
      }
      image.onerror = reject
      image.src = `data:image/png;base64,${encoded}`
    }), { encoded: ink.toString('base64'), start: Math.ceil(icon.y - bounds.y + icon.height * 18.5 / 24), end: Math.floor(icon.y - bounds.y + icon.height * 21.5 / 24) })
    assert(center !== null && Math.abs(bounds.x + center - icon.x - icon.width / 2) < .25, 'The visible folder base is not centered over the guide')
  }
  const expectSidebarAlignment = async () => {
    const layout = await sidebar.locator('.project-group').first().evaluate(group => {
      const project = group.querySelector('.project-open strong').getBoundingClientRect()
      const row = group.querySelector('.project-file-row').getBoundingClientRect()
      const file = group.querySelector('.project-file')
      const icon = file.querySelector('svg').getBoundingClientRect()
      const projectClose = group.querySelector('.project-close svg').getBoundingClientRect()
      const fileClose = group.querySelector('.project-file-close svg').getBoundingClientRect()
      return {
        iconIndent: icon.x - project.x, closeIndent: fileClose.x - projectClose.x,
        iconCenter: icon.y + icon.height / 2 - row.y - row.height / 2,
        closeCenter: fileClose.y + fileClose.height / 2 - row.y - row.height / 2,
      }
    })
    for (const [name, offset] of Object.entries(layout)) assert(Math.abs(offset) < 1, `${name} is misaligned by ${offset}px`)
  }
  await expectGuidePaint()
  await expectSidebarAlignment()
  await expect(sidebar.locator('.project-disclosure .project-folder-open')).toHaveCount(1)
  await expect(sidebar.locator('.project-disclosure .lucide-chevron-down, .project-disclosure .lucide-chevron-right, .project-open > svg')).toHaveCount(0)
  console.log('PASS: folder disclosure, painted guide, file icons and close controls share consistent alignment')
  await page.evaluate(() => { document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text' })
  const historyStart = await page.evaluate(() => history.length)
  const firstFile = page.getByRole('tab', { name: paths[0], exact: true })
  const browseTab = page.getByRole('tab', { name: 'Browse', exact: true })
  for (let repeat = 0; repeat < 3; repeat++) await firstFile.click()
  assert.equal(await page.evaluate(() => history.length), historyStart, 'Selecting the active file added history entries')
  await browseTab.click()
  await expect(page.getByRole('table', { name: 'Directory contents', exact: true })).toBeVisible()
  for (let repeat = 0; repeat < 3; repeat++) await browseTab.click()
  assert.equal(await page.evaluate(() => history.length), historyStart + 1, 'Selecting the active Browse tab added history entries')
  await firstFile.click()
  await expect(page.locator('.source-code')).toBeVisible()
  assert.equal(await page.evaluate(() => history.length), historyStart + 2)
  await page.goBack()
  await expect(browseTab).toHaveAttribute('aria-selected', 'true')
  await page.goBack()
  await expect(firstFile).toHaveAttribute('aria-selected', 'true')
  await page.goForward()
  await expect(browseTab).toHaveAttribute('aria-selected', 'true')
  await page.goForward()
  await expect(firstFile).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.source-code')).toBeVisible()
  await settle()
  console.log('PASS: repeated active-tab selection keeps history compact; Back and Forward reach each distinct view in one step')
  {
    const openTabs = await page.getByRole('tab').count()
    const contentReads = { text: downloads.text, preview: downloads.preview }
    await page.locator('.reader-panel:not([hidden]) .source-scroll').evaluate(element => { element.scrollTop = 400 })
    await settle()
    await page.getByRole('button', { name: 'Reader options', exact: true }).click()
    const folderCommand = page.getByRole('button', { name: 'Open containing folder', exact: true })
    await folderCommand.focus()
    await page.keyboard.press('Enter')
    await expect(browseTab).toHaveAttribute('aria-selected', 'true')
    await expect(browseTab).toBeFocused()
    await expect(page.locator('.reader-actions-panel')).toHaveCount(0)
    await expect(page.getByRole('table', { name: 'Directory contents', exact: true })).toBeVisible()
    await expect(page.getByRole('tab')).toHaveCount(openTabs)
    assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('path')), '')
    assert.deepEqual({ text: downloads.text, preview: downloads.preview }, contentReads)
    await firstFile.click()
    await expect(page.locator('.reader-panel:not([hidden]) .source-scroll')).toBeVisible()
    await expect.poll(() => page.locator('.reader-panel:not([hidden]) .source-scroll').evaluate(element => element.scrollTop)).toBe(400)
    await page.locator('.reader-panel:not([hidden]) .source-scroll').evaluate(element => { element.scrollTop = 0 })
    await settle()
    console.log('PASS: Reader options opens the containing folder with Browse focus, preserves tabs, avoids content reads, and restores the reader position on return')
  }

  await page.screenshot({ path: join(artifacts, 'default-source.png') })
  await page.locator('.reader-panel:not([hidden]) .source-scroll').evaluate(element => { element.scrollTop = 1800; element.scrollLeft = 220 })
  await page.evaluate(() => { window.fixtureCode = document.querySelector('.reader-panel:not([hidden]) .source-code code') })
  const tabState = () => page.locator('.reader-tabs [role="tab"]').evaluateAll(tabs =>
    tabs.map(tab => [tab.textContent, tab.getAttribute('aria-selected')]))
  const originalTabs = await tabState()
  const initialDownloads = { ...downloads }

  for (const delta of [180, -60, 100]) {
    // Finish the previous release before measuring the next drag.
    await settle()
    const initial = await width()
    const before = await writes()
    const renders = await page.evaluate(() => window.fixtureRenders)
    const point = await begin()
    await page.mouse.move(point.x + delta, point.y, { steps: 40 })
    await expectWidth(initial + delta)
    assert.equal(await writes(), before, 'Pointer move wrote preferences')
    assert.equal(await page.evaluate(() => window.fixtureRenders), renders, 'Pointer move rerendered Workspace')
    assert(await page.evaluate(() => window.fixtureCode === document.querySelector('.reader-panel:not([hidden]) .source-code code')), 'Drag replaced source DOM')
    assert.deepEqual(await page.locator('.reader-panel:not([hidden]) .source-scroll').evaluate(element => [element.scrollTop, element.scrollLeft]), [1800, 220])
    await page.mouse.up()
    await expect.poll(writes).toBe(before + 1)
    assert.equal(await saved(), initial + delta)
    assert.deepEqual(await tabState(), originalTabs)
    assert.deepEqual(downloads, initialDownloads, 'Resize downloaded reader content')
    await clean()
  }
  await page.getByRole('button', { name: 'Wrap long lines', exact: true }).click()
  await handle.press('ArrowLeft')
  await expect(page.getByRole('button', { name: 'Wrap long lines', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await handle.press('ArrowRight')
  assert.deepEqual(downloads, initialDownloads)
  await page.getByRole('button', { name: 'Wrap long lines', exact: true }).click()
  await page.screenshot({ path: join(artifacts, 'resized-source.png') })
  await page.reload()
  await expect(page.locator('.source-code')).toBeVisible()
  await settle()
  await expectWidth(480)
  await page.evaluate(() => { document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text' })
  console.log('PASS: 120 pointer moves, zero move-time writes/rerenders, one write per drag, source DOM/scroll/wrap and file tabs preserved, zero extra downloads, reload persistence')

  for (const action of ['escape', 'pointercancel', 'lostcapture', 'blur']) {
    const before = await writes()
    const point = await begin()
    await page.mouse.move(point.x - 90, point.y, { steps: 3 })
    await expectWidth(390)
    if (action === 'escape') await page.keyboard.press('Escape')
    if (action === 'pointercancel') await handle.dispatchEvent('pointercancel', { pointerId: 1 })
    if (action === 'lostcapture') {
      await handle.evaluate(element => element.releasePointerCapture(1))
      // Let the browser deliver pending capture changes on the next native pointer event.
      await page.mouse.move(point.x - 89, point.y)
    }
    if (action === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expectWidth(480)
    await page.mouse.up()
    assert.equal(await writes(), before)
    assert.equal(await saved(), 480)
    await clean()
  }
  await handle.focus()
  let before = await writes()
  for (let i = 0; i < 3; i++) await page.keyboard.down('ArrowLeft')
  await expectWidth(450)
  assert.equal(await writes(), before)
  await page.keyboard.up('ArrowLeft')
  assert.equal(await writes(), before + 1)
  before = await writes()
  await page.keyboard.down('ArrowRight')
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowRight')
  await expectWidth(450)
  assert.equal(await writes(), before)
  await handle.press('Shift+ArrowLeft')
  await expectWidth(410)
  await handle.press('Home')
  await expectWidth(240)
  await handle.press('ArrowLeft')
  await expectWidth(240)
  await handle.press('End')
  await expectWidth(520)
  await handle.press('Enter')
  await expectWidth(260)
  assert.equal(await saved(), null)
  await handle.press('ArrowRight')
  await handle.dblclick()
  await expectWidth(260)
  await expect(handle).toBeFocused()
  assert.equal(await saved(), null)
  console.log('PASS: Escape/pointercancel/lost capture/window blur restore width without writes; keyboard repeat, steps, bounds, reset and focus')

  await page.getByRole('button', { name: 'Open dashboard.html', exact: true }).click()
  await expect(page.locator('.html-viewer iframe:not(.pending-preview)')).toBeVisible()
  const iframe = page.frames().find(frame => frame.url().endsWith('/frame'))
  await iframe.getByRole('textbox', { name: 'Dashboard state' }).fill('Retained dashboard state')
  const iframeDownloads = { ...downloads }
  before = await writes()
  let point = await begin()
  await page.mouse.move(1100, point.y, { steps: 10 })
  await expectWidth(520)
  await page.mouse.up()
  assert.equal(await writes(), before + 1)
  assert.equal(await iframe.evaluate(() => window.pointerUps), 0)
  await expect(iframe.getByRole('textbox', { name: 'Dashboard state' })).toHaveValue('Retained dashboard state')
  assert.deepEqual(downloads, iframeDownloads)
  point = await begin()
  await page.mouse.move(-20, point.y, { steps: 10 })
  await page.mouse.up()
  await expectWidth(240)
  await handle.press('End')
  before = await writes()
  for (const viewport of [800, 701, 1440]) {
    await page.setViewportSize({ width: viewport, height: 900 })
    await settle()
    await expectWidth(Math.min(520, viewport - 420))
    assert((await page.locator('.workspace-main').boundingBox()).width >= 420)
  }
  assert.equal(await saved(), 520)
  assert.equal(await writes(), before, 'Viewport clamp persisted a narrower width')
  await page.screenshot({ path: join(artifacts, 'iframe-resized.png') })
  console.log('PASS: capture across iframe/outside viewport, 240–520 bounds, 420px main content, shrink and restore without writes')

  const heights = new Map()
  for (const fontScale of [0.9, 1, 1.4]) for (const density of ['compact', 'comfortable']) {
    await page.evaluate(patch => window.fixturePreferences(patch), { sidebarWidth: null, fontScale, density })
    await settle()
    await expectWidth(Math.min(350, Math.max(250, 260 * fontScale)))
    if (fontScale === 1) await expectGuidePaint()
    await expectSidebarAlignment()
    const header = await page.locator('.project-sidebar-header').boundingBox()
    const topbar = await page.locator('.project-topline').boundingBox()
    assert.equal(header.height, topbar.height)
    if (heights.has(fontScale)) assert.equal(topbar.height, heights.get(fontScale), 'Density changed topbar height')
    heights.set(fontScale, topbar.height)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    for (const viewport of [1000, 800, 701, 1440]) {
      await page.setViewportSize({ width: viewport, height: 900 })
      await settle()
      await expectWidth(Math.min(350, Math.max(250, 260 * fontScale), viewport - 420))
    }
  }
  await handle.press('End')
  await page.evaluate(() => window.fixturePreferences({ theme: 'dark' }))
  await settle()
  await page.screenshot({ path: join(artifacts, 'font-1.4-comfortable-dark.png') })
  await page.getByRole('button', { name: 'Use overlay sidebar' }).click()
  await expect(handle).toHaveCount(0)
  assert.equal(await width(), 340)
  await page.keyboard.press('Escape')
  await expect(sidebar).not.toBeVisible()
  const sidebarOpener = page.getByRole('button', { name: 'Show project sidebar', exact: true })
  await expect(sidebarOpener).toBeFocused()
  const overlayRoute = await page.evaluate(() => location.hash)
  await page.keyboard.down('Enter')
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await expect(sidebar.getByRole('link', { name: 'Artiface home', exact: true })).toBeFocused()
  assert.equal(await page.evaluate(() => location.hash), overlayRoute, 'Held Enter activated the newly focused sidebar link')
  await page.keyboard.press('Shift+Tab')
  await expect(sidebar.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sidebar.getByRole('link', { name: 'Artiface home', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(sidebarOpener).toBeFocused()
  await sidebarOpener.click()
  await page.getByRole('button', { name: 'Dock sidebar', exact: true }).click()
  await expectWidth(520)
  await page.getByRole('button', { name: 'Hide project sidebar' }).click()
  await expect(handle).toHaveCount(0)
  await page.getByRole('button', { name: 'Show project sidebar' }).click()
  await expectWidth(520)
  await handle.focus()
  for (const viewport of [700, 390, 320]) {
    await page.setViewportSize({ width: viewport, height: 800 })
    await expect(handle).toHaveCount(0)
    await expect(sidebar).not.toBeVisible()
    if (viewport === 700) await expect(page.getByRole('button', { name: 'Show project sidebar' })).toBeFocused()
    await page.getByRole('button', { name: 'Show project sidebar' }).click()
    await settle()
    assert.equal(await width(), Math.min(340, viewport - 32))
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    if (viewport === 320) await page.screenshot({ path: join(artifacts, 'phone-320-overlay.png') })
    await page.keyboard.press('Escape')
    await expect(sidebar).not.toBeVisible()
  }
  await settle()
  await page.screenshot({ path: join(artifacts, 'phone-320.png') })
  assert.equal(await saved(), 520)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expectWidth(520)
  assert(parseFloat(await page.locator('.workspace-shell').evaluate(element => getComputedStyle(element).transitionDuration)) < .001)
  console.log('PASS: font .9/1/1.4, both densities, equal topbar heights, dark theme, overlay/open/close, 700/390/320px phone and reduced motion')

  await page.evaluate(() => window.fixturePreferences({ fontScale: 1, density: 'compact', theme: 'light', browseView: 'icons', sidebarWidth: 240 }))
  await page.getByRole('tab', { name: 'Browse', exact: true }).click()
  const grid = page.locator('.file-grid')
  const browse = page.locator('.project-content')
  await expect(grid.locator('li')).toHaveCount(180)
  await browse.evaluate(element => { element.scrollTop = 1800 })
  await settle()
  const columns = () => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  const oldColumns = await columns()
  const browseDownloads = { ...downloads }
  const firstVisible = () => browse.evaluate(element => {
    const top = element.getBoundingClientRect().top
    return [...element.querySelectorAll('[data-browse-entry]')].find(tile => tile.getBoundingClientRect().bottom > top)?.getAttribute('data-browse-entry')
  })
  const anchor = await firstVisible()
  point = await begin()
  await page.mouse.move(point.x + 280, point.y, { steps: 20 })
  await page.mouse.up()
  await settle()
  assert((await columns()) < oldColumns, 'Fixture did not cross an icon-grid column boundary')
  assert((await browse.evaluate(element => element.scrollTop)) > 1000, 'Icon reflow reset Browse to the top')
  const anchorBox = await grid.locator(`[data-browse-entry="${anchor}"]`).boundingBox()
  const browseBox = await browse.boundingBox()
  assert(anchorBox.y + anchorBox.height > browseBox.y && anchorBox.y < browseBox.y + browseBox.height,
    'The previously visible icon scrolled out of view after reflow')
  assert.deepEqual(downloads, browseDownloads, 'Icon reflow downloaded directory/reader content')
  await page.screenshot({ path: join(artifacts, 'browse-icons-reflow.png') })
  await grid.locator(`[data-browse-entry="${anchor}"] a`).click()
  await expect(page.getByRole('heading', { name: anchor, exact: true })).toBeVisible()
  console.log('PASS: scrolled icon grid reflows columns with its visible anchor retained, no extra downloads, and usable file links')

  // The same real Workspace/reader fixture exercises a crowded strip during resizing and tab changes.
  const crowdedPaths = Array.from({ length: 36 }, (_, i) => `tab-${String(i).padStart(2, '0')}-long-descriptive-research-output.txt`)
  const strip = page.getByRole('tablist', { name: 'Project tabs' })
  const source = page.locator('.reader-panel:not([hidden]) .source-scroll')
  let crowdedLoad = 0
  const startCrowded = async ({ active = 0, viewport = 1440, fontScale = 1, density = 'compact', count = 36, files = crowdedPaths.slice(0, count), overview = false } = {}) => {
    await page.setViewportSize({ width: viewport, height: 900 })
    await page.evaluate(({ project, paths, active, fontScale, density }) => {
      localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300, gitStatus: false, fontScale, density }))
      sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({
        projects: [{ ...project, directory: '', activePath: paths[active], expanded: true }],
        tabs: paths.map(path => ({ ...project, path, autoRefreshPaused: true })),
      }))
    }, { project, paths: files, active, fontScale, density })
    await page.goto(`${origin}/?crowded=${++crowdedLoad}#${new URLSearchParams({ ...project, path: overview ? '' : files[active], kind: overview ? 'overview' : 'file' })}`)
    if (overview) {
      await expect(page.locator('.overview-columns')).toBeVisible()
      await expect(page.locator('.overview-file')).toHaveCount(files.length)
    }
    else {
      await expect(source).toBeVisible()
      await expect(strip.getByRole('tab')).toHaveCount(files.length + 1)
    }
    await settle()
    await page.evaluate(() => { document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text' })
  }
  const selectedTab = () => strip.locator('[role="tab"][aria-selected="true"]')
  const expectSelectedVisible = () => expect.poll(() => strip.evaluate(element => {
    const viewport = element.getBoundingClientRect()
    const row = element.querySelector('[aria-selected="true"]').closest('.reader-tab').getBoundingClientRect()
    return row.left >= viewport.left - 1 && row.right <= viewport.right + 1
  })).toBe(true)
  const tabAnchor = () => strip.evaluate(element => {
    const edge = element.getBoundingClientRect().left
    const row = [...element.children].find(row => row.getBoundingClientRect().right > edge + 1)
    const bounds = row.getBoundingClientRect()
    return { name: row.querySelector('[role="tab"]').getAttribute('aria-label') || 'Browse', fraction: (bounds.left - edge) / bounds.width }
  })
  const expectAnchor = async anchor => {
    await settle()
    const actual = await tabAnchor()
    assert.equal(actual.name, anchor.name, 'Manual tab viewport changed its first visible file')
    assert(Math.abs(actual.fraction - anchor.fraction) < .035, 'Manual tab viewport lost its position within the first file')
  }
  const scrollTabs = async () => {
    const box = await strip.boundingBox()
    const current = await strip.evaluate(element => element.scrollLeft)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(5600 - current, 0)
    // Native wheel scrolling can outlast settle's Web Animations and RAF waits.
    await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(5600)
    await settle()
    return tabAnchor()
  }
  const fullyVisibleTab = () => strip.evaluate(element => {
    const viewport = element.getBoundingClientRect()
    return [...element.querySelectorAll('.reader-tab:not(.browse-tab)')].find(row => {
      const bounds = row.getBoundingClientRect()
      return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1
    }).querySelector('[role="tab"]').getAttribute('aria-label')
  })

  // Native drag changes local order only after a drop; it never selects/remounts a reader.
  await startCrowded({ files: ['one.txt', 'two.txt', 'three.txt', 'four.txt'], active: 1 })
  const finePointer = await page.evaluate(() => matchMedia('(any-pointer: fine)').matches)
  assert.equal(await strip.getByRole('tab', { name: 'Browse', exact: true }).evaluate(element => element.draggable), false)
  await expect(strip.locator('[data-tab-key] [role="tab"]')).toHaveCount(4)
  for (const tab of await strip.locator('[data-tab-key] [role="tab"]').all()) {
    assert.equal(await tab.evaluate(element => element.draggable), finePointer)
  }
  if (finePointer) {
    const tab = name => strip.getByRole('tab', { name, exact: true })
    const order = () => strip.locator('[data-tab-key] [role="tab"]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
    const expectOrder = async names => {
      await expect.poll(order).toEqual(names)
      await expect.poll(() => sidebar.locator('.project-file').evaluateAll(elements => elements.map(element => element.title))).toEqual(names)
      await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('artiface.workspace.v1')).tabs.map(tab => tab.path))).toEqual(names)
      await expect(strip.getByRole('tab').first()).toHaveText('Browse')
    }
    const feedback = strip.locator('.is-dragging, .is-drop-before, .is-drop-after')
    const beginTabDrag = async name => {
      const box = await tab(name).boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 })
      await expect(strip.locator('.is-dragging')).toHaveCount(1)
    }
    for (const pointerType of ['touch', 'pen']) {
      assert(await tab('one.txt').evaluate((element, pointerType) => {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType, button: 0 }))
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        return !element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
      }, pointerType), `${pointerType} compatibility mouse event enabled tab dragging`)
      await expect(feedback).toHaveCount(0)
    }
    await source.evaluate(element => { element.scrollTop = 1200; element.scrollLeft = 80; window.tabDragReader = element; window.tabDragCode = element.querySelector('code') })
    const beforeDrag = { downloads: { ...downloads }, reads: apiReads, hash: await page.evaluate(() => location.hash), writes: await writes() }
    const mutations = []
    const recordMutation = request => { if (request.url().startsWith(`${origin}/api/`) && request.method() !== 'GET') mutations.push(request.url()) }
    context.on('request', recordMutation)
    const original = ['one.txt', 'two.txt', 'three.txt', 'four.txt']
    for (const cancel of ['Escape', 'outside']) {
      await beginTabDrag('one.txt')
      const target = await tab('four.txt').boundingBox()
      await page.mouse.move(target.x + target.width - 2, target.y + target.height / 2, { steps: 3 })
      // Moving again delivers dragover after native dragenter on the new target.
      await page.mouse.move(target.x + target.width - 2, target.y + target.height / 2)
      await expect(strip.locator('.is-drop-after')).toHaveCount(1)
      await expectOrder(original)
      if (cancel === 'Escape') await page.screenshot({ path: join(artifacts, 'tab-drag-before-drop.png') })
      if (cancel === 'Escape') await page.keyboard.press('Escape')
      else {
        const reader = await source.boundingBox()
        await page.mouse.move(reader.x + reader.width / 2, reader.y + 80, { steps: 3 })
      }
      await page.mouse.up()
      await expect(feedback).toHaveCount(0)
      await expectOrder(original)
    }
    for (const [from, to, after, expected] of [
      ['one.txt', 'four.txt', true, ['two.txt', 'three.txt', 'four.txt', 'one.txt']],
      ['two.txt', 'one.txt', true, ['three.txt', 'four.txt', 'one.txt', 'two.txt']],
      ['two.txt', 'three.txt', false, ['two.txt', 'three.txt', 'four.txt', 'one.txt']],
    ]) {
      const target = await tab(to).boundingBox()
      await tab(from).dragTo(tab(to), { targetPosition: { x: after ? target.width - 2 : 2, y: target.height / 2 } })
      await expectOrder(expected)
      await expect(feedback).toHaveCount(0)
    }
    await settle()
    await expect(selectedTab()).toHaveAttribute('aria-label', 'two.txt')
    assert.equal(await page.evaluate(() => location.hash), beforeDrag.hash)
    assert(await source.evaluate(element => element === window.tabDragReader && element.querySelector('code') === window.tabDragCode))
    assert.deepEqual(await source.evaluate(element => [element.scrollTop, element.scrollLeft]), [1200, 80])
    assert.deepEqual(downloads, beforeDrag.downloads, 'Tab dragging downloaded reader/listing content')
    assert.equal(apiReads, beforeDrag.reads, 'Tab dragging requested API data')
    assert.equal(await writes(), beforeDrag.writes, 'Tab order changed shared preferences')
    assert.deepEqual(mutations, [], 'Tab order wrote server state')
    context.off('request', recordMutation)
    await page.reload()
    await expect(source).toBeVisible()
    await expectOrder(['two.txt', 'three.txt', 'four.txt', 'one.txt'])
    await expect(selectedTab()).toHaveAttribute('aria-label', 'two.txt')
    assert.equal(await page.evaluate(() => location.hash), beforeDrag.hash)

    await startCrowded({ count: 6, viewport: 820 })
    const crowdedOrder = crowdedPaths.slice(0, 6)
    await strip.evaluate(element => { element.scrollLeft = 0 })
    await beginTabDrag(crowdedOrder[0])
    const edge = await strip.boundingBox()
    await page.mouse.move(edge.x + edge.width - 3, edge.y + edge.height / 2, { steps: 3 })
    await page.mouse.move(edge.x + edge.width - 3, edge.y + edge.height / 2)
    // Keep a real native drag at the edge: scrolling the target into view would bypass auto-scroll.
    await expect.poll(() => strip.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft), { timeout: 5000 }).toBeLessThanOrEqual(1)
    assert((await strip.evaluate(element => element.scrollLeft)) > 100, 'Fixture did not require edge auto-scroll')
    await expectOrder(crowdedOrder)
    await page.screenshot({ path: join(artifacts, 'tab-drag-edge.png') })
    const last = await tab(crowdedOrder[5]).boundingBox()
    await page.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 3 })
    await page.mouse.move(last.x + last.width - 2, last.y + last.height / 2)
    await expect(tab(crowdedOrder[5]).locator('..')).toHaveClass(/is-drop-after/)
    await page.mouse.up()
    await expectOrder([...crowdedOrder.slice(1), crowdedOrder[0]])
    await expect(feedback).toHaveCount(0)
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedOrder[0])
    await expectSelectedVisible()
    const widthBeforeResize = await strip.evaluate(element => element.clientWidth)
    await page.setViewportSize({ width: 730, height: 900 })
    await settle()
    assert((await strip.evaluate(element => element.clientWidth)) < widthBeforeResize, 'Fixture did not narrow the tab strip after the drop')
    await expectSelectedVisible()
    console.log('PASS: native mouse tab drag commits left/right order locally; Escape/outside cancel; Browse, sidebar/session order and reader state survive; crowded edge auto-scroll reaches a drop')
  }

  for (const viewport of [1440, 390]) {
    await startCrowded({ viewport })
    if (viewport === 390) {
      await page.getByRole('button', { name: 'Show project sidebar', exact: true }).click()
      await settle()
    }
    const rows = sidebar.locator('.project-file')
    const projectRow = sidebar.locator('.project-open')
    await expect(sidebar.getByRole('group', { name: 'Long project name for resize review Synthetic machine', exact: true })
      .getByRole('button', { name: `Open ${crowdedPaths[35]}`, exact: true })).toHaveCount(1)
    await source.evaluate(element => { element.scrollTop = 1200; element.scrollLeft = 80; window.sidebarReader = element })
    const before = { reads: apiReads, downloads: { ...downloads }, renders: await page.evaluate(() => window.fixtureRenders), hash: await page.evaluate(() => location.hash) }
    await rows.first().focus()
    await page.keyboard.press('End')
    await expect(rows.last()).toBeFocused()
    await expect(rows.last()).toBeInViewport()
    await page.keyboard.press('ArrowDown')
    await expect(rows.last()).toBeFocused()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowUp')
    await expect(projectRow).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(rows.first()).toBeFocused()
    assert.equal(apiReads, before.reads, 'Sidebar focus navigation requested API data')
    assert.deepEqual(downloads, before.downloads)
    assert.equal(await page.evaluate(() => window.fixtureRenders), before.renders)
    assert.equal(await page.evaluate(() => location.hash), before.hash)
    assert(await source.evaluate(element => element === window.sidebarReader))
    assert.deepEqual(await source.evaluate(element => [element.scrollTop, element.scrollLeft]), [1200, 80])
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[0])
    for (const properties of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
      assert(await rows.first().evaluate((element, properties) => element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End', bubbles: true, cancelable: true, ...properties,
      })), properties), 'Sidebar consumed a modified or composing key')
      await expect(rows.first()).toBeFocused()
    }
    await page.keyboard.press('Tab')
    await expect(sidebar.locator('.project-file-close').first()).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(rows.first()).toBeFocused()
    await projectRow.focus()
    await page.keyboard.press('Shift+Tab')
    const disclosure = sidebar.locator('.project-disclosure')
    await expect(disclosure).toBeFocused()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(disclosure.locator('.project-folder-open')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(rows).toHaveCount(0)
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(disclosure.locator('.lucide-folder')).toHaveCount(1)
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[0])
    await page.keyboard.press('Tab')
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowDown')
    await expect(projectRow).toBeFocused()
    await disclosure.focus()
    await page.keyboard.press('Enter')
    await expect(disclosure.locator('.project-folder-open')).toHaveCount(1)
    await page.keyboard.press('Tab')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[35])
    await expect(source).toBeVisible()
  }
  console.log('PASS: sidebar arrows/Home/End move focus through visible rows without reads, rerenders, selection or reader-position changes; modifiers/composition and native Tab/disclosure/Enter remain intact')

  await startCrowded()
  await source.focus()
  await source.evaluate(element => { element.scrollTop = 1200; element.scrollLeft = 160 })
  await page.evaluate(() => { window.crowdedCode = document.querySelector('.reader-panel:not([hidden]) .source-code code') })
  let manualAnchor = await scrollTabs()
  let untouchedDownloads = { ...downloads }
  const inactive = await fullyVisibleTab()
  await strip.getByRole('button', { name: `Close ${inactive}`, exact: true }).click()
  await expect(strip.getByRole('tab')).toHaveCount(36)
  await expectAnchor(manualAnchor)
  await expect(source).toBeFocused()
  await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[0])
  assert(await page.evaluate(() => window.crowdedCode === document.querySelector('.reader-panel:not([hidden]) .source-code code')))
  assert.deepEqual(await source.evaluate(element => [element.scrollTop, element.scrollLeft]), [1200, 160])
  assert.deepEqual(downloads, untouchedDownloads, 'Inactive close downloaded reader content')
  await strip.getByRole('tab', { name: await fullyVisibleTab(), exact: true }).click({ button: 'middle' })
  await expect(strip.getByRole('tab')).toHaveCount(35)
  await expectAnchor(manualAnchor)
  await expect(source).toBeFocused()
  await page.screenshot({ path: join(artifacts, 'crowded-manual-after-close.png'), animations: 'disabled' })
  // Removing an earlier, offscreen tab must keep the same visible files, not the same obsolete pixel offset.
  await sidebar.getByRole('button', { name: `Close ${crowdedPaths[1]}`, exact: true }).click()
  await expectAnchor(manualAnchor)
  assert.deepEqual(downloads, untouchedDownloads)

  await strip.getByRole('tab', { name: 'Browse', exact: true }).click()
  await expect(page.locator('.file-grid')).toHaveCount(0)
  await expect(page.locator('.file-table')).toBeVisible()
  // A late content-width change must not turn the next wheel gesture into a layout clamp.
  await strip.evaluate(element => { element.lastElementChild.style.marginRight = '2px' })
  manualAnchor = await scrollTabs()
  const unopened = page.getByRole('link', { name: 'experiment-170-results.txt', exact: true })
  await unopened.scrollIntoViewIfNeeded()
  const listingTop = await browse.evaluate(element => element.scrollTop)
  untouchedDownloads = { ...downloads }
  const openCount = await strip.getByRole('tab').count()
  await unopened.click({ modifiers: ['Control'] })
  await expect(strip.getByRole('tab')).toHaveCount(openCount + 1)
  await expectAnchor(manualAnchor)
  await expect(selectedTab()).toHaveText('Browse')
  await expect(unopened).toBeFocused()
  assert.equal(await browse.evaluate(element => element.scrollTop), listingTop)
  assert.deepEqual(downloads, untouchedDownloads, 'Background opening downloaded or reloaded content')
  await unopened.click()
  await expect(source).toBeVisible()
  await expect(selectedTab()).toHaveAttribute('aria-label', 'experiment-170-results.txt')
  await expectSelectedVisible()
  assert.equal(downloads.text, untouchedDownloads.text + 1)
  console.log('PASS: crowded inactive/earlier closes and background opens retain manual tab position, reader focus/DOM/scroll and downloads; foreground selection reveals its tab')

  // Keep the Browse-to-reader handoff covered with real navigation and a held content read.
  for (const viewport of [1440, 390]) {
    await startCrowded({ viewport, count: 1 })
    await page.evaluate(view => window.fixturePreferences({ browseView: view, flatBrowse: true }), viewport === 390 ? 'icons' : 'list')
    await strip.getByRole('tab', { name: 'Browse', exact: true }).click()
    const entry = page.locator('[data-browse-entry="experiment-000-results.txt"] a')
    await entry.focus()
    const backgroundReads = downloads.text
    await page.keyboard.press(viewport === 390 ? 'Meta+Enter' : 'Control+Enter')
    await expect(strip.getByRole('tab')).toHaveCount(3)
    await expect(selectedTab()).toHaveText('Browse')
    await expect(entry).toBeFocused()
    assert.equal(downloads.text, backgroundReads, 'Background keyboard opening downloaded content')

    for (const cancelled of [false, true]) {
      if (cancelled) {
        // Exercise a cold read again; switching to Browse now retains the loaded reader.
        await strip.getByRole('button', { name: 'Close experiment-000-results.txt', exact: true }).click()
        await strip.getByRole('tab', { name: 'Browse', exact: true }).click()
      }
      let releaseRead
      let heldReads = 0
      const holdRead = async route => {
        heldReads++
        await new Promise(resolve => { releaseRead = resolve })
        await route.fallback()
      }
      await page.route('**/api/text?**', holdRead)
      try {
        await entry.focus()
        const historyLength = await page.evaluate(() => history.length)
        const reads = downloads.text
        await page.keyboard.press('Enter')
        await expect.poll(() => Boolean(releaseRead)).toBe(true)
        await expect(page.getByText('Reading file…', { exact: true })).toBeVisible()
        await expect(source).toHaveCount(0)
        const otherControl = page.getByRole('button', { name: 'Refresh file', exact: true })
        if (cancelled) {
          await expect(otherControl).toHaveAttribute('aria-disabled', 'true')
          assert.equal(await otherControl.evaluate(element => element.disabled), false)
          await page.keyboard.press('Tab')
          await expect(otherControl).toBeFocused()
          await page.keyboard.press('Enter') // Busy Refresh remains focusable but cannot start another read.
        }
        releaseRead()
        await expect(source).toBeVisible()
        if (cancelled) {
          await expect(otherControl).toBeFocused()
          await expect(source).not.toBeFocused()
        } else {
          await expect(source).toBeFocused()
          await page.keyboard.press('PageDown')
          await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
        }
        assert.equal(await page.evaluate(() => history.length), historyLength + 1, 'Enter navigated more than once')
        assert.equal(heldReads, 1, 'Busy Refresh started another content request')
        assert.equal(downloads.text, reads + 1, 'Reader focus caused an extra content read')
      } finally {
        releaseRead?.()
        await page.unroute('**/api/text?**', holdRead)
      }
    }
  }
  console.log('PASS: Browse keyboard opening focuses the ready reader once; delayed focus choices and background openings retain focus on desktop/phone')

  const overviewOrder = () => page.locator('.overview-columns > section').evaluateAll(sections => sections.map(section => section.getAttribute('aria-label')))
  const overviewProjectsFirst = ['Projects', 'Open files'], overviewFilesFirst = [...overviewProjectsFirst].reverse()
  await startCrowded({ overview: true })
  await expect.poll(overviewOrder).toEqual(overviewProjectsFirst)
  await page.evaluate(() => { window.fixtureOverviewNodes = [...document.querySelectorAll('.overview-columns > section, .overview-file, .overview-modified')] })
  await expect(page.locator('.overview-modified').filter({ hasText: 'Checking time…' })).toHaveCount(0)
  const overviewReads = { apiReads, ...downloads }
  for (const selector of ['.overview-project-open', '.overview-file-open']) {
    const focused = page.locator(selector).first()
    await focused.focus()
    for (const viewport of [820, 1440]) {
      await page.setViewportSize({ width: viewport, height: 900 })
      await expect.poll(overviewOrder).toEqual(viewport === 820 ? overviewFilesFirst : overviewProjectsFirst)
      await expect(focused).toBeFocused()
      await expect(focused).toBeInViewport()
      assert(await page.evaluate(() => window.fixtureOverviewNodes.every(node => node.isConnected)), 'Overview reordered by remounting cards or metadata')
    }
  }
  assert.deepEqual({ apiReads, ...downloads }, overviewReads, 'Overview reordering restarted metadata or content requests')
  await page.setViewportSize({ width: 1024, height: 900 })
  await settle()
  const beforePixels = await page.evaluate(() => [window.fixtureRenders, window.fixtureOverviewRenders])
  for (const value of [270, 280, 300, 320, 340]) {
    await page.locator('.workspace-shell').evaluate((element, value) => element.style.setProperty('--project-sidebar-width', `${value}px`), value)
    await settle()
  }
  assert.deepEqual(await page.evaluate(() => [window.fixtureRenders, window.fixtureOverviewRenders]), beforePixels, 'Overview rerendered for each resize pixel')
  await page.locator('.workspace-shell').evaluate(element => element.style.setProperty('--project-sidebar-width', '380px'))
  await expect.poll(overviewOrder).toEqual(overviewFilesFirst)
  assert.equal(await page.evaluate(() => window.fixtureRenders), beforePixels[0], 'Overview threshold rerendered Workspace')
  const afterCrossing = await page.evaluate(() => window.fixtureOverviewRenders)
  assert(afterCrossing > beforePixels[1])
  for (const value of [390, 400, 410]) {
    await page.locator('.workspace-shell').evaluate((element, value) => element.style.setProperty('--project-sidebar-width', `${value}px`), value)
    await settle()
  }
  assert.equal(await page.evaluate(() => window.fixtureOverviewRenders), afterCrossing)

  await startCrowded({ overview: true, viewport: 1024 })
  await handle.focus()
  await page.keyboard.press('End')
  await expect.poll(overviewOrder).toEqual(overviewFilesFirst)
  await expect(handle).toBeFocused()
  await page.keyboard.press('Home')
  await expect.poll(overviewOrder).toEqual(overviewProjectsFirst)
  await page.locator('.overview-file-open').first().focus()
  const pointerStart = await begin()
  await page.mouse.move(pointerStart.x + 180, pointerStart.y)
  await expect.poll(overviewOrder).toEqual(overviewFilesFirst)
  await page.mouse.up()
  await expect(handle).toBeFocused()
  assert.equal(await page.locator('.project-content').evaluate(element => element.scrollTop), 0, 'Pointer resizing scrolled to a formerly focused file')

  await expect(page.locator('.overview-modified').filter({ hasText: 'Checking time…' })).toHaveCount(0)
  const heldOverviewMetadata = []
  const overviewMetadataCleanup = []
  const holdOverviewMetadata = async route => {
    const path = new URL(route.request().url()).searchParams.get('path')
    if (!/^tab-(26|27)-/.test(path || '')) return route.fallback()
    const held = new Promise(resolve => heldOverviewMetadata.push(resolve))
    const cleanup = held.then(() => route.abort())
    overviewMetadataCleanup.push(cleanup)
    await cleanup
  }
  await page.route('**/api/file-info?**', holdOverviewMetadata)
  try {
    await startCrowded({ overview: true, viewport: 390 })
    await expect.poll(overviewOrder).toEqual(overviewFilesFirst)
    await expect.poll(() => heldOverviewMetadata.length).toBe(2)
    await page.locator('.overview-intro > button').focus()
    await page.keyboard.press('Tab')
    await expect(page.locator('.overview-file-open').first()).toBeFocused()
    // Hard navigation cancels the active fetches before WebKit emits pagehide.
    await startCrowded({ overview: true, viewport: 390, files: [] })
    await expect.poll(overviewOrder).toEqual(overviewProjectsFirst)
    await page.locator('.overview-intro > button').focus()
    await page.keyboard.press('Tab')
    await expect(page.locator('.overview-project-open')).toBeFocused()
  } finally {
    for (const release of heldOverviewMetadata) release()
    await Promise.all(overviewMetadataCleanup)
    await page.unroute('**/api/file-info?**', holdOverviewMetadata)
  }
  assert.deepEqual(errors, [], 'Overview must not continue queued fetches after navigation cancels its transport')
  console.log('PASS: Overview initial/empty order, keyed wide/stacked focus and readability, threshold-only local renders, and pointer/keyboard resize ownership')

  await startCrowded({ count: 6 })
  await page.evaluate(({ project, blocked }) => {
    const fetch = window.fetch
    window.fixtureMetadataReads = []
    window.fetch = (input, options) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/file-info') {
        const path = url.searchParams.get('path')
        window.fixtureMetadataReads.push(path)
        if (blocked.includes(path)) return Promise.reject(new TypeError('Synthetic blocked metadata URL'))
      }
      return fetch(input, options)
    }
    window.fixtureRestoreMetadataFetch = () => { window.fetch = fetch }
    window.fixturePreferences({ autoRefreshSeconds: 2 })
    window.fixtureNavigate({ ...project, path: '', kind: 'overview' })
  }, { project, blocked: crowdedPaths.slice(0, 2) })
  try {
    await expect(page.locator('.overview-modified').filter({ hasText: 'Modification time unavailable' })).toHaveCount(2)
    await expect(page.locator('.overview-modified').filter({ hasText: 'Checking time…' })).toHaveCount(4)
    await expect(page.locator('.overview-modified time')).toHaveCount(4)
    await expect.poll(() => page.evaluate(() => window.fixtureMetadataReads)).toEqual([
      ...crowdedPaths.slice(0, 2), ...crowdedPaths.slice(2, 6), ...crowdedPaths.slice(0, 2),
    ])
    await settle()
    assert.equal(await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      return window.fixtureMetadataReads.length
    }), 10, 'Visibility refresh must immediately start the two resumed workers')
    await expect.poll(() => page.evaluate(() => window.fixtureMetadataReads.slice(8)))
      .toEqual([...crowdedPaths.slice(2, 6), ...crowdedPaths.slice(0, 2)])
    await expect(page.locator('.overview-modified time')).toHaveCount(4)
  } finally {
    await page.evaluate(() => window.fixtureRestoreMetadataFetch())
  }
  console.log('PASS: persistent URL-specific transport failures stop workers, but polling and visibility refresh still reach healthy Overview rows')

  const overviewFiles = ['run-a/report.txt', 'run-b/report.txt', 'archive/last.txt']
  const overviewRow = path => page.getByRole('article', { name: `Long project name for resize review: ${path}`, exact: true })
  for (const viewport of [1440, 390]) {
    await startCrowded({ viewport, files: overviewFiles, overview: true })
    const opener = overviewRow(overviewFiles[1]).locator('.overview-file-open')
    await expect(opener).toHaveAttribute('title', `Long project name for resize review · Synthetic machine\n${overviewFiles[1]}`)
    await expect(opener.locator('.overview-file-context bdi')).toHaveText('Long project name for resize review · run-b')
    let releaseRead
    let heldReads = 0
    const holdRead = async route => {
      heldReads++
      await new Promise(resolve => { releaseRead = resolve })
      await route.fallback()
    }
    await page.route('**/api/text?**', holdRead)
    try {
      const historyLength = await page.evaluate(() => history.length)
      await opener.focus()
      if (viewport === 390) {
        await page.keyboard.down('Space')
        await page.keyboard.down('Space')
        await expect(opener).toBeFocused()
        await expect(page.locator('.overview-file')).toHaveCount(3)
        assert.equal(heldReads, 0, 'Space opened before keyup')
        await page.keyboard.up('Space')
      } else await page.keyboard.press('Enter')
      await expect.poll(() => Boolean(releaseRead)).toBe(true)
      await expect(page.getByText('Reading file…', { exact: true })).toBeVisible()
      releaseRead()
      await expect(source).toBeFocused()
      assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('path')), overviewFiles[1])
      assert.equal(await page.evaluate(() => history.length), historyLength + 1)
      assert.equal(heldReads, 1)
      await page.keyboard.press('PageDown')
      await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    } finally {
      releaseRead?.()
      await page.unroute('**/api/text?**', holdRead)
    }

    for (const which of ['middle', 'last', 'only']) {
      const files = which === 'only' ? overviewFiles.slice(1, 2) : overviewFiles
      await startCrowded({ viewport, files, overview: true })
      if (which === 'only' && viewport === 1440) {
        await page.locator('.overview-project-open').evaluate(element => { element.style.marginTop = '1200px' })
      }
      const index = which === 'middle' ? 1 : files.length - 1
      const close = overviewRow(files[index]).locator('.overview-file-close')
      await close.focus()
      const contentReads = downloads.text
      if (viewport === 1440) {
        await page.keyboard.down('Enter')
        await page.keyboard.down('Enter') // The survivor must not activate on a held close key.
        await page.keyboard.up('Enter')
      } else await page.keyboard.press('Space')
      await expect(page.locator('.overview-file')).toHaveCount(files.length - 1)
      await expect.poll(overviewOrder).toEqual(viewport === 390 && files.length > 1 ? overviewFilesFirst : overviewProjectsFirst)
      const target = which === 'only' ? page.locator('.overview-project-open')
        : overviewRow(files[which === 'middle' ? index + 1 : index - 1]).locator('.overview-file-open')
      await expect(target).toBeFocused()
      await expect(target).toBeInViewport()
      assert.equal(downloads.text, contentReads)
      assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('kind')), 'overview')
    }
  }
  await startCrowded({ files: overviewFiles, overview: true })
  await overviewRow(overviewFiles[1]).locator('.overview-file-close').focus()
  await page.evaluate(() => document.addEventListener('click', () => {
    document.querySelector('.overview-project-open').focus()
  }, { once: true, capture: true }))
  await page.keyboard.press('Enter')
  await expect(page.locator('.overview-file')).toHaveCount(2)
  await expect(page.locator('.overview-project-open')).toBeFocused()
  await overviewRow(overviewFiles[0]).locator('.overview-file-close').click()
  await expect(page.locator('.overview-file')).toHaveCount(1)
  await expect(overviewRow(overviewFiles[2]).locator('.overview-file-open')).not.toBeFocused()
  console.log('PASS: Overview Enter/Space opens the canonical duplicate once after loading; keyboard close preserves useful focus, newer choices, and pointer behavior')
  for (const viewport of [1440, 390]) for (const which of ['middle', 'last', 'only']) {
    const files = which === 'only' ? overviewFiles.slice(0, 1) : overviewFiles
    await startCrowded({ viewport, files })
    const opener = page.getByRole('button', { name: 'Show project sidebar', exact: true })
    if (viewport === 390) {
      await opener.focus()
      await page.keyboard.press('Enter')
      await expect(sidebar.getByRole('link', { name: 'Artiface home', exact: true })).toBeFocused()
    }
    const rows = sidebar.locator('.project-file-row')
    const index = which === 'middle' ? 1 : files.length - 1
    const target = which === 'only' ? viewport === 390 ? opener : sidebar.locator('.project-open')
      : rows.nth(which === 'middle' ? index + 1 : index - 1).locator('.project-file')
    const expected = which === 'only' && viewport === 390 ? 'Show project sidebar' : await target.getAttribute('aria-label')
    const reads = downloads.text
    const route = await page.evaluate(() => location.hash)
    await rows.nth(index).locator('.project-file-close').focus()
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await expect(page.getByRole('button', { name: expected, exact: true })).toBeFocused()
    assert.equal(downloads.text, reads, 'Sidebar keyboard close downloaded content')
    if (which !== 'only') assert.equal(await page.evaluate(() => location.hash), route, 'Held close key activated its survivor')
  }
  console.log('PASS: sidebar keyboard close retains next/previous/project focus and the visible overlay opener without repeated activation')


  for (const fontScale of [1, 1.4]) for (const density of ['compact', 'comfortable']) {
    await startCrowded({ fontScale, density })
    manualAnchor = await scrollTabs()
    untouchedDownloads = { ...downloads }
    const divider = await handle.boundingBox()
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
    await page.mouse.down()
    await page.mouse.move(divider.x + divider.width / 2 + 150, divider.y + divider.height / 2, { steps: 12 })
    await page.mouse.up()
    await expectAnchor(manualAnchor)
    for (const viewport of [1000, 390, 1440]) {
      await page.setViewportSize({ width: viewport, height: 900 })
      if (viewport === 390) await expect(handle).toHaveCount(0)
      else await expect(handle).toHaveCount(1)
      await expect.poll(() => strip.evaluate(element => element.clientWidth)).toBeGreaterThan(80)
      await expectAnchor(manualAnchor)
    }
    assert.deepEqual(downloads, untouchedDownloads)
    await strip.getByRole('tab', { name: crowdedPaths[25], exact: true }).click()
    await expectSelectedVisible()
    await page.setViewportSize({ width: 800, height: 900 })
    await expectSelectedVisible()
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(handle).toHaveCount(0)
    await expectSelectedVisible()
  }
  console.log('PASS: 36-tab manual and idle resizing, phone transitions, compact/comfortable density and font 1/1.4 preserve user intent')

  for (const viewport of [1440, 390]) {
    for (const active of [0, 17]) {
      await startCrowded({ active, viewport })
      const accessibleTabs = await strip.ariaSnapshot()
      for (const path of crowdedPaths) assert(accessibleTabs.includes(`button "Close ${path}"`))
      const activeClose = strip.getByRole('button', { name: `Close ${crowdedPaths[active]}`, exact: true })
      const toolbarToggle = page.getByRole('button', { name: 'Hide reader toolbar', exact: true })
      await selectedTab().focus()
      await page.keyboard.press('Tab')
      await expect(activeClose).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(toolbarToggle).toBeFocused()
      if (viewport === 390) {
        await page.keyboard.press('Tab')
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
      }
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: 'Wrap long lines', exact: true })).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      if (viewport === 390) await page.keyboard.press('Shift+Tab')
      await expect(toolbarToggle).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(activeClose).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(selectedTab()).toBeFocused()
    }
    console.log(`PASS: ${viewport}px first/middle selected tabs reach close then reader controls in both directions; all 36 named closes remain accessible`)

    await startCrowded({ active: 25, viewport })
    await selectedTab().focus()
    await page.keyboard.press('Tab')
    await expect(strip.getByRole('button', { name: `Close ${crowdedPaths[25]}`, exact: true })).toBeFocused()
    await page.keyboard.press(viewport === 390 ? 'Enter' : 'Space')
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[26])
    await expect(selectedTab()).toBeFocused()
    await expectSelectedVisible()
    if (viewport === 390) await page.screenshot({ path: join(artifacts, 'crowded-phone-keyboard-close.png'), animations: 'disabled' })
    await page.keyboard.press('ArrowRight')
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[27])
    await page.keyboard.press('Delete')
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[28])
    await expect(selectedTab()).toBeFocused()
    // Move focus during the closing event, before any queued close-focus RAF could run.
    await page.evaluate(() => window.addEventListener('keydown', () => {
      document.querySelector('.reader-toolbar-toggle').focus({ preventScroll: true })
    }, { once: true }))
    await page.keyboard.press('Delete')
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[29])
    await settle()
    await expect(page.getByRole('button', { name: 'Hide reader toolbar', exact: true })).toBeFocused()

    await startCrowded({ viewport })
    // Inactive closes remain accessible even though ordinary Tab skips them.
    await strip.getByRole('button', { name: `Close ${crowdedPaths[25]}`, exact: true }).focus()
    await expect(strip.getByRole('button', { name: `Close ${crowdedPaths[25]}`, exact: true })).toBeFocused()
    await settle()
    untouchedDownloads = { ...downloads }
    await page.keyboard.press('Enter')
    await expect(strip.getByRole('tab', { name: crowdedPaths[26], exact: true })).toBeFocused()
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[0])
    assert((await strip.evaluate(element => element.scrollLeft)) > 4000)
    await page.keyboard.press('Delete')
    await expect(strip.getByRole('tab', { name: crowdedPaths[27], exact: true })).toBeFocused()
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[0])
    assert((await strip.evaluate(element => element.scrollLeft)) > 4000)
    assert.deepEqual(downloads, untouchedDownloads)
    if (touch && viewport === 390) {
      const name = await fullyVisibleTab()
      const count = await strip.getByRole('tab').count()
      await source.focus()
      await strip.getByRole('button', { name: `Close ${name}`, exact: true }).tap()
      await expect(strip.getByRole('tab')).toHaveCount(count - 1)
      await expect(source).toBeFocused()
    }
  }
  await startCrowded({ count: 1 })
  await selectedTab().focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(strip.getByRole('tab')).toHaveCount(1)
  await expect(selectedTab()).toHaveText('Browse')
  await expect(selectedTab()).toBeFocused()
  await page.keyboard.press('Delete')
  await expect(strip.getByRole('tab')).toHaveCount(1)
  console.log('PASS: keyboard X/Delete restore surviving focus on desktop/phone; inactive closures keep reader selection; last-file closure focuses Browse')

  for (const viewport of [390, 1440]) {
    await startCrowded({ count: 2, viewport })
    const original = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.slice(1))))
    const add = page.getByRole('button', { name: 'Add project', exact: true })
    if (viewport === 390) await page.getByRole('button', { name: 'Show project sidebar', exact: true }).click()
    await add.focus()
    await add.press('Enter')
    const back = page.getByRole('button', { name: 'Back to workspace', exact: true })
    await expect(back).toBeFocused()
    await expect(page.locator('.project-topline .add-project-shortcut')).toHaveCount(0)
    await expect(page.locator('.project-chooser')).toBeVisible()
    const historyBefore = await page.evaluate(() => history.length)
    if (viewport === 390) await page.getByRole('button', { name: 'Show project sidebar', exact: true }).click()
    await add.click()
    assert.equal(await page.evaluate(() => history.length), historyBefore, 'Repeated Add inserted a duplicate chooser history entry')
    await back.click()
    await expect(source).toBeVisible()
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.slice(1)))), original,
      'Repeated Add lost the original workspace return location')
    await expect(selectedTab()).toHaveAttribute('aria-label', crowdedPaths[0])
    await expect(source).not.toBeFocused()
    for (const cancel of [false, true]) {
      await source.evaluate(element => { element.scrollTop = 800 })
      const savedTop = await source.evaluate(element => element.scrollTop)
      if (viewport === 390) await page.getByRole('button', { name: 'Show project sidebar', exact: true }).click()
      await add.click()
      await expect(back).toBeFocused()
      const navigations = await page.evaluate(() => window.fixtureNavigations)
      const reads = downloads.text
      await page.keyboard.press(viewport === 390 ? 'Space' : 'Enter')
      await expect(source).toBeVisible()
      await expect(source).toBeFocused()
      assert.equal(await source.evaluate(element => element.scrollTop), savedTop)
      assert.equal(await page.evaluate(() => window.fixtureNavigations), navigations + 1)
      assert.equal(downloads.text, reads, 'Chooser return downloaded its retained reader again')
      if (cancel) {
        const refresh = page.getByRole('button', { name: 'Refresh file', exact: true })
        await refresh.focus()
        await settle()
        await expect(refresh).toBeFocused()
        await expect(source).not.toBeFocused()
      } else {
        await source.evaluate(element => {
          window.chooserScrollFinished = false
          element.addEventListener('scrollend', () => { window.chooserScrollFinished = true }, { once: true })
        })
        await page.keyboard.press('PageDown')
        await expect.poll(() => page.evaluate(() => window.chooserScrollFinished)).toBe(true)
        await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(savedTop + 100)
      }
    }
  }
  console.log('PASS: project chooser preserves its original return; keyboard Back restores the cached reader without changing position, extra reads, or overriding newer focus')

  before = await writes()
  point = await begin()
  await page.mouse.move(point.x - 100, point.y)
  await page.evaluate(() => window.fixtureUnmount())
  await page.mouse.up()
  await clean()
  assert.equal(await writes(), before)
  assert.deepEqual(errors, [])
  console.log(`PASS: unmount cleanup; no browser errors\nScreenshots: ${artifacts}`)
} finally {
  await browser.close()
}
