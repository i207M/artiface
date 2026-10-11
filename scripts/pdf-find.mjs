import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { expect } = require('@playwright/test')

// Requires smoke.py's unchanged 50-page "Long PDF fixture page N" document.
// The caller owns the browser; this check owns and closes its context.
export async function checkPDFFind({ browser, origin, password, source, capture }) {
  const file = { ...source, path: source.path ?? 'reports/long-reader.pdf', kind: 'file' }
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(30_000)
  context.setDefaultNavigationTimeout(30_000)
  try {
    await context.addInitScript(() => {
      localStorage.setItem('artiface.preferences.v1', JSON.stringify({
        pdfCompression: false, pdfNavigation: 'horizontal', readerToolbarVisible: true,
        sidebarVisible: false, autoRefreshSeconds: 300,
      }))
    })
    const login = await context.request.post(origin + '/api/login', { data: { password }, headers: { Origin: origin } })
    assert.equal(login.status(), 200, 'PDF Find fixture login failed')
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin + '/#' + new URLSearchParams(file))
    const toolbar = page.locator('.pdf-toolbar')
    const input = page.getByRole('searchbox', { name: 'Find text in PDF', exact: true })
    const status = page.locator('.pdf-find-status')
    const options = page.getByRole('button', { name: 'Reader options', exact: true })
    const ready = async number => {
      await expect(page.getByRole('region', { name: `PDF page ${number} of 50`, exact: true })).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue(String(number))
      await expect(page.locator(`.pdf-paper[data-page="${number}"] .pdf-text-layer`)).toContainText(`Long PDF fixture page ${number}`)
      await expect.poll(() => page.getByLabel(`Page ${number}`, { exact: true }).evaluate(canvas => {
        if (!canvas.isConnected || !canvas.width || !canvas.height) return false
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100 && pixels[index + 3] > 0) return true
        }
        return false
      })).toBe(true)
    }
    const openFind = async () => {
      await options.click()
      await expect(options).toHaveAttribute('aria-expanded', 'true')
      await page.getByRole('button', { name: 'Find in PDF', exact: true }).click()
      await expect(options).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('.reader-actions-panel')).toHaveCount(0)
      await expect(input).toBeFocused()
      await expect(toolbar.locator(':scope > .pdf-find')).toHaveCount(1)
    }
    const search = async () => {
      await input.fill('page 4')
      await expect(status).toHaveText('11 matching pages · 50/50 pages searched')
    }
    await ready(1)
    const originalURL = page.url()
    const navigation = page.getByRole('button', { name: 'PDF outline and pages', exact: true })
    await navigation.click()
    await expect(page.getByRole('navigation', { name: 'PDF outline', exact: true }).getByRole('button', { name: 'Final section', exact: true })).toBeVisible()
    await capture?.('pdf-outline', page)
    await page.getByRole('navigation', { name: 'PDF outline', exact: true }).getByRole('button', { name: 'Final section', exact: true }).click()
    await ready(50)
    assert.equal(page.url(), originalURL, 'Bookmark navigation replaced the application route')
    await page.getByRole('combobox', { name: 'PDF zoom', exact: true }).selectOption('1.25')
    await ready(50)
    await navigation.click()
    await page.getByRole('button', { name: 'Page overview', exact: true }).click()
    const overview = page.getByRole('region', { name: 'PDF page overview', exact: true })
    await expect(overview).toBeVisible()
    await expect(page.locator('[data-thumbnail-page="50"] canvas')).toHaveClass('is-ready')
    await expect(page.locator('.pdf-overview-placeholder')).toHaveCount(0)
    await capture?.('pdf-overview', page)
    await page.getByRole('button', { name: 'Open page 49', exact: true }).click()
    await ready(49)
    await expect(page.getByRole('combobox', { name: 'PDF zoom', exact: true })).toHaveValue('1.25')
    await navigation.click()
    await page.getByRole('button', { name: 'Page overview', exact: true }).click()
    await page.getByRole('button', { name: 'Return to page', exact: true }).click()
    await ready(49)
    await page.getByRole('spinbutton', { name: 'Page number', exact: true }).fill('1')
    await page.getByRole('spinbutton', { name: 'Page number', exact: true }).press('Enter')
    await ready(1)
    await page.getByRole('combobox', { name: 'PDF zoom', exact: true }).selectOption('fit')
    await ready(1)
    console.log('PASS: embedded PDF bookmarks, real page thumbnails, scoped navigation, preserved zoom, and return to reading')
    await expect(page.locator('.pdf-paper[data-page="40"]')).toHaveCount(0)
    await openFind()
    await search()
    await expect(page.locator('.pdf-paper[data-page="40"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Next matching page', exact: true }).click()
    await ready(4)
    await page.getByRole('button', { name: 'Next matching page', exact: true }).click()
    await ready(40)
    await page.getByRole('button', { name: 'Previous matching page', exact: true }).click()
    await ready(4)
    await input.press('Shift+Enter')
    await ready(49)
    await input.press('Enter')
    await ready(4)
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(options).toBeFocused()

    await openFind()
    await search()
    const refreshed = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/file' && url.searchParams.get('path') === file.path &&
        response.request().method() === 'GET' && response.ok()
    })
    await options.click()
    await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
    await refreshed
    await expect(input).toHaveCount(0)
    await ready(4)
    await openFind()
    await expect(input).toHaveValue('')
    await expect(status).toHaveText('Find matching pages in Original PDF text.')
    await input.fill('text absent from this fixture')
    await expect(status).toHaveText('0 matching pages · 50/50 pages searched')
    await search()

    await page.setViewportSize({ width: 320, height: 740 })
    await expect.poll(() => page.evaluate(() => {
      const toolbar = document.querySelector('.pdf-toolbar').getBoundingClientRect()
      const controls = [...document.querySelectorAll('.pdf-find-controls > *')].map(element => element.getBoundingClientRect())
      return document.documentElement.scrollWidth <= innerWidth && controls.length === 4 &&
        controls.every(rect => rect.width > 0 && rect.left >= toolbar.left && rect.right <= toolbar.right)
    })).toBe(true)
    await page.getByRole('button', { name: 'Hide reader toolbar', exact: true }).click()
    await expect(toolbar).toBeHidden()
    await expect(input).toBeHidden()
    await page.getByRole('button', { name: 'Show reader toolbar', exact: true }).click()
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('page 4')
    await page.getByRole('button', { name: 'Full screen', exact: true }).click()
    await expect(page.locator('.workspace-shell')).toHaveClass(/reader-expanded/)
    await expect(toolbar).toBeHidden()
    await expect(input).toBeHidden()
    await page.getByRole('button', { name: 'Exit full screen', exact: true }).click()
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('page 4')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    // The native exit event and its deferred focus restoration may arrive last.
    await page.waitForFunction(() => !document.fullscreenElement)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(options).toBeFocused()
    assert.deepEqual(errors, [])
    console.log('PASS: real PDF Find, unmounted page 40 rendering, matching-page navigation, keyboard/focus, refresh reset, and narrow/hidden/fullscreen toolbar')
  } finally { await context.close() }
}
