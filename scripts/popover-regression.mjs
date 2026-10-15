import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Bundle current sources in memory and intercept every request; no server or build output is used.
const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const artifacts = process.env.ARTIFACE_POPOVER_ARTIFACTS || await mkdtemp(join(tmpdir(), 'artiface-popovers-'))
await mkdir(artifacts, { recursive: true })
const entry = join(repository, 'web/src/__popover_fixture__.tsx')
const logo = await readFile(join(repository, 'web/public/favicon.svg'), 'utf8')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'isolated-popover-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css')) return '\0fixture-style'
      if (id.includes('.svg?')) return '\0fixture-logo'
      if (id === './FilePreview' || id === './GitPDFPreview') return '\0fixture-reader'
    },
    load(id) {
      if (id === '\0fixture-style') return 'export default ""'
      if (id === '\0fixture-logo') return `export default ${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(logo)}`)}`
      if (id === '\0fixture-reader') return 'export default function Reader(){return null}'
      if (id === entry) return `
        import {createRoot} from 'react-dom/client'
        import Workspace from './components/Workspace'
        import {useLocation} from './location'
        import {setPreferences} from './preferences'
        window.fixturePreferences = setPreferences
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
const css = (await Promise.all(['components/settings.css', 'components/workspace.css', 'styles.css']
  .map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://popover-fixture.invalid'
const host = { id: 'fixture', kind: 'local', target: '', label: 'Fixture machine',
  roots: [{ id: 'reports', label: 'Viewport fixture', path: '/synthetic/reports' }] }
const session = {
  projects: [{ host: 'fixture', root: 'reports', directory: 'reports', activePath: null, expanded: true }],
  tabs: [{ host: 'fixture', root: 'reports', path: 'reports/kept.txt', autoRefreshPaused: true }],
}
const measurements = []
const errors = []
const browser = await (process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, serviceWorkers: 'block' })
  context.setDefaultTimeout(10_000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.addInitScript(session => {
    if (location.origin !== 'http://popover-fixture.invalid' || window.top !== window) return
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300, gitStatus: false }))
    sessionStorage.setItem('artiface.workspace.v1', JSON.stringify(session))
  }, session)
  const page = await context.newPage()
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    const responses = {
      '/api/hosts': { hosts: [host], setupEnabled: true, revision: 'fixture' },
      '/api/workspace/projects': { projects: [{ host: 'fixture', root: 'reports' }], sourcesRevision: 'fixture' },
      '/api/list': { entries: Array.from({ length: 80 }, (_, index) => ({
        name: `file-${index}.txt`, path: `reports/file-${index}.txt`, type: 'file', size: 100,
        modified: '2026-09-21T12:00:00Z',
      })) },
    }
    const body = responses[url.pathname]
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? { error: 'Unknown fixture route' }) })
  })
  await page.goto(`${origin}/#host=fixture&root=reports&path=reports&kind=directory`)
  await expect(page.locator('.file-table tbody tr')).toHaveCount(80)
  const initialHash = await page.evaluate(() => location.hash)
  const settle = () => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  })
  const checkBounds = async (id, scenario) => {
    await settle()
    const result = await page.locator(`#${id}`).evaluate(panel => {
      const rect = panel.getBoundingClientRect()
      const content = document.querySelector('.project-content')
      const area = content.getBoundingClientRect()
      const viewport = window.visualViewport
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        availableLeft: Math.max(area.left + content.clientLeft, viewport?.offsetLeft ?? 0),
        availableRight: Math.min(area.left + content.clientLeft + content.clientWidth, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth)),
        availableTop: Math.max(area.top + content.clientTop, viewport?.offsetTop ?? 0),
        availableBottom: Math.min(area.top + content.clientTop + content.clientHeight, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight)),
        horizontalOverflow: panel.scrollWidth - panel.clientWidth,
      }
    })
    measurements.push({ scenario, panel: id, ...result })
    const contained = result.left >= result.availableLeft + 9 && result.right <= result.availableRight - 9 &&
      result.top >= result.availableTop + 9 && result.bottom <= result.availableBottom - 9
    if (!contained || result.horizontalOverflow > 1) await page.screenshot({ path: join(artifacts, 'failure.png') })
    assert(contained, `${scenario}/${id}: popup outside available content: ${JSON.stringify(result)}`)
    assert(result.horizontalOverflow <= 1, `${scenario}/${id}: horizontal content overflow`)
    if (id === 'browse-settings-panel') {
      const rows = await page.locator(`#${id} .settings-check`).evaluateAll(labels => labels.map(label => {
        const box = label.getBoundingClientRect()
        const input = label.querySelector('input').getBoundingClientRect()
        const text = label.querySelector('span').getBoundingClientRect()
        const help = label.nextElementSibling?.matches('p') ? label.nextElementSibling.getBoundingClientRect().x : text.x
        return { x: input.x, width: input.width, height: input.height, text: text.x, help, center: input.y + input.height / 2 - box.y - box.height / 2 }
      }))
      assert.equal(rows.length, 2)
      for (const row of rows) {
        assert(Math.abs(row.x - rows[0].x) < .5 && Math.abs(row.text - rows[0].text) < .5, `${scenario}: Browse checkboxes/text are not aligned`)
        assert(Math.abs(row.width - row.height) < .5 && Math.abs(row.width - rows[0].width) < .5, `${scenario}: Browse checkboxes have inconsistent sizes`)
        assert(Math.abs(row.center) < .5, `${scenario}: Browse checkbox is not centered in its row`)
        assert(Math.abs(row.help - row.text) < .5, `${scenario}: Browse help text is not aligned with its label`)
      }
    }
  }
  const popups = [['File type filters', 'file-filter-panel'], ['Browse settings', 'browse-settings-panel']]
  const filterTrigger = page.getByRole('button', { name: 'File type filters', exact: true })
  for (const activation of ['click', 'tap']) {
    const settingsTrigger = page.getByRole('button', { name: 'Browse settings', exact: true })
    await settingsTrigger.click()
    const settings = page.locator('#browse-settings-panel')
    const select = settings.getByRole('combobox', { name: 'Default sort order', exact: true })
    await settings.locator('.browse-default-sort > span')[activation]()
    await expect(settings).toBeVisible()
    await expect(select).toBeFocused()
    await select.selectOption('modified:desc')
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('artiface.preferences.v1')).defaultBrowseSort),
      { column: 'modified', direction: 'desc' })
    await select.selectOption('name:asc')
    const flat = settings.getByRole('checkbox', { name: 'Show files from all subfolders', exact: true })
    const checked = await flat.isChecked()
    await flat.evaluate(element => {
      window.labelChanges = 0
      element.addEventListener('change', () => window.labelChanges++)
    })
    const label = settings.getByText('Show files from all subfolders', { exact: true })
    const bounds = await label.boundingBox()
    await label[activation]({ position: { x: 60, y: bounds.height / 2 } })
    await expect(settings).toBeVisible()
    await expect(flat).toBeChecked({ checked: !checked })
    assert.equal(await page.evaluate(() => window.labelChanges), 1, 'Browse label toggled more than once')
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(settingsTrigger).toBeFocused()

    await filterTrigger.click()
    const filters = page.locator('#file-filter-panel')
    const markdown = filters.getByRole('checkbox', { name: 'Markdown', exact: true })
    const selected = await markdown.isChecked()
    await markdown.evaluate(element => {
      window.labelChanges = 0
      element.addEventListener('change', () => window.labelChanges++)
    })
    await filters.locator('.file-type-option > span').filter({ hasText: /^Markdown$/ })[activation]()
    await expect(filters).toBeVisible()
    await expect(markdown).toBeChecked({ checked: !selected })
    assert.equal(await page.evaluate(() => window.labelChanges), 1, 'File type label toggled more than once')
    await page.keyboard.press('Escape')
    await expect(filters).toHaveCount(0)
    await expect(filterTrigger).toBeFocused()
  }
  console.log('PASS native sort and checkbox label clicks/taps stay inside popups, activate once, and preserve Escape focus')
  for (const action of ['Show all types', 'Use defaults']) {
    await filterTrigger.click()
    await page.getByRole('button', { name: action, exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#file-filter-panel')).toHaveCount(0)
    await expect(filterTrigger).toBeFocused()
  }
  for (const [name, id] of popups) {
    const trigger = page.getByRole('button', { name, exact: true })
    await trigger.click()
    await page.locator(`#${id}`).locator('button,input,select').last().focus()
    await page.keyboard.press('Tab')
    await expect(page.locator(`#${id}`)).toHaveCount(0)
    assert(await page.evaluate(() => document.activeElement !== document.body), 'Leaving a popup lost keyboard focus')
    await trigger.click()
    await page.locator(`#${id}`).locator('button,input,select').first().focus()
    await page.keyboard.press('Shift+Tab')
    await expect(trigger).toBeFocused()
    await expect(page.locator(`#${id}`)).toBeVisible()
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator(`#${id}`)).toHaveCount(0)
  }
  console.log('PASS closing filter actions return focus; forward/backward keyboard exits dismiss popups without moving focus')
  for (const width of [768, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1024 })
    for (const density of ['compact', 'comfortable']) for (const fontScale of [1, 1.4]) {
      await page.evaluate(preferences => window.fixturePreferences(preferences), { density, fontScale })
      const scenario = `${width}-${density}-${fontScale}`
      for (const [name, id] of popups) {
        const trigger = page.getByRole('button', { name, exact: true })
        await trigger.focus()
        await page.keyboard.press('Enter')
        await expect(page.locator(`#${id}`)).toBeVisible()
        await checkBounds(id, scenario)
        await page.keyboard.press('Tab')
        assert(await page.locator(`#${id}`).evaluate(panel => panel.contains(document.activeElement)), `${scenario}: Tab left the popup controls`)
        if (density === 'comfortable' && fontScale === 1.4 && width !== 320) {
          await page.screenshot({ path: join(artifacts, `${scenario}-${id}.png`) })
        }
        await page.keyboard.press('Escape')
        await expect(page.locator(`#${id}`)).toHaveCount(0)
        await expect(trigger).toBeFocused()
      }
      console.log(`PASS ${scenario}: both popups contained; keyboard entry and Escape focus`)
    }
  }

  await page.setViewportSize({ width: 320, height: 360 })
  for (const [name, id] of popups) {
    await page.getByRole('button', { name, exact: true }).click()
    const panel = page.locator(`#${id}`)
    await checkBounds(id, 'short-phone')
    const scrolled = await panel.evaluate(element => {
      element.scrollTop = Math.min(80, element.scrollHeight - element.clientHeight)
      return element.scrollTop
    })
    assert(scrolled > 0, `${id}: short fixture should require scrolling`)
    await settle()
    assert.equal(await panel.evaluate(element => element.scrollTop), scrolled, `${id}: positioning reset panel scroll`)
    await panel.locator('button,input,select').last().focus()
    await checkBounds(id, 'short-phone-last-control')
    await page.keyboard.press('Escape')
  }
  await page.getByRole('button', { name: 'File type filters', exact: true }).click()
  await page.setViewportSize({ width: 820, height: 600 })
  await checkBounds('file-filter-panel', 'open-resize-phone-to-tablet')
  await page.evaluate(() => window.fixturePreferences({ fontScale: 1, density: 'compact' }))
  await checkBounds('file-filter-panel', 'open-font-density-change')
  await page.locator('.project-content').evaluate(content => { content.scrollTop = 120 })
  await checkBounds('file-filter-panel', 'ancestor-scroll')
  assert.equal(await page.locator('.project-content').evaluate(content => content.scrollTop), 120)
  await page.keyboard.press('Escape')

  await page.locator('.project-content').evaluate(content => { content.scrollTop = 0 })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'File type filters', exact: true }).click()
  const markdown = page.locator('#file-filter-panel').getByRole('checkbox', { name: 'Markdown', exact: true })
  await markdown.uncheck()
  await expect(markdown).toBeFocused()
  await markdown.check()
  await expect(page.locator('#file-filter-panel')).toBeVisible()
  await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
  await expect(page.locator('#file-filter-panel')).toHaveCount(0)
  await checkBounds('browse-settings-panel', 'outside-click-switch')
  await page.getByRole('button', { name: 'Show project sidebar', exact: true }).click()
  await expect(page.locator('#browse-settings-panel')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Browse settings', exact: true }).click()
  await checkBounds('browse-settings-panel', 'phone-after-sidebar-overlay')
  await page.keyboard.press('Escape')
  const final = await page.evaluate(() => ({ hash: location.hash, session: JSON.parse(sessionStorage.getItem('artiface.workspace.v1')) }))
  assert.equal(final.hash, initialHash, 'Popup interaction changed the route')
  assert.deepEqual(final.session.tabs, session.tabs, 'Popup interaction changed file tabs or pause state')
  assert.deepEqual(final.session.projects, session.projects, 'Popup interaction changed projects or Browse location')
  assert.deepEqual(errors, [])
  await context.close()
  console.log('PASS scrolling, open resize, outside-click switching, phone sidebar overlay, and workspace state')
} finally {
  await writeFile(join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
  await browser.close()
  console.log(`Screenshots and measurements: ${artifacts}`)
}
