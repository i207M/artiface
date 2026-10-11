import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPreviewScriptBoundary } from './preview-security.mjs'
import { checkPWA } from './pwa-smoke.mjs'
import { checkSharedProjects } from './shared-projects.mjs'
import { checkPDFCompression } from './pdf-compression.mjs'
import { checkPDFCompatibility } from './pdf-compatibility.mjs'
import { checkPDFFind } from './pdf-find.mjs'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const origin = process.env.ARTIFACE_TEST_URL
const password = process.env.ARTIFACE_TEST_PASSWORD
const artifactRoot = process.env.ARTIFACE_TEST_ROOT
const localFixtureRoot = process.env.ARTIFACE_TEST_LOCAL_ROOT
const spareHost = process.env.ARTIFACE_TEST_SPARE
assert(origin && password && artifactRoot && localFixtureRoot && spareHost, 'Run this through scripts/smoke.py --browser')
const screenshots = fileURLToPath(new URL('../.local/screenshots/', import.meta.url))
await mkdir(screenshots, { recursive: true })
const fixtureDirectory = dirname(await realpath(artifactRoot))
assert(/^ssh-smoke-/.test(basename(fixtureDirectory)) &&
  dirname(fixtureDirectory) === await realpath(fileURLToPath(new URL('../.local/', import.meta.url))) &&
  dirname(await realpath(localFixtureRoot)) === fixtureDirectory, 'Mutation checks require smoke.py-owned temporary fixtures')
const initialPasswordHash = JSON.parse(await readFile(join(fixtureDirectory, 'config.json'), 'utf8')).passwordHash
const originals = new Map()
let mutation = 0
async function mutateFixture(relative, contents) {
  assert(['reports/notes.md', 'reports/index.html', 'reports/report.pdf', 'reports/metrics.csv'].includes(relative), 'Unexpected mutation target')
  const filename = join(artifactRoot, relative)
  assert.equal(await realpath(filename), filename, 'Fixture mutation must not follow a symlink')
  if (!originals.has(filename)) originals.set(filename, await readFile(filename))
  await writeFile(filename, contents)
  // SFTP v3 timestamps have second precision; guarantee a distinct version
  // without sleeps or relying on a different payload length.
  const modified = new Date(Date.now() + (++mutation * 2000))
  await utimes(filename, modified, modified)
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.ARTIFACE_CHROMIUM ? { executablePath: process.env.ARTIFACE_CHROMIUM } : {}),
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
// Git has focused UI coverage and real SSH checks in smoke.py; keep its extra
// row controls out of unrelated keyboard and toolbar geometry assertions.
await context.addInitScript(origin => {
  if (window.top !== window || location.origin !== origin) return
  const preferences = JSON.parse(localStorage.getItem('artiface.preferences.v1') || '{}')
  localStorage.setItem('artiface.preferences.v1', JSON.stringify({ ...preferences, gitStatus: false }))
}, origin)
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
const page = await context.newPage()
context.setDefaultTimeout(20_000)
context.setDefaultNavigationTimeout(20_000)
const pageErrors = []
let buildInfoVerified = false
page.on('pageerror', error => pageErrors.push(error.message))
const requests = []
page.on('request', request => {
  const url = new URL(request.url())
  if ((url.origin === origin && url.pathname.startsWith('/api/')) || url.pathname.startsWith('/p/')) {
    requests.push({ endpoint: url.pathname, query: url.searchParams, method: request.method() })
  }
})
const remote = { host: 'smoke', root: 'artifacts' }
const directoryTable = target => target.getByRole('table', { name: 'Directory contents' })
const directoryGrid = target => target.getByRole('list', { name: 'Directory contents' })
const projectTabs = target => target.getByRole('tablist', { name: 'Project tabs' })
const activeReader = target => target.locator('.reader-panel:not([hidden])')
const htmlFrameSelector = '.reader-panel:not([hidden]) .html-viewer iframe:not(.pending-preview)'
const postResponse = endpoint => page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST')

function artifactURL(path, kind = 'file', source = remote) {
  return origin + '/#' + new URLSearchParams({ ...source, path, kind })
}

async function open(path, kind = 'file', source = remote, target = page) {
  await target.goto(artifactURL(path, kind, source))
  if (kind === 'file') await expect(target.getByRole('heading', { name: path.split('/').at(-1), exact: true })).toBeVisible()
  else await expect(target.getByRole('tabpanel', { name: 'Browse', exact: true })).toBeVisible()
}

async function shot(name, target = page) {
  await target.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true, animations: 'disabled' })
}

async function settings(section = 'Appearance') {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.locator('.settings-header')).toHaveCount(1)
  await expect(page.locator('.app-header:visible,.project-topline:visible')).toHaveCount(0)
  const back = await page.getByRole('button', { name: 'Back to workspace', exact: true }).boundingBox()
  const title = await page.getByRole('heading', { name: 'Settings', exact: true }).boundingBox()
  assert(back && title && back.x < title.x && Math.abs(back.y - title.y) < 20, 'Settings back button is not at the left of its single header')
  if (!buildInfoVerified) {
    const info = await (await context.request.get(origin + '/api/settings')).json()
    assert(Number.isFinite(Date.parse(info.buildTime)), 'The application build has no compilation timestamp')
    assert(/^[a-f0-9]{40}(-dirty)?$/.test(info.gitCommit), 'The application build has no Git commit')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'About', exact: true }).click()
    await expect(page.getByLabel('Git commit', { exact: true })).toHaveText(info.gitCommit)
    await expect(page.getByLabel('Build time', { exact: true })).toHaveAttribute('datetime', info.buildTime)
    await shot('about-desktop')
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 320, height: 700 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'About overflows a narrow screen')
    await expect(page.getByLabel('Git commit', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Build time', { exact: true })).toBeVisible()
    await shot('about-mobile')
    await page.setViewportSize(viewport)
    buildInfoVerified = true
  }
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
  assert.equal(await page.getByRole('combobox', { name: /Sidebar/ }).count(), 0, 'Sidebar behavior belongs in the sidebar')
  assert.equal(await page.getByRole('checkbox', { name: /Show sidebar/ }).count(), 0, 'Sidebar visibility belongs in the sidebar')
  await expect(page.getByRole('checkbox', { name: /Filter (Browse )?by file type/i })).toHaveCount(0)
}

async function returnToWorkspace() {
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  await expect(page.locator('.settings-page')).toHaveCount(0)
}

async function readerOptions(target = page) {
  const toggle = target.getByRole('button', { name: 'Reader options', exact: true })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
}

async function readerAction(name, target = page) {
  if (!await target.getByRole('button', { name, exact: true }).isVisible()) await readerOptions(target)
  await target.getByRole('button', { name, exact: true }).click()
}

async function expectRefreshPaused(paused, target = page) {
  const name = paused ? 'Resume automatic refresh' : 'Pause automatic refresh'
  if (!await target.getByRole('button', { name, exact: true }).isVisible()) await readerOptions(target)
  await expect(target.getByRole('button', { name, exact: true })).toBeVisible()
  if (await target.getByRole('button', { name: 'Reader options', exact: true }).getAttribute('aria-expanded') === 'true') await target.keyboard.press('Escape')
}

async function expectOverviewFallback(reason) {
  await expect(page.getByRole('heading', { name: 'Open files', exact: true }), reason).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Project unavailable', exact: true }), reason).toHaveCount(0)
  assert.equal(new URLSearchParams(page.url().split('#')[1]).get('kind'), 'overview', reason)
}

async function assertProjectChrome(target = page) {
  // The project strip remains mounted behind an overlay, while intentionally inert.
  const strip = target.locator('[role="tablist"][aria-label="Project tabs"]')
  await expect(strip.locator('[role="tab"]').first()).toHaveText('Browse')
  await expect(strip.locator('.browse-tab [aria-label^="Close "]')).toHaveCount(0)
  await expect(target.locator('.app-header')).toHaveCount(0)
  await expect(target.getByRole('button', { name: /^(Browse|Read)$/, exact: true })).toHaveCount(0)
  await expect(target.locator('[aria-label="Show project sidebar"]:visible,[aria-label="Hide project sidebar"]:visible')).toHaveCount(1)
  await expect(target.getByRole('combobox', { name: /^(Host|Machine|Project)$/, exact: true })).toHaveCount(0)
  await expect(target.getByRole('button', { name: 'Import SSH config', exact: true })).toHaveCount(0)
  await expect(target.locator('[aria-label="Open projects"]').getByText('Browse', { exact: true })).toHaveCount(0)
  await expect(target.locator('[aria-label="Open projects"]').getByRole('button', { name: /^Browse / })).toHaveCount(0)
  const untitled = await target.locator('.icon-button[aria-label]:visible').evaluateAll(buttons =>
    buttons.filter(button => !button.getAttribute('title')?.trim()).map(button => button.getAttribute('aria-label')))
  assert.deepEqual(untitled, [], 'Icon controls omitted native hover titles')
  const reveal = target.getByRole('button', { name: 'Show project sidebar', exact: true })
  if (await reveal.isVisible()) await expect(reveal.locator('svg.lucide-panel-left-open')).toHaveCount(1)
}

async function projectTrust(enabled) {
  await settings('Sources')
  const checkbox = page.getByRole('checkbox', { name: 'Allow scripts in Artifacts', exact: true })
  if (await checkbox.isChecked() !== enabled) {
    const saving = postResponse('/api/settings')
    await checkbox.click()
    const response = await saving
    assert.equal(response.status(), 200)
    const project = (await response.json()).config.hosts.find(host => host.id === remote.host).roots.find(root => root.id === remote.root)
    assert.equal(Boolean(project.trustedScripts), enabled)
    await expect(checkbox).toBeChecked({ checked: enabled })
  }
  await returnToWorkspace()
}

async function removeSource(kind, name, hostLabel = name, cancelFirst = false) {
  const label = kind === 'host' ? `Remove host ${name}` : `Remove project ${name} on ${hostLabel}`
  const trigger = page.getByRole('button', { name: label, exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: `Remove ${kind} “${name}”?`, exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/files and folders will remain/i)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  if (cancelFirst) {
    const before = requests.filter(request => request.endpoint === '/api/settings' && request.method === 'POST').length
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    assert.equal(requests.filter(request => request.endpoint === '/api/settings' && request.method === 'POST').length, before, 'Cancelling deletion wrote configuration')
    await trigger.click()
  }
  const adminPassword = dialog.getByLabel('Admin password', { exact: true })
  if (kind === 'host' && await adminPassword.isVisible()) await adminPassword.fill(password)
  const saving = postResponse('/api/settings')
  await dialog.getByRole('button', { name: `Remove ${kind}`, exact: true }).click()
  const response = await saving
  assert.equal(response.status(), 200, `Removing ${kind} failed: ${await response.text()}`)
  assert(response.request().postDataJSON().revision, 'Deletion omitted the optimistic config revision')
  await expect(dialog).toHaveCount(0)
  return (await response.json()).config
}

async function sourcesAfterReload() {
  await page.reload()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sources', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Machines & Projects', exact: true })).toBeVisible()
}

async function settingsProject(hostLabel, path, label) {
  const card = page.locator('.source-card').filter({ has: page.getByRole('heading', { name: hostLabel, exact: true }) })
  await card.getByRole('button', { name: 'Add project', exact: true }).click()
  await page.locator('.project-setup input[name="path"]').fill(path)
  await page.getByLabel('Project name', { exact: false }).fill(label)
  const saving = postResponse('/api/projects')
  await page.locator('.project-setup').getByRole('button', { name: 'Add project', exact: true }).click()
  const response = await saving
  assert.equal(response.status(), 200, `Restoring ${label} failed: ${await response.text()}`)
  await expect(page.getByRole('checkbox', { name: `Allow scripts in ${label}`, exact: true })).toBeVisible()
  return response.json()
}

async function addProject() {
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Open a project', exact: true })).toBeVisible()
}

async function savedProject(label) {
  const choice = page.locator('.saved-project').filter({ has: page.getByText(label, { exact: true }) })
  await expect(choice).toHaveCount(1)
  await choice.click()
  await expect(projectTabs(page).getByRole('tab', { name: 'Browse', exact: true })).toHaveAttribute('aria-selected', 'true')
}

async function overview() {
  await page.getByRole('button', { name: /^Overview\b/ }).click()
  await expect(page.getByRole('heading', { name: 'Open files', exact: true })).toBeVisible()
}

async function workspaceSession(target = page) {
  return target.evaluate(() => JSON.parse(sessionStorage.getItem('artiface.workspace.v1') || 'null'))
}

async function noOverflow(target, label) {
  const widths = await target.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
  assert(widths.page <= widths.viewport + 1 && widths.body <= widths.viewport + 1, `${label} overflows horizontally: ${JSON.stringify(widths)}`)
}

async function checkSidebarFade(action) {
  const shade = page.locator('.project-sidebar-backdrop')
  await shade.evaluate(element => {
    delete element.dataset.fadeSample
    const sample = event => {
      if (event.propertyName !== 'opacity') return
      const animation = element.getAnimations().find(item => item.transitionProperty === 'opacity')
      if (!animation) return
      animation.pause()
      animation.currentTime = Number(animation.effect.getTiming().duration) / 2
      element.dataset.fadeSample = getComputedStyle(element).opacity
      animation.finish()
      element.removeEventListener('transitionrun', sample)
    }
    element.addEventListener('transitionrun', sample)
  })
  await action()
  await expect(shade).toHaveAttribute('data-fade-sample', /.+/)
  const midway = Number(await shade.getAttribute('data-fade-sample'))
  assert(midway > 0 && midway < 1, 'Sidebar dimming changed instantly instead of fading')
}

async function checkSidebarSelection() {
  const selected = page.locator('.project-file.selected')
  await expect(selected).toHaveCount(1)
  await expect(selected).toHaveAttribute('aria-current', 'page')
  const colors = await selected.evaluate(button => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    const rgb = color => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
    }
    return {
      background: rgb(getComputedStyle(button.closest('.project-file-row')).backgroundColor),
      sidebar: rgb(getComputedStyle(button.closest('.projects-sidebar')).backgroundColor),
      text: rgb(getComputedStyle(button).color),
      normalText: rgb(getComputedStyle(document.body).color),
    }
  })
  assert.deepEqual(colors.text, colors.normalText, 'Sidebar selection should retain normal text color')
  const difference = Math.max(...colors.background.map((channel, index) => Math.abs(channel - colors.sidebar[index])))
  assert(difference > 0, 'Sidebar selection is indistinguishable from its background')
  const luminance = rgb => rgb.map(channel => {
    const value = channel / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
  const foreground = luminance(colors.text), background = luminance(colors.background)
  assert((Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) >= 4.5,
    'Selected sidebar text fails contrast')
}

async function checkTouchDensity(target) {
  const measure = () => target.evaluate(() => ({
    row: document.querySelector('.file-table tbody tr').getBoundingClientRect().height,
    header: document.querySelector('.project-topline').getBoundingClientRect().height,
    font: getComputedStyle(document.querySelector('.file-table td')).fontSize,
  }))
  const compact = await measure()
  await target.getByRole('button', { name: 'Settings', exact: true }).click()
  await target.getByRole('combobox', { name: 'Layout density', exact: true }).selectOption('comfortable')
  await target.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  await expect(directoryTable(target)).toBeVisible()
  const comfortable = await measure()
  assert(comfortable.row >= 44 && comfortable.row > compact.row, 'Touch density choice did not change row height')
  assert.equal(comfortable.header, compact.header, 'Density changed the main top bar height')
  assert.equal(comfortable.font, compact.font, 'Density changed file text size')
  await target.getByRole('button', { name: 'Settings', exact: true }).click()
  await target.getByRole('combobox', { name: 'Layout density', exact: true }).selectOption('compact')
  await target.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  await target.reload()
  await expect(directoryTable(target)).toBeVisible()
  await expect(target.locator('html')).toHaveAttribute('data-density', 'compact')
  assert.deepEqual(await measure(), compact, 'Reload lost compact touch layout')
}

async function checkContrast(theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  const colors = await page.evaluate(() => {
    const probe = document.createElement('span')
    document.body.append(probe)
    const result = {}
    for (const token of ['--bg', '--surface', '--surface-alt', '--text', '--muted', '--accent', '--accent-contrast', '--danger']) {
      probe.style.color = `var(${token})`
      result[token] = getComputedStyle(probe).color
    }
    probe.remove()
    return result
  })
  function luminance(color) {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255)
    return channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
  }
  const contrast = (a, b) => {
    const [low, high] = [luminance(colors[a]), luminance(colors[b])].sort((a, b) => a - b)
    return (high + .05) / (low + .05)
  }
  for (const foreground of ['--text', '--muted', '--accent', '--danger']) {
    for (const background of ['--bg', '--surface', '--surface-alt']) {
      assert(contrast(foreground, background) >= 4.5, `${theme}: ${foreground} on ${background} fails normal-text contrast`)
    }
  }
  assert(contrast('--accent-contrast', '--accent') >= 4.5, `${theme}: selected controls fail contrast`)
}

async function selectFolder({ field, initialPath, branches, selected, expectedPath, host, kind }) {
  // Use the address only to scope the picker to the generated fixture tree.
  // The allowed project itself must be selected through the real folder API/UI.
  const folderField = page.getByRole('textbox', { name: field })
  await folderField.fill(initialPath)
  const listing = postResponse('/api/folders')
  await page.locator('.project-setup').getByRole('button', { name: 'Browse', exact: true }).click()
  const response = await listing
  assert.equal(response.status(), 200, `${kind} folder picker failed`)
  assert.equal(response.request().postDataJSON().host, host)
  assert.equal(response.request().postDataJSON().kind, kind)
  const picker = page.getByRole('dialog', { name: 'Choose a folder' })
  await expect(picker.getByRole('textbox', { name: 'Folder path' })).toHaveValue(initialPath)
  const tree = picker.getByRole('tree', { name: 'Folder structure' })
  for (const branch of branches) {
    const expanded = postResponse('/api/folders')
    await tree.getByRole('button', { name: `Expand ${branch}`, exact: true }).click()
    assert.equal((await expanded).status(), 200, `${kind} nested folder expansion failed`)
  }
  await tree.getByRole('button', { name: selected, exact: true }).click()
  await expect(tree.getByRole('treeitem', { name: selected, exact: true })).toHaveAttribute('aria-selected', 'true')
  await picker.getByRole('button', { name: 'Select folder', exact: true }).click()
  await expect(picker).not.toBeVisible()
  await expect(folderField).toHaveValue(expectedPath)
}

async function saveProject(label) {
  await page.getByLabel('Project name', { exact: false }).fill(label)
  const pending = postResponse('/api/projects')
  await page.locator('.project-setup').getByRole('button', { name: 'Add and open project', exact: true }).click()
  const response = await pending
  assert.equal(response.status(), 200, `Saving ${label} failed: ${await response.text()}`)
  return response.json()
}

async function checkSVG(path, source = remote, scripts = false, target = page) {
  const name = path.split('/').at(-1)
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const scriptRequests = []
  const trackScript = request => { if (new URL(request.url()).pathname.endsWith('/svg-script-executed')) scriptRequests.push(request.url()) }
  target.on('request', trackScript)
  try {
    await target.evaluate(() => { window.artifaceSVGExecuted = false })
    await open(directory, 'directory', source, target)
    const file = directoryTable(target).getByRole('link', { name, exact: true })
    await expect(file.locator('svg.kind-image')).toHaveCount(1)
    await expect(file).toHaveAttribute('title', /\nImage · Modified /)
    const responsePending = target.waitForResponse(response => new URL(response.url()).pathname.endsWith('/' + name))
    await file.click()
    const response = await responsePending
    assert.equal(response.status(), 200)
    assert.match(response.headers()['content-type'], /^image\/svg\+xml\b/)
    assert.equal(response.headers()['cache-control'], 'no-store')
    assert.equal(response.headers()['content-security-policy'].includes('sandbox allow-scripts'), scripts)
    const image = activeReader(target).locator('.image-stage > img:not(.pending-preview)')
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth === 200 && element.naturalHeight === 80)).toBe(true)
    const originalURL = await image.getAttribute('src')
    const zoom = target.getByRole('combobox', { name: 'Image zoom', exact: true })
    await zoom.selectOption('2')
    await expect.poll(() => image.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(400)
    await expect(image).toHaveAttribute('src', originalURL)
    await readerAction('Refresh file', target)
    await expect(image).not.toHaveAttribute('src', originalURL)
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth === 200)).toBe(true)
    await expect(zoom).toHaveValue('2')
    await zoom.selectOption('fit')
    await target.getByRole('button', { name: 'Full screen', exact: true }).click()
    await expect(target.getByRole('button')).toHaveCount(1)
    await expect(image).toBeInViewport()
    await noOverflow(target, 'SVG fullscreen')
    await target.getByRole('button', { name: 'Exit full screen', exact: true }).click()
    assert.equal(await target.evaluate(() => window.artifaceSVGExecuted), false, 'SVG image executed script in the app')
    assert.deepEqual(scriptRequests, [], 'SVG image executed its script, even without access to the app')
    await projectTabs(target).getByRole('button', { name: `Close ${name}`, exact: true }).click()
  } finally { target.off('request', trackScript) }
}

async function checkPDF(text, target = page, number = 1, total = 1) {
  await expect(target.getByRole('region', { name: `PDF page ${number} of ${total}` })).toHaveAttribute('aria-busy', 'false')
  await expect(target.locator(`.pdf-paper[data-page="${number}"] .pdf-text-layer`)).toContainText(text)
  // Refresh can replace the page between assertions; inspect one connected canvas atomically.
  await expect.poll(() => target.getByLabel(`Page ${number}`, { exact: true }).evaluate(canvas => {
    if (!canvas.isConnected || !canvas.width || !canvas.height) return false
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0 && data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) return true
    }
    return false
  })).toBe(true)
}

async function checkTables(localSource) {
  await open('reports/metrics.csv')
  const table = page.getByRole('table', { name: 'File data', exact: true })
  await expect(table.getByRole('columnheader', { name: 'metric', exact: true })).toBeVisible()
  await expect(table.locator('tbody tr')).toHaveCount(50)
  await expect(table.getByRole('cell', { name: 'left, right', exact: true })).toBeVisible()
  await expect(table.getByRole('cell', { name: 'He said "hello"', exact: true })).toBeVisible()
  await expect(table.getByRole('cell', { name: 'line one line two', exact: true })).toBeVisible()
  await expect(table.getByRole('cell', { name: '=1+1', exact: true })).toBeVisible()
  await expect(table.locator('img,script,iframe')).toHaveCount(0)
  assert.equal(await page.evaluate(() => window.csvExecuted), undefined)
  await page.getByRole('button', { name: 'Next rows', exact: true }).click()
  await expect(table.locator('tbody tr').first()).toContainText('record-48')
  await page.getByRole('button', { name: 'Next rows', exact: true }).click()
  await expect(table.locator('tbody tr').last()).toContainText('record-120')
  await expect(page.getByRole('button', { name: 'Next rows', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'First row is header', exact: true }).uncheck()
  await expect(table.getByRole('columnheader', { name: 'Column 1', exact: true })).toBeVisible()
  await expect(table.locator('tbody tr').first()).toContainText('metric')
  await page.getByRole('checkbox', { name: 'First row is header', exact: true }).check()
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page.getByRole('region', { name: 'File source', exact: true })).toContainText('metric,value,notes')
  await page.getByRole('button', { name: 'Rendered', exact: true }).click()
  await expect(table).toBeVisible()
  const original = await readFile(join(artifactRoot, 'reports/metrics.csv'), 'utf8')
  try {
    await mutateFixture('reports/metrics.csv', original.replace('score,42,', 'score,43,'))
    await expect(table.locator('tbody tr').first().getByRole('cell', { name: '43', exact: true })).toBeVisible({ timeout: 20_000 })
  } finally { await mutateFixture('reports/metrics.csv', original) }
  await shot('csv-table-desktop')
  await projectTabs(page).getByRole('button', { name: 'Close metrics.csv', exact: true }).click()

  await open('records.tsv', 'file', localSource)
  await expect(table.getByRole('cell', { name: 'two fields', exact: true })).toBeVisible()
  await expect(table.getByRole('cell', { name: '007', exact: true })).toBeVisible()
  await projectTabs(page).getByRole('button', { name: 'Close records.tsv', exact: true }).click()

  const phone = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true })
  try {
    const mobile = await phone.newPage()
    mobile.on('pageerror', error => pageErrors.push(error.message))
    await open('reports/metrics.csv', 'file', remote, mobile)
    await expect(mobile.getByRole('table', { name: 'File data', exact: true })).toBeVisible()
    assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'CSV table overflowed the phone layout')
    const scroll = mobile.getByRole('region', { name: 'Table contents', exact: true })
    await scroll.evaluate(element => { element.scrollLeft = 80 })
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await shot('csv-table-mobile', mobile)
    await mobile.getByRole('button', { name: 'Full screen', exact: true }).click()
    await expect(mobile.locator('.reader-expanded button:visible')).toHaveCount(1)
    await expect(mobile.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible()
    await mobile.getByRole('button', { name: 'Exit full screen', exact: true }).click()
  } finally { await phone.close() }
  console.log('PASS: SSH CSV and local TSV tables, quoted/multiline cells, literal markup/formulas, pagination, header/source controls, automatic refresh, and phone scrolling/fullscreen')
}

async function checkMobilePDF(target, label) {
  await open('reports/reader-pages.pdf', 'file', remote, target)
  await target.getByRole('spinbutton', { name: 'Page number', exact: true }).fill('1')
  await target.getByRole('spinbutton', { name: 'Page number', exact: true }).press('Enter')
  await target.getByRole('combobox', { name: 'PDF zoom' }).selectOption('fit')
  await checkPDF('Mobile PDF fixture page 1', target, 1, 3)
  await expect(projectTabs(target).getByRole('tab', { name: 'reader-pages.pdf', exact: true })).toBeInViewport({ ratio: 0.95 })
  const area = target.locator('.pdf-canvas-area')
  await expect.poll(() => area.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2)
  assert((await target.locator('.pdf-toolbar').boundingBox()).height <= 49, `${label}: PDF controls wrapped into extra rows`)
  const available = await area.boundingBox()
  assert(available.y <= 105 && available.height >= (await target.evaluate(() => innerHeight)) - 106,
    `${label}: stacked headers consumed too much reading space`)
  await noOverflow(target, `${label} PDF`)
  await shot(`${label}-pdf`, target)
  await readerOptions(target)
  await expect(target.getByRole('button', { name: 'Refresh file', exact: true })).toBeInViewport()
  await expect(target.getByRole('button', { name: 'Pause automatic refresh', exact: true })).toBeInViewport()
  await target.keyboard.press('Escape')
  await target.getByRole('button', { name: 'Full screen', exact: true }).click()
  await expect(target.getByRole('button')).toHaveCount(1)
  await expect(target.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible()
  await expect.poll(async () => (await area.boundingBox()).y).toBeLessThanOrEqual(1)
  await expect.poll(async () => (await target.evaluate(() => innerHeight)) - (await area.boundingBox()).height).toBeLessThanOrEqual(2)
  await expect.poll(() => area.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2)
  await area.evaluate(element => {
    const start = new Touch({ identifier: 1, target: element, clientX: 250, clientY: 250 })
    const end = new Touch({ identifier: 1, target: element, clientX: 100, clientY: 250 })
    element.dispatchEvent(new TouchEvent('touchstart', { touches: [start], changedTouches: [start], bubbles: true }))
    element.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [end], bubbles: true }))
  })
  await checkPDF('Mobile PDF fixture page 2', target, 2, 3)
  await shot(`${label}-pdf-fullscreen`, target)
  await target.getByRole('button', { name: 'Exit full screen', exact: true }).click()
  await expect(target.locator('.project-topline')).toBeVisible()
  await expect(target.locator('.pdf-toolbar')).toBeVisible()
  await checkReaderControls(target)
  await readerOptions(target)
  await target.getByRole('combobox', { name: 'PDF page navigation' }).selectOption('vertical')
  await target.keyboard.press('Escape')
  await target.getByRole('spinbutton', { name: 'Page number', exact: true }).fill('1')
  // A pending scroll from the mode change must not replace an in-progress edit.
  await area.evaluate(element => element.dispatchEvent(new Event('scroll', { bubbles: true })))
  await expect(target.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1')
  await target.getByRole('spinbutton', { name: 'Page number', exact: true }).press('Enter')
  await checkPDF('Mobile PDF fixture page 1', target, 1, 3)
  await area.evaluate(element => {
    element.scrollTop = element.querySelector('[data-page="1"]').offsetHeight + 30
  })
  await checkPDF('Mobile PDF fixture page 2', target, 2, 3)
  await shot(`${label}-pdf-vertical`, target)
  await target.getByRole('button', { name: 'Full screen', exact: true }).click()
  await expect(target.getByRole('button')).toHaveCount(1)
  await area.evaluate(element => { element.scrollTop = element.scrollHeight })
  await checkPDF('Mobile PDF fixture page 3', target, 3, 3)
  await target.getByRole('button', { name: 'Exit full screen', exact: true }).click()
  await readerOptions(target)
  await target.getByRole('combobox', { name: 'PDF page navigation' }).selectOption('horizontal')
  await target.keyboard.press('Escape')
}

async function checkReaderControls(target = page) {
  const toolbar = target.locator('.pdf-toolbar')
  const width = (await toolbar.boundingBox()).width
  if (width > 600) await expect(toolbar.locator('.reader-inline-actions')).toBeVisible()
  if (width < 390) await expect(toolbar.locator('.reader-inline-actions')).not.toBeVisible()
  await readerOptions(target)
  await expect(target.getByRole('button', { name: 'Refresh file', exact: true })).toHaveCount(1)
  await expect(target.getByRole('button', { name: 'Pause automatic refresh', exact: true })).toHaveCount(1)
  const rotate = target.getByRole('button', { name: 'Rotate page clockwise', exact: true })
  for (let turn = 0; turn < 4; turn++) {
    await rotate.click()
    await expect(target.getByRole('button', { name: 'Reader options', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(target.locator('.pdf-canvas-area')).toHaveAttribute('aria-busy', 'false')
    const size = await target.locator('.pdf-paper canvas').evaluate(element => ({ width: element.width, height: element.height }))
    assert(turn % 2 ? size.height > size.width : size.width > size.height, 'Repeated rotation did not update the portrait PDF')
  }
  await target.keyboard.press('Escape')
}

async function checkCollapsibleReaderToolbar() {
  const initial = (await workspaceSession()).tabs
  await open('reports/notes.md')
  const toolbar = page.getByRole('toolbar', { name: 'Reader toolbar', exact: true })
  await expect(toolbar.locator('h1')).toHaveCount(0)
  for (const name of ['Refresh file', 'Pause automatic refresh', 'Share link']) {
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await expect(toolbar.getByRole('link', { name: 'Download file', exact: true })).toBeVisible()
  await page.locator('.project-topline').getByRole('button', { name: 'Hide reader toolbar', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  await expect(activeReader(page).locator('.markdown-viewer')).toBeVisible()
  await open('reports/example.py')
  await expect(page.getByRole('region', { name: 'File source', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Wrap long lines', exact: true })).not.toBeVisible()
  await open('reports/metrics.csv')
  await expect(page.getByRole('table', { name: 'File data', exact: true })).toBeVisible()
  await expect(activeReader(page).locator('.csv-toolbar')).not.toBeVisible()
  await projectTabs(page).getByRole('tab', { name: 'Browse', exact: true }).click()
  await expect(page.locator('.browse-toolbar')).toBeVisible()
  await open('reports/reader-pages.pdf')
  await checkPDF('Mobile PDF fixture page 1', page, 1, 3)
  await expect(page.locator('.pdf-toolbar')).not.toBeVisible()
  await page.getByRole('button', { name: 'Show reader toolbar', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Page number', exact: true }).fill('2')
  await page.getByRole('spinbutton', { name: 'Page number', exact: true }).press('Enter')
  await page.getByRole('combobox', { name: 'PDF zoom', exact: true }).selectOption('1.25')
  await checkPDF('Mobile PDF fixture page 2', page, 2, 3)
  const area = page.locator('.pdf-canvas-area')
  const height = (await area.boundingBox()).height
  const start = requests.length
  await page.getByRole('button', { name: 'Hide reader toolbar', exact: true }).click()
  await expect.poll(async () => (await area.boundingBox()).height).toBeGreaterThan(height + 20)
  await checkPDF('Mobile PDF fixture page 2', page, 2, 3)
  await page.getByRole('button', { name: 'Show reader toolbar', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('2')
  await expect(page.getByRole('combobox', { name: 'PDF zoom', exact: true })).toHaveValue('1.25')
  assert(!requests.slice(start).some(item => item.endpoint === '/api/file' && item.method === 'GET' && item.query.get('path') === 'reports/reader-pages.pdf'),
    'Collapsing the toolbar downloaded the PDF again')
  await page.getByRole('button', { name: 'Hide reader toolbar', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Show reader toolbar', exact: true })).toBeVisible()
  await checkPDF('Mobile PDF fixture page 1', page, 1, 3)
  await expect(page.locator('.pdf-toolbar')).not.toBeVisible()
  await page.getByRole('button', { name: 'Show reader toolbar', exact: true }).click()
  for (const path of ['reports/reader-pages.pdf', 'reports/metrics.csv', 'reports/example.py']) {
    if (!initial.some(tab => tab.host === remote.host && tab.root === remote.root && tab.path === path)) {
      await projectTabs(page).getByRole('button', { name: `Close ${path.split('/').at(-1)}`, exact: true }).click()
    }
  }
  console.log('PASS: direct reader actions, collapsible PDF/source/table toolbars, remembered visibility, retained PDF state, and no extra PDF downloads')
}

const flatFiles = ['plain.txt', 'left/shared.md', 'right/shared.md', 'left/large.txt', 'right/example.py', 'left/report.html']
const hiddenFlatFiles = ['.hidden.md', '.hidden-folder/secret.md', 'left/.nested-hidden/secret.md']
const cacheFiles = ['__pycache__/cached.py', 'node_modules/package/index.js', 'left/__pycache__/cached.py',
  'left/node_modules/package/index.js', '.git/config', 'left/.git/config', '.venv/installed.txt']

function checkFlatResponse(listing, directory, names) {
  assert.equal(listing.path, directory)
  assert(!listing.truncated, 'Small flat fixture was truncated')
  assert(listing.entries.every(entry => entry.type === 'file'), 'Flat Browse returned folders or unavailable entries')
  assert.deepEqual(listing.entries.map(entry => entry.path).sort(), names.map(name => `${directory}/${name}`).sort(),
    'Flat Browse returned incorrect paths, hidden entries, or ignored caches')
}

function flatEntryPaths(view, directory) {
  // Sorting follows logical paths even when the UI displays basename and parent separately.
  return view.locator('[data-browse-entry]').evaluateAll((entries, prefix) => entries.map(entry => {
    const path = entry.getAttribute('data-browse-entry')
    if (!path?.startsWith(prefix)) throw new Error('Flat entry is outside its displayed folder')
    return path.slice(prefix.length)
  }), `${directory}/`)
}

async function browseSetting(label, checked, query) {
  await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
  const checkbox = page.getByRole('checkbox', { name: label, exact: true })
  assert.notEqual(await checkbox.isChecked(), checked, `Expected ${label} to change`)
  const pending = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/list' && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value)
  })
  await checkbox.click()
  const response = await pending
  assert.equal(response.status(), 200, `Browse setting failed: ${await response.text()}`)
  await expect(checkbox).toBeChecked({ checked })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Browse settings', exact: true })).toBeFocused()
  return response.json()
}

async function checkFlatBrowse(source, directory) {
  await open(directory, 'directory', source)
  await expect(directoryTable(page).getByRole('link', { name: 'left', exact: true })).toBeVisible()
  for (const cache of ['node_modules', '__pycache__']) {
    await expect(directoryTable(page).getByRole('link', { name: cache, exact: true })).toHaveCount(0)
  }
  const query = { ...source, path: directory, recursive: '1', showHidden: '0' }
  checkFlatResponse(await browseSetting('Show files from all subfolders', true, query), directory, flatFiles)
  const names = () => flatEntryPaths(directoryTable(page), directory)
  await expect.poll(async () => (await names()).sort()).toEqual([...flatFiles].sort())
  for (const name of flatFiles) await expect(directoryTable(page).getByRole('link', { name, exact: true })).toBeVisible()
  await expect(directoryTable(page).locator('.folder-icon')).toHaveCount(0)
  await expect(directoryTable(page).getByRole('link', { name: 'left/report.html', exact: true }).locator('svg.lucide-globe')).toHaveCount(1)
  for (const [branch, heading] of [['left', 'Left shared note'], ['right', 'Right shared note']]) {
    const link = directoryTable(page).getByRole('link', { name: `${branch}/shared.md`, exact: true })
    const location = new URLSearchParams((await link.getAttribute('href')).split('#')[1])
    assert.equal(location.get('path'), `${directory}/${branch}/shared.md`, 'Flat display name became the wrong navigation path')
    await link.click()
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await projectTabs(page).getByRole('tab', { name: 'Browse', exact: true }).click()
    await projectTabs(page).getByRole('button', { name: 'Close shared.md', exact: true }).click()
  }
  const search = page.getByRole('textbox', { name: 'Search directory', exact: true })
  await search.fill('left/')
  await expect.poll(async () => (await names()).sort()).toEqual(flatFiles.filter(name => name.startsWith('left/')).sort())
  await page.getByRole('button', { name: 'Clear directory search', exact: true }).click()
  await page.getByRole('button', { name: 'File type filters', exact: true }).click()
  await page.locator('#file-filter-panel').getByRole('checkbox', { name: 'Markdown', exact: true }).uncheck()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await names()).sort()).toEqual(flatFiles.filter(name => !name.endsWith('.md')).sort())
  await page.getByRole('button', { name: 'File type filters', exact: true }).click()
  await page.locator('#file-filter-panel').getByRole('checkbox', { name: 'Markdown', exact: true }).check()
  await page.keyboard.press('Escape')
  const sizeHeader = directoryTable(page).getByRole('columnheader', { name: 'Size', exact: true })
  if (await sizeHeader.getAttribute('aria-sort') !== 'descending') {
    await sizeHeader.getByRole('button').click()
    if (await sizeHeader.getAttribute('aria-sort') !== 'descending') await sizeHeader.getByRole('button').click()
  }
  await expect.poll(async () => (await names())[0]).toBe('left/large.txt')
  await page.getByRole('button', { name: 'Icon view', exact: true }).click()
  await page.getByRole('combobox', { name: 'Sort files' }).selectOption('name:desc')
  const descending = await page.evaluate(names => [...names].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })), flatFiles)
  await expect.poll(() => flatEntryPaths(directoryGrid(page), directory)).toEqual(descending)
  await expect(directoryGrid(page).getByRole('link', { name: /^left\/report\.html\s/ }).locator('svg.lucide-globe')).toHaveCount(1)
  await page.reload()
  await expect.poll(() => directoryGrid(page).locator('.tile-name').count()).toBe(flatFiles.length)
  await expect(page.getByRole('combobox', { name: 'Sort files' })).toHaveValue('name:desc')
  await expect.poll(() => flatEntryPaths(directoryGrid(page), directory)).toEqual(descending)
  await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Show files from all subfolders', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'List view', exact: true }).click()
  checkFlatResponse(await browseSetting('Show dotfiles and hidden folders', true, { ...query, showHidden: '1' }),
    directory, [...flatFiles, ...hiddenFlatFiles])
  await expect.poll(async () => (await names()).sort()).toEqual([...flatFiles, ...hiddenFlatFiles].sort())
  checkFlatResponse(await browseSetting('Show dotfiles and hidden folders', false, query), directory, flatFiles)
  await browseSetting('Show files from all subfolders', false, { ...source, path: directory, recursive: null })
  await expect(directoryTable(page).getByRole('link', { name: 'left', exact: true })).toBeVisible()
}

async function checkFolderFileTypes(localSource, remoteSource) {
  const device = await browser.newContext({ storageState: { cookies: (await context.storageState()).cookies, origins: [] }, viewport: { width: 1440, height: 1000 } })
  const target = await device.newPage()
  target.on('pageerror', error => pageErrors.push(error.message))
  const table = target.getByRole('table', { name: 'Directory contents', exact: true })
  const types = target.locator('#file-filter-panel')
  const file = name => table.getByRole('link', { name, exact: true })
  const folder = async (path, source = localSource) => open(`browse-checks/${path}`, 'directory', source, target)
  const defaults = async (label, checked) => {
    await target.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(target.getByRole('heading', { name: 'Default file types', exact: true })).toBeVisible()
    await target.getByRole('checkbox', { name: label, exact: true }).setChecked(checked)
    await target.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  }
  const menu = () => target.getByRole('button', { name: 'File type filters', exact: true }).click()
  try {
    await folder('left')
    await defaults('Markdown', false)
    await expect(file('shared.md')).toHaveCount(0)
    await expect(file('report.html')).toBeVisible()
    await folder('right')
    await expect(file('shared.md')).toHaveCount(0)
    await expect(file('example.py')).toBeVisible()
    await menu()
    await expect(types.getByRole('button', { name: 'Use defaults', exact: true })).toBeDisabled()
    await types.getByRole('checkbox', { name: 'Markdown', exact: true }).check()
    await types.getByRole('checkbox', { name: 'Code', exact: true }).uncheck()
    await target.keyboard.press('Escape')
    await expect(file('shared.md')).toBeVisible()
    await expect(file('example.py')).toHaveCount(0)
    await target.reload()
    await expect(file('shared.md')).toBeVisible()
    await expect(file('example.py')).toHaveCount(0)
    await target.getByRole('button', { name: 'Browse settings', exact: true }).click()
    await target.getByRole('checkbox', { name: 'Show files from all subfolders', exact: true }).check()
    await target.keyboard.press('Escape')
    await expect(file('shared.md')).toBeVisible()
    await expect(file('example.py')).toHaveCount(0)
    await target.getByRole('button', { name: 'Icon view', exact: true }).click()
    await expect(target.locator('.tile-name').filter({ hasText: /^shared\.md$/ })).toBeVisible()
    await expect(target.locator('.tile-name').filter({ hasText: /^example\.py$/ })).toHaveCount(0)
    await target.getByRole('button', { name: 'List view', exact: true }).click()
    await target.getByRole('button', { name: 'Browse settings', exact: true }).click()
    await target.getByRole('checkbox', { name: 'Show files from all subfolders', exact: true }).uncheck()
    await target.keyboard.press('Escape')
    await folder('left')
    await expect(file('shared.md')).toHaveCount(0)
    await folder('right', remoteSource)
    await expect(file('shared.md')).toHaveCount(0)
    await expect(file('example.py')).toBeVisible()
    await defaults('Markdown', true)
    await expect(file('shared.md')).toBeVisible()
    await folder('right')
    await expect(file('shared.md')).toBeVisible()
    await expect(file('example.py')).toHaveCount(0)
    await menu()
    await types.getByRole('button', { name: 'Use defaults', exact: true }).click()
    await expect(file('example.py')).toBeVisible()
    await menu()
    for (const checkbox of await types.getByRole('checkbox').all()) await checkbox.uncheck()
    await target.keyboard.press('Escape')
    await expect(target.getByRole('heading', { name: 'No matching files', exact: true })).toBeVisible()
    await target.reload()
    await expect(target.getByRole('heading', { name: 'No matching files', exact: true })).toBeVisible()
    await folder('left')
    await expect(file('shared.md')).toBeVisible()
    await folder('right')
    await menu()
    await types.getByRole('button', { name: 'Show all types', exact: true }).click()
    await defaults('Code', false)
    await expect(file('example.py')).toBeVisible()
    await folder('right', remoteSource)
    await expect(file('example.py')).toHaveCount(0)
  } finally { await device.close() }
  console.log('PASS: default file types, independent folder/host overrides, reload persistence, list/icon/flat consistency, empty selections, and reset to defaults')
}

async function authenticatedPost(endpoint, data) {
  const response = await context.request.get(origin + '/api/session')
  assert.equal(response.status(), 200)
  const session = await response.json()
  assert(session.authenticated && session.csrfToken)
  return context.request.post(origin + endpoint, { data, headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken } })
}

async function restoreSourceReference(source) {
  // Restoring a source through the configuration editor must not restore deleted credentials.
  const before = await (await context.request.get(origin + '/api/settings')).json()
  const host = { ...source, roots: [] }
  const config = { ...before.config, hosts: [...before.config.hosts, host] }
  const saved = await authenticatedPost('/api/settings', { config, revision: before.revision })
  assert.equal(saved.status(), 200)
  if (host.kind !== 'local') {
    const folders = await authenticatedPost('/api/folders', { host: host.id, kind: 'ssh', path: artifactRoot })
    assert.equal(folders.status(), 422, 'Restoring a source reference unexpectedly restored SSH access')
    assert.match((await folders.json()).error, /^SSH credentials are missing for this host\./)
  }
  await sourcesAfterReload()
  return (await (await context.request.get(origin + '/api/hosts')).json()).hosts
}

async function saveIgnore(contents) {
  await page.getByRole('textbox', { name: 'Ignore rules', exact: true }).fill(contents)
  const saving = postResponse('/api/ignore')
  await page.getByRole('button', { name: 'Save ignore rules', exact: true }).click()
  const response = await saving
  assert.equal(response.status(), 200, `Saving ignore rules failed: ${await response.text()}`)
  assert(response.request().postDataJSON().revision, 'Ignore editor omitted the revision')
  const document = await response.json()
  assert.equal(document.content, contents)
  assert.equal(document.path, join(fixtureDirectory, '.artifaceignore'))
  assert.equal(await realpath(document.path), document.path, 'Ignore save followed a symlink')
  assert.equal(await readFile(document.path, 'utf8'), contents, 'Ignore editor did not persist the sibling file')
  await expect(page.getByText('Ignore rules saved. Browse will use the updated rules.', { exact: true })).toBeVisible()
  return document
}

async function checkIgnoreRules(localSource) {
  const initial = await context.request.get(origin + '/api/ignore')
  assert.equal(initial.status(), 200)
  const defaults = await initial.json()
  assert.equal(defaults.path, join(fixtureDirectory, '.artifaceignore'))
  assert.equal(defaults.editable, true)
  const configBefore = await readFile(join(fixtureDirectory, 'config.json'))
  const sources = [[remote, 'reports/browse-checks'], [localSource, 'browse-checks']]
  const custom = defaults.content + '\n# Isolated smoke rule\nshared.md\n'
  try {
    await open('browse-checks', 'directory', localSource)
    await browseSetting('Show files from all subfolders', true, { ...localSource, path: 'browse-checks', recursive: '1', showHidden: '0' })
    await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
    await page.getByRole('button', { name: 'Ignored files in Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Ignored files', exact: true })).toBeVisible()
    const editor = page.getByRole('textbox', { name: 'Ignore rules', exact: true })
    await expect(editor).toHaveValue(defaults.content)
    const saved = await saveIgnore(custom)
    assert.notEqual(saved.revision, defaults.revision)
    // Returning from Settings must immediately apply the saved rules to Browse.
    await returnToWorkspace()
    await expect(directoryTable(page).getByRole('link', { name: 'plain.txt', exact: true })).toBeVisible()
    await expect(directoryTable(page).getByRole('link', { name: 'left/shared.md', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(directoryTable(page).getByRole('link', { name: 'plain.txt', exact: true })).toBeVisible()
    for (const [source, directory] of sources) {
      await open(directory, 'directory', source)
      await expect.poll(() => flatEntryPaths(directoryTable(page), directory).then(names => names.sort()))
        .toEqual(flatFiles.filter(name => !name.endsWith('shared.md')).sort())
      const query = new URLSearchParams({ ...source, path: directory, recursive: '1', showHidden: '0' })
      const listing = await context.request.get(origin + '/api/list?' + query)
      assert.equal(listing.status(), 200)
      checkFlatResponse(await listing.json(), directory, flatFiles.filter(name => !name.endsWith('shared.md')))
      // Ignores also apply to ordinary Browse and leave direct file access intact.
      const ordinary = await context.request.get(origin + '/api/list?' + new URLSearchParams({ ...source, path: `${directory}/left` }))
      assert.equal(ordinary.status(), 200)
      assert(!(await ordinary.json()).entries.some(entry => entry.name === 'shared.md' || entry.name === '__pycache__'))
      const direct = await context.request.get(origin + '/api/text?' + new URLSearchParams({ ...source, path: `${directory}/left/shared.md` }))
      assert.equal(direct.status(), 200)
      assert.equal((await direct.json()).text, '# Left shared note\n')
    }
    await settings('Ignored files')
    await expect(editor).toHaveValue(custom)
    await saveIgnore('')
    await returnToWorkspace()
    for (const [source, directory] of sources) {
      await open(directory, 'directory', source)
      await expect(directoryTable(page).getByRole('link', { name: 'left/__pycache__/cached.py', exact: true })).toBeVisible()
      const listing = await context.request.get(origin + '/api/list?' + new URLSearchParams({ ...source, path: directory, recursive: '1', showHidden: '1' }))
      assert.equal(listing.status(), 200)
      checkFlatResponse(await listing.json(), directory, [...flatFiles, ...hiddenFlatFiles, ...cacheFiles])
    }
    await browseSetting('Show dotfiles and hidden folders', true, { ...localSource, path: 'browse-checks', recursive: '1', showHidden: '1' })
    await expect(directoryTable(page).getByRole('link', { name: 'left/.git/config', exact: true })).toBeVisible()
    await page.reload()
    await expect(directoryTable(page).getByRole('link', { name: 'left/.git/config', exact: true })).toBeVisible()
    await settings('Ignored files')
    await expect(editor).toHaveValue('')
    const empty = await (await context.request.get(origin + '/api/ignore')).json()
    const draft = '# Browser draft must survive a conflict\nplain.txt\n'
    await editor.fill(draft)
    const externalContent = '# Concurrent isolated editor\nlarge.txt\n'
    const external = await authenticatedPost('/api/ignore', { content: externalContent, revision: empty.revision })
    assert.equal(external.status(), 200)
    const conflict = postResponse('/api/ignore')
    await page.getByRole('button', { name: 'Save ignore rules', exact: true }).click()
    assert.equal((await conflict).status(), 409, 'Stale ignore edit overwrote another editor')
    await expect(page.getByRole('alert')).toContainText('Your draft is kept')
    await expect(editor).toHaveValue(draft)
    await expect(page.getByRole('button', { name: 'Save ignore rules', exact: true })).toBeDisabled()
    assert.equal(await readFile(join(fixtureDirectory, '.artifaceignore'), 'utf8'), externalContent)
    page.once('dialog', dialog => { assert.equal(dialog.type(), 'confirm'); void dialog.accept() })
    await page.getByRole('button', { name: 'Reload rules', exact: true }).click()
    await expect(editor).toHaveValue(externalContent)
    await saveIgnore(defaults.content)
    await returnToWorkspace()
    await expect(directoryTable(page).getByRole('link', { name: 'left/shared.md', exact: true })).toBeVisible()
    await expect(directoryTable(page).getByRole('link', { name: 'left/.git/config', exact: true })).toHaveCount(0)
    await browseSetting('Show dotfiles and hidden folders', false, { ...localSource, path: 'browse-checks', recursive: '1', showHidden: '0' })
    await browseSetting('Show files from all subfolders', false, { ...localSource, path: 'browse-checks', recursive: null })
  } finally {
    const current = await context.request.get(origin + '/api/ignore')
    if (current.ok()) {
      const document = await current.json()
      if (document.content !== defaults.content) {
        const restored = await authenticatedPost('/api/ignore', { content: defaults.content, revision: document.revision })
        assert.equal(restored.status(), 200, 'Could not restore smoke ignore defaults')
      }
    }
    assert.deepEqual(await readFile(join(fixtureDirectory, 'config.json')), configBefore, 'Ignore edits changed app configuration')
  }
}

async function checkChooserRemoval(localSource) {
  const configBefore = await readFile(join(fixtureDirectory, 'config.json'))
  const projectPath = join(localFixtureRoot, 'projects/local-report/browse-checks')
  const fileBefore = await readFile(join(projectPath, 'left/shared.md'))
  const added = await authenticatedPost('/api/projects', { host: localSource.host, kind: 'local', path: projectPath, label: 'Disposable chooser project' })
  assert.equal(added.status(), 200)
  const disposable = await added.json()
  await page.reload()
  await addProject()
  const trigger = page.getByRole('button', { name: 'Remove project Disposable chooser project on localhost', exact: true })
  await expect(trigger).toHaveAttribute('title', 'Remove project')
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Remove project “Disposable chooser project”?', exact: true })
  await expect(dialog).toContainText(projectPath)
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  const configWithProject = await readFile(join(fixtureDirectory, 'config.json'))
  const beforeCancel = requests.filter(request => request.endpoint === '/api/settings' && request.method === 'POST').length
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  assert.equal(requests.filter(request => request.endpoint === '/api/settings' && request.method === 'POST').length, beforeCancel)
  assert.deepEqual(await readFile(join(fixtureDirectory, 'config.json')), configWithProject, 'Cancelling chooser removal changed configuration')
  assert.deepEqual(await readFile(join(projectPath, 'left/shared.md')), fileBefore)
  const removed = await removeSource('project', 'Disposable chooser project', 'localhost')
  assert(!removed.hosts.find(host => host.id === localSource.host).roots.some(root => root.id === disposable.root.id))
  await expect(trigger).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Open a project', exact: true })).toBeVisible()
  await expect(page.locator('.saved-project').filter({ hasText: 'Disposable chooser project' })).toHaveCount(0)
  assert.deepEqual(JSON.parse(await readFile(join(fixtureDirectory, 'config.json'), 'utf8')), JSON.parse(configBefore.toString()),
    'Chooser removal changed another saved project or configuration field')
  assert.deepEqual(await readFile(join(projectPath, 'left/shared.md')), fileBefore, 'Chooser removal changed artifact files')
  await savedProject('Report folder')
}

async function checkOverviewMetadata(originalNotes) {
  const key = location => JSON.stringify([location.host, location.root, location.path])
  const files = (await workspaceSession()).tabs
  const expected = new Set(files.map(key))
  assert(expected.size > 2 && new Set(files.map(file => file.host)).size > 1,
    'Overview metadata check requires more than two files across multiple hosts')
  // Start observation from a settled Overview so an outgoing reader request
  // cannot be mistaken for a third Overview worker or an Overview content fetch.
  await overview()
  await expect(page.locator('.overview-file time')).toHaveCount(expected.size)
  const metadata = new Map()
  const failures = []
  const pending = new Set()
  const inFlight = new Set()
  let peak = 0
  const isMetadata = request => {
    const url = new URL(request.url())
    return url.origin === origin && url.pathname === '/api/file-info'
  }
  const requested = request => {
    if (!isMetadata(request)) return
    inFlight.add(request)
    peak = Math.max(peak, inFlight.size)
  }
  const finished = request => inFlight.delete(request)
  const responded = response => {
    const request = response.request()
    if (!isMetadata(request)) return
    finished(request)
    const completion = (async () => {
      assert.equal(response.status(), 200, 'Overview metadata request failed')
      const entry = await response.json()
      metadata.set(key(Object.fromEntries(new URL(request.url()).searchParams)), entry)
    })().catch(failure => { failures.push(failure.message) })
    pending.add(completion)
    void completion.then(() => pending.delete(completion))
  }
  page.on('request', requested)
  page.on('response', responded)
  page.on('requestfailed', finished)
  const start = requests.length
  try {
    // Observe real traffic without intercepting, delaying, or replacing it.
    await expect.poll(() => [...expected].every(file => metadata.has(file)), { timeout: 15_000 }).toBe(true)
    await expect(page.locator('.overview-file time')).toHaveCount(expected.size)
    assert(peak <= 2, `Overview exceeded two concurrent metadata requests: ${peak}`)
    const displayed = await page.locator('.overview-file time').evaluateAll(times => times.map(time => ({
      modified: time.getAttribute('datetime'), title: time.getAttribute('title'), text: time.textContent,
    })))
    assert(displayed.every(time => Number.isFinite(Date.parse(time.modified)) && /^Last modified /.test(time.title) && /^Modified /.test(time.text)),
      'Overview omitted readable modification times or native date titles')
    assert.deepEqual(displayed.map(time => Date.parse(time.modified)).sort(),
      [...expected].map(file => Date.parse(metadata.get(file).modified)).sort(), 'Overview dates did not match actual metadata')
    const time = page.getByRole('article', { name: 'Artifacts: reports/notes.md', exact: true })
      .getByRole('button', { name: 'Open notes.md', exact: true }).locator('time')
    const before = await time.getAttribute('datetime')
    const beforeTitle = await time.getAttribute('title')
    assert.equal(Date.parse(before), Date.parse(metadata.get(key({ ...remote, path: 'reports/notes.md' })).modified))
    await mutateFixture('reports/notes.md', originalNotes + '\n\nOverview metadata mutation.\n')
    const expectedModified = Math.floor((await stat(join(artifactRoot, 'reports/notes.md'))).mtimeMs / 1000) * 1000
    assert.notEqual(Date.parse(before), expectedModified, 'Overview mutation must change the real SSH modification time')
    await expect.poll(async () => Date.parse(await time.getAttribute('datetime')), { timeout: 12_000 }).toBe(expectedModified)
    const updatedTitle = await page.evaluate(modified => `Last modified ${new Date(modified).toLocaleString()}`, expectedModified)
    await expect(time).toHaveAttribute('title', updatedTitle)
    assert.notEqual(updatedTitle, beforeTitle, 'Overview date hover label did not reflect the changed seconds')
    await expect.poll(() => Date.parse(metadata.get(key({ ...remote, path: 'reports/notes.md' })).modified)).toBe(expectedModified)
    const observed = requests.slice(start)
    const polled = observed.filter(item => item.endpoint === '/api/file-info')
    assert(polled.length >= expected.size + 1, 'Overview did not refresh metadata after its first pass')
    assert(polled.every(item => expected.has(key(Object.fromEntries(item.query)))), 'Overview polled a file that was not open')
    assert(!observed.some(item => ['/api/list', '/api/text', '/api/preview', '/api/file'].includes(item.endpoint) || item.endpoint.startsWith('/p/')),
      'Overview fetched directory listings, file contents, or preview assets')
    assert(peak <= 2, `Overview refresh exceeded two concurrent metadata requests: ${peak}`)
    assert.deepEqual(failures, [])
    await expect(page.locator('.file-preview:visible, .html-viewer iframe:visible')).toHaveCount(0)
    await shot('overview')
  } finally {
    page.off('request', requested)
    page.off('response', responded)
    page.off('requestfailed', finished)
    await Promise.allSettled([...pending])
    await mutateFixture('reports/notes.md', originalNotes)
  }
  assert.deepEqual(failures, [])
}

try {
  await page.goto(artifactURL('reports/notes.md'))
  await expect(page.getByLabel('Workspace password')).toBeVisible()
  await shot('login')
  await page.getByLabel('Workspace password').fill(password)
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Experiment notes', exact: true })).toBeVisible()
  await expect(activeReader(page).locator('.markdown-viewer .katex')).toBeVisible()
  await expect(activeReader(page).locator('.markdown-viewer table')).toBeVisible()
  await expect.poll(() => activeReader(page).locator('.markdown-viewer img').evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0))).toBe(true)
  assert.equal(await page.evaluate(() => window.artifaceXSS), undefined)
  const readerRoute = page.url()
  await page.getByRole('link', { name: 'Skip to content', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()
  assert.equal(page.url(), readerRoute, 'Skipping navigation changed the open reader route')
  await assertProjectChrome()
  await checkSidebarSelection()
  await expect(directoryTable(page)).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Files in current directory' })).toHaveCount(0)
  await expect(projectTabs(page).getByRole('tab')).toHaveCount(2)
  await shot('markdown')
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page.getByRole('region', { name: 'File source' })).toContainText('# Experiment notes')
  await page.getByRole('button', { name: 'Rendered', exact: true }).click()
  await readerAction('Share link')
  await expect(page.locator('.toast')).toContainText('Link copied.')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  assert.equal(new URL(copied).origin, origin)
  assert(copied.includes('notes.md') && !copied.includes('/p/'), 'Copied link exposed a preview capability')

  // Both the mark and the wordmark are genuine home navigation targets.
  await page.getByRole('link', { name: 'Artiface home' }).locator('.brand-mark').click()
  await expect(page.getByRole('heading', { name: 'Open files', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open project Artifacts on SSH fixture', exact: true }).click()
  await expect(directoryTable(page).getByRole('link', { name: 'notes.md', exact: true })).toBeVisible()
  assert.equal(new URLSearchParams(page.url().split('#')[1]).get('path'), 'reports', 'Project name did not open its last Browse directory')
  await page.getByRole('link', { name: 'Artiface home' }).locator('span').first().click()
  await expect(page.getByRole('heading', { name: 'Open files', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open project Artifacts on SSH fixture', exact: true }).click()
  await expect(directoryTable(page)).toBeVisible()
  await assertProjectChrome()
  const row = await directoryTable(page).locator('tbody tr').first().boundingBox()
  assert(row.height >= 24 && row.height <= 28, `Compact desktop row height: ${row.height}`)
  const desktopType = await page.evaluate(() => ({ body: parseFloat(getComputedStyle(document.body).fontSize), label: parseFloat(getComputedStyle(document.querySelector('.project-list-label')).fontSize) }))
  assert(desktopType.body >= 14 && desktopType.label >= 12, 'Desktop type is too small')
  await noOverflow(page, '1440 desktop')
  await shot('files')

  // Browse owns file selection, filtering, and list/grid sort; readers have no file list.
  for (const column of ['Type', 'Modified', 'Name', 'Size']) {
    const header = directoryTable(page).getByRole('columnheader', { name: column, exact: true })
    await header.getByRole('button', { name: column, exact: true }).click()
    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await header.getByRole('button', { name: column, exact: true }).click()
    await expect(header).toHaveAttribute('aria-sort', 'descending')
  }
  const namesBySize = await directoryTable(page).locator('tbody tr td:first-child').allTextContents()
  assert(namesBySize.indexOf('sorting-large.txt') < namesBySize.indexOf('example.py'), 'Size sort did not reorder files')
  const modifiedHeader = directoryTable(page).getByRole('columnheader', { name: 'Modified', exact: true })
  await modifiedHeader.getByRole('button').click()
  await modifiedHeader.getByRole('button').click()
  const namesByModified = await directoryTable(page).locator('tbody tr td:first-child').allTextContents()
  await page.reload()
  await expect(modifiedHeader).toHaveAttribute('aria-sort', 'descending')
  assert.deepEqual(await directoryTable(page).locator('tbody tr td:first-child').allTextContents(), namesByModified,
    'Reload changed the selected modification-time order')
  await expect(directoryTable(page).getByRole('link', { name: 'checkpoint.pt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'File type filters', exact: true }).click()
  const filters = page.locator('#file-filter-panel')
  for (const category of ['Documents', 'Multimedia', 'Code', 'Others']) await expect(filters.getByRole('group', { name: category, exact: true })).toBeVisible()
  await expect(filters.getByRole('checkbox', { name: 'Python', exact: true })).toHaveCount(0)
  await filters.getByRole('checkbox', { name: 'Code', exact: true }).uncheck()
  await filters.getByRole('checkbox', { name: 'PDF', exact: true }).uncheck()
  await filters.getByRole('checkbox', { name: 'LaTeX', exact: true }).uncheck()
  await expect(filters.getByRole('checkbox', { name: 'Filter by file type', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  for (const filename of ['example.py', 'example.ts', 'run.sh', 'settings.yaml', 'result.json', 'report.pdf', 'report.tex']) await expect(directoryTable(page).getByRole('link', { name: filename, exact: true })).toHaveCount(0)
  for (const filename of ['notes.md', 'metrics.csv', 'experiments']) await expect(directoryTable(page).getByRole('link', { name: filename, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'File type filters', exact: true }).click()
  for (const label of ['Code', 'PDF', 'LaTeX']) await filters.getByRole('checkbox', { name: label, exact: true }).check()
  for (const label of ['Shell scripts', 'Configuration', 'JSON', 'Tables (CSV/TSV)', 'Binary data']) await expect(filters.getByRole('checkbox', { name: label, exact: true })).toHaveCount(0)
  await filters.getByRole('checkbox', { name: 'Others', exact: true }).uncheck()
  for (const filename of ['metrics.csv', 'checkpoint.pt']) await expect(directoryTable(page).getByRole('link', { name: filename, exact: true })).toHaveCount(0)
  for (const filename of ['run.sh', 'settings.yaml', 'result.json']) await expect(directoryTable(page).getByRole('link', { name: filename, exact: true })).toBeVisible()
  await filters.getByRole('button', { name: 'Show all types', exact: true }).click()
  await expect(directoryTable(page).getByRole('link', { name: 'checkpoint.pt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'File type filters', exact: true }).click()
  assert(await filters.getByRole('checkbox').evaluateAll(items => items.length === 8 && items.every(item => item.checked)), 'Show all types did not select every individual type')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Icon view', exact: true }).click()
  await expect(directoryGrid(page)).toBeVisible()
  await page.getByRole('combobox', { name: 'Sort files' }).selectOption('size:desc')
  const gridNames = await directoryGrid(page).locator('.tile-name').allTextContents()
  assert(gridNames.indexOf('sorting-large.txt') < gridNames.indexOf('example.py'), 'Icon size sort did not reorder files')
  const noteTile = directoryGrid(page).getByRole('link', { name: /^notes\.md\s/ })
  await expect(noteTile.locator('.tile-meta')).toContainText('Markdown')
  await expect(noteTile.locator('.tile-meta time')).toHaveAttribute('datetime', /T/)
  await expect(noteTile.locator('.tile-meta time')).toHaveAttribute('title', /^Last edited /)
  await expect(noteTile.locator('.tile-details > span').first()).toHaveText('Markdown')
  await expect(noteTile.locator('.tile-size')).toHaveText(/^[\d.]+ \w+$/)
  await expect(noteTile.locator('.tile-meta time')).toBeVisible()
  await expect(noteTile.locator('.tile-meta time')).not.toHaveText('')
  await shot('icons')
  await page.getByRole('combobox', { name: 'Sort files' }).selectOption('modified:asc')
  // A fresh browser context restores device preferences without workspace session storage.
  const restoredContext = await browser.newContext({ storageState: await context.storageState() })
  try {
    const restoredPage = await restoredContext.newPage()
    restoredPage.on('pageerror', error => pageErrors.push(error.message))
    await open('reports', 'directory', remote, restoredPage)
    await expect(directoryGrid(restoredPage)).toBeVisible()
    await expect(restoredPage.getByRole('combobox', { name: 'Sort files' })).toHaveValue('modified:asc')
    await restoredPage.getByRole('button', { name: 'List view', exact: true }).click()
    await expect(directoryTable(restoredPage).getByRole('columnheader', { name: 'Modified', exact: true })).toHaveAttribute('aria-sort', 'ascending')
  } finally { await restoredContext.close() }
  await page.getByRole('button', { name: 'List view', exact: true }).click()
  await expect(modifiedHeader).toHaveAttribute('aria-sort', 'ascending')
  console.log('PASS: list and icon sort choices survive reloads and a fresh browser session')
  await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Default sort order', exact: true }).selectOption('modified:desc')
  await expect(page.getByRole('button', { name: 'Use default order', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(modifiedHeader).toHaveAttribute('aria-sort', 'descending')
  await page.reload()
  await expect(modifiedHeader).toHaveAttribute('aria-sort', 'descending')
  const sizeHeader = directoryTable(page).getByRole('columnheader', { name: 'Size', exact: true })
  await sizeHeader.getByRole('button').click()
  await page.reload()
  await expect(sizeHeader).toHaveAttribute('aria-sort', 'ascending')
  await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Default sort order', exact: true })).toHaveValue('modified:desc')
  await page.getByRole('button', { name: 'Use default order', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(modifiedHeader).toHaveAttribute('aria-sort', 'descending')
  await page.getByRole('button', { name: 'Icon view', exact: true }).click()
  const sortMenu = page.getByRole('combobox', { name: 'Sort files', exact: true })
  await expect(sortMenu).toHaveValue('default')
  await expect(sortMenu.locator('option:checked')).toHaveText('Default: Newest first')
  await expect(sortMenu.locator('option:checked')).toHaveAccessibleName('Default: Modified · Newest first')
  await sortMenu.selectOption('name:asc')
  await sortMenu.selectOption('default')
  await page.reload()
  await expect(sortMenu).toHaveValue('default')
  await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
  await shot('default-sort')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'List view', exact: true }).click()
  await expect(modifiedHeader).toHaveAttribute('aria-sort', 'descending')
  console.log('PASS: configurable default applies immediately, survives reloads, and can be restored after remembered list/icon overrides')
  await settings('Ignored files')
  await page.getByRole('checkbox', { name: 'Show hidden files and folders', exact: true }).check()
  await returnToWorkspace()
  await expect(directoryTable(page).getByRole('link', { name: '.hidden.md', exact: true })).toBeVisible()
  await settings('Ignored files')
  await page.getByRole('checkbox', { name: 'Show hidden files and folders', exact: true }).uncheck()
  await returnToWorkspace()
  await expect(directoryTable(page).getByRole('link', { name: '.hidden.md', exact: true })).toHaveCount(0)

  for (const alias of ['notes-link.md', 'notes-absolute.md', 'notes-chain.md']) {
    const link = directoryTable(page).getByRole('link', { name: alias, exact: true })
    await expect(link).toHaveAttribute('href', /path=reports%2Fnotes\.md/)
    await link.click()
    await expect(page.getByRole('heading', { name: 'Experiment notes', exact: true })).toBeVisible()
    assert.equal(new URLSearchParams(page.url().split('#')[1]).get('path'), 'reports/notes.md')
    await projectTabs(page).getByRole('tab', { name: 'Browse', exact: true }).click()
  }
  await directoryTable(page).getByRole('link', { name: 'experiments-link', exact: true }).click()
  assert.equal(new URLSearchParams(page.url().split('#')[1]).get('path'), 'reports/experiments')
  await expect(directoryTable(page).getByRole('link', { name: 'run-a', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Up one directory', exact: true }).click()
  for (const alias of ['project-escape', 'broken-link', 'cycle-a', 'cycle-b']) {
    await expect(directoryTable(page).getByRole('link', { name: alias, exact: true })).toHaveCount(0)
    await expect(directoryTable(page).locator('.unavailable-entry').filter({ hasText: alias })).toHaveAttribute('aria-disabled', 'true')
  }
  await directoryTable(page).getByRole('link', { name: 'index-alias.html', exact: true }).click()
  await expect(page.frameLocator(htmlFrameSelector).getByRole('heading', { name: 'SSH report fixture', exact: true })).toBeVisible()
  assert.equal(new URLSearchParams(page.url().split('#')[1]).get('path'), 'reports/index.html')
  await projectTabs(page).getByRole('tab', { name: 'Browse', exact: true }).click()
  console.log('PASS: contained SSH file/directory/absolute/chained links and canonical HTML aliases; escaping, broken, and cyclic links remain unavailable')

  const folderSearch = page.getByRole('textbox', { name: 'Search directory', exact: true })
  await folderSearch.fill('notes')
  await expect(directoryTable(page).getByRole('link', { name: 'example.py', exact: true })).toHaveCount(0)
  await directoryTable(page).getByRole('link', { name: 'notes.md', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Experiment notes', exact: true })).toBeVisible()
  await projectTabs(page).getByRole('tab', { name: 'Browse', exact: true }).click()
  await expect(folderSearch).toHaveValue('notes')
  await expect(directoryTable(page).getByRole('link', { name: 'example.py', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Up one directory', exact: true }).click()
  await expect(folderSearch).toHaveValue('')
  await folderSearch.fill('reports')
  await directoryTable(page).getByRole('link', { name: 'reports', exact: true }).click()
  await expect(folderSearch).toHaveValue('notes')
  await page.getByRole('button', { name: 'Clear directory search', exact: true }).click()
  await expect(directoryTable(page).getByRole('link', { name: 'example.py', exact: true })).toBeVisible()
  console.log('PASS: Browse filename search survives opening/returning from a file and remains independent per folder')

  const tabs = projectTabs(page)
  while (await tabs.getByRole('button', { name: /^Close / }).count()) await tabs.getByRole('button', { name: /^Close / }).first().click()
  await expect(tabs.getByRole('tab')).toHaveCount(1)
  await tabs.getByRole('tab', { name: 'Browse', exact: true }).focus()
  await page.keyboard.press('Delete')
  await expect(tabs.getByRole('tab')).toHaveCount(1)
  await directoryTable(page).getByRole('link', { name: 'notes.md', exact: true }).click({ modifiers: ['Control'] })
  await directoryTable(page).getByRole('link', { name: 'example.py', exact: true }).click({ button: 'middle' })
  await expect(tabs.getByRole('tab')).toHaveCount(3)
  await expect(tabs.getByRole('tab', { name: 'Browse', exact: true })).toHaveAttribute('aria-selected', 'true')
  await directoryTable(page).getByRole('link', { name: 'notes.md', exact: true }).click()
  await expect(tabs.getByRole('tab')).toHaveCount(3)
  await expect(directoryTable(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Full screen', exact: true }).click()
  await expect(page.locator('#project-sidebar')).not.toBeVisible()
  await expect(tabs).not.toBeVisible()
  await expect(page.getByRole('button')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
  await shot('expanded-reader')
  await page.keyboard.press('Escape')
  await expect(tabs.getByRole('tab')).toHaveCount(3)
  await expect(page.locator('#project-sidebar')).toBeVisible()
  await tabs.getByRole('tab', { name: 'notes.md', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'example.py', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Wrap long lines', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Wrap long lines', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(tabs.getByRole('tab')).toHaveCount(3)
  await expect(tabs.getByRole('tab', { name: 'example.py', exact: true })).toHaveAttribute('aria-selected', 'true')
  await tabs.getByRole('tab', { name: 'example.py', exact: true }).focus()
  await page.keyboard.press('Delete')
  await expect(tabs.getByRole('tab')).toHaveCount(2)
  await expect(tabs.getByRole('tab', { name: 'notes.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  console.log('PASS: project-first chrome, logo/name home links, permanent Browse tab, sortable list/icons, categorized filters, background tabs, reader expansion, and keyboard/reload restoration')

  // Sources exposes instructions, not a browser endpoint that reads SSH files.
  await settings('Sources')
  await expect(page.getByRole('heading', { name: 'Machines & Projects', exact: true })).toBeVisible()
  const discovery = await (await context.request.get(origin + '/api/hosts')).json()
  const discovered = discovery.hosts.find(host => host.target === 'artiface-discovered')
  const dismissedConfig = await removeSource('host', discovered.label, discovered.label, true)
  assert(!dismissedConfig.hosts.some(host => host.target === 'artiface-discovered'))
  await sourcesAfterReload()
  assert(!(await (await context.request.get(origin + '/api/hosts')).json()).hosts.some(host => host.target === 'artiface-discovered'), 'Removed discovery-only host reappeared after reload')
  const importGuide = page.locator('.ssh-import-guide')
  await importGuide.locator('summary').click()
  await expect(importGuide.getByLabel('SSH import command')).toContainText('docker compose run --rm -it')
  await expect(page.getByRole('button', { name: 'Import SSH config', exact: true })).toHaveCount(0)
  const catalog = await restoreSourceReference(discovered)
  assert(catalog.every(host => host.kind === 'local' || ['artiface-smoke', 'artiface-spare', 'artiface-discovered'].includes(host.target)), 'Discovery escaped the isolated fixture')
  assert(catalog.some(host => host.target === 'artiface-discovered'), 'Source edit did not restore a saved alias')
  const localHost = catalog.find(host => host.kind === 'local')
  assert(localHost && localHost.label === 'localhost' && localHost.target === '' && localHost.roots.length === 0)
  assert.equal(catalog.find(host => host.id === spareHost).roots.length, 0)
  await returnToWorkspace()
  await addProject()
  await expect(page.locator('.saved-project')).toHaveCount(1)
  await expect(page.getByRole('combobox', { name: 'Machine', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  await page.getByRole('combobox', { name: 'Machine', exact: true }).selectOption(spareHost)
  await selectFolder({ field: /Remote folder/, initialPath: artifactRoot, branches: ['reports', 'experiments'], selected: 'reports', expectedPath: `${artifactRoot}/reports`, host: spareHost, kind: 'ssh' })
  const savedRemote = await saveProject('Report folder')
  assert.equal(savedRemote.root.path, `${artifactRoot}/reports`)
  await expect(directoryTable(page)).toContainText('notes.md')
  await assertProjectChrome()
  await directoryTable(page).getByRole('link', { name: 'notes.md', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Experiment notes' })).toBeVisible()
  await shot('remote-project')

  await addProject()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const machine = page.getByRole('combobox', { name: 'Machine', exact: true })
  await machine.selectOption(localHost.id)
  await expect(machine.locator(`option[value="${localHost.id}"]`)).toHaveText(localHost.label)
  assert(!/Local machine\s+local\b/i.test(await page.locator('.project-setup').innerText()), 'Local machine label is duplicated')
  await expect(page.locator('.project-setup .state-symbol,.project-setup .eyebrow')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Add a project', exact: true })).toBeVisible()
  await selectFolder({ field: /Local folder/, initialPath: localFixtureRoot, branches: ['projects'], selected: 'local-report', expectedPath: `${localFixtureRoot}/projects/local-report`, host: localHost.id, kind: 'local' })
  const savedLocal = await saveProject('Local reports')
  assert.equal(savedLocal.host.kind, 'local')
  assert.equal(savedLocal.host.target, '')
  const localSource = { host: savedLocal.host.id, root: savedLocal.root.id }
  await directoryTable(page).getByRole('link', { name: 'notes-chain.md', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Local dispatch notes' })).toBeVisible()
  assert.equal(new URLSearchParams(page.url().split('#')[1]).get('path'), 'notes.md')
  await projectTabs(page).getByRole('tab', { name: 'Browse', exact: true }).click()
  await directoryTable(page).getByRole('link', { name: 'nested-link', exact: true }).click()
  assert.equal(new URLSearchParams(page.url().split('#')[1]).get('path'), 'nested')
  await expect(directoryTable(page).getByRole('link', { name: 'child.md', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Up one directory', exact: true }).click()
  await directoryTable(page).getByRole('link', { name: 'notes.md', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Local dispatch notes' })).toBeVisible()
  await open('report.pdf', 'file', localSource)
  await checkPDF('Artiface local PDF smoke test')
  await expect(page.getByRole('navigation', { name: 'Open projects' }).locator('.project-group')).toHaveCount(3)
  await expect(tabs.getByRole('tab')).toHaveCount(3)
  await shot('local-pdf')

  await overview()
  let session = await workspaceSession()
  assert.equal(session.projects.length, 3)
  assert.equal(new Set(session.projects.map(project => project.host)).size, 3)
  await expect(page.locator('.overview-file')).toHaveCount(session.tabs.length)
  await expect(page.locator('.overview-project')).toHaveCount(3)
  await expect(page.locator('.overview-files').getByText('Browse', { exact: true })).toHaveCount(0)
  await expect(tabs).toHaveCount(0)
  await expect(directoryTable(page)).toHaveCount(0)
  await shot('overview')
  await page.getByRole('button', { name: 'Collapse project Report folder', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Expand project Report folder', exact: true })).toBeVisible()
  session = await workspaceSession()
  assert.equal(session.projects.find(project => project.host === spareHost).expanded, false)
  await page.getByRole('button', { name: 'Expand project Report folder', exact: true }).click()
  await page.getByRole('button', { name: 'Open project Report folder on artiface-spare', exact: true }).click()
  await expect(directoryTable(page).getByRole('link', { name: 'notes.md', exact: true })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'Browse', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.getByRole('tab')).toHaveCount(2)
  await page.getByRole('button', { name: 'Close project Report folder', exact: true }).click()
  session = await workspaceSession()
  assert(session.projects.every(project => project.host !== spareHost) && session.tabs.every(tab => tab.host !== spareHost), 'Closing a project retained its session tabs')
  await addProject()
  await savedProject('Report folder')
  await expect(tabs.getByRole('tab')).toHaveCount(1)
  await directoryTable(page).getByRole('link', { name: 'notes.md', exact: true }).click()
  console.log('PASS: isolated SSH import, saved-project chooser, new-project Machine selection, local/SSH folder trees, cross-host projects, Overview, disclosure persistence, and project close/reopen')

  await checkFlatBrowse(remote, 'reports/browse-checks')
  await checkFlatBrowse(localSource, 'browse-checks')
  await checkFolderFileTypes(localSource, { host: savedRemote.host.id, root: savedRemote.root.id })
  await checkIgnoreRules(localSource)
  await checkChooserRemoval(localSource)
  console.log('PASS: local/SSH flat relative paths, duplicate basenames, sorting/filter/view persistence, nested hidden/cache rules, saved and empty ignores, retained conflict drafts, and chooser cancellation/removal without file changes')

  await settings('Configuration')
  const editor = page.getByRole('textbox', { name: 'Configuration JSON', exact: true })
  await expect(editor).toBeEnabled()
  const editedConfig = JSON.parse(await editor.inputValue())
  assert.equal(editedConfig.passwordHash, undefined, 'Editor exposed password credentials')
  const configuredSpare = editedConfig.hosts.find(host => host.id === spareHost)
  assert.equal(configuredSpare.target, 'artiface-spare')
  const renamedSource = 'Configured smoke source'
  configuredSpare.label = renamedSource
  await editor.fill(JSON.stringify(editedConfig, null, 2))
  const configSave = postResponse('/api/settings')
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  assert.equal((await configSave).status(), 200)
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible()
  await returnToWorkspace()
  await page.reload()
  await expect(page.getByRole('button', { name: `Open project Report folder on ${renamedSource}`, exact: true })).toBeVisible()
  for (const rootID of [null, savedRemote.root.id]) {
    const checkboxName = rootID ? `Show Report folder on ${renamedSource}` : `Show ${renamedSource}`
    for (const visible of [false, true]) {
      await settings('Sources')
      const checkbox = page.getByRole('checkbox', { name: checkboxName, exact: true })
      if (visible) await expect(checkbox).not.toBeChecked()
      else await expect(checkbox).toBeChecked()
      const visibilitySave = postResponse('/api/settings')
      // This is server-controlled state: it changes after persistence completes.
      await checkbox.click()
      const response = await visibilitySave
      assert.equal(response.status(), 200)
      const savedHost = (await response.json()).config.hosts.find(host => host.id === spareHost)
      const savedEntry = rootID ? savedHost.roots.find(root => root.id === rootID) : savedHost
      assert.equal(Boolean(savedEntry.hidden), !visible)
      await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible()
      if (visible) await expect(checkbox).toBeChecked()
      else await expect(checkbox).not.toBeChecked()
      await returnToWorkspace()
      if (!visible) await expectOverviewFallback(`Back after hiding the current ${rootID ? 'project' : 'host'} should open Overview`)
      await overview()
      await page.reload()
      if (!visible) assert((await workspaceSession()).tabs.every(tab => tab.host !== spareHost), 'Hidden source/project retained open file tabs')
      await addProject()
      const choice = page.locator('.saved-project').filter({ has: page.getByText('Report folder', { exact: true }) })
      await expect(choice).toHaveCount(visible ? 1 : 0)
      if (visible) {
        await savedProject('Report folder')
        await directoryTable(page).getByRole('link', { name: 'notes.md', exact: true }).click()
      }
    }
  }
  console.log('PASS: safe Configuration editor and shared source/project visibility persisted into the chooser and open-project session')

  await checkTables(localSource)
  await checkCollapsibleReaderToolbar()
  await open('reports/index.html')
  const iframe = page.locator(htmlFrameSelector)
  const frame = page.frameLocator(htmlFrameSelector)
  // The bridge runs in both trust states; authored scripts remain blocked below.
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frame.locator('#answer')).toHaveText('loading')
  await expect(page.getByRole('button', { name: /^(Enable|Disable) scripts$/ })).toHaveCount(0)
  let previewAddress = new URL(await iframe.getAttribute('src'))
  assert.equal(previewAddress.origin, origin)
  assert.equal(previewAddress.port, new URL(origin).port, 'HTML did not use the forwarded app port')
  const untrustedCapability = previewAddress.href
  await projectTrust(true)
  assert.equal((await context.request.get(untrustedCapability)).status(), 401, 'Enabling project trust left previous capabilities active')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frame.locator('#answer')).toHaveText('42')
  await expect(frame.locator('#cookies')).toHaveText('isolated')
  await expect(frame.locator('#api')).toHaveText('blocked')
  await expect.poll(() => frame.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
  await expect(frame.locator('body')).toHaveCSS('color', 'rgb(19, 78, 74)')
  await shot('html')
  await checkSVG('reports/assets/plot.svg', remote, true)
  await checkSVG('plot.SVG', localSource)
  console.log('PASS: local/SSH SVG image classification, MIME type, refresh/fullscreen, uppercase extensions, and no SVG script execution in a trusted project')
  await open('reports/second.html')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frame.locator('#answer')).toHaveText('42')
  await expect(frame.getByRole('heading', { name: 'Second SSH report' })).toBeVisible()
  await open('reports/index.html')
  await projectTrust(false)
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frame.locator('#answer')).toHaveText('loading')
  await checkPreviewScriptBoundary({ page, origin, password })
  await open('reports/report.tex')
  await expect(page.getByRole('region', { name: 'File source' })).toContainText('\\documentclass')
  await page.getByRole('button', { name: 'Open compiled PDF', exact: true }).click()
  await checkPDF('Artiface PDF smoke test')
  await page.getByRole('combobox', { name: 'PDF zoom' }).selectOption('1')
  await expect(page.getByRole('region', { name: 'PDF page 1 of 1' })).toHaveAttribute('aria-busy', 'false')
  await shot('pdf')
  console.log('PASS: Markdown/math/source/images, isolated HTML scripts, TeX/compiled PDF, and actual PDF canvas/text rendering')

  // EasyPrivacy blocks /api/stat?: file metadata must not use that analytics URL.
  const blockAnalyticsURL = route => route.abort('blockedbyclient')
  await context.route(/\/api\/stat\?/, blockAnalyticsURL)
  try {
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    const beforeReload = requests.length
    await page.reload()
    await checkPDF('Artiface PDF smoke test')
    const loaded = requests.slice(beforeReload)
    assert(loaded.some(item => item.endpoint === '/api/file-info' && item.query.get('path') === 'reports/report.pdf'),
      'PDF reload skipped its metadata/access check')
    assert(loaded.some(item => item.endpoint === '/api/file' && item.method === 'GET' && item.query.get('path') === 'reports/report.pdf'),
      'PDF reload did not perform a fresh content request')
    assert(!loaded.some(item => item.endpoint === '/api/stat'), 'Reader used a metadata URL blocked as analytics')
  } finally { await context.unroute(/\/api\/stat\?/, blockAnalyticsURL) }
  console.log('PASS: PDF page reload retains authenticated metadata checks when the old analytics-like URL is blocked')

  await open('reports/reader-pages.pdf')
  await checkPDF('Mobile PDF fixture page 1', page, 1, 3)
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await page.getByRole('combobox', { name: 'PDF zoom' }).selectOption('1.25')
  await checkPDF('Mobile PDF fixture page 2', page, 2, 3)
  await page.locator('.pdf-canvas-area').evaluate(element => { element.scrollTop = 80 })
  await expect.poll(() => page.locator('.pdf-canvas-area').evaluate(element => element.scrollTop)).toBe(80)
  const cacheStart = requests.length
  await open('reports/notes.md')
  await projectTabs(page).getByRole('tab', { name: 'reader-pages.pdf', exact: true }).click()
  await checkPDF('Mobile PDF fixture page 2', page, 2, 3)
  await expect(page.getByRole('combobox', { name: 'PDF zoom' })).toHaveValue('1.25')
  await expect.poll(() => page.locator('.pdf-canvas-area').evaluate(element => element.scrollTop)).toBe(80)
  const pdfReads = since => requests.slice(since).filter(item => item.endpoint === '/api/file' && item.method === 'GET' && item.query.get('path') === 'reports/reader-pages.pdf')
  assert.equal(pdfReads(cacheStart).length, 0, 'Switching tabs downloaded an unchanged PDF again')
  assert(requests.slice(cacheStart).some(item => item.endpoint === '/api/file-info' && item.query.get('path') === 'reports/reader-pages.pdf'), 'Cached PDF skipped access/version validation')
  const forceStart = requests.length
  await readerAction('Refresh file')
  await expect.poll(() => pdfReads(forceStart).length).toBeGreaterThan(0)
  await checkPDF('Mobile PDF fixture page 2', page, 2, 3)
  await open('reports/notes.md')
  const denyCachedFile = async route => {
    if (new URL(route.request().url()).searchParams.get('path') === 'reports/reader-pages.pdf') {
      await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Access removed for this fixture"}' })
    } else await route.continue()
  }
  await page.route(/\/api\/file-info\?/, denyCachedFile)
  try {
    await open('reports/reader-pages.pdf')
    await expect(page.getByRole('heading', { name: 'Couldn’t open this PDF', exact: true })).toBeVisible()
    await expect(page.locator('.pdf-paper')).toHaveCount(0)
  } finally { await page.unroute(/\/api\/file-info\?/, denyCachedFile) }
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  // Revocation clears the document; retry retains the mounted reader's view.
  await checkPDF('Mobile PDF fixture page 2', page, 2, 3)
  await expect(page.getByRole('combobox', { name: 'PDF zoom' })).toHaveValue('1.25')
  await projectTabs(page).getByRole('button', { name: 'Close reader-pages.pdf', exact: true }).click()
  const closeStart = requests.length
  await open('reports/reader-pages.pdf')
  await checkPDF('Mobile PDF fixture page 1', page, 1, 3)
  assert(pdfReads(closeStart).length > 0, 'Closing a PDF tab kept its cached document')
  await open('reports/report.pdf')
  console.log('PASS: PDF tab reuse avoids content downloads, revalidates metadata, restores page/zoom/scroll, bypasses cache on refresh, and frees closed tabs')

  await open('reports/long-reader.pdf')
  await checkPDF('Long PDF fixture page 1', page, 1, 50)
  await checkReaderControls()
  await readerOptions()
  await page.getByRole('combobox', { name: 'PDF page navigation' }).selectOption('vertical')
  await page.keyboard.press('Escape')
  await page.getByRole('spinbutton', { name: 'Page number', exact: true }).fill('30')
  await page.getByRole('spinbutton', { name: 'Page number', exact: true }).press('Enter')
  await checkPDF('Long PDF fixture page 30', page, 30, 50)
  assert(await page.locator('.pdf-paper').count() < 6, 'Continuous scrolling mounted the entire PDF')
  await expect(page.getByLabel('Page 1', { exact: true })).toHaveCount(0)
  const verticalPosition = await page.locator('.pdf-canvas-area').evaluate(element => {
    element.scrollTop += 70
    return element.scrollTop
  })
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('30')
  const verticalCacheStart = requests.length
  await open('reports/notes.md')
  await projectTabs(page).getByRole('tab', { name: 'long-reader.pdf', exact: true }).click()
  await checkPDF('Long PDF fixture page 30', page, 30, 50)
  await expect.poll(() => page.locator('.pdf-canvas-area').evaluate(element => element.scrollTop)).toBeCloseTo(verticalPosition, 0)
  assert(!requests.slice(verticalCacheStart).some(item => item.endpoint === '/api/file' && item.method === 'GET' && item.query.get('path') === 'reports/long-reader.pdf'),
    'Continuous scrolling lost the cached PDF on a tab switch')
  await shot('pdf-vertical')
  await page.reload()
  await readerOptions()
  await expect(page.getByRole('combobox', { name: 'PDF page navigation' })).toHaveValue('vertical')
  await page.getByRole('combobox', { name: 'PDF page navigation' }).selectOption('horizontal')
  await page.keyboard.press('Escape')
  await open('reports/report.pdf')
  console.log('PASS: desktop adaptive reader actions, repeated rotations, bounded continuous PDF pages, position/cache restoration, and remembered navigation mode')
  await checkPDFCompression({ browser, origin, password, sources: [
    { ...remote, path: 'reports/reader-pages.pdf' },
    { ...localSource, path: 'report.pdf' },
  ] })
  await checkPDFCompatibility({ browser, origin, password, source: { ...localSource, path: 'report.pdf' } })
  await checkPDFFind({ browser, origin, password, source: { ...remote, path: 'reports/long-reader.pdf' }, capture: shot })

  await settings()
  await page.getByRole('combobox', { name: 'Automatic refresh interval', exact: true }).selectOption('2')
  await returnToWorkspace()
  await checkPDF('Artiface PDF smoke test')
  await page.getByRole('combobox', { name: 'PDF zoom' }).selectOption('1.25')
  await expect(page.getByLabel('Page 1', { exact: true })).toHaveCSS('width', '500px')
  await page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.ok() && url.pathname === '/api/file-info' && url.searchParams.get('host') === 'smoke' &&
      url.searchParams.get('root') === 'artifacts' && url.searchParams.get('path') === 'reports/report.pdf'
  })
  const originalPDF = await readFile(join(artifactRoot, 'reports/report.pdf'))
  const oldTitle = Buffer.from('Artiface PDF smoke test', 'ascii')
  const newTitle = Buffer.from('Artiface updated report', 'ascii')
  assert.equal(newTitle.length, oldTitle.length, 'PDF title replacement must preserve object offsets')
  const titleOffset = originalPDF.indexOf(oldTitle)
  assert(titleOffset >= 0 && originalPDF.indexOf(oldTitle, titleOffset + oldTitle.length) === -1, 'Expected one PDF fixture title')
  const updatedPDF = Buffer.from(originalPDF)
  newTitle.copy(updatedPDF, titleOffset)
  assert.equal(updatedPDF.length, originalPDF.length)
  try {
    await mutateFixture('reports/report.pdf', updatedPDF)
    await expect(page.locator('.pdf-text-layer')).toContainText(newTitle.toString('ascii'), { timeout: 12_000 })
    await checkPDF(newTitle.toString('ascii'))
    await expect(page.locator('.pdf-text-layer')).not.toContainText(oldTitle.toString('ascii'))
    await expect(page.getByRole('combobox', { name: 'PDF zoom' })).toHaveValue('1.25')
    await expect(page.getByLabel('Page 1', { exact: true })).toHaveCSS('width', '500px')
  } finally {
    await mutateFixture('reports/report.pdf', originalPDF)
  }
  console.log('PASS: same-size real SSH PDF update refreshes rendered text while retaining 125% zoom')

  // Only the visible file polls; unchanged metadata must not repeatedly reload contents.
  await open('reports', 'directory')
  await directoryTable(page).getByRole('link', { name: 'example.py', exact: true }).click({ modifiers: ['Control'] })
  await directoryTable(page).getByRole('link', { name: 'notes.md', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Experiment notes' })).toBeVisible()
  await expectRefreshPaused(false)
  let start = requests.length
  await expect.poll(() => requests.slice(start).filter(item => item.endpoint === '/api/file-info').length, { timeout: 8000 }).toBeGreaterThanOrEqual(2)
  let observed = requests.slice(start)
  assert(observed.filter(item => item.endpoint === '/api/file-info').every(item => item.query.get('host') === 'smoke' && item.query.get('root') === 'artifacts' && item.query.get('path') === 'reports/notes.md'), 'Background files were polled')
  assert(!observed.some(item => ['/api/text', '/api/preview', '/api/file', '/api/list'].includes(item.endpoint)), 'Unchanged metadata reloaded contents or a reader file list')
  const originalNotes = await readFile(join(artifactRoot, 'reports/notes.md'), 'utf8')
  await mutateFixture('reports/notes.md', originalNotes + '\n\nLive update one.\n')
  await expect(activeReader(page).locator('.markdown-viewer')).toContainText('Live update one.', { timeout: 12_000 })
  await readerAction('Pause automatic refresh')
  await expectRefreshPaused(true)
  await page.reload()
  await expect(activeReader(page).locator('.markdown-viewer')).toContainText('Live update one.')
  await expectRefreshPaused(true)
  session = await workspaceSession()
  assert.equal(session.tabs.find(tab => tab.host === 'smoke' && tab.path === 'reports/notes.md').autoRefreshPaused, true)
  start = requests.length
  await mutateFixture('reports/notes.md', originalNotes + '\n\nLive update two after pause.\n')
  await page.waitForTimeout(4500)
  await expect(activeReader(page).locator('.markdown-viewer')).toContainText('Live update one.')
  await expect(activeReader(page).locator('.markdown-viewer')).not.toContainText('Live update two after pause.')
  assert(!requests.slice(start).some(item => ['/api/file-info', '/api/text', '/api/preview'].includes(item.endpoint)), 'Paused file kept polling or refreshing')
  await readerAction('Resume automatic refresh')
  await expect(activeReader(page).locator('.markdown-viewer')).toContainText('Live update two after pause.', { timeout: 12_000 })
  assert.equal((await workspaceSession()).tabs.find(tab => tab.host === 'smoke' && tab.path === 'reports/notes.md').autoRefreshPaused, false)
  await checkOverviewMetadata(originalNotes)
  await open('reports/index.html')
  await projectTrust(true)
  await expect(frame.locator('#answer')).toHaveText('42')
  start = requests.length
  await expect.poll(() => requests.slice(start).filter(item => item.endpoint === '/api/file-info' && item.query.get('path') === 'reports/index.html').length, { timeout: 8000 }).toBeGreaterThanOrEqual(1)
  const originalHTML = await readFile(join(artifactRoot, 'reports/index.html'), 'utf8')
  await mutateFixture('reports/index.html', originalHTML.replace('</body>', '<p id="live-revision">New HTML revision</p></body>'))
  await expect(frame.locator('#live-revision')).toHaveText('New HTML revision', { timeout: 12_000 })
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frame.locator('#answer')).toHaveText('42')
  await expect(frame.locator('#cookies')).toHaveText('isolated')
  await readerAction('Pause automatic refresh')
  await expectRefreshPaused(true)
  const trustedCapability = await iframe.getAttribute('src')
  await projectTrust(false)
  await expectRefreshPaused(true)
  assert.equal((await context.request.get(trustedCapability)).status(), 401, 'Disabling trust left the paused report capability active')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  assert.notEqual(await iframe.getAttribute('src'), trustedCapability, 'Paused report did not receive a fresh capability after project trust changed')
  await expect(frame.locator('#live-revision')).toHaveText('New HTML revision')
  await expect(frame.locator('#answer')).toHaveText('loading')
  await expect(frame.locator('#cookies')).toHaveText('')
  await mutateFixture('reports/index.html', originalHTML)
  console.log('PASS: real SSH updates refresh visible content; pause persists; background readers stay idle; Overview refreshes actual dates with at most two metadata requests and no content fetches; project trust survives HTML changes and disabling trust revokes/refetches paused reports')

  await open('reports/notes.md')
  await settings()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await checkContrast('dark')
  await page.getByRole('combobox', { name: 'Interface text size' }).selectOption('1.2')
  await page.getByRole('combobox', { name: 'Reader text size' }).selectOption('20')
  await returnToWorkspace()
  await expect(activeReader(page).locator('.markdown-viewer')).toHaveCSS('font-size', '20px')
  await expect(page.locator('body')).toHaveCSS('font-size', '16.8px')
  await checkSidebarSelection()
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(activeReader(page).locator('.source-viewer')).toHaveCSS('font-size', '20px')
  await page.getByRole('button', { name: 'Rendered', exact: true }).click()
  await shot('dark-reader')
  await settings()
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await checkContrast('light')
  await page.getByRole('combobox', { name: 'Interface text size' }).selectOption('1')
  await page.getByRole('combobox', { name: 'Reader text size' }).selectOption('18')
  await page.getByRole('combobox', { name: 'Layout density' }).selectOption('compact')
  await returnToWorkspace()
  const overlayToggle = page.getByRole('button', { name: 'Use overlay sidebar', exact: true })
  assert.equal((await overlayToggle.innerText()).trim(), '', 'Dock/overlay control should be an icon')
  await checkSidebarFade(() => overlayToggle.click())
  await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toBeVisible()
  await expect.poll(async () => (await page.locator('.workspace-main').boundingBox()).x).toBe(0)
  await expect(page.locator('.projects-sidebar')).toHaveCSS('box-shadow', 'none')
  await expect(page.locator('.project-sidebar-backdrop')).toHaveCSS('backdrop-filter', 'none')
  const backdrop = await page.locator('.project-sidebar-backdrop').evaluate(element => ({ color: getComputedStyle(element).backgroundColor, opacity: Number(getComputedStyle(element).opacity) }))
  const alpha = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(backdrop.color)
  assert(backdrop.opacity * (alpha ? Number(alpha[1]) : 1) >= .15, 'Overlay backdrop is too faint')
  await assertProjectChrome()
  await shot('sidebar-overlay')
  await checkSidebarFade(() => page.keyboard.press('Escape'))
  await expect(page.locator('#project-sidebar')).not.toBeVisible()
  await expect(page.locator('.project-sidebar-backdrop')).not.toBeVisible()
  await assertProjectChrome()
  await page.getByRole('button', { name: 'Show project sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'Dock sidebar', exact: true }).click()
  await expect.poll(async () => (await page.locator('.workspace-main').boundingBox()).x).toBeGreaterThanOrEqual(220)
  await page.getByRole('button', { name: 'Hide project sidebar', exact: true }).click()
  await expect(page.locator('#project-sidebar')).not.toBeVisible()
  await assertProjectChrome()
  await page.getByRole('button', { name: 'Show project sidebar', exact: true }).click()

  const authenticatedState = await context.storageState()
  for (const width of [390, 768, 1024]) {
    const touchContext = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: true, storageState: authenticatedState })
    touchContext.setDefaultTimeout(20_000)
    const touchPage = await touchContext.newPage()
    if (width === 390) await touchPage.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined })
    })
    touchPage.on('pageerror', error => pageErrors.push(error.message))
    try {
      await open('reports', 'directory', remote, touchPage)
      await expect(directoryTable(touchPage)).toBeVisible()
      await assertProjectChrome(touchPage)
      assert(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches))
      assert((await directoryTable(touchPage).locator('tbody tr').first().boundingBox()).height >= 32, `${width}: compact touch rows too small`)
      assert((await touchPage.getByRole('button', { name: 'Settings', exact: true }).boundingBox()).height >= 32, `${width}: compact touch controls too small`)
      await checkTouchDensity(touchPage)
      await noOverflow(touchPage, `${width} touch Browse`)
      if (width === 390) {
        await expect(touchPage.locator('#project-sidebar')).not.toBeVisible()
        await touchPage.getByRole('button', { name: 'Show project sidebar', exact: true }).click()
        await expect(touchPage.getByRole('dialog', { name: 'Projects', exact: true })).toBeVisible()
        await expect(touchPage.getByRole('button', { name: 'Open project Artifacts on SSH fixture', exact: true })).toBeInViewport()
        await touchPage.keyboard.press('Escape')
        await expect(touchPage.locator('#project-sidebar')).not.toBeVisible()
        assert.equal(await touchPage.evaluate(() => JSON.parse(localStorage.getItem('artiface.preferences.v1')).sidebarMode), 'dock', 'Phone overwrote desktop sidebar preference')
      }
      await directoryTable(touchPage).getByRole('link', { name: 'notes.md', exact: true }).click()
      await expect(touchPage.getByRole('heading', { name: 'Experiment notes', exact: true })).toBeVisible()
      await expect(activeReader(touchPage).locator('.markdown-viewer')).toHaveCSS('font-size', '18px')
      await expect(directoryTable(touchPage)).toHaveCount(0)
      await noOverflow(touchPage, `${width} touch reader`)
      await shot(`touch-${width}`, touchPage)
      await checkMobilePDF(touchPage, `touch-${width}`)
      if (width === 390) await checkSVG('reports/assets/plot.svg', remote, false, touchPage)
      await open('reports/notes.md', 'file', remote, touchPage)
      await touchPage.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(touchPage.locator('.settings-header')).toHaveCount(1)
      await expect(touchPage.locator('.project-topline:visible,.app-header:visible')).toHaveCount(0)
      await noOverflow(touchPage, `${width} touch Settings`)
      if (width <= 700) await touchPage.getByRole('combobox', { name: 'Settings section', exact: true }).selectOption({ label: 'Security' })
      else await touchPage.getByRole('button', { name: 'Security', exact: true }).click()
      await expect(touchPage.getByLabel('Current password', { exact: true })).toBeVisible()
      await noOverflow(touchPage, `${width} touch password settings`)
      await touchPage.getByRole('button', { name: 'Back to workspace', exact: true }).click()
      await expect(touchPage.getByRole('heading', { name: 'Experiment notes', exact: true })).toBeVisible()
      if (width === 390) {
        await touchPage.setViewportSize({ width: 320, height: 900 })
        await open('reports/browse-checks', 'directory', remote, touchPage)
        await touchPage.getByRole('button', { name: 'Browse settings', exact: true }).click()
        await touchPage.getByRole('checkbox', { name: 'Show files from all subfolders', exact: true }).check()
        await expect(directoryTable(touchPage).getByRole('link', { name: 'left/shared.md', exact: true })).toBeVisible()
        await expect(directoryTable(touchPage).locator('.folder-icon')).toHaveCount(0)
        const panel = await touchPage.locator('#browse-settings-panel').boundingBox()
        assert(panel && panel.x >= 0 && panel.x + panel.width <= 321, '320px Browse settings extends outside the viewport')
        await noOverflow(touchPage, '320 touch flat Browse settings')
        await shot('touch-320-flat-settings', touchPage)
        await touchPage.keyboard.press('Escape')
        await noOverflow(touchPage, '320 touch flat Browse')
        await shot('touch-320-flat', touchPage)
        await touchPage.setViewportSize({ width: 320, height: 568 })
        await checkMobilePDF(touchPage, 'touch-320')
        await touchPage.setViewportSize({ width: 844, height: 390 })
        await checkMobilePDF(touchPage, 'touch-landscape')
      }
    } finally { await touchContext.close() }
  }
  console.log('PASS: single Settings header/back, appearance/contrast/fonts, one sidebar toggle, icon dock/overlay, animated dimming without blur/shadow, and phone/tablet layouts')

  // Host deletion removes saved credentials and trusted keys as well as source references.
  // Restoring references leaves credentials deleted and never edits the isolated SSH config or files.
  const notesBeforeRemoval = await readFile(join(artifactRoot, 'reports/notes.md'))
  const localNotesBeforeRemoval = await readFile(join(localFixtureRoot, 'projects/local-report/notes.md'))
  await open('', 'directory', { host: savedRemote.host.id, root: savedRemote.root.id })
  await settings('Sources')
  let removedConfig = await removeSource('project', 'Report folder', renamedSource, true)
  assert.equal(removedConfig.hosts.find(host => host.target === 'artiface-spare').roots.length, 0)
  assert.deepEqual(await readFile(join(artifactRoot, 'reports/notes.md')), notesBeforeRemoval, 'Project removal changed files')
  await returnToWorkspace()
  await expectOverviewFallback('Back after deleting the current Browse project should open Overview')
  await settings('Sources')
  await sourcesAfterReload()
  await expect(page.getByRole('checkbox', { name: 'Allow scripts in Report folder', exact: true })).toHaveCount(0)
  const restoredReportProject = await settingsProject(renamedSource, `${artifactRoot}/reports`, 'Report folder')
  await returnToWorkspace()
  await open('notes.md', 'file', { host: restoredReportProject.host.id, root: restoredReportProject.root.id })
  await settings('Sources')
  removedConfig = await removeSource('host', renamedSource)
  assert(!removedConfig.hosts.some(host => host.target === 'artiface-spare'))
  await returnToWorkspace()
  await expectOverviewFallback('Back after deleting the current reader’s SSH host should open Overview')
  await settings('Sources')
  await sourcesAfterReload()
  assert(!(await (await context.request.get(origin + '/api/hosts')).json()).hosts.some(host => host.target === 'artiface-spare'), 'Configured host returned through SSH discovery after removal')
  const restoredCatalog = await restoreSourceReference(catalog.find(host => host.target === 'artiface-spare'))
  const restoredSpare = restoredCatalog.find(host => host.target === 'artiface-spare')
  assert(restoredSpare && restoredSpare.roots.length === 0, 'SSH restoration unexpectedly restored deleted projects')
  await settingsProject(restoredSpare.label, `${artifactRoot}/reports`, 'Report folder')
  await returnToWorkspace()
  await open('notes.md', 'file', localSource)
  await settings('Sources')
  removedConfig = await removeSource('host', 'localhost')
  assert.equal(removedConfig.hideLocalSource, true)
  assert(!removedConfig.hosts.some(host => host.kind === 'local'))
  await returnToWorkspace()
  await expectOverviewFallback('Back after deleting the current reader’s local host should open Overview')
  await settings('Sources')
  await sourcesAfterReload()
  assert(!(await (await context.request.get(origin + '/api/hosts')).json()).hosts.some(host => host.kind === 'local'), 'Removed localhost source was regenerated automatically')
  const restoreLocal = postResponse('/api/settings')
  await page.getByRole('button', { name: 'Add localhost', exact: true }).click()
  assert.equal((await restoreLocal).status(), 200)
  await expect(page.getByRole('heading', { name: 'localhost', exact: true })).toBeVisible()
  const restoredLocal = await settingsProject('localhost', `${localFixtureRoot}/projects/local-report`, 'Local reports')
  assert.equal(restoredLocal.host.kind, 'local')
  assert.deepEqual(await readFile(join(localFixtureRoot, 'projects/local-report/notes.md')), localNotesBeforeRemoval, 'Localhost removal changed files')
  await returnToWorkspace()
  console.log('PASS: named project/host deletion, persistent dismissal/restoration, untouched files, and Back returning to Overview after hiding/deleting the current Browse project or reader host')

  await open('reports/résultats #1.md')
  await expect(page.getByRole('heading', { name: 'Encoded artifact' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByLabel('Workspace password')).toBeVisible()
  assert.equal(await page.evaluate(() => sessionStorage.getItem('artiface.workspace.v1')), null, 'Logout retained project/tab session')
  await page.getByLabel('Workspace password').fill(password)
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Encoded artifact' })).toBeVisible()
  await checkPWA({ page, origin })
  assert.equal(JSON.parse(await readFile(join(fixtureDirectory, 'config.json'), 'utf8')).passwordHash,
    initialPasswordHash, 'Source settings changed the password hash')
  await settings('Security')
  const changedPassword = 'newpass6'
  await shot('password-settings')
  await page.getByLabel('Current password', { exact: true }).fill('incorrect')
  await page.getByLabel('New password', { exact: true }).fill(changedPassword)
  await page.getByLabel('Confirm new password', { exact: true }).fill('different')
  await page.getByRole('button', { name: 'Change password', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('New passwords do not match.')
  await page.getByLabel('Confirm new password', { exact: true }).fill(changedPassword)
  await page.getByRole('button', { name: 'Change password', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Incorrect current password')
  await page.getByLabel('Current password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Change password', exact: true }).click()
  await expect(page.getByLabel('Workspace password')).toBeVisible()
  await page.getByLabel('Workspace password').fill(password)
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Incorrect password')
  await page.getByLabel('Workspace password').fill(changedPassword)
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await returnToWorkspace()
  await open('reports/résultats #1.md')
  await expect(page.getByRole('heading', { name: 'Encoded artifact' })).toBeVisible()
  // Restore the fixture password so the parent smoke can finish its checks.
  await settings('Security')
  await page.getByLabel('Current password', { exact: true }).fill(changedPassword)
  await page.getByLabel('New password', { exact: true }).fill(password)
  await page.getByLabel('Confirm new password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Change password', exact: true }).click()
  await expect(page.getByLabel('Workspace password')).toBeVisible()
  await page.getByLabel('Workspace password').fill(password)
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await returnToWorkspace()
  await open('reports/résultats #1.md')
  await expect(page.getByRole('heading', { name: 'Encoded artifact' })).toBeVisible()
  console.log('PASS: password confirmation, current-password verification, immediate change, and reauthentication')
  await checkSharedProjects({ browser, origin, password, newProjectPath: `${artifactRoot}/reports/experiments`, files: [
    { ...remote, path: 'reports/notes.md' },
    { host: restoredLocal.host.id, root: restoredLocal.root.id, path: 'notes.md' },
  ] })
  console.log('PASS: cross-device project persistence, separate file tabs, stale-device merges, failed-save retry, and no project deletion on logout')
  await open('reports/résultats #1.md')
  await context.clearCookies()
  await page.reload()
  await expect(page.getByLabel('Workspace password')).toBeVisible()
  assert(page.url().includes('r%C3%A9sultats'), 'Session expiry discarded the authenticated deep link')
  assert.deepEqual(pageErrors, [], 'Unexpected browser JavaScript errors')
  console.log('PASS: Artiface real SSH/local project workspace, viewer/security boundaries, automatic refresh, persisted sessions, responsive UI, and PWA')
} catch (error) {
  await shot('failure').catch(() => {})
  throw error
} finally {
  // All mutations are confined to the generated fixture directory, even on failure.
  for (const [filename, contents] of originals) await writeFile(filename, contents)
  await context.close()
  await browser.close()
}
