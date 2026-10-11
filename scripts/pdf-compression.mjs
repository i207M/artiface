import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { expect } = require('@playwright/test')

// Run only against smoke.py's generated projects, in a separate browser session.
export async function checkPDFCompression({ browser, origin, password, sources }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  context.setDefaultTimeout(30_000)
  const authResponse = await context.request.post(origin + '/api/login', { data: { password }, headers: { Origin: origin } })
  assert.equal(authResponse.status(), 200)
  const auth = await authResponse.json()
  const headers = { Origin: origin, 'X-CSRF-Token': auth.csrfToken }
  const page = await context.newPage()
  const reader = page.locator('.reader-panel:not([hidden])')
  const viewer = reader.locator('.pdf-viewer:visible')
  // Readers and refresh replacements can retain hidden canvases.
  const pages = viewer.locator('.pdf-canvas-area:visible')
  const firstPage = pages.locator('.pdf-paper[data-page="1"]')
  const requests = [], errors = []
  page.on('request', request => requests.push({ url: new URL(request.url()), method: request.method() }))
  page.on('pageerror', error => errors.push(error.message))
  const images = () => requests.filter(request => request.url.pathname === '/api/pdf/page')
  const originals = () => requests.filter(request => request.url.pathname === '/api/file' && request.method === 'GET')
  const navigate = (source, path) => page.goto(origin + '/#' + new URLSearchParams({ ...source, path, kind: 'file' }))
  try {
    // Poppler is optional for native installs; the container smoke requires it.
    const probe = await context.request.post(origin + '/api/pdf/info', { headers, data: sources[0] })
    if (probe.status() === 501) {
      console.log('SKIP: PDF compression browser checks require native Poppler')
      return
    }
    assert.equal(probe.status(), 200, await probe.text())
    await page.goto(origin + '/#kind=settings')
    await page.getByRole('checkbox', { name: 'Compression', exact: true }).check()
    await page.getByRole('combobox', { name: 'Automatic refresh interval', exact: true }).selectOption('2')
    for (const source of sources) {
      await navigate(source, source.path)
      const info = await (await context.request.post(origin + '/api/pdf/info', { headers, data: source })).json()
      const pageDownloads = number => images().filter(request =>
        request.url.searchParams.get('document') === info.id &&
        request.url.searchParams.get('page') === String(number) &&
        request.url.searchParams.get('size') !== '320').length
      const ready = async number => {
        await expect(viewer.getByRole('region', { name: `PDF page ${number} of ${info.pages}`, exact: true })).toHaveAttribute('aria-busy', 'false')
        await expect.poll(() => pages.locator(`.compressed-paper[data-page="${number}"] canvas`).evaluate(canvas => canvas.width)).toBeGreaterThan(0)
      }
      await ready(1)
      const raster = await firstPage.locator('canvas').evaluate(canvas => ({
        density: canvas.width / parseFloat(canvas.style.width), pixels: canvas.width * canvas.height,
      }))
      assert(raster.density >= 2.98, 'Compression undersampled the high-density phone display')
      assert(raster.pixels <= 8_000_000, 'Compression exceeded the canvas pixel budget')
      assert(await firstPage.locator('canvas').evaluate(canvas => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        let dark = 0
        for (let i = 0; i < pixels.length; i += 16) if (pixels[i] < 220 && pixels[i + 3] > 0) dark++
        return dark > 5
      }), 'Compressed page canvas was blank')
      assert.equal(originals().length, 0, 'Compression downloaded the source PDF')
      await expect(pages.locator('.pdf-text-layer')).toHaveCount(0)
      const image = await context.request.get(images().at(-1).url.href)
      assert.equal(image.headers()['content-type'], 'image/jpeg')
      assert.equal(image.headers()['cache-control'], 'no-store')
      const navigation = page.getByRole('button', { name: 'PDF outline and pages', exact: true })
      const outlineResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pdf/outline')
      await navigation.click()
      const outline = await outlineResponse
      if (outline.ok()) {
        const data = await outline.json()
        assert(Array.isArray(data.items), 'Outline response did not contain an array')
        if (info.pages > 1) {
          await page.getByRole('navigation', { name: 'PDF outline', exact: true }).getByRole('button', { name: 'Final section', exact: true }).click()
          await ready(info.pages)
          await navigation.click()
        } else await expect(page.getByText('This PDF has no outline. Use Page overview to browse its pages.', { exact: true })).toBeVisible()
      } else {
        assert.equal(outline.status(), 501, 'Unexpected compressed outline error')
        await expect(page.getByRole('button', { name: 'Use Original mode', exact: true })).toBeVisible()
      }
      await page.getByRole('button', { name: 'Page overview', exact: true }).click()
      await expect(viewer.locator('[data-thumbnail-page="1"] canvas')).toHaveClass('is-ready')
      assert(images().some(request => request.url.searchParams.get('size') === '320'), 'Overview did not request small thumbnails')
      await page.getByRole('button', { name: 'Open page 1', exact: true }).click()
      await ready(1)
      assert.equal(originals().length, 0, 'Outline or overview downloaded the original PDF in Compression mode')
      if (info.pages > 1) {
        await page.getByRole('button', { name: 'Next page', exact: true }).click()
        await ready(2)
        const before = pageDownloads(1)
        await page.getByRole('button', { name: 'Previous page', exact: true }).click()
        await ready(1)
        assert.equal(pageDownloads(1), before, 'Revisiting a page bypassed the browser image cache')
      }
      const beforeTab = pageDownloads(1)
      await navigate(source, source.path.startsWith('reports/') ? 'reports/notes.md' : 'notes.md')
      await expect(reader.locator('.markdown-viewer')).toBeVisible()
      await navigate(source, source.path)
      await ready(1)
      assert.equal(pageDownloads(1), beforeTab, 'Returning to a file tab downloaded its cached page again')
      await page.getByRole('button', { name: 'Reader options', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Compression · On', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await page.getByRole('button', { name: 'Rotate page clockwise', exact: true }).click()
      await page.getByRole('button', { name: 'Rotate page clockwise', exact: true }).click()
      await page.keyboard.press('Escape')
      await ready(1)
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pdf/info' && response.ok())
      let retry = true
      await page.route('**/api/pdf/info', async route => {
        if (retry && route.request().postDataJSON().refresh) {
          retry = false
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'PDF compression is busy; try again shortly' }) })
        } else await route.continue()
      })
      await page.getByRole('button', { name: 'Reader options', exact: true }).click()
      await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
      assert.notEqual((await (await refreshed).json()).id, info.id, 'Refresh retained the old server snapshot')
      await page.unroute('**/api/pdf/info')
      await ready(1)
      await page.reload()
      await ready(1)
      assert.equal(originals().length, 0, 'Reload lost Compression mode')
      await page.getByRole('button', { name: 'Full screen', exact: true }).click()
      await expect(page.getByRole('button')).toHaveCount(1)
      await page.getByRole('button', { name: 'Exit full screen', exact: true }).click()
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(pages).toHaveAttribute('aria-busy', 'false')
    await expect.poll(() => images().some(request => Number(request.url.searchParams.get('size')) > 1920)).toBe(true)
    assert(await firstPage.locator('canvas').evaluate(canvas => canvas.width * canvas.height <= 8_000_000),
      'Desktop compression exceeded the canvas pixel budget')
    await page.getByRole('button', { name: 'Reader options', exact: true }).click()
    await page.getByRole('button', { name: 'Compression · On', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(firstPage.locator('.pdf-text-layer')).not.toBeEmpty()
    await expect(pages).toHaveAttribute('aria-busy', 'false')
    assert(await firstPage.locator('canvas').evaluate(canvas => {
      const width = parseFloat(canvas.style.width), height = parseFloat(canvas.style.height)
      const expected = Math.min(3, Math.sqrt(8_000_000 / (width * height)))
      return canvas.width / width >= expected - .01 && canvas.width * canvas.height <= 8_000_000
    }), 'Original PDF rendering lost display density or exceeded its pixel budget')
    assert(originals().length > 0, 'Original mode did not restore the PDF viewer')
    assert.deepEqual(errors, [])
    console.log('PASS: local/SSH Compression, server outlines, 320px page overview, no browser PDF download, JPEG pages, page/tab cache, refresh, reload, rotation, fullscreen, and Original mode')
  } finally {
    await context.request.post(origin + '/api/logout', { headers, data: {} })
    await context.close()
  }
}
