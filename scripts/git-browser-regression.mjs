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
const hash = number => number.toString(16).repeat(40)
const historyCommits = [
  [6, [5, 4], 'Merge feature\n\nA complete merge message with <script>literal text</script>.', ['HEAD → main', 'origin/main']],
  [5, [2], 'Update main', []],
  [4, [3], 'Finish feature', ['feature', 'tag: v1']],
  [3, [2], 'Start feature', []],
  [2, [1], 'Add report', []],
  [1, [], 'Initial commit', []],
].map(([number, parents, message, refs]) => ({ hash: hash(number), parents: parents.map(hash), message, refs, author: 'Fixture author', email: 'fixture@invalid', date: '2026-10-14T10:00:00Z' }))
const commitDetails = commit => ({
  ...commit, committer: 'Fixture committer', committerEmail: 'committer@invalid', commitDate: '2026-10-14T11:00:00Z',
  files: commit.hash === hash(5) ? [] : [
    { path: 'README.md', status: 'M' }, { path: 'reports/src/plot.py', status: 'A' },
    { path: 'reports/data/metrics.csv', status: 'M' }, { path: 'reports/old.txt', status: 'D' },
  ], truncated: false,
})
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
const css = (await Promise.all(['components/git.css', 'components/gitHistory.css', 'components/gitDiff.css', 'components/settings.css', 'components/workspace.css', 'viewers.css', 'styles.css']
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
  let historyReads = 0, historyChanged = false, holdHistory = false, heldHistory
  let commitReads = 0, holdCommit = false, heldCommit
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
    if (url.pathname === '/api/git/history') {
      historyReads++
      if (holdHistory) { heldHistory = route; holdHistory = false; return }
      const offset = Number(url.searchParams.get('offset') || 0)
      if (offset && historyChanged) return route.fulfill({ status: 409, json: { error: 'Branches changed while loading history. Refresh history to continue.' } })
      if (offset) assert.equal(url.searchParams.get('revision'), 'a'.repeat(64))
      body = { commits: offset ? historyCommits.slice(offset) : historyCommits.slice(0, 4), revision: 'a'.repeat(64), hasMore: !offset, scoped: false, head: hash(6) }
    }
    if (url.pathname === '/api/git/commit') {
      commitReads++
      if (holdCommit) { heldCommit = route; holdCommit = false; return }
      body = commitDetails(historyCommits.find(commit => commit.hash === url.searchParams.get('commit')))
    }
    if (!body) errors.push(`Unexpected request: ${url.pathname}`)
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? {}) })
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const settleLayout = () => page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
  })
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
  await expect(viewer.getByLabel('File diff')).toHaveAttribute('data-layout', 'split')
  await expect(viewer.locator('.git-split-cell.diff-remove .git-line-number')).toHaveText('1')
  await expect(viewer.locator('.git-split-cell.diff-add .git-line-number')).toHaveText('1')
  await viewer.getByRole('button', { name: 'Inline diff', exact: true }).click()
  await expect(viewer.getByLabel('File diff')).toHaveAttribute('data-layout', 'inline')
  await expect(viewer.locator('.git-inline-row.diff-remove .git-line-number')).toHaveText(['1', ''])
  await expect(viewer.locator('.git-inline-row.diff-add .git-line-number')).toHaveText(['', '1'])
  assert.equal(diffs, 1, 'Switching diff layout refetched the patch')
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

  await page.getByRole('button', { name: 'Git status', exact: true }).click()
  await page.getByRole('button', { name: 'View Git history', exact: true }).click()
  const historyTab = strip.getByRole('tab', { name: 'Git history', exact: true })
  const history = page.locator('.reader-panel:not([hidden]) .git-history-preview')
  await expect(historyTab).toHaveAttribute('aria-selected', 'true')
  await expect(history.locator('.git-history-row')).toHaveCount(4)
  await expect(history.getByLabel('Commit history')).toBeFocused()
  await expect(history.locator('.git-graph-node').first()).toBeVisible()
  assert.match(page.url(), /view=history/)
  assert.equal(commitReads, 0, 'Collapsed rows loaded changed files')
  const firstRow = history.locator('.git-history-row').first()
  const subject = firstRow.locator('.git-history-subject > span:last-child')
  const subjectBox = await subject.boundingBox()
  await page.mouse.move(subjectBox.x + 1, subjectBox.y + subjectBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(subjectBox.x + subjectBox.width + 1, subjectBox.y + subjectBox.height / 2, { steps: 12 })
  await page.mouse.up()
  assert.match(await page.evaluate(() => getSelection().toString()), /Merge feature/, 'Commit message cannot be selected by dragging')
  await expect(firstRow).toHaveAttribute('aria-expanded', 'false')
  assert.equal(commitReads, 0, 'Selecting text expanded the commit')
  await page.evaluate(() => getSelection().removeAllRanges())
  await history.locator('.git-history-row').first().click()
  const expansion = history.getByRole('region', { name: 'Commit changes', exact: true })
  const metadata = history.locator('.git-commit-metadata')
  await expect(expansion.getByRole('list', { name: 'Changed files', exact: true })).toBeVisible()
  await expect(expansion).toContainText('<script>literal text</script>')
  assert(await firstRow.evaluate(row => row.nextElementSibling?.classList.contains('git-commit-expanded')), 'Commit did not expand directly below its row')
  await expect(metadata).toHaveJSProperty('open', false)
  await expect(metadata.getByText('Fixture committer <committer@invalid>', { exact: true })).toBeHidden()
  await expect(expansion.getByText('Compared with first parent', { exact: true })).toBeVisible()
  await expect(expansion.getByText('plot.py', { exact: true })).toBeVisible()
  await expansion.locator('summary').getByText('reports', { exact: true }).click()
  await expect(expansion.getByText('plot.py', { exact: true })).toBeHidden()
  await expansion.locator('summary').getByText('reports', { exact: true }).click()
  await expect(expansion.getByText('plot.py', { exact: true })).toBeVisible()
  await firstRow.locator('.git-history-hash').dblclick()
  assert.equal(await page.evaluate(() => getSelection().toString()), hash(6), 'Double-click did not select the complete commit ID')
  await expect(firstRow).toHaveAttribute('aria-expanded', 'true')
  await page.evaluate(() => {
    window.nativeCopiedSelection = ''
    document.addEventListener('copy', () => { window.nativeCopiedSelection = getSelection().toString() }, { once: true })
  })
  await page.keyboard.press('Control+c')
  assert.equal(await page.evaluate(() => window.nativeCopiedSelection), hash(6), 'Native copy did not receive the selected ID')
  const messageRects = await expansion.locator('.git-commit-message').evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))
  })
  const messageStart = messageRects[0], messageEnd = messageRects.at(-1)
  await page.mouse.move(messageStart.x + 1, messageStart.y + messageStart.height / 2)
  await page.mouse.down()
  await page.mouse.move(messageEnd.x + messageEnd.width + 1, messageEnd.y + messageEnd.height / 2, { steps: 12 })
  await page.mouse.up()
  assert.equal((await page.evaluate(() => getSelection().toString())).trimEnd(), historyCommits[0].message.trimEnd(), 'Full commit message cannot be selected by dragging')
  await expect(firstRow).toHaveAttribute('aria-expanded', 'true')
  await metadata.locator('summary').click()
  await expect(metadata).toHaveJSProperty('open', true)
  await expect(metadata.getByText('Fixture committer <committer@invalid>', { exact: true })).toBeVisible()
  await expect(metadata.getByText(hash(5), { exact: true })).toBeVisible()
  assert.equal(commitReads, 1, 'Opening metadata refetched the commit')
  await expect(history.locator('script')).toHaveCount(0)
  await expect(history.getByRole('button', { name: 'Copy commit ID', exact: true })).toHaveCount(0)
  await history.getByRole('button', { name: 'Share link', exact: true }).click()
  assert.match(await page.evaluate(() => window.copiedText), /view=history/)
  await history.locator('.git-history-row').first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(history.locator('.git-history-row').nth(1)).toBeFocused()
  assert.equal(commitReads, 1, 'Arrow navigation fetched commit details before activation')
  await page.keyboard.press('Enter')
  await expect(expansion).toContainText('Update main')
  await expect(expansion).toContainText('No file changes in this project.')
  await expect(metadata).toHaveJSProperty('open', false)
  await page.keyboard.press('Space')
  await expect(expansion).toHaveCount(0)
  holdCommit = true
  await history.locator('.git-history-row').nth(2).click()
  await expect.poll(() => Boolean(heldCommit)).toBe(true)
  await history.locator('.git-history-row').nth(3).click()
  await expect(expansion.getByRole('list', { name: 'Changed files', exact: true })).toBeVisible()
  await heldCommit.fulfill({ json: { ...commitDetails(historyCommits[2]), files: [{ path: 'OBSOLETE-COMMIT.txt', status: 'A' }] } }).catch(() => {})
  await expect(page.getByText('OBSOLETE-COMMIT.txt')).toHaveCount(0)
  await expect(expansion).toContainText('Start feature')
  await history.locator('.git-history-row').nth(3).locator('.git-history-disclosure').click()
  await expect(expansion).toHaveCount(0)
  await history.getByRole('button', { name: 'Load older commits', exact: true }).click()
  await expect(history.locator('.git-history-row')).toHaveCount(6)
  await expect(history.getByRole('button', { name: 'Load older commits', exact: true })).toHaveCount(0)
  const cachedHistoryReads = historyReads
  await strip.getByRole('tab', { name: 'Browse', exact: true }).click()
  await page.getByRole('button', { name: 'Git status', exact: true }).click()
  await page.getByRole('button', { name: 'View Git history', exact: true }).click()
  await expect(historyTab).toHaveCount(1)
  await expect(history.locator('.git-history-row')).toHaveCount(6)
  assert.equal(historyReads, cachedHistoryReads)
  await page.reload()
  await expect(historyTab).toHaveAttribute('aria-selected', 'true')
  await expect(history.locator('.git-history-row')).toHaveCount(4)
  assert.equal(historyReads, cachedHistoryReads + 1)
  const historyMetadataReads = metadataReads
  await page.getByRole('button', { name: /^Overview/ }).click()
  const overviewHistory = page.locator('.overview-file').filter({ has: page.getByRole('button', { name: 'Open Git history', exact: true }) })
  await expect(overviewHistory).toBeVisible()
  await expect(overviewHistory.locator('.overview-modified')).toHaveCount(0)
  assert.equal(metadataReads - historyMetadataReads, 1, 'History tab requested file metadata')
  await overviewHistory.getByRole('button', { name: 'Open Git history', exact: true }).click()
  await expect(history.locator('.git-history-row')).toHaveCount(4)
  historyChanged = true
  await history.getByRole('button', { name: 'Load older commits', exact: true }).click()
  await expect(history.getByRole('status')).toContainText('Branches changed')
  await expect(history.getByRole('button', { name: 'Load older commits', exact: true })).toBeDisabled()
  historyChanged = false
  await history.getByRole('status').getByRole('button', { name: 'Refresh history', exact: true }).click()
  await expect(history.getByRole('status')).toHaveCount(0)
  await expect(history.locator('.git-history-row')).toHaveCount(4)
  await history.locator('.git-history-row').first().click()
  await expect(expansion.getByRole('list', { name: 'Changed files', exact: true })).toBeVisible()
  await page.screenshot({ path: join(artifacts, 'history-desktop.png') })
  for (const density of ['compact', 'comfortable']) for (const fontScale of [1, 1.4]) {
    await page.setViewportSize({ width: 320, height: 740 })
    await page.evaluate(options => window.fixturePreferences(options), { density, fontScale })
    await settleLayout()
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'History overflowed the phone workspace')
    assert(await history.evaluate(element => {
      const box = element.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && box.width >= innerWidth - 1
    }), 'History was obscured by a docked sidebar on the phone')
    await expect(history.getByRole('button', { name: 'Refresh history', exact: true })).toBeVisible()
  }
  await page.screenshot({ path: join(artifacts, 'history-phone.png') })
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.evaluate(() => window.fixturePreferences({ density: 'compact', fontScale: 1 }))
  holdHistory = true
  await history.getByRole('button', { name: 'Refresh history', exact: true }).click()
  await expect.poll(() => Boolean(heldHistory)).toBe(true)
  await navigate('two')
  await heldHistory.fulfill({ json: { commits: [{ ...historyCommits[0], message: 'OBSOLETE HISTORY' }], revision: 'a'.repeat(64), hasMore: false, scoped: false } }).catch(() => {})
  await expect(page.getByText('OBSOLETE HISTORY')).toHaveCount(0)
  await navigate('one')
  await historyTab.click()
  await expect(history.locator('.git-history-row')).toHaveCount(4)
  await strip.getByRole('button', { name: 'Close Git history', exact: true }).click()
  await expect(historyTab).toHaveCount(0)
  await navigate('one')
  console.log('PASS selectable history, native copy, inline commit/file trees, collapsed metadata, stale detail requests, paging, restoration and phone layout')

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
        const controlsFit = await viewer.getByRole('toolbar').evaluate(toolbar => {
          const box = toolbar.getBoundingClientRect()
          return [...toolbar.querySelectorAll('button')].every(button => {
            const rect = button.getBoundingClientRect()
            return rect.left >= box.left && rect.right <= box.right
          })
        })
        assert(controlsFit, `Diff controls overflow at ${width}px ${density} font ${fontScale}`)
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
  await expect(viewer.getByLabel('File diff')).toHaveAttribute('data-layout', 'inline')
  await viewer.getByRole('button', { name: 'Side-by-side diff', exact: true }).click()
  await expect(viewer.getByLabel('File diff')).toHaveAttribute('data-layout', 'split')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Side-by-side diff overflowed the workspace')
  await page.setViewportSize({ width: 1440, height: 900 })
  await settleLayout()
  await page.screenshot({ path: join(artifacts, 'diff-split-desktop.png') })
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
