import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const engine = process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium
const artifacts = process.env.ARTIFACE_IMAGE_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const measurements = []
const entry = join(repository, 'web/src/__image_view_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'image-view-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css') || id.includes('.svg?')) return '\0fixture-asset'
      if (['./PDFViewer', './MarkdownViewer', './SourceViewer', './CSVViewer'].includes(id)) return '\0fixture-reader'
    },
    load(id) {
      if (id === '\0fixture-asset') return 'export default ""'
      if (id === '\0fixture-reader') return 'export default function Reader(){return "Synthetic reader"}'
      if (id === entry) return `
        import {StrictMode} from 'react'
        import {createRoot} from 'react-dom/client'
        import App from './App'
        import {readImageView, reusableImagePreview, retainImagePreview, imageViewGeneration, clearImageViews} from './imageView'
        import {setPreferences} from './preferences'
        window.fixtureCachedImageView = readImageView
        window.fixtureReusableImagePreview = (key, fresh) => reusableImagePreview(key, fresh, imageViewGeneration())
        window.fixtureSeedImagePreview = (key, preview) => retainImagePreview(key, preview, imageViewGeneration(), new AbortController().signal)
        window.fixtureClearImageViews = clearImageViews
        window.fixturePreferences = setPreferences
        createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>)
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'viewers.css', 'components/workspace.css', 'components/settings.css', 'components/imageViewer.css']
  .map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')

// A generated solid PNG avoids artifact files and screenshot/pixel comparisons.
function png(width, height) {
  const chunk = (type, payload) => {
    const body = Buffer.concat([Buffer.from(type), payload])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const result = Buffer.alloc(body.length + 8)
    result.writeUInt32BE(payload.length)
    body.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc((width * 3 + 1) * height, 120)
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const original = png(1600, 1200)
const replacement = png(1200, 1600)
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"><script>window.fixtureSVGExecuted=true</script><rect width="1200" height="800" fill="teal"/></svg>'
const origin = 'http://image-view-fixture.invalid'
const previewOrigin = 'http://image-preview-fixture.invalid'
const host = { id: 'fixture', kind: 'local', label: 'Fixture', target: '', roots: [{ id: 'images', label: 'Images', path: '/synthetic/images' }] }
const files = ['first.png', 'second.svg']
const fileLocation = path => ({ host: 'fixture', root: 'images', path, kind: 'file' })
const key = path => `/api/file?host=fixture&root=images&path=${path}`
const browser = await engine.launch({ headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, serviceWorkers: 'block' })
  context.setDefaultTimeout(8000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.addInitScript(() => {
    if (location.origin !== 'http://image-view-fixture.invalid' || window.top !== window) return
    for (const property of ['naturalWidth', 'naturalHeight']) {
      const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, property)
      Object.defineProperty(HTMLImageElement.prototype, property, { ...original, get() {
        return window.fixtureSVGZeroSize && this.src.includes('/p/svg-') ? 0 : original.get.call(this)
      } })
    }
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300 }))
    sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({
      projects: [{ host: 'fixture', root: 'images', directory: '', activePath: 'first.png', expanded: true }],
      tabs: ['first.png', 'second.svg'].map(path => ({ host: 'fixture', root: 'images', path, autoRefreshPaused: true })),
    }))
  })
  const page = await context.newPage()
  let token = 0
  let version = 'v1'
  let sourceRevision = 'source-v1'
  let authenticated = true
  let nextImage = 'original'
  let failPreviewURL = false
  let deniedPreview = ''
  let previewLifetime = 15 * 60_000
  let heldPreview
  let held
  let imageRequests = 0
  let previewRequests = 0
  const imageLoads = []
  const issuedPreviews = new Map()
  const responses = new Map()
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === previewOrigin) {
      imageRequests++
      imageLoads.push(url.pathname)
      const image = responses.get(url.pathname)
      if (image.held) { image.held.started(); await image.held.wait }
      if (image.kind === 'revoked') return route.fulfill({ status: 401, body: 'Synthetic revoked capability' })
      if (image.kind === 'broken') return route.fulfill({ status: 404, body: 'Synthetic image failure' })
      return route.fulfill({ contentType: image.path.endsWith('.svg') ? 'image/svg+xml' : 'image/png', body:
        image.path.endsWith('.svg') ? svg : image.kind === 'replacement' ? replacement : original })
    }
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    let body
    if (url.pathname === '/api/session' || url.pathname === '/api/login') body = { authenticated, mode: 'personal', role: 'personal', csrfToken: 'fixture' }
    else if (url.pathname === '/api/logout') { authenticated = false; body = {} }
    else if (url.pathname === '/api/hosts') body = { hosts: [host], setupEnabled: true, revision: sourceRevision }
    else if (url.pathname === '/api/workspace/projects') body = { projects: [{ host: 'fixture', root: 'images' }], sourcesRevision: sourceRevision }
    else if (url.pathname === '/api/list') body = { entries: files.map(path => ({ name: path, path, type: 'file', size: 1000, modified: '2026-09-21T12:00:00Z' })) }
    else if (url.pathname === '/api/text') body = { text: 'Eviction fixture', version }
    else if (url.pathname === '/api/file-info') body = { size: 1000, modified: '2026-09-21T12:00:00Z', version }
    else if (url.pathname === '/api/preview') {
      previewRequests++
      if (failPreviewURL) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic preview URL failure' }) })
      const path = request.postDataJSON().path
      if (path === deniedPreview) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic access revoked' }) })
      const resource = `/p/${path.endsWith('.svg') ? 'svg' : 'png'}-${++token}`
      responses.set(resource, { path, kind: nextImage, held })
      held = undefined
      body = { url: `${previewOrigin}${resource}`, path, version, scripts: false, expiresAt: new Date(Date.now() + previewLifetime).toISOString() }
      issuedPreviews.set(path, body)
      if (heldPreview?.path === path) {
        const pending = heldPreview
        heldPreview = undefined
        pending.started()
        await pending.wait
      }
    }
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? { error: 'Unknown synthetic route' }) })
  })
  const settle = () => page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const reader = page.locator('.reader-panel:not([hidden])')
  const area = reader.locator('.image-reader')
  const image = reader.locator('.image-stage img:not(.pending-preview)')
  const hiddenImage = path => page.locator(`.reader-panel[hidden] .image-reader[aria-label="${path} image"]`)
  const zoom = reader.getByRole('combobox', { name: 'Image zoom', exact: true })
  const options = reader.getByRole('button', { name: 'Reader options', exact: true })
  const showOptions = async () => { if (await options.getAttribute('aria-expanded') !== 'true') await options.click() }
  const closeOptions = async () => { if (await options.getAttribute('aria-expanded') === 'true') await options.click() }
  const geometry = () => area.evaluate(element => {
    const image = element.querySelector('img:not(.pending-preview)')
    const bounds = image.getBoundingClientRect()
    const viewport = element.getBoundingClientRect()
    return { width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
      left: element.scrollLeft, top: element.scrollTop, imageWidth: bounds.width, imageHeight: bounds.height,
      centerX: bounds.left + bounds.width / 2 - viewport.left, centerY: bounds.top + bounds.height / 2 - viewport.top,
      naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, transform: image.style.transform }
  })
  const cached = path => page.evaluate(key => window.fixtureCachedImageView(key), key(path))
  const cachedPreview = path => page.evaluate(({ key, fresh }) => window.fixtureReusableImagePreview(key, fresh),
    { key: key(path), fresh: issuedPreviews.get(path) })
  const choose = async value => { await zoom.selectOption(value); await settle() }
  const background = reader.getByRole('combobox', { name: 'Image background', exact: true })
  const expectBackground = value => expect(image).toHaveCSS('background-color',
    { theme: 'rgba(0, 0, 0, 0)', light: 'rgb(255, 255, 255)', dark: 'rgb(32, 33, 36)' }[value])
  const chooseBackground = async (value, holdLabel = false) => {
    await showOptions()
    const label = reader.locator('.image-view-options > label')
    await label.scrollIntoViewIfNeeded()
    if (holdLabel) {
      const previous = await background.inputValue()
      const bounds = await label.boundingBox()
      await page.mouse.move(bounds.x + 40, bounds.y + 10)
      await page.mouse.down()
      await page.waitForTimeout(500)
      await expect(options).toHaveAttribute('aria-expanded', 'true')
      await expect(background).toHaveValue(previous)
      await page.mouse.up()
    } else await label.click({ position: { x: 40, y: 10 } })
    await expect(background).toBeFocused()
    await background.selectOption(value)
    await expect(options).toHaveAttribute('aria-expanded', 'false')
    await expect(options).toBeFocused()
    await settle()
    await expectBackground(value)
  }
  const openTab = async path => {
    await page.getByRole('tab', { name: path, exact: true }).click()
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute('alt', path)
    await expect(zoom).toBeEnabled()
    await settle()
  }
  await page.goto(`${origin}/#${new URLSearchParams(fileLocation('first.png'))}`)
  await expect(image).toBeVisible()
  await expect(zoom).toBeEnabled()
  await settle()
  let box = await geometry()
  assert(box.imageWidth <= box.width && box.imageHeight <= box.height)
  assert(box.scrollWidth <= box.width + 1 && box.scrollHeight <= box.height + 1, 'Fit overflowed')
  // A viewBox-only SVG can finish loading after its retained reader is hidden.
  // Its DOM probe has no geometry until that paused reader is visible again.
  let releaseHiddenSVG
  let hiddenSVGStarted
  const hiddenSVGArrived = new Promise(resolve => { hiddenSVGStarted = resolve })
  held = { started: hiddenSVGStarted, wait: new Promise(resolve => { releaseHiddenSVG = resolve }) }
  await page.evaluate(() => { window.fixtureSVGZeroSize = true })
  await page.getByRole('tab', { name: 'second.svg', exact: true }).click()
  await hiddenSVGArrived
  await reader.locator('img.pending-preview').evaluate(element => {
    window.fixtureHiddenSVG = element
    window.fixtureHiddenSVGLoaded = new Promise(resolve => element.addEventListener('load', resolve, { once: true }))
  })
  await openTab('first.png')
  releaseHiddenSVG()
  await page.evaluate(() => window.fixtureHiddenSVGLoaded)
  await settle()
  await expect(hiddenImage('second.svg').locator('.error-state')).toHaveCount(0)
  assert(await page.evaluate(() => window.fixtureHiddenSVG.isConnected), 'Valid SVG completion in a hidden reader was treated as a failed image')
  const beforeSVGReturn = { imageRequests, previewRequests }
  await openTab('second.svg')
  assert(await image.evaluate(element => element === window.fixtureHiddenSVG), 'Returning to the loaded SVG replaced its image element')
  assert.deepEqual({ imageRequests, previewRequests }, beforeSVGReturn, 'Returning to the loaded SVG retried its resource or authorization')
  await expect(reader.getByRole('button', { name: 'Resume automatic refresh', exact: true }).filter({ visible: true })).toBeVisible()
  box = await geometry()
  assert(box.naturalWidth === 0 && box.naturalHeight === 0)
  assert(box.imageWidth > 0 && box.imageHeight > 0 && Math.abs(box.imageWidth / box.imageHeight - 1.5) < 0.002,
    'Deferred SVG readiness lost its viewBox aspect ratio')
  await page.evaluate(() => { window.fixtureSVGZeroSize = false })
  await openTab('first.png')
  console.log('PASS: zero-intrinsic SVG completing in a hidden paused reader becomes ready on return without failure, replacement, or another request')
  const initialRequests = { imageRequests, previewRequests }

  // Older size containers establish a fixed containing block at the toolbar's nonzero origin.
  await page.setViewportSize({ width: 1280, height: 240 })
  await showOptions()
  await settle()
  const containedMenu = reader.locator('.reader-actions-panel')
  const normalPanel = await containedMenu.boundingBox()
  const toolbar = reader.locator('.preview-toolbar')
  const toolbarBox = await toolbar.boundingBox()
  assert(toolbarBox.x > 0 && toolbarBox.y > 0, 'Contained-origin fixture needs a translated toolbar')
  await toolbar.evaluate(element => { element.style.contain = 'layout' })
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await settle()
  const containedPanel = await containedMenu.boundingBox()
  assert(Math.abs(containedPanel.x - normalPanel.x) <= 1 && Math.abs(containedPanel.y - normalPanel.y) <= 1,
    `Toolbar containment offset the reader menu: ${JSON.stringify({ normalPanel, containedPanel, toolbarBox })}`)
  assert(containedPanel.x >= 0 && containedPanel.x + containedPanel.width <= 1280 &&
    containedPanel.y >= 0 && containedPanel.y + containedPanel.height <= 240, 'Contained reader menu escaped the viewport')
  const rotate = containedMenu.getByRole('button', { name: /Rotate clockwise/ })
  await rotate.focus()
  const panelScroll = await containedMenu.evaluate(element => {
    element.scrollTop = element.scrollHeight - element.clientHeight
    return element.scrollTop
  })
  assert(panelScroll > 0, 'Contained reader menu must exercise internal scrolling')
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await settle()
  assert.equal(await containedMenu.evaluate(element => element.scrollTop), panelScroll, 'Origin measurement reset menu scroll')
  await expect(rotate).toBeFocused()
  measurements.push({ scenario: 'contained-reader-menu', normalPanel, containedPanel, toolbarBox, panelScroll })
  await page.keyboard.press('Escape')
  await expect(containedMenu).toHaveCount(0)
  await expect(options).toBeFocused()
  await toolbar.evaluate(element => { element.style.removeProperty('contain') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await settle()
  assert.deepEqual({ imageRequests, previewRequests }, initialRequests, 'Reader menu positioning downloaded the image again')
  console.log('PASS: Reader menu compensates a contained toolbar origin without losing internal scroll/focus or downloading content')
  await choose('1')
  box = await geometry()
  assert.equal(box.imageWidth, 1600)
  assert.equal(box.imageHeight, 1200)
  await area.evaluate(element => { element.scrollLeft = 430; element.scrollTop = 310 })
  await settle()
  const panBounds = await area.boundingBox()
  const panPoint = { x: panBounds.x + panBounds.width / 2, y: panBounds.y + panBounds.height / 2 }
  await image.evaluate(element => { window.fixtureImageDOM = element })
  await page.mouse.move(panPoint.x, panPoint.y)
  await page.mouse.down()
  await expect(area).toHaveClass(/is-panning/)
  await expect(area).toBeFocused()
  await page.mouse.move(panPoint.x - 100, panPoint.y - 75, { steps: 20 })
  await expect.poll(async () => { const value = await geometry(); return [value.left, value.top] }).toEqual([530, 385])
  await page.mouse.up()
  await expect(area).not.toHaveClass(/is-panning/)
  assert(await image.evaluate(element => window.fixtureImageDOM === element),
    'Panning replaced the image element')
  assert.deepEqual({ imageRequests, previewRequests }, initialRequests, 'Panning downloaded the image again')
  assert(await area.evaluate(element => element.dispatchEvent(new PointerEvent('pointerdown',
    { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 99, isPrimary: true, button: 0 }))),
  'Image panning prevented native touch scrolling')
  await expect(area).not.toHaveClass(/is-panning/)
  await page.mouse.move(panPoint.x, panPoint.y)
  await page.mouse.down()
  await expect(area).toHaveClass(/is-panning/)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(area).not.toHaveClass(/is-panning/)
  const cancelled = await geometry()
  await page.mouse.move(panPoint.x - 30, panPoint.y - 30)
  await page.mouse.up()
  box = await geometry()
  assert.deepEqual([box.left, box.top], [cancelled.left, cancelled.top], 'A cancelled pan kept moving')
  console.log('PASS: zoomed images pan directly without replacement/downloads; release and window blur end the gesture; native touch input remains available')
  const centerBefore = await geometry()
  await choose('2')
  box = await geometry()
  const x = (centerBefore.left + centerBefore.width / 2 - 16) / centerBefore.imageWidth
  const y = (centerBefore.top + centerBefore.height / 2 - 16) / centerBefore.imageHeight
  assert(Math.abs((box.left + box.width / 2 - 16) / box.imageWidth - x) < 0.002, 'Zoom moved the horizontal image center')
  assert(Math.abs((box.top + box.height / 2 - 16) / box.imageHeight - y) < 0.002, 'Zoom moved the vertical image center')
  await showOptions()
  await reader.getByRole('button', { name: /Rotate clockwise/ }).click()
  await expect(options).toHaveAttribute('aria-expanded', 'true')
  await settle()
  box = await geometry()
  assert.equal(box.imageWidth, 2400)
  assert.equal(box.imageHeight, 3200)
  assert(Math.abs((box.left + box.width / 2 - 16) / box.imageWidth - (1 - y)) < 0.002)
  assert(Math.abs((box.top + box.height / 2 - 16) / box.imageHeight - x) < 0.002)
  await reader.locator('.image-view-options').getByRole('button', { name: 'Zoom image in', exact: true }).click()
  await reader.locator('.image-view-options').getByRole('button', { name: 'Zoom image out', exact: true }).click()
  await expect(options).toHaveAttribute('aria-expanded', 'true')
  await closeOptions()
  assert.deepEqual({ imageRequests, previewRequests }, initialRequests, 'View controls downloaded the image again')
  const backingGeometry = await geometry()
  const backingToolbar = await toolbar.boundingBox()
  const backingURL = await image.getAttribute('src')
  const authoredStyle = await image.evaluate(element => {
    const style = getComputedStyle(element)
    return { scheme: style.colorScheme, filter: style.filter, opacity: style.opacity }
  })
  await showOptions()
  await expect(background).toHaveValue('theme')
  assert.deepEqual(await background.locator('option').allTextContents(), ['Match theme', 'Light', 'Dark'])
  await closeOptions()
  for (const [index, value] of ['light', 'dark', 'theme', 'light'].entries()) {
    await chooseBackground(value, index === 0)
    assert.deepEqual(await geometry(), backingGeometry, 'Image background changed zoom, rotation, center, or scroll')
    assert.deepEqual(await toolbar.boundingBox(), backingToolbar, 'Image background changed toolbar geometry')
    await expect(image).toHaveAttribute('src', backingURL)
    assert(await image.evaluate(element => element === window.fixtureImageDOM), 'Image background replaced the image node')
    assert.deepEqual(await image.evaluate(element => {
      const style = getComputedStyle(element)
      return { scheme: style.colorScheme, filter: style.filter, opacity: style.opacity }
    }), authoredStyle, 'Image background altered authored presentation')
    assert.deepEqual({ imageRequests, previewRequests }, initialRequests, 'Image background fetched another preview')
  }
  measurements.push({ scenario: 'image-background', geometry: backingGeometry, toolbar: backingToolbar, authoredStyle })
  console.log('PASS: Image background changes only the backing; authored presentation, image node, URL, geometry, and requests stay intact; native selection closes Reader options and restores focus')
  const beforeResize = await geometry()
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect.poll(async () => {
    const current = await geometry()
    return {
      x: Math.abs((current.left + current.width / 2 - 16) / current.imageWidth - (beforeResize.left + beforeResize.width / 2 - 16) / beforeResize.imageWidth) < 0.002,
      y: Math.abs((current.top + current.height / 2 - 16) / current.imageHeight - (beforeResize.top + beforeResize.height / 2 - 16) / beforeResize.imageHeight) < 0.002,
    }
  }, {message: 'Resize must preserve the image center after layout finishes'}).toEqual({x: true, y: true})
  box = await geometry()
  const remembered = await geometry()
  await openTab('second.svg')
  await expectBackground('theme')
  await expect(hiddenImage('first.png')).toHaveAttribute('data-background', 'light')
  await chooseBackground('dark')
  assert.equal(await page.evaluate(() => window.fixtureSVGExecuted), undefined, 'SVG executed as active markup')
  box = await geometry()
  assert(box.imageWidth > 0 && box.imageHeight > 0)
  assert(Math.abs(box.imageWidth / box.imageHeight - 1.5) < 0.002, 'ViewBox-only SVG lost its aspect ratio')
  assert(Math.abs(box.centerX - box.width / 2) <= 1 && Math.abs(box.centerY - box.height / 2) <= 1)
  await showOptions()
  for (let step = 0; step < 4; step++) {
    await reader.getByRole('button', { name: /Rotate clockwise/ }).click()
    await settle()
    box = await geometry()
    assert(box.imageWidth <= box.width && box.imageHeight <= box.height)
    assert(Math.abs(box.centerX - box.width / 2) <= 1 && Math.abs(box.centerY - box.height / 2) <= 1, 'Rotated Fit moved the SVG center')
  }
  await closeOptions()
  await page.evaluate(() => { window.fixtureSVGZeroSize = true })
  await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
  await expect.poll(async () => (await geometry()).naturalWidth).toBe(0)
  await expect(image).toBeVisible()
  await settle()
  await expectBackground('dark')
  box = await geometry()
  assert(box.imageWidth > 0 && box.imageHeight > 0)
  assert(Math.abs(box.imageWidth / box.imageHeight - 1.5) < 0.002, 'Zero-intrinsic-size SVG fallback lost its aspect ratio')
  await choose('1')
  box = await geometry()
  assert(box.imageWidth > 0 && box.imageHeight > 0)
  await choose('2')
  const restoreViewport = page.viewportSize()
  for (const density of ['compact', 'comfortable']) {
    await page.evaluate(density => window.fixturePreferences({ density, fontScale: 1.4 }), density)
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(viewport)
      await showOptions()
      await reader.getByRole('button', { name: /Rotate clockwise/ }).click()
      await closeOptions()
      await settle()
      await area.evaluate(element => { element.scrollLeft += 27; element.scrollTop += 19 })
      await settle()
      const before = await geometry()
      for (let refresh = 0; refresh < 3; refresh++) {
        const previous = await image.getAttribute('src')
        await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
        await expect(image).not.toHaveAttribute('src', previous)
        await settle()
        const after = await geometry()
        await expect(zoom).toHaveValue('2')
        assert.equal(after.naturalWidth, 0)
        assert.equal(after.transform, before.transform)
        assert(Math.abs(after.imageWidth - before.imageWidth) <= 1 && Math.abs(after.imageHeight - before.imageHeight) <= 1,
          `Unchanged zero-intrinsic SVG changed size after refresh at 200%: ${JSON.stringify({ density, viewport, before, after })}`)
        assert(Math.abs(after.left - before.left) <= 1 && Math.abs(after.top - before.top) <= 1,
          `Unchanged zero-intrinsic SVG moved the image center after refresh: ${JSON.stringify({ density, viewport, before, after })}`)
        measurements.push({ scenario: 'svg-refresh', density, viewport, refresh, ...after })
      }
    }
  }
  await page.setViewportSize(restoreViewport)
  await page.evaluate(() => window.fixturePreferences({ density: 'compact', fontScale: 1 }))
  await settle()
  await choose('fit')
  await expect(reader.locator('.refresh-stale')).toHaveCount(0)
  await page.evaluate(() => { window.fixtureSVGZeroSize = false })
  await expect(hiddenImage('first.png')).toHaveCount(1)
  assert(await page.evaluate(() => window.fixtureImageDOM.isConnected), 'Tab switch detached the retained image')
  await openTab('first.png')
  await expectBackground('light')
  await expect(hiddenImage('second.svg')).toHaveAttribute('data-background', 'dark')
  await expect(zoom).toHaveValue('2')
  box = await geometry()
  assert(box.transform.includes('90deg'))
  assert(Math.abs(box.left - remembered.left) <= 1 && Math.abs(box.top - remembered.top) <= 1, `Tab round trip lost pan position: ${JSON.stringify({before: remembered, after: box})}`)
  console.log('PASS: Fit/zoom/rotation centers, native pan, resize, viewBox-only SVG and missing-intrinsic-size fallback, SVG img safety, no view-action requests, and tab reuse')

  const previousURL = await image.getAttribute('src')
  let release
  let started
  const arrived = new Promise(resolve => { started = resolve })
  held = { started, wait: new Promise(resolve => { release = resolve }) }
  nextImage = 'replacement'
  version = 'v2'
  await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
  await arrived
  await expect(image).toHaveAttribute('src', previousURL)
  await expect(image).toBeVisible()
  await expectBackground('light')
  release()
  await expect(image).not.toHaveAttribute('src', previousURL)
  await expect(zoom).toHaveValue('2')
  await settle()
  await expectBackground('light')
  box = await geometry()
  assert.equal(box.naturalWidth, 1200)
  assert.equal(box.naturalHeight, 1600)
  assert(box.transform.includes('90deg'))
  nextImage = 'broken'
  const goodURL = await image.getAttribute('src')
  await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
  await expect(page.getByText('Update pending: The image could not be refreshed.')).toBeAttached()
  await expect(reader.locator('.refresh-stale')).toBeVisible()
  await expect(reader.locator('.refresh-stale')).toHaveAttribute('title', /The image could not be refreshed/)
  await expect(image).toHaveAttribute('src', goodURL)
  await expect(image).toBeVisible()
  failPreviewURL = true
  const requestsBeforeURLFailure = imageRequests
  await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
  await expect(reader.locator('.refresh-stale')).toHaveAttribute('title', /Synthetic preview URL failure/)
  await expect(reader.locator('.refresh-stale')).toBeVisible()
  await expect(image).toHaveAttribute('src', goodURL)
  await expect(image).toBeVisible()
  assert.equal(imageRequests, requestsBeforeURLFailure)
  failPreviewURL = false
  nextImage = 'replacement'
  await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
  await expect(image).not.toHaveAttribute('src', goodURL)
  await expect(reader.locator('.refresh-stale')).toHaveCount(0)
  await expectBackground('light')
  console.log('PASS: Refresh double buffer, visible warnings for image/URL failure, and successful retry')

  const beforeHide = await geometry()
  await page.getByRole('button', { name: 'Hide reader toolbar', exact: true }).click()
  await expect(zoom).toBeHidden()
  await expect(image).toBeVisible()
  await settle()
  box = await geometry()
  assert(box.height >= beforeHide.height && box.height > 200, 'Hiding the toolbar collapsed the image document')
  assert.equal(box.imageWidth, beforeHide.imageWidth)
  assert.equal(box.imageHeight, beforeHide.imageHeight)
  await page.getByRole('button', { name: 'Show reader toolbar', exact: true }).click()
  await reader.getByRole('button', { name: 'Full screen', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: false })).toBeVisible()
  await expect(zoom).toBeHidden()
  assert.deepEqual(await page.getByRole('button').filter({ visible: true }).allTextContents(), ['Exit full screen'])
  await page.getByRole('button', { name: 'Exit full screen', exact: false }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await choose('4')
  box = await geometry()
  assert(box.scrollWidth > box.width && box.scrollHeight > box.height)
  const pageWidth = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert(pageWidth.scroll <= pageWidth.width + 1, 'Zoom created page-level horizontal overflow')
  await area.evaluate(element => { element.scrollLeft = 500; element.scrollTop = 600 })
  await settle()
  box = await geometry()
  assert.equal(box.left, 500)
  assert.equal(box.top, 600)
  assert.equal(await area.evaluate(element => getComputedStyle(element).overflow), 'auto')
  await showOptions()
  await expect(reader.getByRole('button', { name: /Rotate clockwise/ })).toBeVisible()
  await closeOptions()
  console.log('PASS: Toolbar collapse, fullscreen Exit-only controls, mobile bounds and native overflow')

  for (const width of [320, 390, 768]) for (const density of ['compact', 'comfortable']) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(density => window.fixturePreferences({ density, fontScale: 1.4 }), density)
    await choose('1.25')
    const bounds = await zoom.evaluate(element => {
      const style = getComputedStyle(element)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ')
      return {
        width: element.getBoundingClientRect().width,
        // Reserve space for the native select arrow as well as the selected text.
        requiredWidth: context.measureText(element.selectedOptions[0].text).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 32,
      }
    })
    assert(bounds.width >= bounds.requiredWidth, `Zoom label clipped at ${width}/${density}/140%: ${JSON.stringify(bounds)}`)
    const toolbar = await reader.locator('.preview-toolbar').evaluate(element => ({
      pageWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      controls: [...element.querySelectorAll('button,select,a')].filter(control => control.getClientRects().length).map(control => {
        const box = control.getBoundingClientRect()
        return { label: control.getAttribute('aria-label') || control.textContent, left: box.left, right: box.right }
      }),
    }))
    assert(toolbar.scrollWidth <= toolbar.pageWidth + 1, 'Image toolbar overflowed the page')
    for (const control of toolbar.controls) assert(control.left >= 0 && control.right <= toolbar.pageWidth + 1,
      `Image toolbar control clipped at ${width}/${density}: ${JSON.stringify(control)}`)
    measurements.push({ scenario: 'toolbar', width, density, zoom: bounds, ...toolbar })
    if (artifacts) await page.screenshot({ path: join(artifacts, `${width}-${density}.png`) })
  }
  console.log('PASS: Consecutive zero-intrinsic SVG refreshes preserve 200% scale/center through rotations and orientation changes; zoom labels and toolbar fit at 320/390/768px and 140% text')

  const beforePopup = { imageRequests, previewRequests }
  await page.setViewportSize({ width: 568, height: 240 })
  await options.focus()
  await page.keyboard.press('Enter')
  const panel = reader.locator('.reader-actions-panel')
  for (const viewport of [{ width: 568, height: 240 }, { width: 768, height: 600 }, { width: 568, height: 240 }]) {
    await page.setViewportSize(viewport)
    await settle()
    const bounds = await panel.evaluate(element => {
      const box = element.getBoundingClientRect()
      const content = document.querySelector('.project-content').getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        contentLeft: content.left, contentTop: content.top, contentRight: content.right,
        contentBottom: content.bottom, width: innerWidth, height: innerHeight,
        topScroll: element.scrollTop, maxScroll: element.scrollHeight - element.clientHeight }
    })
    assert(bounds.left >= Math.max(0, bounds.contentLeft) + 9 && bounds.right <= Math.min(bounds.width, bounds.contentRight) - 9 &&
      bounds.top >= Math.max(0, bounds.contentTop) + 9 && bounds.bottom <= Math.min(bounds.height, bounds.contentBottom) - 9,
    `Reader options escaped its bounds: ${JSON.stringify(bounds)}`)
    if (viewport.height === 240) assert(bounds.maxScroll > 0, 'Short reader must exercise popup scrolling')
    await page.mouse.move((bounds.left + bounds.right) / 2, bounds.bottom - 12)
    await page.mouse.wheel(0, bounds.maxScroll - bounds.topScroll)
    // Wait for the native wheel destination before checking scroll retention.
    await expect.poll(() => panel.evaluate(element => Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight)))).toBeLessThanOrEqual(1)
    await settle()
    const detail = await panel.evaluate(element => {
      const box = element.getBoundingClientRect()
      const last = element.querySelector('.reader-file-details').lastElementChild.getBoundingClientRect()
      return { top: last.top, bottom: last.bottom, panelTop: box.top, panelBottom: box.bottom }
    })
    assert(detail.top >= detail.panelTop && detail.bottom <= detail.panelBottom, 'Final file information remains clipped after scrolling')
    await expect(options).toBeFocused()
    measurements.push({ scenario: 'reader-options-open-resize', viewport, bounds, detail })
  }
  if (artifacts) await page.screenshot({ path: join(artifacts, 'short-reader-options.png') })
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(options).toBeFocused()
  assert.deepEqual({ imageRequests, previewRequests }, beforePopup, 'Popup layout caused a file read')
  console.log('PASS: short Reader options stays bounded through open resize; native scroll exposes final metadata without reset, focus loss, or reads')
  await page.evaluate(() => window.fixturePreferences({ density: 'compact', fontScale: 1 }))
  await page.setViewportSize({ width: 1280, height: 900 })

  // Retained DOM is immediately readable, including while automatic refresh is paused.
  version = 'reuse-v1'
  nextImage = 'original'
  const refreshImage = async () => {
    const previous = await image.getAttribute('src')
    await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
    await expect(image).not.toHaveAttribute('src', previous)
    await settle()
  }
  await refreshImage()
  const loadedPreview = await cachedPreview('first.png')
  assert.equal(loadedPreview.url, await image.getAttribute('src'))
  await image.evaluate(element => { window.fixtureRetainedImage = element })
  await openTab('second.svg')
  const beforeWarmReturn = { imageRequests, previewRequests }
  await expect(hiddenImage('first.png')).toHaveCount(1)
  await openTab('first.png')
  assert(await image.evaluate(element => element === window.fixtureRetainedImage), 'Warm return replaced the retained image DOM')
  await expect(image).toHaveAttribute('src', loadedPreview.url)
  assert.deepEqual({ imageRequests, previewRequests }, beforeWarmReturn, 'Paused warm return reauthorized or downloaded its retained image')

  // Evict through the actual bounded deck, keeping the image tab and descriptor open.
  const evictFirstReader = async () => {
    for (let index = 0; index < 8; index++) {
      const path = `eviction-${index}.txt`
      await page.evaluate(location => { window.location.hash = new URLSearchParams(location).toString() }, fileLocation(path))
      await expect(reader.getByRole('heading', { name: path, exact: true })).toHaveCount(1)
      await expect(reader).toContainText('Synthetic reader')
    }
    await expect(page.locator('.reader-panel')).toHaveCount(8)
    await expect(page.locator('.reader-panel img[alt="first.png"]')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'first.png', exact: true })).toHaveCount(1)
    await openTab('second.svg')
  }
  await evictFirstReader()
  assert.equal((await cachedPreview('first.png')).url, loadedPreview.url, 'DOM eviction discarded the still-open descriptor cache')
  let authorize
  const authorization = new Promise(resolve => { authorize = resolve })
  let authorizationStarted = false
  heldPreview = { path: 'first.png', started: () => { authorizationStarted = true }, wait: authorization }
  const beforeReturn = previewRequests
  await page.getByRole('tab', { name: 'first.png', exact: true }).click()
  await expect.poll(() => authorizationStarted).toBe(true)
  await expect(image).toHaveCount(0)
  authorize()
  await expect(image).toHaveAttribute('src', loadedPreview.url)
  await settle()
  assert.equal(previewRequests, beforeReturn + 1, 'Cold descriptor reuse skipped fresh authorization')
  assert.equal((await cachedPreview('first.png')).expiresAt, loadedPreview.expiresAt, 'Reuse extended the old capability expiry')
  await refreshImage()
  assert.equal(await image.getAttribute('src'), issuedPreviews.get('first.png').url, 'Explicit Refresh reused the loaded URL')

  await evictFirstReader()
  version = 'reuse-v2'
  await openTab('first.png')
  assert.equal(await image.getAttribute('src'), issuedPreviews.get('first.png').url, 'Changed version reused old pixels')
  previewLifetime = 60_000
  await refreshImage()
  const expiringURL = await image.getAttribute('src')
  await evictFirstReader()
  previewLifetime = 15 * 60_000
  await page.evaluate(() => { window.fixtureDateNow = Date.now; Date.now = () => window.fixtureDateNow() + 120_000 })
  try {
    await openTab('first.png')
    assert.notEqual(await image.getAttribute('src'), expiringURL, 'Expired descriptor reused')
    assert.equal(await image.getAttribute('src'), issuedPreviews.get('first.png').url)
  } finally { await page.evaluate(() => { Date.now = window.fixtureDateNow }) }

  const seedColdDescriptor = async () => {
    const descriptor = await cachedPreview('first.png')
    assert(descriptor)
    await evictFirstReader()
    // Represent a previously loaded image whose browser resource is no longer present.
    const resource = `/p/cold-revoked-${++token}`
    responses.set(resource, { path: 'first.png', kind: 'revoked' })
    await page.evaluate(({ key, descriptor }) => window.fixtureSeedImagePreview(key, descriptor),
      { key: key('first.png'), descriptor: { ...descriptor, url: previewOrigin + resource } })
    return resource
  }
  const cold = await seedColdDescriptor()
  const beforeFallback = { previews: previewRequests, loads: imageLoads.length }
  await openTab('first.png')
  const fallbackURL = issuedPreviews.get('first.png').url
  assert.equal(await image.getAttribute('src'), fallbackURL)
  assert.equal(previewRequests, beforeFallback.previews + 1, 'Fallback created another authorization request')
  assert.deepEqual(imageLoads.slice(beforeFallback.loads), [cold, new URL(fallbackURL).pathname])
  await expect(reader.getByRole('button', { name: 'Resume automatic refresh', exact: true }).filter({ visible: true })).toBeVisible()
  await expect(reader.locator('.refresh-stale')).toHaveCount(0)
  assert.equal((await cachedPreview('first.png')).url, fallbackURL)

  const coldFailure = await seedColdDescriptor()
  nextImage = 'broken'
  const beforeFailedFallback = { previews: previewRequests, loads: imageLoads.length }
  await page.getByRole('tab', { name: 'first.png', exact: true }).click()
  await expect(reader.getByRole('heading', { name: 'Couldn’t display this image', exact: true })).toBeVisible()
  await settle()
  assert.deepEqual(imageLoads.slice(beforeFailedFallback.loads), [coldFailure, new URL(issuedPreviews.get('first.png').url).pathname])
  assert.equal(previewRequests, beforeFailedFallback.previews + 1, 'Failed fallback retried repeatedly while paused')
  assert.equal(await cachedPreview('first.png'), undefined, 'Failed resource retained')
  nextImage = 'original'
  await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
  await expect.poll(async () => (await image.getAttribute('src')) === issuedPreviews.get('first.png').url).toBe(true)
  await settle()
  await evictFirstReader()
  deniedPreview = 'first.png'
  const beforeDenied = imageRequests
  await page.getByRole('tab', { name: 'first.png', exact: true }).click()
  await expect(reader.getByRole('heading', { name: 'Couldn’t prepare a preview', exact: true })).toBeVisible()
  await expect(image).toHaveCount(0)
  assert.equal(imageRequests, beforeDenied, 'Revoked authorization displayed a cached image')
  assert.equal(await cachedPreview('first.png'), undefined)
  deniedPreview = ''
  await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
  await expect(image).toBeVisible()
  await settle()
  assert.equal(await image.getAttribute('src'), issuedPreviews.get('first.png').url)

  for (const interruption of ['generation', 'close and reopen']) {
    let finishLoad
    let started = false
    held = { started: () => { started = true }, wait: new Promise(resolve => { finishLoad = resolve }) }
    await reader.getByRole('button', { name: 'Refresh file', exact: true }).filter({ visible: true }).click()
    await expect.poll(() => started).toBe(true)
    const pendingURL = issuedPreviews.get('first.png').url
    assert.notEqual((await cachedPreview('first.png'))?.url, pendingURL, 'Unloaded resource retained')
    if (interruption === 'generation') {
      await page.evaluate(() => window.fixtureClearImageViews())
      finishLoad()
      await expect(image).toHaveAttribute('src', pendingURL)
      await settle()
      assert.equal(await cachedPreview('first.png'), undefined, 'Late load resurrected a cleared descriptor')
    } else {
      await openTab('second.svg')
      await page.getByRole('tablist', { name: 'Project tabs' }).getByRole('button', { name: 'Close first.png', exact: true }).click()
      await page.getByRole('tab', { name: 'Browse', exact: true }).click()
      await page.getByRole('link', { name: 'first.png', exact: true }).click()
      await expect.poll(async () => (await image.getAttribute('src')) === issuedPreviews.get('first.png').url).toBe(true)
      await settle()
      const reopened = await image.getAttribute('src')
      finishLoad()
      await settle()
      assert.equal((await cachedPreview('first.png')).url, reopened, 'Closed owner overwrote the reopened descriptor')
    }
  }
  console.log('PASS: warm retained DOM avoids reauthorization/downloads; cold descriptor reuse requires authorization; version/expiry/Refresh bypass, one paused fallback, access denial, failed loads, generation and close/reopen guards prevent stale reuse')

  await openTab('second.svg')
  await page.getByRole('tablist', { name: 'Project tabs' }).getByRole('button', { name: 'Close first.png', exact: true }).click()
  await expect.poll(() => cached('first.png')).toBeUndefined()
  assert.equal(await cachedPreview('first.png'), undefined)
  await page.getByRole('tab', { name: 'Browse', exact: true }).click()
  await page.getByRole('link', { name: 'first.png', exact: true }).click()
  await expect(zoom).toHaveValue('fit')
  await expect(image).toBeVisible()
  await expectBackground('theme')
  await chooseBackground('light')
  await choose('2')
  await openTab('second.svg')
  await expect(hiddenImage('first.png')).toHaveAttribute('data-background', 'light')
  await evictFirstReader()
  assert.equal((await cached('first.png')).background, 'light', 'Eviction did not retain the current image view')
  await page.evaluate(() => window.dispatchEvent(new Event('artiface:configuration-changed')))
  await expect.poll(() => cached('first.png')).toBeUndefined()
  assert.equal(await cachedPreview('first.png'), undefined)
  await openTab('first.png')
  await expect(zoom).toHaveValue('fit')
  await expectBackground('theme')
  await chooseBackground('dark')
  await choose('2')
  await openTab('second.svg')
  await expect(hiddenImage('first.png')).toHaveAttribute('data-background', 'dark')
  assert(await cachedPreview('first.png'), 'Source-change fixture needs a cached descriptor to invalidate')
  sourceRevision = 'source-v2'
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(() => cached('first.png')).toBeUndefined()
  await expect.poll(() => cachedPreview('first.png')).toBeUndefined()
  await openTab('first.png')
  await expectBackground('theme')
  await chooseBackground('light')
  await choose('3')
  await openTab('second.svg')
  await expect(hiddenImage('first.png')).toHaveAttribute('data-background', 'light')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.locator('#password')).toBeVisible()
  await expect.poll(() => cached('first.png')).toBeUndefined()
  await expect.poll(() => cached('second.svg')).toBeUndefined()
  assert.equal(await cachedPreview('first.png'), undefined)
  assert.equal(await cachedPreview('second.svg'), undefined)
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
  assert(!storage.includes('"rotation"') && !storage.includes('"background"') && !storage.includes(previewOrigin),
    'Image view or preview capability metadata reached browser storage')
  assert.deepEqual(errors, [])
  console.log('PASS: Closed-tab reset, config/source/session cache cleanup, no persistent image view storage, and no browser errors')
} finally {
  if (artifacts) await writeFile(join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
  await browser.close()
}
