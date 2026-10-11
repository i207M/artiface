import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const directory = await mkdtemp(join(tmpdir(), 'artiface-project-setup-'))
const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const browserName = process.env.ARTIFACE_BROWSER || 'chromium'
const entry = join(repository, 'web/src/__held_save_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'held-save-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css')) return '\0fixture-css'
      if (id.includes('.svg?')) return '\0fixture-logo'
      if (id === './FilePreview') return '\0fixture-reader'
    },
    async load(id) {
      if (id === '\0fixture-css') return 'export default ""'
      if (id === '\0fixture-logo') return `export default ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(await readFile(join(repository, 'web/public/favicon.svg'))).toString('base64'))}`
      if (id === '\0fixture-reader') return 'export default function Reader(){return "Synthetic reader"}'
      if (id === entry) return `
        import {createRoot} from 'react-dom/client'
        import App from './App'
        import ProjectChooser from './components/ProjectChooser'
        createRoot(document.getElementById('root')).render(location.search === '?chooser-only'
          ? <main><ProjectChooser hosts={window.fixtureHosts} setupEnabled onOpen={() => {}}
              onSaved={(host, root, current) => window.fixtureCallbacks.push({host, root, current})} onRemoved={() => {}} onSettings={() => {}}/></main>
          : <App/>);
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'components/workspace.css', 'components/settings.css'].map(path =>
  readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>`
const origin = 'http://held-project-save.invalid'
const errors = []
const evidence = []
await mkdir(join(directory, 'screenshots'), { recursive: true })
const browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true })
async function fixture(width, isolated = false, projectCount = 1) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, serviceWorkers: 'block' })
  context.setDefaultTimeout(8000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.addInitScript(({ origin, projectCount }) => {
    if (window.top !== window || location.origin !== origin) return
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ theme: 'light', density: 'compact', sidebarVisible: false }))
    window.fixtureHosts = [
      { id: 'local', kind: 'local', label: 'localhost', target: '', roots: [{ id: 'design', label: 'Design review', path: '/synthetic/saved/design' }] },
      { id: 'lab', kind: 'ssh', label: 'Fixture lab', target: 'synthetic-lab', roots: [] },
    ]
    for (let index = 1; index < projectCount; index++) window.fixtureHosts[0].roots.push({
      id: `project-${index}`, label: `Project ${index + 1}`, path: `/synthetic/saved/project-${index}`,
    })
    window.fixtureRequests = []
    window.fixtureCallbacks = []
    window.fixtureRevision = 1
    window.fixturePending = null
    window.fixtureCompleted = false
    window.fixturePendingRemoval = null
    const workspace = new Map()
    const json = body => new Response(JSON.stringify(body), { status: 200 })
    window.fixtureReleaseRemoval = (status = 200) => {
      const pending = window.fixturePendingRemoval
      if (!pending) throw new Error('No held project removal')
      window.fixturePendingRemoval = null
      if (status !== 200) {
        pending.resolve(new Response(JSON.stringify({ error: 'Synthetic removal conflict' }), { status }))
        return
      }
      window.fixtureHosts = pending.body.config.hosts
      window.fixtureRevision++
      pending.resolve(json({ config: pending.body.config, revision: 'fixture-' + window.fixtureRevision }))
    }
    window.fixtureReleaseSave = (failure = false) => {
      const pending = window.fixturePending
      if (!pending) throw new Error('No held project save')
      window.fixturePending = null
      const { body, resolve } = pending
      if (failure) {
        resolve(new Response(JSON.stringify({ error: 'Synthetic save failure' }), { status: 503 }))
        return
      }
      const host = window.fixtureHosts.find(host => host.id === body.host)
      const root = { id: 'completed', label: body.label, path: body.path }
      host.roots.push(root)
      window.fixtureRevision++
      window.fixtureCompleted = true
      resolve(json({ host, root }))
    }
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, location.href)
      const endpoint = parsed.pathname
      const body = options.body ? JSON.parse(options.body) : undefined
      window.fixtureRequests.push({ endpoint, method: options.method || 'GET', body, revision: window.fixtureRevision, csrf: options.headers?.['X-CSRF-Token'] })
      if (endpoint === '/api/session') return json({ authenticated: true, mode: 'personal', role: 'personal', csrfToken: 'synthetic' })
      if (endpoint === '/api/hosts') return json({ hosts: window.fixtureHosts, setupEnabled: true, revision: 'fixture-' + window.fixtureRevision })
      if (endpoint === '/api/settings') {
        if (body) return new Promise(resolve => { window.fixturePendingRemoval = { body, resolve } })
        return json({ config: { hosts: window.fixtureHosts, sessionHours: 24, listen: 'synthetic-only' }, revision: 'fixture-' + window.fixtureRevision, gitCommit: 'held-save-fixture' })
      }
      if (endpoint === '/api/ignore') return json({ content: '# Synthetic ignore\n', revision: 'ignore-1', path: '/synthetic/ignore', editable: true })
      if (endpoint === '/api/list') return json({ entries: [], path: parsed.searchParams.get('path') || '', ignored: 0 })
      if (endpoint === '/api/workspace/projects') {
        for (const project of body?.open || []) workspace.set(JSON.stringify(project), project)
        for (const project of body?.close || []) workspace.delete(JSON.stringify(project))
        return json({ projects: [...workspace.values()], sourcesRevision: 'fixture-' + window.fixtureRevision })
      }
      if (endpoint === '/api/projects') return new Promise(resolve => { window.fixturePending = { body, resolve } })
      throw new Error('Unexpected fixture request: ' + endpoint)
    }
  }, { origin, projectCount })
  const page = await context.newPage()
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort())
  await page.goto(origin + (isolated ? '/?chooser-only' : '/#kind=add-project'))
  await expect(page.locator('.saved-project')).toHaveCount(projectCount)
  return { context, page }
}
const path = page => page.locator('.project-setup input[name="path"]')
const name = page => page.locator('.project-setup input[name="label"]')
const machine = page => page.getByRole('combobox', { name: 'Machine', exact: true })
async function fill(page, value, label) { await path(page).fill(value); await name(page).fill(label) }
async function startChooserSave(page) {
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  await fill(page, '/synthetic/old-save///', '  Old save  ')
  await page.getByRole('button', { name: 'Add and open project', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Boolean(window.fixturePending))).toBe(true)
  await expect(path(page)).toBeDisabled()
}
async function observe(page) {
  return page.evaluate(() => ({ hash: location.hash, heading: document.querySelector('h1')?.textContent,
    setupHeading: document.querySelector('.project-setup h2')?.textContent,
    machine: document.querySelector('#new-project-machine')?.value,
    path: document.querySelector('.project-setup input[name="path"]')?.value ?? null,
    name: document.querySelector('.project-setup input[name="label"]')?.value ?? null,
    savedCards: document.querySelectorAll('.saved-project').length,
    settingsSection: document.querySelector('.settings-section-select')?.selectedOptions[0]?.textContent ?? document.querySelector('.settings-nav button[aria-current="page"]')?.textContent,
    message: document.querySelector('.settings-message')?.textContent,
    sourceCards: document.querySelectorAll('.source-card').length,
    pending: Boolean(window.fixturePending), completed: window.fixtureCompleted,
  }))
}
async function shot(page, scenario, width, phase) { await page.screenshot({ path: join(directory, 'screenshots', `${scenario}-${width}-${phase}.png`), animations: 'disabled' }) }
async function release(page, failure = false) {
  await page.evaluate(failure => window.fixtureReleaseSave(failure), failure)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function chooseSettingsSection(page, label) {
  const select = page.locator('.settings-section-select')
  if (page.viewportSize().width <= 700) await select.selectOption({ label })
  else await page.locator('.settings-nav').getByRole('button', { name: label, exact: true }).click()
}
async function enterSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible()
  await chooseSettingsSection(page, 'Sources')
  await expect(page.getByRole('heading', { name: 'Machines & Projects', exact: true })).toBeVisible()
}
async function addSettings(page, host = 'localhost') {
  await page.locator('.source-card').filter({ has: page.getByRole('heading', { name: host, exact: true }) }).getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(path(page)).toBeEnabled()
}
async function unchanged(page, before) {
  const after = await observe(page)
  for (const key of ['hash', 'setupHeading', 'machine', 'path', 'name', 'settingsSection']) {
    assert.equal(after[key], before[key], `Late response changed ${key}`)
  }
}
async function refreshed(page, endpoint = '/api/hosts') {
  await expect.poll(() => page.evaluate(endpoint => window.fixtureRequests.some(request => request.endpoint === endpoint && request.revision === 2), endpoint)).toBe(true)
}
async function record(page, scenario, width, before) {
  const after = await observe(page)
  const requests = await page.evaluate(() => window.fixtureRequests)
  evidence.push({ scenario, width, before, after, requests })
  await shot(page, scenario, width, 'after')
  console.log(`PASS ${width}px ${scenario}`)
}
try {
  {
    const { context, page } = await fixture(390, false, 3)
    for (const [label, expected, remaining] of [['Project 2', 'Project 3', 2], ['Project 3', 'Design review', 1], ['Design review', null, 0]]) {
      const trigger = page.getByRole('button', { name: `Remove project ${label} on localhost`, exact: true })
      await trigger.focus()
      await trigger.press('Enter')
      const confirm = page.getByRole('dialog').getByRole('button', { name: 'Remove project', exact: true })
      await confirm.focus()
      await page.keyboard.down('Enter')
      await expect.poll(() => page.evaluate(() => Boolean(window.fixturePendingRemoval))).toBe(true)
      await page.evaluate(() => window.fixtureReleaseRemoval())
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('.saved-project')).toHaveCount(remaining)
      const survivor = expected ? page.locator('.saved-project').filter({ hasText: expected }) : page.getByRole('button', { name: 'New project', exact: true })
      await expect(survivor).toBeFocused()
      await expect(survivor).toBeInViewport()
      await page.keyboard.down('Enter')
      await expect(survivor).toBeFocused()
      await expect(page.locator('.project-chooser')).toBeVisible()
      await expect(page.locator('.project-setup')).toHaveCount(0)
      await page.keyboard.up('Enter')
    }
    assert.equal(await page.evaluate(() => window.fixtureRequests.some(request => request.endpoint === '/api/workspace/projects' && request.body?.open?.length)), false,
      'Held Enter opened the project that received removal focus')
    await page.getByRole('button', { name: 'New project', exact: true }).press('Enter')
    await expect(page.locator('.project-setup')).toBeVisible()
    const writes = await page.evaluate(() => window.fixtureRequests.filter(request => request.endpoint === '/api/settings' && request.method === 'POST'))
    assert.deepEqual(writes.map(request => request.body.revision), ['fixture-1', 'fixture-2', 'fixture-3'])
    await record(page, 'chooser-removal-next-previous-empty', 390, null)
    await context.close()
  }

  for (const intent of ['filter-empty', 'wheel', 'pointer-text', 'newer-navigation', 'conflict', 'identity-change']) {
    const { context, page } = await fixture(390, false, 2)
    if (intent === 'filter-empty') await page.getByRole('textbox', { name: 'Search saved projects', exact: true }).fill('Design review')
    await page.getByRole('button', { name: 'Remove project Design review on localhost', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const confirm = dialog.locator('button.remove-confirm')
    if (intent === 'identity-change') await page.evaluate(() => { window.fixtureHosts[0].roots[0].path = '/synthetic/moved' })
    await confirm.focus()
    await confirm.press('Enter')
    if (intent === 'identity-change') {
      await expect(dialog.getByRole('alert')).toContainText('This project changed since it was listed')
      assert.equal(await page.evaluate(() => window.fixtureRequests.filter(request => request.endpoint === '/api/settings' && request.method === 'POST').length), 0)
      await expect(dialog.locator('.settings-confirm-path')).toContainText('/synthetic/moved')
      await confirm.focus()
      await confirm.press('Enter')
    }
    await expect.poll(() => page.evaluate(() => Boolean(window.fixturePendingRemoval))).toBe(true)
    await expect(confirm).toBeDisabled()
    if (intent === 'wheel') {
      await page.evaluate(() => {
        window.fixtureWheel = false
        document.addEventListener('wheel', () => { window.fixtureWheel = true }, { once: true })
      })
      await page.mouse.move(200, 400)
      await page.mouse.wheel(0, -200)
      await expect.poll(() => page.evaluate(() => window.fixtureWheel)).toBe(true)
    }
    if (intent === 'pointer-text') await dialog.getByRole('heading').click()
    if (intent === 'newer-navigation') {
      await page.evaluate(() => { location.hash = '#kind=overview' })
      await expect(page.locator('.project-chooser')).toHaveCount(0)
      await page.getByRole('button', { name: 'Open a project', exact: true }).focus()
    }
    await page.evaluate(status => window.fixtureReleaseRemoval(status), intent === 'conflict' ? 409 : 200)
    if (intent === 'conflict') {
      await expect(dialog.getByRole('alert')).toContainText('The project was not removed')
      await expect(confirm).toBeEnabled()
      await expect(page.locator('.saved-project')).toHaveCount(2)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    } else {
      await expect(dialog).toHaveCount(0)
      if (intent === 'filter-empty') {
        await expect(page.getByRole('textbox', { name: 'Search saved projects', exact: true })).toBeFocused()
        await expect(page.getByRole('status')).toContainText('No matching projects')
      } else if (intent === 'newer-navigation') await expect(page.getByRole('button', { name: 'Open a project', exact: true })).toBeFocused()
      else if (intent === 'identity-change') await expect(page.locator('.saved-project')).toBeFocused()
      else {
        await expect(page.locator('.saved-project')).toHaveCount(1)
        await expect(page.locator('.saved-project')).not.toBeFocused()
        await expect(page.getByRole('textbox', { name: 'Search saved projects', exact: true })).not.toBeFocused()
      }
    }
    const writes = await page.evaluate(() => window.fixtureRequests.filter(request => request.endpoint === '/api/settings' && request.method === 'POST'))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].body.revision, 'fixture-1')
    await record(page, `chooser-removal-${intent}`, 390, null)
    await context.close()
  }

  for (const width of [1280, 390]) {
    for (const surface of ['chooser', 'settings']) {
      const scenario = `${surface}-local-path-validation`
      const { context, page } = await fixture(width)
      if (surface === 'chooser') await page.getByRole('button', { name: 'New project', exact: true }).click()
      else { await enterSettings(page); await addSettings(page) }
      await fill(page, 'relative/reports', 'Draft label')
      const submit = page.locator('.project-setup button[type="submit"]')
      await submit.focus()
      await submit.press('Enter')
      await expect(path(page)).toBeFocused()
      await expect(path(page)).toHaveAttribute('aria-invalid', 'true')
      await expect(path(page)).toHaveAttribute('aria-describedby', 'project-path-error folder-help')
      await expect(page.getByRole('alert')).toHaveText('Enter an absolute folder path on the selected machine.')
      assert.equal(await page.evaluate(() => window.fixtureRequests.some(request => request.endpoint === '/api/projects')), false)
      await shot(page, scenario, width, 'invalid')
      await name(page).fill('Corrected label')
      await expect(path(page)).toHaveAttribute('aria-invalid', 'true')
      await path(page).fill('/synthetic/corrected/reports')
      await expect(path(page)).not.toHaveAttribute('aria-invalid')
      await expect(path(page)).toHaveAttribute('aria-describedby', 'folder-help')
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(name(page)).toHaveValue('Corrected label')
      await record(page, scenario, width, null)
      await context.close()
    }
    for (const scenario of ['chooser-active', 'chooser-switch-machine', 'chooser-saved-projects', 'chooser-leave', 'chooser-reopen', 'chooser-newer-same-source']) {
      const { context, page } = await fixture(width)
      await startChooserSave(page)
      if (scenario === 'chooser-switch-machine') {
        await machine(page).selectOption('lab')
        await fill(page, '/synthetic/newer-lab', 'Newer lab draft')
      } else if (scenario === 'chooser-saved-projects') {
        await page.getByRole('button', { name: 'Saved projects', exact: true }).click()
      } else if (scenario === 'chooser-leave' || scenario === 'chooser-reopen') {
        await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
        if (scenario === 'chooser-reopen') {
          await page.getByRole('button', { name: 'Open a project', exact: true }).click()
          await page.getByRole('button', { name: 'New project', exact: true }).click()
          await fill(page, '/synthetic/reopened', 'Reopened draft')
        }
      } else if (scenario === 'chooser-newer-same-source') {
        await machine(page).selectOption('lab')
        await machine(page).selectOption('local')
        await fill(page, '/synthetic/newer-local', 'Newer local draft')
      }
      const before = await observe(page)
      if (scenario === 'chooser-switch-machine') await shot(page, scenario, width, 'before')
      await release(page)
      await refreshed(page)
      assert.deepEqual(await page.evaluate(() => window.fixtureRequests.find(request => request.endpoint === '/api/projects').body),
        { host: 'local', kind: 'local', target: '', path: '/synthetic/old-save', label: 'Old save' })
      assert.equal(await page.evaluate(() => window.fixtureRequests.find(request => request.endpoint === '/api/projects').csrf), 'synthetic')
      if (scenario === 'chooser-active') {
        await expect.poll(() => page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('root'))).toBe('completed')
        await expect(path(page)).toHaveCount(0)
      } else {
        await unchanged(page, before)
        assert.equal(await page.evaluate(() => window.fixtureRequests.some(request =>
          request.endpoint === '/api/workspace/projects' && request.body?.open?.some(project => project.root === 'completed'))), false)
      }
      await record(page, scenario, width, before)
      if (['chooser-switch-machine', 'chooser-reopen', 'chooser-newer-same-source'].includes(scenario)) {
        // Reopening the same keyed form must read the retained snapshot, not just its current local state.
        await machine(page).selectOption(before.machine === 'local' ? 'lab' : 'local')
        if (scenario === 'chooser-switch-machine') {
          await expect(path(page)).toHaveValue('')
          await expect(name(page)).toHaveValue('')
        }
        await machine(page).selectOption(before.machine)
        await expect(path(page)).toHaveValue(before.path)
        await expect(name(page)).toHaveValue(before.name)
      } else if (scenario === 'chooser-saved-projects') {
        await expect(page.locator('.saved-project')).toHaveCount(2)
        await expect(page.locator('.saved-project').filter({ hasText: 'Old save' })).toHaveCount(1)
        await page.getByRole('button', { name: 'New project', exact: true }).click()
        await expect(path(page)).toHaveValue('')
        await expect(name(page)).toHaveValue('')
      }
      await context.close()
    }

    {
      // Keep the parent from navigating to prove that completion cannot delete a newer cached draft.
      const scenario = 'chooser-isolated-newer-draft'
      const { context, page } = await fixture(width, true)
      await startChooserSave(page)
      await machine(page).selectOption('lab')
      await machine(page).selectOption('local')
      await fill(page, '/synthetic/newer-local', 'Newer local draft')
      const before = await observe(page)
      await release(page)
      await expect.poll(() => page.evaluate(() => window.fixtureCallbacks.length)).toBe(1)
      assert.equal(await page.evaluate(() => window.fixtureCallbacks[0].current), false)
      await unchanged(page, before)
      await machine(page).selectOption('lab')
      await machine(page).selectOption('local')
      await expect(path(page)).toHaveValue(before.path)
      await expect(name(page)).toHaveValue(before.name)
      await record(page, scenario, width, before)
      await context.close()
    }

    for (const scenario of ['settings-active', 'settings-section-other', 'settings-reopen-same-source', 'settings-reopen-other-source', 'settings-leave', 'settings-whole-page-reopen']) {
      const { context, page } = await fixture(width)
      await enterSettings(page)
      await addSettings(page)
      await fill(page, '/synthetic/old-save', 'Old save')
      await page.getByRole('button', { name: 'Add project', exact: true }).click()
      await expect.poll(() => page.evaluate(() => Boolean(window.fixturePending))).toBe(true)
      await expect(path(page)).toBeDisabled()
      if (scenario === 'settings-section-other' || scenario.startsWith('settings-reopen-')) {
        await chooseSettingsSection(page, 'Appearance')
        if (scenario.startsWith('settings-reopen-')) {
          await chooseSettingsSection(page, 'Sources')
          await addSettings(page, scenario === 'settings-reopen-other-source' ? 'Fixture lab' : 'localhost')
          await fill(page, '/synthetic/newer-settings', 'Newer Settings draft')
        }
      } else if (scenario === 'settings-leave' || scenario === 'settings-whole-page-reopen') {
        await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
        await expect(page.locator('.project-chooser')).toBeVisible()
        if (scenario === 'settings-whole-page-reopen') {
          await enterSettings(page)
          await addSettings(page)
          await fill(page, '/synthetic/reopened-settings', 'Reopened Settings draft')
        }
      }
      const before = await observe(page)
      if (scenario === 'settings-reopen-other-source') await shot(page, scenario, width, 'before')
      await release(page)
      await refreshed(page)
      if (scenario === 'settings-active') {
        await expect(path(page)).toHaveCount(0)
        await expect(page.getByRole('heading', { name: 'Machines & Projects', exact: true })).toBeVisible()
        await expect(page.locator('.settings-message')).toContainText('Project saved.')
      } else {
        await unchanged(page, before)
        await expect(page.locator('.settings-message')).toHaveCount(0)
      }
      if (scenario !== 'settings-leave') await refreshed(page, '/api/settings')
      await record(page, scenario, width, before)
      if (scenario.startsWith('settings-reopen-') || scenario === 'settings-whole-page-reopen') {
        await expect(path(page)).toBeEnabled()
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      } else if (scenario === 'settings-section-other') {
        await chooseSettingsSection(page, 'Sources')
      }
      if (scenario === 'settings-leave') await expect(page.locator('.saved-project')).toHaveCount(2)
      else await expect(page.locator('.source-root').filter({ hasText: 'Old save' })).toHaveCount(1)
      await context.close()
    }

    for (const surface of ['chooser', 'settings']) for (const newer of [false, true]) {
      const scenario = `${surface}-failure-${newer ? 'newer-form' : 'active-retry'}`
      const { context, page } = await fixture(width)
      if (surface === 'chooser') await startChooserSave(page)
      else {
        await enterSettings(page)
        await addSettings(page)
        await fill(page, '/synthetic/old-save', 'Old save')
        await page.getByRole('button', { name: 'Add project', exact: true }).click()
        await expect.poll(() => page.evaluate(() => Boolean(window.fixturePending))).toBe(true)
      }
      if (newer) {
        if (surface === 'chooser') {
          await machine(page).selectOption('lab')
          await machine(page).selectOption('local')
        } else {
          // Exercise failure after a true Settings remount, not only a change of section.
          await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
          await expect(page.locator('.project-chooser')).toBeVisible()
          await enterSettings(page)
          await addSettings(page)
        }
        await fill(page, '/synthetic/newer-after-failure', 'Newer draft')
      }
      const before = await observe(page)
      const requests = await page.evaluate(() => window.fixtureRequests.length)
      const movedFocus = surface === 'chooser' ? machine(page) : page.getByRole('button', { name: 'Back to workspace', exact: true })
      if (!newer) await movedFocus.focus()
      await release(page, true)
      await unchanged(page, before)
      await expect(path(page)).toBeEnabled()
      assert.equal(await page.evaluate(() => window.fixtureRevision), 1)
      assert.equal(await page.evaluate(start => window.fixtureRequests.slice(start).some(request =>
        ['/api/hosts', '/api/settings'].includes(request.endpoint)), requests), false)
      if (newer) await expect(page.locator('.form-error')).toHaveCount(0)
      else {
        await expect(page.locator('.form-error')).toHaveText('Synthetic save failure')
        await expect(movedFocus).toBeFocused()
        await path(page).fill('/synthetic/corrected-after-service-failure')
        await expect(page.locator('.form-error')).toHaveText('Synthetic save failure')
        await expect(path(page)).not.toHaveAttribute('aria-invalid')
      }
      await record(page, scenario, width, before)
      if (newer && surface === 'chooser') {
        await machine(page).selectOption('lab')
        await machine(page).selectOption('local')
        await expect(path(page)).toHaveValue(before.path)
      }
      await page.getByRole('button', { name: surface === 'chooser' ? 'Add and open project' : 'Add project', exact: true }).click()
      await expect.poll(() => page.evaluate(() => Boolean(window.fixturePending))).toBe(true)
      await release(page)
      await refreshed(page)
      if (surface === 'chooser') {
        await expect.poll(() => page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('root'))).toBe('completed')
      } else {
        await expect(path(page)).toHaveCount(0)
        await expect(page.getByRole('heading', { name: 'Machines & Projects', exact: true })).toBeVisible()
      }
      await context.close()
    }
  }
  assert.deepEqual(errors, [])
  await writeFile(join(directory, 'results.json'), JSON.stringify({ evidence, errors }, null, 2) + '\n')
} catch (error) {
  const page = browser.contexts().at(-1)?.pages()[0]
  if (page) await page.screenshot({ path: join(directory, 'failure.png') })
  await writeFile(join(directory, 'partial-results.json'), JSON.stringify({ evidence, errors }, null, 2) + '\n')
  throw error
} finally {
  await browser.close()
  console.log(`Project setup artifacts: ${directory}`)
}
