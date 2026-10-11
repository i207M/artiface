import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { expect } = require('@playwright/test')

// Reproduce missing Safari APIs in both the page and the real PDF worker.
// A modern worker can otherwise go unnoticed when the page alone is polyfilled.
export async function checkPDFCompatibility({ browser, origin, password, source }) {
  const context = await browser.newContext({
    viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 2, serviceWorkers: 'block',
  })
  context.setDefaultTimeout(30_000)
  const removeAPIs = `{
    const prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    for (const name of ['drop', 'every', 'filter', 'find', 'flatMap', 'forEach', 'map', 'reduce', 'some', 'take', 'toArray', 'join']) delete prototype[name];
    delete globalThis.Iterator;
    delete Promise.withResolvers;
    delete ArrayBuffer.prototype.transferToFixedLength;
  }`
  await context.addInitScript(removeAPIs)
  let workers = 0
  await context.route('**/assets/pdf.worker*.js', async route => {
    workers++
    const response = await route.fetch()
    await route.fulfill({ response, body: removeAPIs + '\n' + await response.text() })
  })
  const page = await context.newPage()
  const errors = []
  const pdfWorkers = []
  page.on('worker', worker => pdfWorkers.push(worker))
  page.on('pageerror', error => errors.push(error.message))
  const login = await context.request.post(origin + '/api/login', {
    data: { password }, headers: { Origin: origin },
  })
  assert.equal(login.status(), 200)
  try {
    await page.goto(origin + '/#' + new URLSearchParams({ ...source, kind: 'file' }))
    const ready = async () => {
      await expect(page.locator('.pdf-canvas-area')).toHaveAttribute('aria-busy', 'false')
      await expect(page.locator('.pdf-text-layer').first()).not.toBeEmpty()
      const appearance = await page.locator('.pdf-paper canvas').first().evaluate(canvas => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        let ink = false, stampPixels = 0
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] < 180 && pixels[i + 3] > 0) ink = true
          if (pixels[i] > 200 && pixels[i + 1] < 80 && pixels[i + 2] < 80 && pixels[i + 3] > 0) stampPixels++
        }
        return { ink, stampPixels }
      })
      assert(appearance.ink, 'Compatibility viewer rendered a blank page')
      assert(appearance.stampPixels > 500, 'PDF reader omitted the saved annotation appearance')
    }
    await ready()
    assert(workers > 0, 'Missing APIs were not exercised in the PDF worker')
    const checkAPIs = async () => {
      const { promise, resolve } = Promise.withResolvers()
      const buffer = new ArrayBuffer(4)
      const resized = buffer.transferToFixedLength(8)
      resolve(buffer.byteLength === 0 && resized.byteLength === 8 && typeof Iterator === 'function')
      return promise
    }
    assert(await page.evaluate(checkAPIs), 'Page compatibility APIs are incomplete')
    assert(pdfWorkers.length > 0, 'PDF rendering fell back to the main thread')
    assert(await pdfWorkers[0].evaluate(checkAPIs), 'Worker compatibility APIs are incomplete')
    await page.getByRole('button', { name: 'Reader options', exact: true }).click()
    await page.getByRole('button', { name: 'Rotate page clockwise', exact: true }).click()
    await ready()
    await page.keyboard.press('Escape')
    await page.reload()
    await ready()
    await page.addInitScript(() => {
      globalThis.Worker = class { constructor() { throw new Error('Worker unavailable in this test') } }
    })
    await page.reload()
    await ready()
    assert.deepEqual(errors, [])
    console.log('PASS: PDF canvas/text/annotation appearances, real worker and fallback, rotation, and reload without native Iterator, Promise.withResolvers, or ArrayBuffer transfer')
  } finally { await context.close() }
}
