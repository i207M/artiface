import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../web/', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, webkit, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const origin = 'https://git-browse.invalid'
const artifacts = await mkdtemp(join(tmpdir(), 'artiface-git-'))
const logo = await readFile(`${web}/public/favicon.svg`, 'utf8')
const hosts = [{ id: 'local', kind: 'local', label: 'localhost', target: '', roots: [
  { id: 'one', label: 'Research', path: '/synthetic/research' },
  { id: 'two', label: 'Other project', path: '/synthetic/other' },
] }]
const projects = hosts[0].roots.map(root => ({ host: 'local', root: root.id }))
const status = (branch = 'main', changes = [
  { path: 'notes.py', index: '.', worktree: 'M' }, { path: 'README.md', index: 'A', worktree: '.' },
  { path: 'removed.txt', index: '.', worktree: 'D' }, { path: 'scratch', index: '?', worktree: '?', directory: true },
]) => ({ state: 'ready', branch, changes, checkedAt: new Date().toISOString(), retryAt: new Date(Date.now() + 30_000).toISOString() })
const statuses = { one: status(), two: status('other-branch', []) }
const bundle = await rolldown({
  cwd: web, input: 'fixture:git', platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'git-browse',
    resolveId(id) {
      if (id === 'fixture:git') return '\0fixture.tsx'
      if (id.endsWith('.css')) return '\0asset'
      if (id.includes('.svg?')) return '\0logo'
      if (id === './FilePreview') return '\0reader.tsx'
    },
    load(id) {
      if (id === '\0asset') return 'export default ""'
      if (id === '\0logo') return `export default ${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(logo)}`)}`
      if (id === '\0reader.tsx') return `import React from 'react'
        export default function Reader({location}) { return <section className="file-preview fixture-original" aria-label={'Original '+location.path}>
          <div className="preview-toolbar" role="toolbar" aria-label="Reader toolbar"><button className="icon-button" aria-label="Original file control">F</button></div>
          <div className="source-scroll" tabIndex={0}>Original file content</div></section> }`
      if (id === '\0fixture.tsx') return `
        import {createRoot} from 'react-dom/client'
        import Workspace from '${web}/src/components/Workspace'
        import {useLocation} from '${web}/src/location'
        import {setPreferences} from '${web}/src/preferences'
        import {SettingsDraftProvider} from '${web}/src/SettingsDrafts'
        window.fixturePreferences = setPreferences
        function Fixture() {
          const [location, navigate] = useLocation()
          window.fixtureNavigate = navigate
          return <Workspace location={location} navigate={navigate} onLogout={()=>{}}/>
        }
        createRoot(document.getElementById('root')).render(<SettingsDraftProvider><Fixture/></SettingsDraftProvider>)
      `
    },
  }],
})
const { output } = await bundle.generate({ format: 'iife', codeSplitting: false })
await bundle.close()
const script = output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['components/git.css', 'components/settings.css', 'components/workspace.css', 'viewers.css', 'styles.css']
  .map(path => readFile(`${web}/src/${path}`, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const browser = await (process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, hasTouch: process.env.ARTIFACE_TOUCH === '1', serviceWorkers: 'block' })
  context.setDefaultTimeout(8000)
  await context.addInitScript(({ projects }) => {
    if (!localStorage.getItem('artiface.preferences.v1')) localStorage.setItem('artiface.preferences.v1', JSON.stringify({ gitStatus: true, autoRefreshSeconds: 300 }))
    if (!sessionStorage.getItem('artiface.workspace.v1')) sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({ projects, tabs: [] }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text } } })
    const timeout = window.setTimeout
    window.delays = []
    window.setTimeout = (callback, delay, ...args) => {
      window.delays.push(delay)
      return timeout(callback, delay, ...args)
    }
  }, { projects })
  const errors = []
  let heldStatus, heldDiff, holdStatus = true, holdDiff = false, oversizedDiff = false
  let checks = 0, diffs = 0, metadataReads = 0
  let patch = 'diff --git a/notes.py b/notes.py\n@@ -1 +1 @@\n-before\n+<script>window.diffExecuted=true</script>\n'
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    const root = url.searchParams.get('root')
    let body
    if (url.pathname === '/api/hosts') body = { revision: 'fixture', setupEnabled: false, hosts }
    if (url.pathname === '/api/workspace/projects') body = { projects, sourcesRevision: 'fixture' }
    if (url.pathname === '/api/file-info') { metadataReads++; body = { modified: '2026-10-08T12:00:00Z', version: 'fixture' } }
    if (url.pathname === '/api/list') body = { entries: (url.searchParams.get('path') === 'scratch' ? ['scratch/new.txt'] : ['notes.py', 'README.md', 'scratch']).map(path => ({
      name: path.split('/').at(-1), path, type: path === 'scratch' ? 'directory' : 'file', size: 42, modified: '2026-10-08T12:00:00Z',
    })) }
    if (url.pathname === '/api/settings') body = {
      revision: 'fixture', mode: 'personal', buildTime: '2026-10-09T12:00:00Z', gitCommit: 'fixture',
      config: { listen: '127.0.0.1:8787', appOrigin: origin, previewOrigin: origin, sessionHours: 12, hosts, openProjects: projects },
    }
    if (url.pathname === '/api/ignore') body = { content: '.git/\n', exists: true, defaultContent: '.git/\n' }
    if (url.pathname === '/api/git/status') {
      checks++
      if (holdStatus) { heldStatus = route; holdStatus = false; return }
      body = statuses[root]
    }
    if (url.pathname === '/api/git/diff') {
      diffs++
      if (oversizedDiff) return route.fulfill({ status: 413, json: { error: 'Diff previews support file versions up to 8 MiB.' } })
      if (holdDiff) { heldDiff = route; holdDiff = false; return }
      body = { patch, truncated: false }
    }
    if (!body) errors.push(`Unexpected request: ${url.pathname}`)
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? {}) })
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const navigate = async (root, path = '') => page.evaluate(location => window.fixtureNavigate(location), { host: 'local', root, path, kind: 'directory' })
  await page.goto(`${origin}/#host=local&root=one&path=&kind=directory`)
  await expect(page.getByRole('table', { name: 'Directory contents' })).toBeVisible()
  await expect.poll(() => Boolean(heldStatus)).toBe(true)
  assert.equal(diffs, 0)
  await expect(page.getByRole('link', { name: 'notes.py', exact: true })).toBeVisible()
  await heldStatus.fulfill({ json: statuses.one })
  const badge = page.getByRole('button', { name: 'View Git diff for notes.py: Modified', exact: true })
  await expect(badge).toBeVisible()
  await page.screenshot({ path: join(artifacts, 'browse-desktop.png') })
  await badge.click()
  const strip = page.getByRole('tablist', { name: 'Project tabs' })
  const diffTab = strip.getByRole('tab', { name: 'notes.py · Diff', exact: true })
  const viewer = page.locator('.reader-panel:not([hidden]) .git-diff-preview')
  await expect(diffTab).toHaveAttribute('aria-selected', 'true')
  await expect(viewer.getByLabel('File diff')).toContainText('<script>')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('#project-sidebar').getByRole('button', { name: 'Open notes.py · Diff', exact: true })).toHaveAttribute('aria-current', 'page')
  assert(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('view') === 'diff')
  assert.equal(await page.evaluate(() => window.diffExecuted), undefined)
  assert.equal(diffs, 1)
  await strip.getByRole('tab', { name: 'Browse', exact: true }).click()
  await badge.click()
  await expect(diffTab).toHaveCount(1)
  await expect(viewer.getByLabel('File diff')).toBeVisible()
  assert.equal(diffs, 1, 'Reopening a retained diff should reuse its content')
  await strip.getByRole('tab', { name: 'Browse', exact: true }).click()
  await page.getByRole('link', { name: 'notes.py', exact: true }).click()
  const originalTab = strip.getByRole('tab', { name: 'notes.py', exact: true })
  await expect(originalTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Original notes.py', exact: true })).toBeVisible()
  await diffTab.click()
  await expect(viewer.getByLabel('File diff')).toBeVisible()
  assert.equal(diffs, 1)
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('artiface.workspace.v1')).tabs.map(tab => tab.view ?? 'file'))).toEqual(['diff', 'file'])
  await page.reload()
  await expect(diffTab).toHaveAttribute('aria-selected', 'true')
  await expect(originalTab).toHaveCount(1)
  await expect(viewer.getByLabel('File diff')).toBeVisible()
  assert.equal(diffs, 2, 'Reload should restore the diff tab and fetch a fresh diff')
  const reads = metadataReads
  await page.getByRole('button', { name: /^Overview/ }).click()
  const overviewDiff = page.locator('.overview-file').filter({ has: page.getByRole('button', { name: 'Open notes.py · Diff', exact: true }) })
  await expect(overviewDiff.locator('time')).toBeVisible()
  assert.equal(metadataReads - reads, 1, 'Original and diff should share one file metadata request')
  await overviewDiff.getByRole('button', { name: 'Open notes.py · Diff', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(viewer.getByLabel('Git diff', { exact: true })).toBeFocused()
  await viewer.getByRole('button', { name: 'Copy file path', exact: true }).click()
  assert.equal(await page.evaluate(() => window.copiedText), '/synthetic/research/notes.py')
  await viewer.getByRole('button', { name: 'Share link', exact: true }).click()
  assert.match(await page.evaluate(() => window.copiedText), /view=diff/)
  await viewer.getByRole('button', { name: 'Full screen', exact: true }).click()
  await expect(page.locator('.reader-expanded')).toBeVisible()
  await expect(viewer.getByRole('toolbar')).toBeHidden()
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click()
  await expect(viewer.getByRole('toolbar')).toBeVisible()
  await strip.getByRole('button', { name: 'Close notes.py · Diff', exact: true }).click()
  await expect(originalTab).toHaveAttribute('aria-selected', 'true')
  await expect(diffTab).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Original notes.py', exact: true })).toBeVisible()
  await navigate('one')
  await expect(badge).toBeVisible()
  await expect(page.getByRole('button', { name: 'Git status', exact: true })).not.toHaveAttribute('title', 'Checking Git status…')
  const count = checks
  await page.getByRole('link', { name: 'scratch', exact: true }).click()
  await expect(page.getByRole('button', { name: 'View Git diff for scratch/new.txt: Untracked', exact: true })).toBeVisible()
  assert.equal(checks, count, 'Folder navigation should reuse project status')
  await navigate('one')
  await page.getByRole('button', { name: 'Git status', exact: true }).click()
  await page.getByRole('list', { name: 'Git changes', exact: true }).getByRole('button', { name: 'Deleted removed.txt', exact: true }).click()
  await expect(strip.getByRole('tab', { name: 'removed.txt · Diff', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(viewer.getByLabel('File diff')).toBeVisible()
  await strip.getByRole('button', { name: 'Close removed.txt · Diff', exact: true }).click()
  await navigate('one')
  console.log('PASS safe diff tabs, separate file identity, sidebar/Overview, reload restoration, cache reuse, copy/share/fullscreen, deleted files and folder status reuse')

  statuses.one = { state: 'paused', message: 'Git checks paused: size limit.', checkedAt: new Date().toISOString(), retryAt: new Date(Date.now() + 600_000).toISOString() }
  await page.getByRole('button', { name: 'Git status', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh Git status', exact: true }).click()
  await expect(page.getByText(/Git checks paused: size limit/)).toBeVisible()
  assert(await page.evaluate(() => window.delays.some(delay => delay > 590_000)), 'Oversized status did not schedule a cooldown')
  statuses.one = status()
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Git changes', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
  await expect(page.locator('#browse-settings-panel').getByRole('checkbox')).toHaveCount(2)
  await expect(page.locator('#browse-settings-panel').getByRole('checkbox', { name: /Git/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Git status', exact: true }).click()
  await page.getByRole('button', { name: 'Project Git settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sources', exact: true })).toHaveAttribute('aria-current', 'page')
  const projectGit = page.getByRole('checkbox', { name: 'Git status for Research on localhost', exact: true })
  await projectGit.uncheck()
  await expect(page.getByRole('checkbox', { name: 'Git status for Other project on localhost', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Git status', exact: true })).toHaveCount(0)
  await navigate('two')
  await expect(page.getByRole('button', { name: 'Git status', exact: true })).toContainText('other-branch')
  await navigate('one')
  await expect(page.getByRole('button', { name: 'Git status', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('table', { name: 'Directory contents' })).toBeVisible()
  await expect(badge).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByText('Choose projects', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: /^Git status for / })).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Show Git status in Browse', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Sources', exact: true }).click()
  await expect(projectGit).toBeDisabled()
  await expect(projectGit).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Git status for Other project on localhost', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  const disabledChecks = checks
  await navigate('two')
  await expect(page.getByRole('table', { name: 'Directory contents' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Git status', exact: true })).toHaveCount(0)
  assert.equal(checks, disabledChecks)
  console.log('PASS automatic cooldown, Git-menu link to Sources, persistent project switches and independent global Appearance switch')

  await page.evaluate(() => window.fixturePreferences({ gitStatus: true, disabledGitProjects: [] }))
  await navigate('one')
  await expect(badge).toBeVisible()
  holdDiff = true
  await badge.click()
  await expect.poll(() => Boolean(heldDiff)).toBe(true)
  await navigate('two')
  await expect(viewer).toHaveCount(0)
  await heldDiff.fulfill({ json: { patch: 'OBSOLETE DIFF', truncated: false } }).catch(() => {})
  await expect(page.getByText('OBSOLETE DIFF')).toHaveCount(0)
  await navigate('one')
  await diffTab.click()
  await expect(viewer.getByLabel('File diff')).toContainText('<script>')

  heldDiff = null
  holdDiff = true
  await viewer.getByRole('button', { name: 'Refresh diff', exact: true }).click()
  await expect.poll(() => Boolean(heldDiff)).toBe(true)
  await expect(viewer.getByLabel('File diff')).toContainText('<script>')
  await originalTab.click()
  await heldDiff.fulfill({ json: { patch: 'OBSOLETE REFRESH', truncated: false } }).catch(() => {})
  await expect(page.getByText('OBSOLETE REFRESH')).toHaveCount(0)
  patch = '@@ -1 +1 @@\n-old\n+Updated diff\n'
  await diffTab.click()
  await expect(viewer.getByLabel('File diff')).toContainText('Updated diff')
  const cachedDiffs = diffs
  await originalTab.click()
  await diffTab.click()
  await expect(viewer.getByLabel('File diff')).toContainText('Updated diff')
  assert.equal(diffs, cachedDiffs)

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 850 })
    for (const density of ['compact', 'comfortable']) {
      for (const fontScale of [1, 1.4]) {
        await page.evaluate(options => window.fixturePreferences(options), { density, fontScale })
        await diffTab.click()
        const previewHeight = await viewer.getByRole('toolbar').evaluate(element => element.getBoundingClientRect().height)
        await strip.getByRole('tab', { name: 'Browse', exact: true }).click()
        const heights = await page.locator('.browse-toolbar').evaluate(element => {
          const rows = [...element.querySelectorAll('.browse-location-row, .browse-controls-row')]
          return (getComputedStyle(rows[0]).display === 'contents' ? [element] : rows).map(row => row.getBoundingClientRect().height)
        })
        for (const height of heights) assert(Math.abs(height - previewHeight) <= 1, `${width}px ${density} font ${fontScale}: Browse ${height}px vs preview ${previewHeight}px`)
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Toolbar overflow at ${width}px`)
      }
    }
  }
  await page.setViewportSize({ width: 320, height: 740 })
  await page.evaluate(() => window.fixturePreferences({ theme: 'dark', browseView: 'icons', density: 'compact', fontScale: 1 }))
  await navigate('one')
  await expect(badge).toBeVisible()
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await badge.click()
  await expect(viewer.getByLabel('File diff')).toBeVisible()
  assert(await viewer.evaluate(element => element.getBoundingClientRect().width <= innerWidth))
  await page.screenshot({ path: join(artifacts, 'diff-phone-dark.png') })
  oversizedDiff = true
  await page.evaluate(() => window.fixtureNavigate({ host: 'local', root: 'one', path: 'large.pdf', kind: 'file', view: 'diff' }))
  await expect(strip.getByRole('tab', { name: 'large.pdf · Diff', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(viewer.getByText(/file versions up to 8 MiB/)).toBeVisible()
  await expect(viewer.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Original large.pdf', exact: true })).toHaveCount(0)
  assert.deepEqual(errors, [])
  console.log('PASS canceled loads/refreshes, retained diff cache, PDF diff routing and narrow dark layout')
  console.log('PASS Browse/preview toolbar heights match across desktop/phone, compact/comfortable and enlarged text')
  console.log(`Git UI previews: ${artifacts}`)
  await context.close()
} finally { await browser.close() }
