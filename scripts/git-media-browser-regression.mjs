import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the built app, its real PDF worker, and the production styles/CSP.
// Run npm run build --prefix web before this regression.
const web = fileURLToPath(new URL('../web/', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, webkit, expect } = require('@playwright/test')
const origin = 'http://git-media.invalid'
const artifacts = await mkdtemp(join(tmpdir(), 'artiface-git-media-'))
const hash = 'a'.repeat(40)
const hosts = [{ id: 'local', kind: 'local', label: 'Local', target: '', roots: [{ id: 'one', label: 'Research', path: '/research' }] }]
const projects = [{ host: 'local', root: 'one' }]
const version = bytes => ({ data: Buffer.from(bytes).toString('base64') })
const figure = (color, width) => version(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="240"><script>window.mediaExecuted=true</script><rect width="100%" height="100%" fill="${color}"/></svg>`)
function pdf(color) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    ...Array.from({ length: 3 }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 900] /Resources << >> /Contents 6 0 R >>'),
  ]
  const content = `${color} rg 0 0 600 900 re f\n`
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)
  let data = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(data.length)
    data += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = data.length
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  data += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return version(data + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}
const media = {
  'figure.svg': { type: 'image/svg+xml', before: figure('#cc331a', 300), after: figure('#1a664d', 480) },
  'figure.png': { type: 'image/png', before: null, after: { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } },
  'report.pdf': { type: 'application/pdf', before: pdf('0.8 0.2 0.1'), after: pdf('0.1 0.4 0.3') },
  'deleted.pdf': { type: 'application/pdf', before: pdf('0.8 0.2 0.1'), after: null },
  'bad.pdf': { type: 'application/pdf', before: null, after: version('not a PDF') },
  'bad.png': { type: 'image/png', before: null, after: version('<html>not an image</html>') },
}
const browser = await (process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(10000)
  await context.addInitScript(({ projects }) => {
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ gitStatus: true, pdfCompression: true, autoRefreshSeconds: 300 }))
    sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({ projects, tabs: [] }))
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    window.mediaURLs = new Set()
    URL.createObjectURL = object => { const url = create(object); window.mediaURLs.add(url); return url }
    URL.revokeObjectURL = url => { window.mediaURLs.delete(url); revoke(url) }
    window.cspViolations = []
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective))
  }, { projects })
  const errors = [], requests = []
  let oversized = false
  const assets = `${origin}/assets/`
  const csp = `default-src 'self'; script-src ${assets}; style-src ${assets} 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src ${assets} blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { errors.push(`External request: ${url.href}`); return route.abort() }
    const name = url.searchParams.get('path')
    if (!url.pathname.startsWith('/api/')) {
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (path.includes('..')) return route.abort()
      const body = await readFile(join(web, 'dist', path)).catch(() => null)
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' }[extname(path)] ?? 'application/octet-stream'
      return route.fulfill({ status: body ? 200 : 404, contentType: type, body: body ?? '', headers: { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' } })
    }
    requests.push(url.pathname + url.search)
    let body
    if (url.pathname === '/api/session') body = { authenticated: true, mode: 'personal', role: 'owner', csrfToken: 'fixture' }
    if (url.pathname === '/api/hosts') body = { revision: 'fixture', setupEnabled: false, hosts }
    if (url.pathname === '/api/workspace/projects') body = { projects, sourcesRevision: 'fixture' }
    if (url.pathname === '/api/list') body = { entries: [] }
    if (url.pathname === '/api/git/status') body = { state: 'ready', branch: 'main', changes: [], checkedAt: new Date().toISOString(), retryAt: new Date(Date.now() + 300000).toISOString() }
    if (url.pathname === '/api/git/history') body = { commits: [{ hash, parents: [], author: 'Author', email: 'author@invalid', date: '2026-10-15T00:00:00Z', message: 'Update figures', refs: [] }], hasMore: false, revision: 'a'.repeat(64), head: hash }
    if (url.pathname === '/api/git/commit') body = { hash, parents: [], author: 'Author', message: 'Update figures', files: Object.keys(media).map(path => ({ path, status: 'M' })), truncated: false }
    if (url.pathname === '/api/git/diff') {
      if (oversized) return route.fulfill({ status: 413, json: { error: 'Diff previews support file versions up to 8 MiB.' } })
      body = media[name] ? { media: media[name] } : { patch: '@@ -1 +1 @@\n-old\n+new\n', truncated: false }
    }
    if (!body) errors.push(`Unexpected API: ${url.pathname}`)
    return route.fulfill({ status: body ? 200 : 404, json: body ?? {} })
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const routeHash = (path, view = 'diff', commit = hash) => new URLSearchParams({ host: 'local', root: 'one', path, kind: 'file', view, ...(commit ? { commit } : {}) }).toString()
  const navigate = async (path, view = 'diff', commit = hash) => page.evaluate(hash => { window.location.hash = hash }, routeHash(path, view, commit))
  const viewer = page.locator('.reader-panel:not([hidden]) .git-diff-preview')
  const image = side => viewer.getByRole('region', { name: side, exact: side === 'Before' }).locator('img:not(.pending-preview)')
  const selectLayout = mode => viewer.getByRole('button', { name: mode === 'split' ? 'Side-by-side diff' : 'Inline diff', exact: true }).click()
  const rendered = async (pane, color) => {
    await expect.poll(async () => pane.locator('canvas').first().evaluate((canvas, color) => {
      if (!canvas.width || !canvas.height) return false
      const pixel = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
      return color.every((value, index) => Math.abs(value - pixel[index]) <= 1)
    }, color).catch(() => false)).toBe(true)
  }
  await page.goto(`${origin}/#${routeHash('', 'history', '')}`)
  await page.getByText('Update figures', { exact: true }).click()
  await page.getByRole('button', { name: /figure\.svg/ }).click()
  await expect(viewer.getByLabel('Visual file diff')).toHaveAttribute('data-layout', 'split')
  await expect(image('Before')).toHaveJSProperty('naturalWidth', 300)
  await expect(image(/After/)).toHaveJSProperty('naturalWidth', 480)
  const reads = requests.filter(url => url.startsWith('/api/git/diff')).length
  await selectLayout('inline')
  await expect(viewer.getByRole('region', { name: 'Before', exact: true })).toHaveCount(0)
  await expect(image(/After/)).toHaveJSProperty('naturalWidth', 480)
  await viewer.getByRole('combobox', { name: 'Image zoom' }).selectOption('1.5')
  await selectLayout('split')
  await expect(image('Before')).toBeVisible()
  assert.equal(requests.filter(url => url.startsWith('/api/git/diff')).length, reads, 'Changing layout refetched the diff')
  assert.equal(await page.evaluate(() => window.mediaExecuted), undefined, 'SVG script ran')
  await page.screenshot({ path: join(artifacts, 'images-side-by-side.png') })
  await navigate('report.pdf')
  await expect(viewer.locator('.git-media-version')).toHaveCount(2)
  await rendered(viewer.getByRole('region', { name: 'Before', exact: true }), [204, 51, 26])
  const after = viewer.getByRole('region', { name: /After/ })
  await rendered(after, [26, 102, 77])
  await after.getByRole('spinbutton', { name: /PDF page/ }).fill('3')
  await after.getByRole('spinbutton', { name: /PDF page/ }).press('Enter')
  await expect(after.getByRole('region', { name: 'PDF page 3 of 3' })).toBeVisible()
  await selectLayout('inline')
  await rendered(after, [26, 102, 77])
  await expect(after.getByRole('spinbutton')).toHaveValue('3')
  await selectLayout('split')
  await rendered(viewer.getByRole('region', { name: 'Before', exact: true }), [204, 51, 26])
  await page.screenshot({ path: join(artifacts, 'pdf-side-by-side.png') })
  await navigate('deleted.pdf')
  await selectLayout('inline')
  await expect(viewer).toContainText('File deleted.')
  await expect(viewer.locator('canvas')).toHaveCount(0)
  await selectLayout('split')
  await rendered(viewer.getByRole('region', { name: 'Before', exact: true }), [204, 51, 26])
  await navigate('figure.png', 'diff', '')
  await expect(image(/After/)).toHaveJSProperty('naturalWidth', 1)
  await expect(viewer).toContainText('This file did not exist before this change.')
  await navigate('bad.pdf')
  await expect(viewer.getByRole('alert')).toContainText('Couldn’t display this PDF')
  await navigate('bad.png')
  await expect(viewer.getByRole('alert')).toContainText('Couldn’t display this image')
  await navigate('figure.svg')
  oversized = true
  await viewer.getByRole('button', { name: 'Refresh diff', exact: true }).click()
  await expect(viewer.getByRole('alert')).toContainText('8 MiB')
  await expect(viewer.locator('img')).toHaveCount(0)
  oversized = false
  await viewer.getByRole('button', { name: 'Refresh diff', exact: true }).click()
  await expect(image(/After/)).toBeVisible()
  await page.setViewportSize({ width: 370, height: 800 })
  await selectLayout('inline')
  await expect(image(/After/)).toBeVisible()
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile preview overflowed the viewport')
  await navigate('report.pdf')
  await selectLayout('inline')
  await rendered(viewer.getByRole('region', { name: /After/ }), [26, 102, 77])
  await page.screenshot({ path: join(artifacts, 'pdf-mobile.png') })
  await navigate('notes.txt')
  await expect(viewer.getByLabel('File diff')).toContainText('new')
  assert(!requests.some(url => url.startsWith('/api/file') || url.startsWith('/api/pdf/')), 'Historical media fetched working-tree content or Compression')
  const close = page.getByRole('tablist', { name: 'Project tabs' }).locator('.tab-close')
  while (await close.count()) await close.first().click()
  await expect.poll(() => page.evaluate(() => window.mediaURLs.size)).toBe(0)
  assert.deepEqual(await page.evaluate(() => window.cspViolations), [])
  assert.deepEqual(errors, [])
  await context.close()
  console.log(`PASS: Built app image/PDF history diffs, real PDF rendering, new-only inline mode, deleted/added files, working tree, invalid media, size errors, mobile layout, text fallback, and CSP. Screenshots: ${artifacts}`)
} finally { await browser.close() }
