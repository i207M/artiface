import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { expect } = require('@playwright/test')

async function checkObsoleteCacheCleanup({ page, origin }) {
  // A separate browser storage partition lets us seed the old cache before the
  // new worker's first activation without disturbing the tested workspace.
  const context = await page.context().browser().newContext()
  const probe = await context.newPage()
  try {
    await probe.goto(origin + '/favicon.svg')
    await probe.evaluate(async () => {
      await (await caches.open('artiface-shell-obsolete-fixture')).put('/obsolete-shell', new Response('old public shell'))
      await caches.open('unrelated-smoke-cache')
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      if (registration.active?.state === 'activated') return
      await navigator.serviceWorker.ready
    })
    await expect.poll(() => probe.evaluate(async () => (await caches.keys()).includes('artiface-shell-obsolete-fixture'))).toBe(false)
    const names = await probe.evaluate(() => caches.keys())
    assert(names.some(name => name.startsWith('artiface-shell-')), 'Worker did not cache the new shell')
    assert(names.includes('unrelated-smoke-cache'), 'Worker deleted an unrelated application cache')
  } finally {
    await context.close()
  }
}

export async function checkBrandCacheUpgrade({ page, origin }) {
  const context = await page.context().browser().newContext()
  const probe = await context.newPage()
  try {
    await probe.goto(origin)
    await expect.poll(() => probe.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 20_000 }).toBe(true)
    const expected = await (await context.request.get(origin + '/favicon.svg')).text()
    // An existing worker may still serve its fixed-path favicon after the app updates.
    await probe.evaluate(async () => {
      const name = (await caches.keys()).find(name => name.startsWith('artiface-shell-'))
      const cache = await caches.open(name)
      await cache.put('/favicon.svg', new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><title>Old cached logo</title><rect width="40" height="40" fill="#126556"/></svg>',
        { headers: { 'Content-Type': 'image/svg+xml' } },
      ))
    })
    await probe.reload({ waitUntil: 'domcontentloaded' })
    const image = probe.locator('.brand-mark')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
    const logoURL = await image.getAttribute('src')
    const faviconURL = await probe.locator('link[rel="icon"]').getAttribute('href')
    for (const [name, url] of [['App logo', logoURL], ['Browser favicon', faviconURL]]) {
      const artwork = await probe.evaluate(async url => (await fetch(url)).text(), url)
      assert.equal(artwork, expected, `${name} reused the stale favicon cache`)
    }
    const cached = await probe.evaluate(async url => (await caches.match(url))?.text(), logoURL)
    assert.equal(cached, expected, 'The current logo was not included in the offline shell')
  } finally {
    await context.close()
  }
  console.log('PASS: app logo and browser favicon bypass a stale fixed-path logo cache; current artwork is cached for offline use')
}

export async function checkPWA({ page, origin }) {
  const context = page.context()
  const previewOrigin = origin
  const previewWorker = await context.request.get(previewOrigin + '/p/sw.js')
  assert.equal(previewWorker.status(), 404, 'The preview namespace exposed the application service worker')
  assert.equal(previewWorker.headers()['cache-control'], 'no-store')
  assert.equal(await page.evaluate(async url => (await fetch(url, {
    method: 'HEAD', mode: 'cors', credentials: 'omit', cache: 'no-store',
  })).status, previewOrigin + '/p/healthz'), 204, 'Installed app cannot reach preview health on the app port')
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/')
    return registration?.active?.state || ''
  }), { timeout: 20_000 }).toBe('activated')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)

  const manifestResponse = await context.request.get(origin + '/manifest.webmanifest')
  assert.equal(manifestResponse.status(), 200)
  const manifest = await manifestResponse.json()
  assert.equal(manifest.name, 'Artiface')
  assert.equal(manifest.short_name, 'Artiface')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert(manifest.icons.some(icon => icon.sizes === '192x192'))
  assert(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'))
  for (const icon of manifest.icons) {
    const response = await context.request.get(new URL(icon.src, origin).href)
    assert.equal(response.status(), 200)
    const png = await response.body()
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    const size = Number(icon.sizes.split('x')[0])
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
  }
  const client = await context.newCDPSession(page)
  try {
    await client.send('Page.enable')
    const result = await client.send('Page.getInstallabilityErrors')
    assert.deepEqual(result.installabilityErrors, [], 'Browser reports an installation requirement is missing')
  } finally {
    await client.detach()
  }

  const cached = await page.evaluate(async () => {
    const paths = []
    for (const name of await caches.keys()) {
      if (!name.startsWith('artiface-shell-')) continue
      for (const request of await (await caches.open(name)).keys()) {
        const url = new URL(request.url)
        paths.push({ path: url.pathname, search: url.search, sameOrigin: url.origin === location.origin })
      }
    }
    return paths
  })
  assert(cached.some(item => item.path === '/index.html'), 'Application shell was not cached')
  assert(cached.some(item => item.path.startsWith('/assets/')), 'Application scripts were not cached')
  assert(cached.every(item => item.sameOrigin && !item.search && (
    ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'].includes(item.path) ||
    item.path.startsWith('/assets/') || item.path.startsWith('/icons/') || item.path.startsWith('/pdfjs/')
  )), 'A private or unexpected URL was stored in the service worker cache')
  await checkObsoleteCacheCleanup({ page, origin })
  await checkBrandCacheUpgrade({ page, origin })

  try {
    await context.setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(/You’re offline\. Reconnect to your server/)).toBeVisible()
    await expect.poll(() => page.locator('.brand-mark').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
    assert.equal(await page.getByRole('heading', { name: 'Experiment notes', exact: true }).count(), 0,
      'An artifact was unexpectedly restored from offline cache')
  } finally {
    const session = page.waitForResponse(response => response.url().endsWith('/api/session') && response.status() === 200)
    await context.setOffline(false)
    await session
    await expect(page.getByText(/You’re offline\. Reconnect to your server/)).toHaveCount(0)
  }
  await expect(page.locator('.workspace-shell')).toBeVisible()
  const workspace = await page.locator('.workspace-shell').elementHandle()
  let sessionChecks = 0
  const checked = request => { if (new URL(request.url()).pathname === '/api/session') sessionChecks++ }
  page.on('request', checked)
  try {
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('online'))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(sessionChecks, 0, 'Going online restarted an active workspace')
    assert(await workspace.evaluate(element => element.isConnected), 'Going online replaced the active workspace')
  } finally { page.off('request', checked); await workspace.dispose() }
  console.log('PASS: Artiface manifest/installability, shared-origin preview routes, offline shell/reconnection, stable active workspace, obsolete cache cleanup, and no cached private artifact/API responses')
}
