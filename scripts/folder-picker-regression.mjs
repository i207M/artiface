import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, expect } = require('@playwright/test')
const artifacts = await mkdtemp(join(tmpdir(), 'artiface-folder-tree-'))
const entry = join(repository, 'web/src/__folder_tree_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'folder-tree-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css')) return '\0fixture-css'
    },
    load(id) {
      if (id === '\0fixture-css') return 'export default ""'
      if (id === entry) return `
        import {useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import FolderPicker from './components/FolderPicker'
        import {setPreferences} from './preferences'
        window.fixturePreferences = setPreferences
        window.fixturePicks = []
        function Fixture() {
          const [open, setOpen] = useState(true)
          const [source, setSource] = useState('ssh')
          window.fixtureSource = setSource
          window.fixtureClose = () => setOpen(false)
          const host = source === 'manual' ? undefined : {
            id: 'fixture-' + source, label: 'Fixture source', kind: source,
            target: source === 'ssh' ? 'fixture-alias' : '', roots: []
          }
          return <><button onClick={() => setOpen(true)}>Open picker</button>
            {open && <FolderPicker key={source} host={host} target="manual-fixture" kind={source === 'local' ? 'local' : 'ssh'}
              onPick={path => { window.fixturePicks.push(path); setOpen(false) }} onClose={() => setOpen(false)}/>}
          </>
        }
        createRoot(document.getElementById('root')).render(<Fixture/>)
      `
    },
  }],
})
const built = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = built.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'components/settings.css'].map(path =>
  readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://folder-tree-fixture.invalid'
const errors = []
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, hasTouch: true, serviceWorkers: 'block' })
  context.setDefaultTimeout(10_000)
  await context.addInitScript(() => {
    const folder = (name, path) => ({ name, path, type: 'directory', size: 0, modified: '2026-09-21T12:00:00Z' })
    const listing = (path, entries, parent = path.split('/').slice(0, -1).join('/') || '/') => ({ path, parent, home: '/work', entries })
    const root = [folder('.hidden', '/work/.hidden'), ...Array.from({ length: 100 }, (_, index) =>
      folder(`folder-${String(index).padStart(3, '0')}`, `/work/folder-${String(index).padStart(3, '0')}`))]
    const wide = (path, prefix, count = 10000) => listing(path, Array.from({ length: count }, (_, index) => {
      const name = `${prefix}-${String(index).padStart(5, '0')}`
      return folder(name, `${path}/${name}`)
    }))
    const fixtures = {
      '/work': listing('/work', root),
      '/': listing('/', [folder('work', '/work')], null),
      '/work/folder-000': listing('/work/folder-000', [folder('child-a', '/work/folder-000/child-a'), folder('child-b', '/work/folder-000/child-b')]),
      '/work/folder-000/child-a': listing('/work/folder-000/child-a', [folder('grandchild', '/work/folder-000/child-a/grandchild')]),
      '/work/folder-001': listing('/work/folder-001', [folder('late-child', '/work/folder-001/late-child')]),
      '/work/folder-002': listing('/work/folder-002', []),
      '/work/folder-003': listing('/work', [folder('cycle', '/work/folder-003/cycle')]),
      '/work/folder-004': listing('/work/folder-004', [folder('recovered', '/work/folder-004/recovered')]),
      '/work/folder-006': listing('/work/folder-006', [folder('delayed-six', '/work/folder-006/delayed-six')]),
      '/work/folder-008': listing('/work/folder-008', [folder('delayed-eight', '/work/folder-008/delayed-eight')]),
      '/work/folder-009': listing('/work/folder-009', [folder('closed-late', '/work/folder-009/closed-late')]),
      '/newer': listing('/newer', [folder('fresh', '/newer/fresh')]),
      '/alias': listing('/resolved', [folder('resolved-child', '/resolved/resolved-child')]),
      '/stale': listing('/stale', [folder('stale', '/stale/stale')]),
      '/wide': wide('/wide', 'folder'),
      '/wide/folder-00000': wide('/wide/folder-00000', 'child'),
      '/wide/folder-00000/child-00000': listing('/wide/folder-00000/child-00000', [folder('late-grandchild', '/wide/folder-00000/child-00000/late-grandchild')]),
    }
    window.fixtureResizeWide = count => { fixtures['/wide'] = wide('/wide', 'folder', count) }
    window.fixtureRequests = []
    window.fixtureHolds = {}
    window.fixtureFailures = {}
    const pending = new Map()
    window.fixtureReply = (path, failure = false) => {
      const match = [...pending.values()].find(request => request.path === path)
      if (!match) throw new Error('No held request for ' + path)
      pending.delete(match.id)
      delete window.fixtureHolds[path]
      if (failure) match.reject(new Error('Late synthetic failure'))
      else match.respond()
    }
    // Held responses can ignore abort deliberately, exercising the component's stale-response guards.
    window.fetch = async (url, options) => {
      if (new URL(url, location.href).pathname !== '/api/folders') throw new Error('Unexpected fixture API')
      const body = JSON.parse(options.body)
      const path = body.path || '/work'
      const record = { id: window.fixtureRequests.length, body, path, aborted: false }
      window.fixtureRequests.push(record)
      return new Promise((resolve, reject) => {
        const respond = () => {
          if (window.fixtureFailures[path]) {
            window.fixtureFailures[path]--
            resolve(new Response(JSON.stringify({ error: 'Synthetic folder failure' }), { status: 500 }))
          } else {
            resolve(new Response(JSON.stringify(fixtures[path] ?? listing(path, [])), { status: 200 }))
          }
        }
        options.signal.addEventListener('abort', () => {
          record.aborted = true
          if (!window.fixtureHolds[path]) reject(new DOMException('Aborted', 'AbortError'))
        })
        if (window.fixtureHolds[path]) pending.set(record.id, { ...record, respond, reject })
        else respond()
      })
    }
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    : route.abort())
  await page.goto(origin)
  const dialog = page.getByRole('dialog', { name: 'Choose a folder', exact: true })
  const tree = page.getByRole('tree', { name: 'Folder structure', exact: true })
  const filter = page.getByRole('textbox', { name: 'Filter folders', exact: true })
  const item = name => tree.getByRole('treeitem', { name, exact: true })
  const selected = dialog.locator('.folder-picker-footer code')
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const oneTabStop = async () => {
    const stops = await tree.evaluate(area => [area, ...area.querySelectorAll('*')]
      .filter(element => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length).length)
    assert.equal(stops, 1, 'The tree must have exactly one sequential tab stop')
  }
  const hold = path => page.evaluate(path => { window.fixtureHolds[path] = true }, path)
  const reply = (path, failure = false) => page.evaluate(({ path, failure }) => window.fixtureReply(path, failure), { path, failure })
  const root = async () => {
    await page.getByRole('button', { name: 'Home folder', exact: true }).click()
    await expect(tree.getByRole('treeitem')).toHaveCount(100)
  }
  await expect(tree.getByRole('treeitem')).toHaveCount(100)
  await oneTabStop()
  assert.deepEqual(await page.evaluate(() => window.fixtureRequests[0].body), { host: 'fixture-ssh', target: 'fixture-alias', kind: 'ssh' })
  await filter.focus()
  await page.keyboard.press('Tab')
  await expect(item('folder-000')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(item('folder-000')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(item('folder-001')).toBeFocused()
  await expect(selected).toHaveText('/work')
  await page.keyboard.press('End')
  await expect(item('folder-099')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(item('folder-099')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(selected).toHaveText('/work/folder-099')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Space')
  await expect(selected).toHaveText('/work/folder-098')
  assert.deepEqual(await page.evaluate(() => window.fixturePicks), [])
  await page.keyboard.press('Home')
  await expect(item('folder-000')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(item('folder-000')).toBeFocused()
  await oneTabStop()
  console.log('PASS 100 folders expose one tab stop; arrows/Home/End move focus and Enter/Space only select')

  await page.keyboard.press('ArrowRight')
  await expect(item('child-a')).toBeVisible()
  await expect(item('folder-000')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(item('child-a')).toBeFocused()
  await expect(item('child-a')).toHaveAttribute('aria-level', '2')
  await page.keyboard.press('ArrowRight')
  await expect(item('grandchild')).toBeVisible()
  await expect(item('child-a')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(item('grandchild')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(item('child-b')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(item('grandchild')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(item('child-a')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(item('grandchild')).toHaveCount(0)
  await expect(item('child-a')).toBeFocused()
  await oneTabStop()
  console.log('PASS Right expands then enters children; Left collapses or returns to parent; visible preorder and ARIA levels')

  await hold('/work/folder-001')
  await item('folder-001').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(item('folder-001')).toHaveAttribute('aria-busy', 'true')
  await reply('/work/folder-001')
  await expect(item('late-child')).toBeFocused()
  await hold('/work/folder-006')
  await item('folder-006').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await reply('/work/folder-006')
  await expect(item('delayed-six')).toBeVisible()
  await expect(item('folder-007')).toBeFocused()
  await hold('/work/folder-008')
  await item('folder-008').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await filter.focus()
  await reply('/work/folder-008')
  await expect(filter).toBeFocused()

  await item('child-a').focus()
  await filter.fill('folder-09')
  await expect(tree.getByRole('treeitem')).toHaveCount(10)
  await oneTabStop()
  await expect(filter).toBeFocused()
  await filter.fill('')
  await page.keyboard.press('Tab')
  await expect(item('child-a')).toBeFocused()
  await filter.fill('no such folder')
  await expect(tree.getByRole('treeitem')).toHaveCount(0)
  await oneTabStop()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Clear folder filter', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(tree).toBeFocused()
  await page.getByRole('button', { name: 'Clear folder filter', exact: true }).click()
  await expect(filter).toBeFocused()
  await expect(filter).toHaveValue('')
  await page.keyboard.press('Tab')
  await expect(item('child-a')).toBeFocused()
  await page.evaluate(() => window.fixturePreferences({ showHidden: true }))
  await item('.hidden').focus()
  await page.evaluate(() => window.fixturePreferences({ showHidden: false }))
  await expect(item('folder-000')).toBeFocused()
  await oneTabStop()
  console.log('PASS delayed child entry respects changed focus; filtering restores logical focus; empty/hidden results remain keyboard reachable')

  await item('folder-000').locator(':scope > .folder-tree-row .folder-tree-name').dblclick()
  await expect(page.getByRole('textbox', { name: 'Folder path', exact: true })).toHaveValue('/work/folder-000')
  await expect(item('child-a')).toBeFocused()
  await page.getByRole('button', { name: 'Parent folder', exact: true }).click()
  await expect(tree.getByRole('treeitem')).toHaveCount(100)
  await expect(page.getByRole('button', { name: 'Parent folder', exact: true })).toBeFocused()
  await filter.focus()
  await page.keyboard.press('Tab')
  await expect(item('folder-000')).toBeFocused()
  await page.getByRole('button', { name: 'Expand folder-000', exact: true }).click()
  await expect(item('child-b')).toBeVisible()
  await expect(item('folder-000')).toBeFocused()
  await page.getByRole('button', { name: 'Collapse folder-000', exact: true }).click()
  await expect(item('child-b')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open folder-000', exact: true }).click()
  await expect(item('child-a')).toBeFocused()
  await root()
  console.log('PASS pointer disclosure/name/double-click/Open actions and parent navigation preserve logical focus')

  await page.evaluate(() => { window.fixtureFailures['/work/folder-004'] = 1 })
  await item('folder-004').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tree.getByRole('alert')).toHaveText('Synthetic folder failure')
  await expect(item('folder-004')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(item('recovered')).toBeFocused()
  await item('folder-003').focus()
  await page.keyboard.press('ArrowRight')
  await expect(item('folder-003').getByText('Open this folder to continue navigating.')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(item('cycle')).toHaveCount(0)
  await expect(item('folder-003')).toBeFocused()
  console.log('PASS retry after branch failure and existing canonical-path cycle boundary')

  await hold('/work/folder-001')
  await item('folder-001').focus()
  await page.keyboard.press('ArrowRight')
  await root()
  await reply('/work/folder-001')
  await expect(item('late-child')).toHaveCount(0)
  assert(await page.evaluate(() => window.fixtureRequests.some(request => request.path === '/work/folder-001' && request.aborted)))
  for (const failure of [false, true]) {
    await hold('/stale')
    await page.getByRole('textbox', { name: 'Folder path', exact: true }).fill('/stale')
    await dialog.locator('form').evaluate(form => form.requestSubmit())
    await page.getByRole('textbox', { name: 'Folder path', exact: true }).fill('/newer')
    await dialog.locator('form').evaluate(form => form.requestSubmit())
    await expect(item('fresh')).toBeVisible()
    await reply('/stale', failure)
    await settle()
    await expect(item('fresh')).toBeVisible()
    await expect(dialog.locator('.settings-error')).toHaveCount(0)
    await expect(selected).toHaveText('/newer')
    await expect(page.getByRole('textbox', { name: 'Folder path', exact: true })).toHaveValue('/newer')
  }
  await root()
  await hold('/work/folder-009')
  await item('folder-009').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'The initial auto-open has no external opener')
  await reply('/work/folder-009')
  assert(await page.evaluate(() => window.fixtureRequests.some(request => request.path === '/work/folder-009' && request.aborted)))
  await page.getByRole('button', { name: 'Open picker', exact: true }).click()
  await expect(tree.getByRole('treeitem')).toHaveCount(100)
  await expect(item('closed-late')).toHaveCount(0)
  console.log('PASS canceled branch/root requests and unmount cannot publish late rows, failures, or selections')

  for (const [width, height] of [[320, 900], [768, 900], [740, 360]]) for (const density of ['compact', 'comfortable']) {
    await page.setViewportSize({ width, height })
    await page.evaluate(density => window.fixturePreferences({ density, fontScale: 1.4 }), density)
    await filter.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('End')
    await expect(item('folder-099')).toBeFocused()
    const bounds = await item('folder-099').evaluate(element => {
      const row = element.querySelector('.folder-tree-row').getBoundingClientRect()
      const area = element.closest('[role="tree"]').getBoundingClientRect()
      return { top: row.top, bottom: row.bottom, areaTop: area.top, areaBottom: area.bottom,
        dialogScroll: element.closest('dialog').scrollTop, pageScroll: document.scrollingElement.scrollTop }
    })
    assert(bounds.areaBottom - bounds.areaTop >= 2 * (bounds.bottom - bounds.top), 'The folder tree must fit at least two rows in short windows')
    assert(bounds.top >= bounds.areaTop - 1 && bounds.bottom <= bounds.areaBottom + 1)
    assert.equal(bounds.dialogScroll, 0)
    assert.equal(bounds.pageScroll, 0)
    await oneTabStop()
    await page.screenshot({ path: join(artifacts, `${width}-${density}.png`) })
  }
  await item('folder-099').press('Enter')
  await expect(dialog).toBeVisible()
  assert.deepEqual(await page.evaluate(() => window.fixturePicks), [])
  await page.getByRole('button', { name: 'Select folder', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.fixturePicks), ['/work/folder-099'])
  await expect(dialog).toHaveCount(0)

  await page.getByRole('button', { name: 'Open picker', exact: true }).click()
  await page.evaluate(() => window.fixtureSource('local'))
  await expect(tree.getByRole('treeitem')).toHaveCount(100)
  await expect.poll(() => page.evaluate(() => window.fixtureRequests.at(-1).body.kind)).toBe('local')
  assert.deepEqual(await page.evaluate(() => window.fixtureRequests.at(-1).body), { host: 'fixture-local', target: '', kind: 'local' })
  await page.evaluate(() => window.fixtureSource('manual'))
  await expect.poll(() => page.evaluate(() => window.fixtureRequests.at(-1).body.target)).toBe('manual-fixture')
  assert.deepEqual(await page.evaluate(() => window.fixtureRequests.at(-1).body), { target: 'manual-fixture', kind: 'ssh' })
  await oneTabStop()
  assert.deepEqual(errors, [])
  console.log('PASS responsive focus/scroll, explicit Select folder, and unchanged SSH/local/manual source requests')

  await page.setViewportSize({ width: 1000, height: 900 })
  await page.evaluate(() => window.fixturePreferences({ density: 'compact', fontScale: 1 }))
  const address = dialog.getByRole('textbox', { name: 'Folder path', exact: true })
  const go = dialog.getByRole('button', { name: 'Go', exact: true })
  const navigate = async path => {
    // Initial loading also writes the address; do not type until it has settled.
    await expect(dialog.getByRole('button', { name: 'Select folder', exact: true })).toBeEnabled()
    await expect(go).toBeEnabled()
    await address.fill(path)
    const requestStart = await page.evaluate(() => window.fixtureRequests.length)
    await go.click()
    await expect.poll(() => page.evaluate(start =>
      window.fixtureRequests.slice(start).map(request => request.body.path), requestStart)).toEqual([path])
    await expect(tree).toHaveAttribute('aria-busy', 'false')
    await expect(address).toHaveValue(path)
    await expect(selected).toHaveText(path)
  }
  const pager = (path, edge = 'start') => tree.locator(`[data-folder-pager="${path}"][data-page-edge="${edge}"]`)
  const siblings = path => tree.locator(`[data-folder-group="${path}"]`)
  const boundedTree = async maximum => {
    assert(await tree.locator('[data-folder-path]').count() <= maximum)
    // Icon markup is bounded with the mounted folders, not with the API array.
    assert(await tree.locator('*').count() < maximum * 16 + 150)
    await oneTabStop()
  }
  await navigate('/wide')
  await expect(siblings('/wide')).toHaveCount(200)
  await expect(pager('/wide')).toContainText('1–200 of 10,000 folders')
  await expect(item('folder-00000')).toHaveAttribute('aria-posinset', '1')
  await expect(item('folder-00000')).toHaveAttribute('aria-setsize', '10000')
  await boundedTree(200)
  await filter.focus()
  await page.keyboard.press('Tab')
  await expect(pager('/wide')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(item('folder-00000')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(selected).toHaveText('/wide/folder-00000')
  await page.keyboard.press('ArrowUp')
  await expect(pager('/wide')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(pager('/wide')).toContainText('201–400 of 10,000 folders')
  await expect(pager('/wide')).toBeFocused()
  await expect(item('folder-00200')).toHaveAttribute('aria-posinset', '201')
  await expect(selected).toHaveText('/wide/folder-00000')
  await page.keyboard.press('End')
  await expect(pager('/wide')).toContainText('9,801–10,000 of 10,000 folders')
  await page.keyboard.press('ArrowLeft')
  await expect(pager('/wide')).toContainText('9,601–9,800 of 10,000 folders')
  await page.keyboard.press('Home')
  await expect(item('folder-00000')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(pager('/wide')).toContainText('201–400 of 10,000 folders')
  await page.keyboard.press('Space')
  await expect(pager('/wide')).toContainText('401–600 of 10,000 folders')
  await expect(selected).toHaveText('/wide/folder-00000')
  await boundedTree(200)
  await pager('/wide').getByRole('button', { name: 'Last folder page for /wide', exact: true }).click()
  await expect(pager('/wide')).toBeFocused()
  await expect(item('folder-09999')).toBeVisible()
  await item('folder-09999').focus()
  await page.keyboard.press('Enter')
  await expect(selected).toHaveText('/wide/folder-09999')
  await page.keyboard.press('ArrowDown')
  await expect(pager('/wide', 'end')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(pager('/wide', 'end')).toBeFocused()
  await expect(item('folder-00000')).toHaveCount(1)
  await expect(selected).toHaveText('/wide/folder-09999')
  await pager('/wide', 'end').getByRole('button', { name: 'Next folder page for /wide', exact: true }).click()
  await expect(pager('/wide', 'end')).toBeFocused()
  const bottomBounds = await pager('/wide', 'end').evaluate(element => {
    const row = element.getBoundingClientRect()
    const area = element.closest('[role="tree"]').getBoundingClientRect()
    return row.top >= area.top - 1 && row.bottom <= area.bottom + 1
  })
  assert(bottomBounds, 'Changing page must keep the bottom pager in view')
  await filter.fill('folder-09999')
  await expect(siblings('/wide')).toHaveCount(1)
  await expect(tree.locator('[data-folder-pager]')).toHaveCount(0)
  await expect(item('folder-09999')).toHaveAttribute('aria-selected', 'true')
  await expect(filter).toBeFocused()
  await oneTabStop()
  await page.getByRole('button', { name: 'Clear folder filter', exact: true }).click()
  await expect(filter).toBeFocused()
  await expect(pager('/wide')).toContainText('201–400 of 10,000 folders')
  await expect(selected).toHaveText('/wide/folder-09999')
  await page.getByRole('button', { name: 'Select folder', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.fixturePicks), ['/work/folder-099', '/wide/folder-09999'])
  await expect(dialog).toHaveCount(0)
  await hold('/work')
  await page.getByRole('button', { name: 'Open picker', exact: true }).click()
  await expect(tree).toHaveAttribute('aria-busy', 'true')
  await expect(go).toBeDisabled()
  await address.evaluate(input => {
    window.fixtureNavigationInputs = []
    input.addEventListener('input', () => window.fixtureNavigationInputs.push({
      value: input.value, busy: document.querySelector('[role="tree"]').getAttribute('aria-busy'),
    }))
  })
  const reopening = navigate('/wide')
  await expect(dialog.getByRole('button', { name: 'Select folder', exact: true })).toBeDisabled()
  await reply('/work')
  await reopening
  assert.deepEqual(await page.evaluate(() => window.fixtureNavigationInputs), [{ value: '/wide', busy: 'false' }])
  await expect(siblings('/wide')).toHaveCount(200)
  console.log('PASS reopening navigation waits for the held home response before typing and clicking enabled Go')
  await pager('/wide').focus()
  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: 'Open folder-00230', exact: true }).click()
  await expect(tree.getByRole('treeitem')).toHaveCount(0)
  await page.getByRole('button', { name: 'Parent folder', exact: true }).click()
  await expect(pager('/wide')).toContainText('201–400 of 10,000 folders')
  await filter.focus()
  await page.keyboard.press('Tab')
  await expect(item('folder-00230')).toBeFocused()
  await pager('/wide').focus()
  await page.keyboard.press('End')
  await page.evaluate(() => window.fixtureResizeWide(201))
  await page.getByRole('button', { name: 'Refresh folders', exact: true }).click()
  await expect(pager('/wide')).toContainText('201–201 of 201 folders')
  await expect(siblings('/wide')).toHaveCount(1)
  await oneTabStop()
  await page.evaluate(() => window.fixtureResizeWide(10000))
  await page.getByRole('button', { name: 'Refresh folders', exact: true }).click()
  await pager('/wide').focus()
  await page.keyboard.press('Home')
  console.log('PASS 10,000 root folders mount 200 siblings; keyboard/button paging, selection, filter-before-page, and refresh clamping')

  const branch = '/wide/folder-00000'
  await hold(branch)
  await item('folder-00000').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(item('folder-00000')).toHaveAttribute('aria-busy', 'true')
  await pager('/wide').focus()
  await page.keyboard.press('ArrowRight')
  await reply(branch)
  await settle()
  await expect(pager('/wide')).toBeFocused()
  await expect(item('child-00000')).toHaveCount(0)
  await page.keyboard.press('Home')
  await expect(siblings(branch)).toHaveCount(200)
  await expect(pager(branch)).toContainText('1–200 of 10,000 folders')
  await boundedTree(400)
  await item('folder-00000').focus()
  await page.keyboard.press('ArrowRight')
  await expect(item('child-00000')).toBeFocused()
  await expect(item('child-00000')).toHaveAttribute('aria-level', '2')
  await page.keyboard.press('Enter')
  await expect(selected).toHaveText(branch + '/child-00000')
  await page.keyboard.press('ArrowUp')
  await expect(pager(branch)).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(pager(branch)).toContainText('201–400 of 10,000 folders')
  await page.keyboard.press('End')
  await expect(pager(branch)).toContainText('9,801–10,000 of 10,000 folders')
  await expect(item('child-09999')).toHaveAttribute('aria-posinset', '10000')
  await page.keyboard.press('ArrowLeft')
  await expect(pager(branch)).toContainText('9,601–9,800 of 10,000 folders')
  await page.keyboard.press('Home')
  await expect(item('child-00000')).toHaveAttribute('aria-selected', 'true')
  await expect(selected).toHaveText(branch + '/child-00000')
  await filter.fill('folder-00000')
  await expect(siblings('/wide')).toHaveCount(1)
  await expect(siblings(branch)).toHaveCount(200)
  await expect(pager(branch)).toContainText('1–200 of 10,000 folders')
  await boundedTree(201)
  await filter.fill('child-00000')
  await expect(tree.getByRole('treeitem')).toHaveCount(0)
  await oneTabStop()
  await filter.fill('folder-00000')
  await pager(branch).getByRole('button', { name: 'Next folder page for ' + branch, exact: true }).click()
  await pager(branch).getByRole('button', { name: 'Previous folder page for ' + branch, exact: true }).click()
  await expect(pager(branch)).toBeFocused()
  await boundedTree(201)
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => window.fixturePreferences({ density: 'comfortable', fontScale: 1.4 }))
    await pager(branch).focus()
    await page.keyboard.press('Home')
    await pager(branch).getByRole('button', { name: 'Last folder page for ' + branch, exact: true }).click()
    await expect(pager(branch)).toBeFocused()
    const contained = await pager(branch).evaluate(element => {
      const area = element.closest('[role="tree"]').getBoundingClientRect()
      return [...element.querySelectorAll('button')].every(button => {
        const bounds = button.getBoundingClientRect()
        return bounds.left >= area.left - 1 && bounds.right <= area.right + 1
      })
    })
    assert(contained, 'Wide-branch page controls overflowed the tree')
    await page.screenshot({ path: join(artifacts, `${width}-wide-paging.png`) })
    await oneTabStop()
  }
  await pager(branch).focus()
  await page.keyboard.press('Home')
  await hold(branch + '/child-00000')
  await item('child-00000').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await navigate('/work')
  await reply(branch + '/child-00000')
  await settle()
  await expect(tree.getByRole('treeitem')).toHaveCount(100)
  await expect(tree.locator('[data-folder-pager]')).toHaveCount(0)
  await expect(item('late-grandchild')).toHaveCount(0)
  assert(await page.evaluate(path => window.fixtureRequests.some(request => request.path === path && request.aborted), branch + '/child-00000'))
  assert.deepEqual(await page.evaluate(() => window.fixturePicks), ['/work/folder-099', '/wide/folder-09999'])
  assert.deepEqual(errors, [])
  await writeFile(join(artifacts, 'requests.json'), JSON.stringify(await page.evaluate(() => window.fixtureRequests), null, 2) + '\n')
  console.log('PASS 10,000-child branches stay bounded; paging preserves tree focus/selection, root-only filtering, responsive controls, and stale-response cancellation')

  const opener = page.getByRole('button', { name: 'Open picker', exact: true })
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.reload()
    await expect(tree.getByRole('treeitem')).toHaveCount(100)
    await oneTabStop()
    assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Auto-open must retain focus inside the dialog')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'Auto-open must not invent an opener')
    for (const action of ['Escape', 'Cancel', 'Select folder', 'Close folder picker', 'Unmount']) {
      await opener.focus()
      await opener.press('Enter')
      await expect(tree.getByRole('treeitem')).toHaveCount(100)
      await filter.focus()
      await page.keyboard.press('Tab')
      await expect(item('folder-000')).toBeFocused()
      await oneTabStop()
      if (action === 'Escape') await page.screenshot({ path: join(artifacts, `${width}-picker.png`) })
      if (action === 'Escape') await page.keyboard.press('Escape')
      else if (action === 'Unmount') await page.evaluate(() => window.fixtureClose())
      else await dialog.getByRole('button', { name: action, exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(opener).toBeFocused()
      await settle()
      await expect(opener).toBeFocused()
      await page.screenshot({ path: join(artifacts, `${width}-close-${action.toLowerCase().replaceAll(' ', '-')}.png`) })
    }
    assert.deepEqual(await page.evaluate(() => window.fixturePicks), ['/work'])
    console.log(`PASS ${width}px auto-open without an opener; Escape, Cancel, Select, close button, and unmount restore the external opener`)
  }

  await hold('/work')
  await opener.click()
  await expect(tree).toHaveAttribute('aria-busy', 'true')
  await expect(address).toBeEditable()
  await address.fill('/alias')
  await address.press('ArrowLeft')
  const initialCaret = await address.evaluate(input => input.selectionStart)
  await reply('/work')
  await expect(tree).toHaveAttribute('aria-busy', 'false')
  await expect(tree.getByRole('treeitem')).toHaveCount(100)
  await expect(selected).toHaveText('/work')
  await expect(address).toHaveValue('/alias')
  await expect(address).toBeFocused()
  assert.equal(await address.evaluate(input => input.selectionStart), initialCaret, 'Initial loading moved the editing caret')
  await page.screenshot({ path: join(artifacts, 'initial-address-preserved.png') })
  await go.click()
  await expect(address).toHaveValue('/resolved')
  await expect(selected).toHaveText('/resolved')
  await expect(item('resolved-child')).toBeVisible()

  await hold('/alias')
  await address.fill('/alias')
  await go.click()
  await expect(tree).toHaveAttribute('aria-busy', 'true')
  await expect(address).toBeEditable()
  await address.fill('/newer')
  await reply('/alias')
  await expect(tree).toHaveAttribute('aria-busy', 'false')
  await expect(address).toHaveValue('/newer')
  await expect(address).toBeFocused()
  await expect(selected).toHaveText('/resolved')
  await expect(item('resolved-child')).toBeVisible()
  await go.click()
  await expect(selected).toHaveText('/newer')
  await expect(item('fresh')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(opener).toBeFocused()
  await writeFile(join(artifacts, 'address-requests.json'), JSON.stringify(await page.evaluate(() => window.fixtureRequests), null, 2) + '\n')
  console.log('PASS held initial/submitted responses preserve newer address edits and caret while current tree/selection and explicit canonicalization advance')

  await hold('/work')
  await opener.click()
  await expect(tree).toHaveAttribute('aria-busy', 'true')
  const initialRequest = await page.evaluate(() => window.fixtureRequests.length - 1)
  const form = dialog.locator('.folder-address')
  const requestCount = () => page.evaluate(() => window.fixtureRequests.length)
  // The omitted initial path and an empty address are the same pending request.
  await address.press('Enter')
  await form.evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  assert.equal(await requestCount(), initialRequest + 1)
  await address.pressSequentially('/alias')
  await expect(go).toBeEnabled()
  await hold('/alias')
  await address.press('Enter')
  await expect.poll(requestCount).toBe(initialRequest + 2)
  assert(await page.evaluate(index => window.fixtureRequests[index].aborted, initialRequest))
  await expect(go).toBeDisabled()
  await address.press('Enter')
  await form.evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  assert.equal(await requestCount(), initialRequest + 2, 'Duplicate pending address restarted its request')
  await reply('/work', true)
  await settle()
  await expect(tree).toHaveAttribute('aria-busy', 'true')
  await expect(address).toHaveValue('/alias')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Home folder', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Refresh folders', exact: true })).toBeDisabled()
  // Editing back to the pending spelling still preserves the address-edit counter.
  await address.fill('/newer')
  await expect(go).toBeEnabled()
  await address.fill('/alias')
  await expect(go).toBeDisabled()
  await reply('/alias')
  await expect(tree).toHaveAttribute('aria-busy', 'false')
  await expect(address).toHaveValue('/alias')
  await expect(address).toBeFocused()
  await expect(selected).toHaveText('/resolved')
  await expect(item('resolved-child')).toBeVisible()

  await hold('/alias')
  await go.click()
  await expect(tree).toHaveAttribute('aria-busy', 'true')
  await address.fill('/newer')
  await expect(go).toBeEnabled()
  await hold('/newer')
  await go.click()
  await expect.poll(requestCount).toBe(initialRequest + 4)
  assert(await page.evaluate(index => window.fixtureRequests[index].aborted, initialRequest + 2))
  await form.evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  assert.equal(await requestCount(), initialRequest + 4)
  await filter.focus()
  await reply('/alias')
  await settle()
  await expect(tree).toHaveAttribute('aria-busy', 'true')
  await expect(address).toHaveValue('/newer')
  await expect(selected).toHaveText('/resolved')
  await expect(filter).toBeFocused()
  await reply('/newer')
  await expect(tree).toHaveAttribute('aria-busy', 'false')
  await expect(address).toHaveValue('/newer')
  await expect(selected).toHaveText('/newer')
  await expect(item('fresh')).toBeVisible()
  await expect(filter).toBeFocused()
  await page.getByRole('button', { name: 'Refresh folders', exact: true }).click()
  await expect.poll(requestCount).toBe(initialRequest + 5)
  await expect(tree).toHaveAttribute('aria-busy', 'false')
  await root()
  await expect.poll(requestCount).toBe(initialRequest + 6)
  await expect(selected).toHaveText('/work')
  await writeFile(join(artifacts, 'pending-address-requests.json'), JSON.stringify(await page.evaluate(index => window.fixtureRequests.slice(index), initialRequest), null, 2) + '\n')
  console.log('PASS native new-address Enter/Go supersede pending roots; duplicate submissions stay single-flight; stale replies, address edits, selection, Home and Refresh remain correct')
  assert.deepEqual(errors, [])
  await context.close()
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png') })
  throw error
} finally {
  await browser.close()
  console.log(`Folder tree artifacts: ${artifacts}`)
}
