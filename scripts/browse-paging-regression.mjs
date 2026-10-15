import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const engine = process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium
const artifacts = await mkdtemp(join(tmpdir(), 'artiface-browse-paging-'))
const entry = join(repository, 'web/src/__browse_paging_fixture__.tsx')
const logo = await readFile(join(repository, 'web/public/favicon.svg'), 'utf8')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'isolated-browse-paging',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css')) return '\0fixture-css'
      if (id.includes('.svg?')) return '\0fixture-logo'
      if (id === './FilePreview' || id === './GitPDFPreview') return '\0fixture-reader'
    },
    async load(id) {
      if (id === '\0fixture-css') return 'export default ""'
      if (id === '\0fixture-logo') return `export default ${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(logo)}`)}`
      if (id === '\0fixture-reader') return 'export default function Reader(){return "Synthetic reader"}'
      if (id === join(repository, 'web/src/components/FileList.tsx')) {
        const source = await readFile(id, 'utf8')
        const marker = '  const results = useRef<HTMLDivElement>(null)'
        assert(source.includes(marker), 'Update the FileList render spy for the current component')
        return source.replace(marker, `  window.fixtureFileListRenders = (window.fixtureFileListRenders || 0) + 1\n${marker}`)
      }
      if (id === join(repository, 'web/src/components/fileTypes.ts')) {
        const source = await readFile(id, 'utf8')
        const signature = 'export function sortEntries(entries: Entry[], sort: FileSort, flat = false) {'
        assert(source.includes(signature), 'Update the fixture sort spy for the current function signature')
        return source.replace(signature, `${signature}\nglobalThis.fixtureSortCalls = (globalThis.fixtureSortCalls || 0) + 1;`)
      }
      if (id === entry) return `
        import {createRoot} from 'react-dom/client'
        import Workspace from './components/Workspace'
        import {useLocation} from './location'
        import {setPreferences} from './preferences'
        import {sortEntries, entryTypeLabel} from './components/fileTypes'
        window.fixturePreferences = setPreferences
        window.fixtureSort = sortEntries
        window.fixtureTypeLabel = entryTypeLabel
        function Fixture() {
          const [location, navigate] = useLocation()
          return <Workspace location={location} navigate={navigate} onLogout={() => {}}/>
        }
        createRoot(document.getElementById('root')).render(<Fixture/>)
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'components/workspace.css', 'components/settings.css']
  .map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://browse-paging-fixture.invalid'
const host = { id: 'fixture', kind: 'local', target: '', label: 'Fixture machine',
  roots: [{ id: 'reports', label: 'Paging fixture', path: '/synthetic/reports' }, { id: 'other', label: 'Second fixture', path: '/synthetic/other' }] }
const projectRefs = host.roots.map(root => ({ host: host.id, root: root.id }))
let count = 10_000
let requests = 0
let holdNextListing = false
let nextListingStatus = 0
let releaseListing = null
let customEntries = null
const observations = []
const headerLayouts = []
const errors = []
const browser = await engine.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, serviceWorkers: 'block' })
  context.setDefaultTimeout(10_000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.addInitScript(({ projects, origin }) => {
    // The initial about:blank page has no origin and cannot use web storage.
    if (location.origin !== origin) return
    // Network completion alone does not mean Browse has consumed its JSON.
    const fetch = window.fetch.bind(window)
    window.fixtureListingLoads = []
    window.fetch = async (...args) => {
      if (new URL(String(args[0]), location.href).pathname !== '/api/list') return fetch(...args)
      const load = { settled: false }
      window.fixtureListingLoads.push(load)
      try {
        const response = await fetch(...args)
        const json = response.json.bind(response)
        response.json = async () => {
          try { return await json() } finally { load.settled = true }
        }
        return response
      } catch (error) {
        load.settled = true
        throw error
      }
    }
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300, gitStatus: false }))
    sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({
      projects: projects.map(project => ({ ...project, directory: 'reports', activePath: null, expanded: true })), tabs: [],
    }))
  }, { projects: projectRefs, origin })
  const page = await context.newPage()
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    let body
    let status = 200
    if (url.pathname === '/api/hosts') body = { hosts: [host], setupEnabled: true, revision: 'fixture' }
    else if (url.pathname === '/api/workspace/projects') body = { projects: projectRefs, sourcesRevision: 'fixture' }
    else if (url.pathname === '/api/list') {
      requests++
      const path = url.searchParams.get('path')
      const size = url.searchParams.get('root') === 'other' ? 600 : path === 'archive' ? 500 : count
      body = { entries: path === '' ? ['reports', 'archive'].map(name => ({ name, path: name, type: 'directory', size: 0, modified: '2026-09-21T12:00:00Z' }))
        : customEntries ?? Array.from({ length: size }, (_, index) => ({
          name: `file-${index}.txt`, path: `${path}/file-${index}.txt`, type: 'file', size: index + 1, modified: '2026-09-21T12:00:00Z',
        })) }
      if (nextListingStatus) { status = nextListingStatus; nextListingStatus = 0; body = { error: 'Synthetic listing failure' } }
      // Exercise restoration after the new folder's loading state, not just a synchronous response.
      if (holdNextListing) {
        holdNextListing = false
        await new Promise(resolve => { releaseListing = resolve })
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    } else if (url.pathname === '/api/file-info') body = { modified: '2026-09-21T12:00:00Z', size: 100 }
    return route.fulfill({ status: body ? status : 404, contentType: 'application/json', body: JSON.stringify(body ?? { error: 'Unknown synthetic route' }) })
  })
  // Establish the second project's remembered folder through normal navigation.
  await page.goto(`${origin}/#host=fixture&root=other&path=reports&kind=directory`)
  await expect(page.locator('.file-table tbody tr')).toHaveCount(200)
  await page.goto(`${origin}/#host=fixture&root=reports&path=reports&kind=directory`)
  const rows = page.locator('.file-table tbody tr')
  const pager = page.getByRole('navigation', { name: 'File pages', exact: true })
  const footer = page.getByRole('navigation', { name: 'File pages footer', exact: true })
  const pageSelect = page.getByRole('combobox', { name: 'File page', exact: true })
  const footerSelect = footer.getByRole('combobox', { name: 'File page at end of list', exact: true })
  const content = page.locator('.project-content')
  const search = page.getByRole('textbox', { name: 'Search directory', exact: true })
  const doneFiltering = page.getByRole('button', { name: 'Done filtering', exact: true })
  const settle = () => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  })
  const pageNumber = () => pageSelect.inputValue()
  const choosePage = async number => {
    await pageSelect.selectOption(String(number))
    await settle()
    assert.equal(await pageNumber(), String(number))
  }
  const setScroll = async top => { await content.evaluate((element, top) => { element.scrollTop = top }, top); await settle() }
  const scrollTop = () => content.evaluate(element => element.scrollTop)
  const poll = async () => {
    await settle()
    const previous = requests
    // Wait for an existing load before emitting exactly one visibility event.
    // An event during a load is deliberately coalesced by the application.
    const started = await page.waitForFunction(() => {
      const loads = window.fixtureListingLoads
      if (loads.some(load => !load.settled)) return false
      const before = loads.length
      document.dispatchEvent(new Event('visibilitychange'))
      if (loads.length !== before + 1) throw new Error('Idle Browse did not start its visibility refresh')
      return loads.length
    })
    const number = await started.jsonValue()
    await started.dispose()
    await page.waitForFunction(number => window.fixtureListingLoads[number - 1]?.settled, number)
    await expect.poll(() => requests).toBeGreaterThan(previous)
    await settle()
  }
  const bounded = async (view, expected = 200) => {
    const entries = page.locator(view === 'list' ? '.file-table tbody tr' : '.file-grid > li')
    await expect(entries).toHaveCount(expected)
    assert(await entries.count() <= 200)
    observations.push({ view, entries: await entries.count(), elements: await page.getByRole('region', { name: 'Directory results', exact: true }).locator('*').count(),
      tableElements: view === 'list' ? await page.locator('.file-table *').count() : undefined })
  }
  await bounded('list')
  await expect(pager.getByRole('status')).toHaveText('1–200 of 10,000')
  await expect(rows.first()).toContainText('file-0.txt')
  await expect(rows.last()).toContainText('file-199.txt')
  const sortedBeforePoll = await page.evaluate(() => window.fixtureSortCalls)
  await poll()
  assert.equal(await page.evaluate(() => window.fixtureSortCalls), sortedBeforePoll, 'An unchanged listing was sorted again')

  const ordering = await page.evaluate(() => {
    const entries = ['a2.txt', 'A2.txt', 'a02.txt', 'a10.txt', 'á2.txt', 'Z.md', 'x.pdf', 'folder10', 'folder2'].map((name, index) => ({
      name, path: `${index % 2 ? 'right' : 'left'}/${name}`, type: name.startsWith('folder') ? 'directory' : 'file',
      size: index % 3, modified: index % 2 ? 'invalid' : '2026-09-21T12:00:00Z',
    }))
    const results = []
    for (const flat of [false, true]) for (const column of ['name', 'type', 'size', 'modified']) for (const direction of ['asc', 'desc']) {
      const name = (a, b) => (flat ? a.path : a.name).localeCompare(flat ? b.path : b.name, undefined, { numeric: true, sensitivity: 'base' })
      const expected = [...entries].sort((a, b) => {
        if ((a.type === 'directory') !== (b.type === 'directory')) return a.type === 'directory' ? -1 : 1
        const value = column === 'name' ? name(a, b) : column === 'type' ? window.fixtureTypeLabel(a).localeCompare(window.fixtureTypeLabel(b))
          : column === 'size' ? a.size - b.size : (Date.parse(a.modified) || 0) - (Date.parse(b.modified) || 0)
        return (value || name(a, b)) * (direction === 'asc' ? 1 : -1)
      })
      results.push({ expected: expected.map(entry => entry.path), actual: window.fixtureSort(entries, { column, direction }, flat).map(entry => entry.path) })
    }
    return results
  })
  for (const result of ordering) assert.deepEqual(result.actual, result.expected)
  await settle()
  const sorts = await page.evaluate(() => window.fixtureSortCalls)
  await choosePage(49)
  await search.pressSequentially('FILE-9999')
  await bounded('list', 1)
  await expect(rows.first()).toContainText('file-9999.txt')
  await expect(search).toBeFocused()
  assert.equal(await page.evaluate(() => window.fixtureSortCalls), sorts, 'Paging or filter typing repeated sorting')
  await search.press('Tab')
  await expect(page.getByRole('button', { name: 'Clear directory search', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('')
  await expect(pager.getByRole('combobox', { name: 'File page' })).toHaveValue('0')
  await bounded('list')
  await search.press('Enter')
  await expect(search).toBeFocused()
  await expect(doneFiltering).toBeHidden()
  await expect(search).not.toHaveAttribute('enterkeyhint')
  await search.press('Shift+Tab')
  await expect(page.getByRole('button', { name: 'Refresh files', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'File type filters', exact: true })).toBeVisible()
  console.log('PASS 10,000 entries bounded; natural/stable ordering preserved; filtering searches all pages without sorting again')

  await choosePage(2)
  await setScroll(650)
  const beforeReader = await scrollTop()
  const visibleName = await rows.evaluateAll(entries => entries.find(entry => {
    const box = entry.getBoundingClientRect()
    return box.top > 180 && box.bottom < innerHeight - 80
  }).querySelector('a').textContent)
  await page.getByRole('link', { name: visibleName, exact: true }).click()
  await expect(page.locator('#reader-panel')).toBeVisible()
  await page.getByRole('tab', { name: 'Browse', exact: true }).click()
  await bounded('list')
  await settle()
  assert.equal(await pageNumber(), '2')
  assert(Math.abs(await scrollTop() - beforeReader) <= 1, 'Reader round trip lost Browse scroll')
  const visibleLink = page.getByRole('link', { name: visibleName, exact: true })
  await visibleLink.click({ modifiers: ['Control'] })
  assert.equal(await pageNumber(), '2')
  assert(Math.abs(await scrollTop() - beforeReader) <= 1, 'Background opening moved Browse')

  await page.getByRole('button', { name: 'Open project Second fixture on Fixture machine', exact: true }).click()
  await bounded('list')
  await choosePage(1)
  await setScroll(280)
  await page.getByRole('button', { name: 'Open project Paging fixture on Fixture machine', exact: true }).click()
  await bounded('list')
  await settle()
  assert.equal(await pageNumber(), '2')
  assert(Math.abs(await scrollTop() - beforeReader) <= 1, 'Project round trip lost Browse scroll')
  // Activate without Playwright first scrolling the nonsticky breadcrumb into view.
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Paging fixture', exact: true }).evaluate(button => button.click())
  await bounded('list', 2)
  await page.getByRole('link', { name: 'archive', exact: true }).click()
  await bounded('list')
  await choosePage(1)
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Paging fixture', exact: true }).click()
  await page.getByRole('link', { name: 'reports', exact: true }).click()
  await bounded('list')
  await settle()
  assert.equal(await pageNumber(), '2')
  assert(Math.abs(await scrollTop() - beforeReader) <= 1, 'Folder round trip lost Browse scroll')
  console.log('PASS reader, background opening, project, and folder round trips retain paging/scroll')

  count = 995
  await poll()
  assert.equal(await pageNumber(), '2')
  assert(Math.abs(await scrollTop() - beforeReader) <= 1, 'Same-page refresh moved scroll')
  await choosePage(4)
  count = 450
  await poll()
  await bounded('list', 50)
  assert.equal(await pageNumber(), '2', 'Refresh did not clamp the last page')
  assert.equal(await scrollTop(), 0)
  for (const size of [0, 199, 200, 201]) {
    count = size
    await poll()
    await bounded('list', Math.min(size, 200))
    await expect(pager).toHaveCount(size > 200 ? 1 : 0)
  }
  await pager.getByRole('button', { name: 'Next page', exact: true }).focus()
  await page.keyboard.press('Enter')
  await bounded('list', 1)
  await expect(pager.getByRole('combobox', { name: 'File page' })).toBeFocused()
  await footerSelect.focus()
  count = 199
  await poll()
  await expect(pager).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Directory results', exact: true })).toBeFocused()
  count = 1000
  await poll()
  assert.equal(await pageNumber(), '0', 'A later refresh resurrected an invalid page')
  console.log('PASS 0/199/200/201 boundaries, background clamp, scroll stability, and focus when pagination disappears')

  for (const patch of [
    { showHidden: true }, { flatBrowse: true },
    { folderReaderTypes: { [JSON.stringify(['fixture', 'reports', 'reports'])]: ['text'] } },
    { browseSort: { column: 'size', direction: 'desc' } },
  ]) {
    await choosePage(2)
    await page.evaluate(patch => window.fixturePreferences(patch), patch)
    await bounded('list')
    await settle()
    assert.equal(await pageNumber(), '0', 'Browse criteria did not reset pagination')
  }
  await expect(rows.first()).toContainText('file-999.txt')
  await choosePage(2)
  await page.evaluate(() => window.fixturePreferences({ defaultBrowseSort: { column: 'name', direction: 'asc' } }))
  assert.equal(await pageNumber(), '2', 'An unused default sort reset the current override')
  await page.evaluate(() => window.fixturePreferences({ browseSort: null, showHidden: false, flatBrowse: false, folderReaderTypes: {} }))
  await bounded('list')
  await expect(rows.first()).toContainText('file-0.txt')
  assert.equal(await pageNumber(), '0')

  customEntries = [
    { name: '.hidden.txt', path: 'reports/.hidden.txt' }, { name: 'deep.txt', path: 'reports/.hidden/deep.txt' },
    { name: 'shown.txt', path: 'reports/sub/shown.txt' }, { name: 'plot.pdf', path: 'reports/sub/plot.pdf' },
  ].map(entry => ({ ...entry, type: 'file', size: 10, modified: '2026-09-21T12:00:00Z' }))
  await page.evaluate(() => window.fixturePreferences({ flatBrowse: true }))
  await poll()
  await bounded('list', 2)
  await expect(rows.first()).toContainText('sub/plot.pdf')
  await search.fill('sub/shown')
  await bounded('list', 1)
  await expect(rows.first()).toContainText('sub/shown.txt')
  await search.fill('')
  customEntries = null
  count = 10_000
  holdNextListing = true
  await page.evaluate(() => window.fixturePreferences({ flatBrowse: false }))
  await expect.poll(() => releaseListing !== null).toBe(true)
  const beforeRelease = requests
  const waitingPoll = poll()
  // Let the poll helper enter while the setting's own request is still held.
  await page.evaluate(() => Promise.resolve())
  assert.equal(requests, beforeRelease, 'A busy Browse started another listing request')
  releaseListing()
  releaseListing = null
  await waitingPoll
  assert.equal(requests, beforeRelease + 1, 'Visibility refresh did not run once after the setting reload')
  await bounded('list')
  console.log('PASS visibility refresh waits for an in-flight setting reload and consumes its own response')
  console.log('PASS reset rules, default-sort fallback, flat-path search, and nested hidden-file filtering')

  await choosePage(2)
  await setScroll(650)
  const anchor = await rows.evaluateAll(entries => entries.find(entry => entry.getBoundingClientRect().bottom > document.querySelector('.project-content').getBoundingClientRect().top).dataset.browseEntry)
  await page.getByRole('button', { name: 'Icon view', exact: true }).evaluate(button => button.click())
  await bounded('icons')
  assert.equal(await pageNumber(), '2')
  const gridAnchor = page.locator(`.file-grid > [data-browse-entry="${anchor}"]`)
  await expect(gridAnchor).toBeInViewport()
  await footer.getByRole('button', { name: 'Next page at end of list', exact: true }).click()
  await settle()
  assert.equal(await pageNumber(), '3')
  assert.equal(await scrollTop(), 0)
  await expect(pager.getByRole('button', { name: 'Next page', exact: true })).toBeFocused()
  console.log('PASS icon-view anchor and footer navigation returning focus to the top pager')

  const checkPhoneHeader = async scenario => {
    const layout = await page.evaluate(() => {
      const rect = selector => {
        const element = document.querySelector(selector)
        const box = element.getBoundingClientRect()
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right,
          width: box.width, height: box.height, overflow: element.scrollWidth - element.clientWidth }
      }
      const location = rect('.browse-location-row'), controls = rect('.browse-controls-row')
      const pageJump = document.querySelector('.browse-page-jump')
      const intrinsicJump = pageJump.cloneNode(true)
      intrinsicJump.style.cssText = 'position:fixed;visibility:hidden;max-width:none;width:auto'
      document.body.appendChild(intrinsicJump)
      const intrinsicJumpWidth = intrinsicJump.getBoundingClientRect().width
      intrinsicJump.remove()
      const buttons = [...document.querySelectorAll('.browse-location-row > button,.browse-location-row > select,.browse-controls-row button,.browse-controls-row input')]
        .filter(element => element.getClientRects().length)
        .map(element => {
          const box = element.getBoundingClientRect()
          return { name: element.getAttribute('aria-label'), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }
        })
      return { viewport: innerWidth, topline: rect('.project-topline'), toolbar: rect('.browse-toolbar'), location, controls,
        pageJump: rect('.browse-page-jump'), intrinsicJumpWidth, breadcrumb: rect('.breadcrumbs'), currentBreadcrumb: rect('.breadcrumbs [aria-current="page"]'),
        files: rect('.browse-files'), entry: rect('[data-browse-entry]'), search: rect('.browse-search input'), buttons,
        searchFocused: document.querySelector('.browse-search').matches(':focus-within'),
        contentOverflow: document.querySelector('.project-content').scrollWidth - document.querySelector('.project-content').clientWidth }
    })
    headerLayouts.push({ scenario, ...layout })
    assert(layout.location.overflow <= 1 && layout.controls.overflow <= 1 && layout.contentOverflow <= 1,
      `${scenario}: header/content overflow: ${JSON.stringify(layout)}`)
    assert(layout.toolbar.height <= layout.location.height + layout.controls.height + 14, `${scenario}: extra Browse toolbar layer`)
    assert(layout.location.top >= layout.topline.bottom && layout.controls.top >= layout.location.bottom,
      `${scenario}: Browse rows overlap`)
    assert(layout.entry.top <= layout.toolbar.bottom + 14, `${scenario}: pagination adds a mobile header layer`)
    assert(layout.pageJump.width >= layout.intrinsicJumpWidth - 1, `${scenario}: native page label is constrained: ${layout.pageJump.width}px, needs ${layout.intrinsicJumpWidth}px`)
    assert(layout.breadcrumb.width >= layout.currentBreadcrumb.width - 1, `${scenario}: page jump crowds the current breadcrumb`)
    for (const button of layout.buttons) {
      assert(button.left >= 0 && button.right <= layout.viewport + 1 && button.width >= 16,
        `${scenario}: clipped control: ${JSON.stringify(button)}`)
    }
    assert(layout.search.width >= (layout.searchFocused ? 180 : 24), `${scenario}: search input collapsed: ${layout.search.width}`)
    if (layout.searchFocused) {
      await expect(doneFiltering).toBeVisible()
      await expect(page.getByRole('button', { name: 'File type filters', exact: true })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Browse settings', exact: true })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Sort files', exact: true })).toBeHidden()
      await expect(page.locator('.browse-view-toggle')).toBeHidden()
    }
    await expect(pager).toHaveCount(0)
    await expect(page.locator('.browse-grid-sort')).toHaveCount(0)
    await expect(pageSelect).toHaveCount(1)
    await expect(pageSelect).toHaveAttribute('aria-describedby', 'browse-page-description')
    await expect(pageSelect).toHaveAttribute('title', /of 50; .* of 10,000 entries/)
    await expect(page.locator('#browse-page-description')).toHaveText(/of 10,000 entries/)
    const scrollable = await page.locator('.breadcrumbs').evaluate(element => {
      const overflows = element.scrollWidth > element.clientWidth
      element.scrollLeft = element.scrollWidth
      return { overflows, moved: element.scrollLeft > 0 }
    })
    if (scrollable.overflows) assert(scrollable.moved, `${scenario}: breadcrumb cannot scroll`)
  }
  const checkPhoneSearch = async scenario => {
    const results = page.getByRole('region', { name: 'Directory results', exact: true })
    const clear = page.getByRole('button', { name: 'Clear directory search', exact: true })
    const types = page.getByRole('button', { name: 'File type filters', exact: true })
    const refresh = page.getByRole('button', { name: 'Refresh files', exact: true })
    await search.fill('file-9999')
    await bounded('list', 1)
    await expect(rows.first()).toContainText('file-9999.txt')
    await expect(search).toBeFocused()
    await expect(search).toHaveAttribute('enterkeyhint', 'done')
    await expect(doneFiltering).toBeVisible()
    const layout = await page.locator('.browse-controls-row').evaluate(element => ({
      width: element.clientWidth, overflow: element.scrollWidth - element.clientWidth,
      searchWidth: element.querySelector('input').getBoundingClientRect().width,
      searchContainerWidth: element.querySelector('.browse-search').getBoundingClientRect().width,
    }))
    assert(layout.searchWidth >= 180 && layout.overflow <= 1, `${scenario}: focused search is cramped or overflows: ${JSON.stringify(layout)}`)
    assert(Math.abs(layout.width - layout.searchContainerWidth) <= 1, `${scenario}: focused search does not fill its row`)
    headerLayouts.push({ scenario: `${scenario}-focused-filter`, ...layout })
    await page.screenshot({ path: join(artifacts, `${scenario}-focused-filter.png`) })
    for (const action of ['Done', 'Enter', 'Escape']) {
      await search.focus()
      if (action === 'Done') await doneFiltering.click()
      else await search.press(action)
      await expect(results).toBeFocused()
      await expect(search).toHaveValue('file-9999')
      await expect(rows).toHaveCount(1)
      await expect(types).toBeVisible()
      await expect(doneFiltering).toBeHidden()
    }
    await search.focus()
    await search.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await expect(search).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(clear).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(search).toHaveValue('')
    await expect(search).toBeFocused()
    await expect(doneFiltering).toBeVisible()
    await bounded('list')
    await page.keyboard.press('Shift+Tab')
    await expect(doneFiltering).toBeFocused()
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 768, height: viewport.height })
    await expect(doneFiltering).toBeHidden()
    await expect(search).toBeFocused()
    await page.setViewportSize({ width: viewport.width, height: 400 })
    await expect(search).toBeFocused()
    await expect(doneFiltering).toBeVisible()
    const keyboardBounds = await search.boundingBox()
    assert(keyboardBounds.y >= 0 && keyboardBounds.y + keyboardBounds.height <= 400, `${scenario}: search outside reduced viewport`)
    await search.press('Enter')
    await expect(results).toBeFocused()
    await page.setViewportSize(viewport)
    await search.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    await expect(results).toBeFocused()
    for (const [name, panel] of [
      ['File type filters', '.file-filter-panel'], ['Browse settings', '.browse-settings-panel'], ['Sort files', '.browse-sort-panel'],
    ]) {
      const trigger = page.getByRole('button', { name, exact: true })
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator(panel)).toBeVisible()
      // Shift+Tab from Types must enter search without leaving a hidden popup open.
      if (name === 'File type filters') await page.keyboard.press('Shift+Tab')
      else await search.focus()
      await expect(search).toBeFocused()
      await expect(page.locator(panel)).toHaveCount(0)
      await doneFiltering.click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator(panel)).toHaveCount(0)
    }
    await search.fill('file-9999')
    await refresh.focus()
    await expect(refresh).toBeFocused()
    await expect(types).toBeVisible()
    await expect(search).toHaveValue('file-9999')
    await search.fill('no-such-file')
    await expect(page.getByRole('heading', { name: 'No matching files', exact: true })).toBeVisible()
    await search.press('Escape')
    await expect(page.locator('#main-content')).toBeFocused()
    await expect(search).toHaveValue('no-such-file')
    await search.fill('')
    await doneFiltering.click()
    await bounded('list')
    console.log(`PASS ${scenario}: full-row search, retained filtering, Done/Enter/Escape/clear focus, popup dismissal and blur`)
  }
  for (const width of [320, 390, 768, 820]) for (const density of ['compact', 'comfortable']) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(density => window.fixturePreferences({ density, fontScale: 1.4 }), density)
    for (const view of ['list', 'icons']) {
      await page.evaluate(view => window.fixturePreferences({ browseView: view }), view)
      await bounded(view)
      await choosePage(width <= 700 ? 49 : 6)
      await setScroll(0)
      if (width <= 700) {
        await checkPhoneHeader(`${width}-${density}-${view}-empty-search`)
        await search.fill('file-')
        await settle()
        await checkPhoneHeader(`${width}-${density}-${view}-typed-search`)
        await page.getByRole('button', { name: 'Clear directory search', exact: true }).click()
        if (view === 'list') await checkPhoneSearch(`${width}-${density}`)
        await choosePage(6)
        const previous = Number(await pageNumber())
        await footer.getByRole('button', { name: 'Next page at end of list', exact: true }).click()
        await settle()
        await expect(pageSelect).toBeFocused()
        assert.equal(Number(await pageNumber()), previous + 1)
        assert.equal(await scrollTop(), 0, 'Phone footer did not return to the breadcrumb page selector')
        await footerSelect.focus()
        await page.keyboard.press('ArrowDown')
        await settle()
        await expect(pageSelect).toBeFocused()
        assert.equal(Number(await pageNumber()), previous + 2)
      } else {
        const layout = await pager.evaluate(element => {
          const box = element.getBoundingClientRect()
          return { left: box.left, right: box.right, width: innerWidth, overflow: element.scrollWidth - element.clientWidth }
        })
        assert(layout.left >= 0 && layout.right <= layout.width + 1 && layout.overflow <= 1, `Pager overflow at ${width}/${density}/${view}`)
      }
      await pageSelect.focus()
      await page.keyboard.press('ArrowDown')
      await settle()
      await expect(pageSelect).toBeFocused()
      await expect(page.locator('.browse-entry-count')).toHaveCount(0)
      await choosePage(6)
      if ([320, 390, 768].includes(width)) {
        await page.screenshot({ path: join(artifacts, `${width}-${density}-${view}.png`) })
      }
    }
    console.log(`PASS ${width}px/${density}/140% text: bounded list/icons, visible controls, page focus and counts`)
  }
  await page.setViewportSize({ width: 320, height: 900 })
  await pageSelect.focus()
  count = 199
  await poll()
  await bounded('icons', 199)
  await expect(pageSelect).toHaveCount(0)
  await expect(footer).toHaveCount(0)
  await expect(page.locator('.browse-entry-count')).toHaveText('199 entries')
  await expect(page.getByRole('region', { name: 'Directory results', exact: true })).toBeFocused()
  const smallHeader = await page.locator('.browse-location-row').evaluate(element => element.scrollWidth - element.clientWidth)
  assert(smallHeader <= 1, 'Small-list count overflowed the phone breadcrumb row')
  count = 10_000
  await poll()
  await pageSelect.focus()
  await page.setViewportSize({ width: 768, height: 900 })
  await settle()
  await expect(pager.getByRole('combobox', { name: 'File page', exact: true })).toBeFocused()
  await page.setViewportSize({ width: 390, height: 900 })
  await settle()
  await expect(page.locator('.browse-page-jump')).toBeFocused()
  console.log('PASS mobile jump removal and focus transfer across phone/tablet layouts')
  await page.evaluate(() => window.fixturePreferences({ browseView: 'list', density: 'compact', fontScale: 1 }))
  await bounded('list')
  await choosePage(0)
  await setScroll(0)
  const touchRow = page.locator('.file-table tbody tr').first()
  const destination = await touchRow.locator('a').getAttribute('href')
  const metadata = await touchRow.locator('.table-modified').boundingBox()
  assert(metadata && metadata.width > 0 && metadata.height > 0, 'Mobile file metadata is not visible')
  await page.touchscreen.tap(metadata.x + metadata.width / 2, metadata.y + metadata.height / 2)
  await expect.poll(() => new URL(page.url()).hash).toBe(destination)
  await page.getByRole('tab', { name: 'Browse', exact: true }).click()
  await bounded('list')
  console.log('PASS tapping mobile file metadata opens the correct file and returns to Browse')

  const nativePreferences = await page.evaluate(() => JSON.parse(localStorage.getItem('artiface.preferences.v1')))
  await page.setViewportSize({ width: 820, height: 900 })
  await page.evaluate(() => window.fixturePreferences({ density: 'comfortable', fontScale: 1, sidebarVisible: true, sidebarWidth: 260, browseView: 'icons' }))
  const nativeSort = page.getByRole('combobox', { name: 'Sort files', exact: true })
  for (const [column, direction, shortLabel, fullLabel] of [
    ['name', 'asc', 'Name A–Z', 'Name · A–Z'], ['name', 'desc', 'Name Z–A', 'Name · Z–A'],
    ['type', 'asc', 'Type A–Z', 'Type · A–Z'], ['type', 'desc', 'Type Z–A', 'Type · Z–A'],
    ['size', 'asc', 'Smallest first', 'Size · Smallest first'], ['size', 'desc', 'Largest first', 'Size · Largest first'],
    ['modified', 'asc', 'Oldest first', 'Modified · Oldest first'], ['modified', 'desc', 'Newest first', 'Modified · Newest first'],
  ]) {
    await page.evaluate(({ column, direction }) => window.fixturePreferences({ defaultBrowseSort: { column, direction }, browseSort: null }), { column, direction })
    await choosePage(49)
    await expect(nativeSort).toHaveValue('default')
    await expect(nativeSort.locator('option:checked')).toHaveText(`Default: ${shortLabel}`)
    await expect(nativeSort.locator('option:checked')).toHaveAccessibleName(`Default: ${fullLabel}`)
    await expect(footer.locator('.browse-page-range')).toHaveText('10,000 entries')
    await expect(pager.getByRole('status')).toHaveText('9,801–10,000 of 10,000')
    const layout = await pager.evaluate(element => {
      const children = [...element.children].map(child => child.getBoundingClientRect())
      return { centers: children.map(box => box.top + box.height / 2),
        fonts: [...element.querySelectorAll('select')].map(select => Number.parseFloat(getComputedStyle(select).fontSize)) }
    })
    assert(layout.fonts.every(font => font >= 16), 'Coarse-pointer page/sort fields must retain the 16px minimum')
    assert(Math.max(...layout.centers) - Math.min(...layout.centers) <= 1, `Default ${shortLabel} added a pagination row`)
    await nativeSort.selectOption(`${column}:${direction}`)
    await expect(nativeSort.locator('option:checked')).toHaveAccessibleName(fullLabel)
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('artiface.preferences.v1')).browseSort), { column, direction })
  }
  await page.evaluate(preferences => window.fixturePreferences(preferences), nativePreferences)
  console.log('PASS all eight meaningful default sort labels fit beside 16px paging fields; accessible names, native values, and footer totals preserved')

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const folder = JSON.stringify(['fixture', 'reports', 'reports'])
    const otherFolder = JSON.stringify(['fixture', 'other', 'reports'])
    customEntries = ['review.md', 'review.pdf'].map(name => ({
      name, path: `reports/${name}`, type: 'file', size: 10, modified: '2026-09-21T12:00:00Z',
    }))
    await page.evaluate(({ otherFolder }) => window.fixturePreferences({
      sidebarVisible: false, browseView: 'list', flatBrowse: false, browseSort: null, fontScale: 1,
      defaultReaderTypes: ['pdf'], folderReaderTypes: { [otherFolder]: ['text'] },
    }), { otherFolder })
    await poll()
    await search.fill('review.md')
    const showTypes = page.getByRole('button', { name: 'Show all file types', exact: true })
    await expect(rows).toHaveCount(0)
    await expect(showTypes).toBeVisible()
    await page.screenshot({ path: join(artifacts, `${width}-filtered-empty-recovery.png`) })
    await showTypes.click()
    await expect(search).toHaveValue('review.md')
    await expect(rows).toHaveCount(1)
    await expect(page.getByRole('region', { name: 'Directory results', exact: true })).toBeFocused()
    const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem('artiface.preferences.v1')))
    assert.deepEqual(preferences.defaultReaderTypes, ['pdf'])
    assert.deepEqual(preferences.folderReaderTypes[otherFolder], ['text'])
    assert.equal(preferences.folderReaderTypes[folder].length, 8)
    await search.fill('absent')
    await expect(rows).toHaveCount(0)
    await expect(showTypes).toHaveCount(0)
    await search.fill('')
    console.log(`PASS ${width}px empty-state recovery preserves query/defaults/other folders and focuses matching results`)

    customEntries = ['.review.md', '.notes.txt'].map(name => ({
      name, path: `reports/${name}`, type: 'file', size: 10, modified: '2026-09-21T12:00:00Z',
    }))
    await poll()
    const hiddenHint = page.getByText('Show dotfiles and hidden folders in Browse settings.', { exact: true })
    await expect(hiddenHint).toBeVisible()
    await search.fill('missing')
    await expect(hiddenHint).toHaveCount(0)
    await search.fill('.review')
    await expect(hiddenHint).toBeVisible()
    await search.press('Enter')
    await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Show dotfiles and hidden folders', exact: true }).check()
    await page.keyboard.press('Escape')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('.review.md')
    await page.evaluate(() => window.fixturePreferences({ showHidden: false }))
    await search.fill('')
    console.log(`PASS ${width}px hidden-only guidance names the effective setting and respects the query`)


    const parent = 'shared/weekly-evaluation/architecture-comparison'
    const paths = [`reports/a-trials/z.txt`, `reports/${parent}/seed-001/summary.md`,
      `reports/${parent}/seed-002/summary.md`, `reports/z-trials/a.txt`]
    customEntries = paths.map(path => ({
      name: path.split('/').at(-1), path, type: 'file', size: 10, modified: '2026-09-21T12:00:00Z',
    })).reverse()
    await page.evaluate(() => window.fixturePreferences({ flatBrowse: true }))
    await poll()
    for (const view of ['list', 'icons']) {
      await page.evaluate(view => window.fixturePreferences({ browseView: view }), view)
      await bounded(view, 4)
      const rendered = page.locator('[data-browse-entry]')
      assert.deepEqual(await rendered.evaluateAll(entries => entries.map(entry => entry.dataset.browseEntry)), paths,
        'Flat sorting must still use relative paths, not the displayed basenames')
      for (const [index, path] of paths.entries()) {
        const row = rendered.nth(index)
        await expect(row.locator('.flat-entry-basename')).toHaveText(path.split('/').at(-1))
        await expect(row.locator('a')).toHaveAttribute('title', new RegExp(`^${path}`))
        const relative = path.slice('reports/'.length)
        assert((await row.locator('a').ariaSnapshot()).includes(relative), 'The full relative path must remain accessible')
      }
      await expect(rendered.nth(1).locator('.flat-entry-parent')).toHaveText(`${parent}/seed-001`)
      await expect(rendered.nth(2).locator('.flat-entry-parent')).toHaveText(`${parent}/seed-002`)
      const namesFit = await rendered.locator('.flat-entry-basename').evaluateAll(names =>
        names.every(name => name.scrollWidth <= name.clientWidth + 1))
      assert(namesFit, 'Short basenames must remain visible beside long parent paths')
      await page.screenshot({ path: join(artifacts, `${width}-flat-names-${view}.png`) })
    }
    await search.fill('seed-002')
    await bounded('icons', 1)
    await expect(page.locator('[data-browse-entry]')).toHaveAttribute('data-browse-entry', paths[2])
    await search.fill('')
    console.log(`PASS ${width}px flat basenames, duplicate-parent context, full accessible paths, and unchanged path sorting/search`)

    customEntries = null
    count = 10_000
    const deep = 'reports/research-archive/2026-release/weekly-evaluation/architecture-comparison/selected-candidates/final-review'
    await page.evaluate(deep => { location.hash = new URLSearchParams({ host: 'fixture', root: 'reports', path: deep, kind: 'directory' }) }, deep)
    await page.evaluate(defaultReaderTypes => window.fixturePreferences({ flatBrowse: false, browseView: 'list', defaultReaderTypes }), preferences.folderReaderTypes[folder])
    await bounded('list')
    await settle()
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb', exact: true })
    const currentCrumb = crumbs.locator('[aria-current="page"]')
    const horizontallyVisible = target => target.evaluate(element => {
      const bounds = element.getBoundingClientRect(), area = element.closest('.breadcrumbs').getBoundingClientRect()
      return bounds.left >= area.left - 1 && bounds.right <= area.right + 1
    })
    await expect(currentCrumb).toHaveText('final-review')
    assert(await horizontallyVisible(currentCrumb), 'Entering a deep folder must reveal the current breadcrumb')
    await crumbs.evaluate(element => { element.scrollLeft = 0 })
    await poll()
    assert.equal(await crumbs.evaluate(element => element.scrollLeft), 0, 'Background polling must preserve manual breadcrumb scroll')
    // End text editing before manually scrolling and resizing the listing.
    await search.evaluate(input => input.blur())
    await setScroll(400)
    await page.setViewportSize({ width: width + 30, height: 900 })
    await settle()
    assert(await horizontallyVisible(currentCrumb), 'Width changes must reveal the current breadcrumb')
    assert.equal(await scrollTop(), 400, 'Revealing a breadcrumb must not scroll the file listing')
    await page.setViewportSize({ width, height: 900 })
    await setScroll(0)
    await currentCrumb.focus()
    await page.keyboard.press('Shift+Tab')
    const ancestor = crumbs.getByRole('button', { name: 'selected-candidates', exact: true })
    await expect(ancestor).toBeFocused()
    assert(await horizontallyVisible(ancestor))
    await page.setViewportSize({ width: width + 30, height: 900 })
    await poll()
    await expect(ancestor).toBeFocused()
    assert(await horizontallyVisible(ancestor), 'Resizing/polling must keep the focused ancestor visible')
    await ancestor.click()
    await bounded('list')
    await expect(currentCrumb).toHaveText('selected-candidates')
    assert(await horizontallyVisible(currentCrumb))
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: join(artifacts, `${width}-current-breadcrumb.png`) })
    await crumbs.getByRole('button', { name: 'reports', exact: true }).click()
    await bounded('list')
    console.log(`PASS ${width}px breadcrumb navigation/resize, manual scroll through polling, keyboard ancestors, and no page jumps`)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  customEntries = null
  count = 450
  await poll()
  await choosePage(1)
  const refresh = page.getByRole('button', { name: 'Refresh files', exact: true })
  nextListingStatus = 503
  await poll()
  await expect(page.locator('.browse-stale')).toBeVisible()
  await bounded('list')
  assert.equal(await pageNumber(), '1', 'A transient failure reset the page')
  await setScroll(200)
  const retainedScroll = await scrollTop()
  await page.evaluate(() => { window.retainedRow = document.querySelector('.file-table tbody tr') })
  holdNextListing = true
  await refresh.evaluate(button => button.focus({ preventScroll: true }))
  await page.keyboard.press('Enter')
  await expect.poll(() => releaseListing !== null).toBe(true)
  const heldRefreshCount = requests
  await expect(refresh).toHaveAttribute('aria-disabled', 'true')
  await expect(refresh).toBeFocused()
  await page.keyboard.press('Enter')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
  assert.equal(requests, heldRefreshCount, 'Pending refresh restarted its request')
  assert(await page.evaluate(() => window.retainedRow === document.querySelector('.file-table tbody tr')))
  assert.equal(await pageNumber(), '1')
  assert.equal(await scrollTop(), retainedScroll)
  releaseListing(); releaseListing = null
  await expect(refresh).toHaveAttribute('aria-disabled', 'false')
  await expect(refresh).toBeFocused()
  console.log('PASS pending refresh coalesces activation/visibility while retaining stale rows, page, scroll and focus')

  nextListingStatus = 403
  await poll()
  const retry = page.locator('.error-state .state-actions button')
  await expect(rows).toHaveCount(0)
  for (const outcome of ['success', 'failure', 'other-focus', 'settings', 'navigate']) {
    if (outcome === 'failure') { nextListingStatus = 403; await poll() }
    await expect(retry).toHaveText('Try again')
    holdNextListing = true
    if (outcome === 'failure') nextListingStatus = 503
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => releaseListing !== null).toBe(true)
    const heldRetryCount = requests
    await expect(retry).toHaveText('Retrying…')
    await expect(retry).toHaveAttribute('aria-disabled', 'true')
    await expect(retry).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await refresh.evaluate(button => button.click())
    await settle()
    assert.equal(requests, heldRetryCount, 'Pending retry was restarted through a retry or toolbar control')
    if (outcome === 'other-focus') await search.focus()
    if (outcome === 'settings') {
      await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
      const flat = page.getByRole('checkbox', { name: 'Show files from all subfolders', exact: true })
      await flat.check()
      await bounded('list')
      await expect(flat).toBeFocused()
      assert.equal(requests, heldRetryCount + 1, 'A configuration change was blocked by the pending retry')
    }
    if (outcome === 'navigate') {
      await page.evaluate(() => { location.hash = 'host=fixture&root=reports&path=archive&kind=directory' })
      await bounded('list')
    }
    releaseListing(); releaseListing = null
    if (outcome === 'failure') {
      await expect(retry).toHaveText('Try again')
      await expect(retry).toBeFocused()
    } else if (outcome === 'settings') {
      await expect(page.locator('.error-state')).toHaveCount(0)
      await page.keyboard.press('Escape')
      nextListingStatus = 403
      await poll()
    } else if (outcome === 'navigate') {
      await settle()
      await expect(page.locator('[data-browse-entry]').first()).toHaveAttribute('data-browse-entry', /^archive\//)
      await expect(page.locator('.error-state')).toHaveCount(0)
    } else {
      await expect(retry).toHaveCount(0)
      await expect(outcome === 'success' ? page.getByRole('region', { name: 'Directory results', exact: true }) : search).toBeFocused()
      if (outcome === 'other-focus') { nextListingStatus = 403; await poll() }
    }
  }
  console.log('PASS held retry feedback, keyboard guards, success/failure focus, newer focus, configuration invalidation and canceled navigation')

  // Markdown relative links and untyped deep links enter Workspace as kind:auto.
  customEntries = [
    ['note', 'file', 'docs/notes.md'], ['report', 'file', 'docs/report.pdf'],
    ['folder', 'directory', 'docs'], ['home', 'directory', ''],
    ['ordinary.md', 'file'], ['broken', 'symlink'], ['escape', 'symlink'],
  ].map(([name, type, resolvedPath]) => ({
    name, path: `reports/${name}`, type, size: 100, modified: '2026-09-21T12:00:00Z',
    ...(resolvedPath === undefined ? {} : { resolvedPath, symlink: true }),
  }))
  for (const [requested, path, kind] of [
    ['reports/note', 'docs/notes.md', 'file'], ['reports/report', 'docs/report.pdf', 'file'],
    ['reports/folder', 'docs', 'directory'], ['reports/home', '', 'directory'],
    ['reports/ordinary.md', 'reports/ordinary.md', 'file'],
    ['reports/broken', 'reports/broken', 'file'], ['reports/escape', 'reports/escape', 'file'],
    ['reports/missing', 'reports/missing', 'file'], ['', '', 'directory'],
  ]) {
    await page.evaluate(path => {
      location.hash = new URLSearchParams({ host: 'fixture', root: 'reports', path, kind: 'auto' })
    }, requested)
    await expect.poll(() => page.evaluate(() => {
      const route = new URLSearchParams(location.hash.slice(1))
      return { path: route.get('path'), kind: route.get('kind') }
    }), `Automatic resolution of ${requested} must match Browse's canonical target`).toEqual({ path, kind })
  }
  console.log('PASS automatic file/directory/root aliases use canonical paths; ordinary and unavailable paths retain their existing fallback')

  // Focus navigation stays within rendered links, including holes and a resized grid.
  customEntries = Array.from({ length: 205 }, (_, index) => ({
    name: 'report.txt', path: `reports/keyboard/run-${String(index).padStart(3, '0')}/report.txt`,
    type: index === 1 ? 'symlink' : 'file', size: 100, modified: '2026-09-21T12:00:00Z',
  }))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() => {
    window.fixturePreferences({ browseView: 'list', flatBrowse: true, defaultReaderTypes: ['text'], density: 'compact', fontScale: 1,
      browseSort: null, defaultBrowseSort: { column: 'name', direction: 'asc' } })
    location.hash = 'host=fixture&root=reports&path=reports%2Fkeyboard&kind=directory'
  })
  await bounded('list')
  const fileLinks = page.locator('.table-name > a[href], a.file-tile[href]')
  const firstLink = fileLinks.first()
  const focusWork = () => page.evaluate(() => [window.fixtureFileListRenders, window.fixtureSortCalls, location.hash])
  await expect(fileLinks).toHaveCount(199)
  await firstLink.focus()
  await settle()
  const beforeFocus = await focusWork(), beforeFocusReads = requests
  await page.keyboard.press('ArrowDown')
  await expect(fileLinks.nth(1)).toBeFocused()
  await expect(fileLinks.nth(1)).toHaveAttribute('href', /run-002%2Freport.txt/)
  await page.keyboard.press('ArrowUp')
  await expect(firstLink).toBeFocused()
  await page.keyboard.press('End')
  await expect(fileLinks.last()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(fileLinks.last()).toBeFocused()
  assert.equal(await pageNumber(), '0')
  await page.keyboard.press('Tab')
  await expect(footerSelect).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(fileLinks.last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(firstLink).toBeFocused()
  const ignored = await firstLink.evaluate(element => {
    return [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { prevented: true }]
      .map(({ prevented, ...options }) => {
        const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, ...options })
        if (prevented) event.preventDefault()
        element.dispatchEvent(event)
        return event.defaultPrevented === Boolean(prevented) && document.activeElement === element
      })
  })
  assert(ignored.every(Boolean), 'Modified, composing or already-handled keys moved focus')
  const selectionPrevented = await firstLink.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element.querySelector('.flat-entry-basename'))
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  assert.equal(selectionPrevented, false, 'Arrow focus stole an active filename text selection')
  await page.keyboard.press('ArrowDown')
  await expect(firstLink).toBeFocused()
  await page.evaluate(() => getSelection().removeAllRanges())
  await page.keyboard.press('ArrowDown')
  await expect(fileLinks.nth(1)).toBeFocused()
  assert.deepEqual(await focusWork(), beforeFocus, 'Focus movement rendered, sorted or navigated')
  assert.equal(requests, beforeFocusReads, 'Focus movement fetched a listing')

  await page.getByRole('button', { name: 'Icon view', exact: true }).click()
  await bounded('icons')
  const tiles = page.locator('.file-grid > li')
  const columns = () => page.locator('.file-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  await firstLink.focus()
  await page.keyboard.press('ArrowRight')
  await expect(tiles.nth(2).locator('a')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(firstLink).toBeFocused()
  await page.keyboard.press('ArrowRight')
  const wideColumns = await columns()
  await page.keyboard.press('ArrowDown')
  await expect(tiles.nth(wideColumns + 2).locator('a')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(tiles.nth(2).locator('a')).toBeFocused()
  await page.setViewportSize({ width: 820, height: 900 })
  await settle()
  assert((await columns()) < wideColumns, 'Fixture did not change the grid column count')
  await page.keyboard.press('ArrowDown')
  await expect(tiles.nth(await columns() + 2).locator('a')).toBeFocused()
  await choosePage(1)
  await bounded('icons', 5)
  await firstLink.focus()
  await page.keyboard.press('End')
  await expect(fileLinks.last()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(fileLinks.last()).toBeFocused()
  assert.equal(await pageNumber(), '1')
  console.log('PASS local filename arrows, current-page bounds, native Tab, selection/modifier guards, unavailable links and resized icon geometry without focus work')

  // A listing response may remove a filename while the user is navigating with arrows.
  const removalEntries = Array.from({ length: 12 }, (_, index) => ({
    name: `file-${String(index).padStart(2, '0')}.txt`, path: `reports/removal/file-${String(index).padStart(2, '0')}.txt`,
    type: 'file', size: 100, modified: '2026-09-21T12:00:00Z',
  }))
  await page.setViewportSize({ width: 1280, height: 900 })
  for (const view of ['list', 'icons']) {
    customEntries = removalEntries
    await page.evaluate(view => {
      window.fixturePreferences({ browseView: view, flatBrowse: false, sidebarMode: 'dock', sidebarVisible: true, density: 'compact', fontScale: 1 })
      location.hash = 'host=fixture&root=reports&path=reports%2Fremoval&kind=directory'
    }, view)
    await poll()
    for (const outcome of ['next', 'last', 'search', 'blank', 'empty']) {
      customEntries = outcome === 'empty' ? removalEntries.slice(0, 1) : removalEntries
      await poll()
      await bounded(view, customEntries.length)
      await firstLink.focus()
      if (outcome === 'last') await page.keyboard.press('End')
      else if (outcome !== 'empty') await page.keyboard.press(view === 'list' ? 'ArrowDown' : 'ArrowRight')
      const removed = await page.evaluate(() => document.activeElement.closest('[data-browse-entry]').dataset.browseEntry)
      customEntries = customEntries.filter(entry => entry.path !== removed)
      holdNextListing = true
      const refreshing = poll()
      try {
        await expect.poll(() => releaseListing !== null).toBe(true)
        if (outcome === 'search') await search.focus()
        if (outcome === 'blank') {
          await page.mouse.click(10, 850) // Empty sidebar area intentionally clears filename focus.
          assert(await page.evaluate(() => document.activeElement === document.body))
        }
      } finally {
        releaseListing?.(); releaseListing = null
        await refreshing
      }
      if (outcome === 'search') await expect(search).toBeFocused()
      else if (outcome === 'blank') assert(await page.evaluate(() => document.activeElement === document.body), 'Refresh stole deliberate blank-area focus')
      else if (outcome === 'empty') await expect(page.locator('#main-content')).toBeFocused()
      else {
        await expect(fileLinks.nth(outcome === 'last' ? 10 : 1)).toBeFocused()
        if (outcome === 'next') {
          await expect(fileLinks.nth(1)).toHaveAttribute('href', /file-02.txt/)
          await page.keyboard.press(view === 'list' ? 'ArrowDown' : 'ArrowRight')
          await expect(fileLinks.nth(2)).toBeFocused()
        }
      }
    }
  }
  console.log('PASS held listing removal restores next/previous/empty focus in list/icons; newer Search and blank pointer choices win')
  assert.deepEqual(errors, [])
  await context.close()
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png') })
  throw error
} finally {
  await writeFile(join(artifacts, 'dom-counts.json'), JSON.stringify(observations, null, 2) + '\n')
  await writeFile(join(artifacts, 'header-layouts.json'), JSON.stringify(headerLayouts, null, 2) + '\n')
  await browser.close()
  console.log(`Screenshots and DOM counts: ${artifacts}`)
}
