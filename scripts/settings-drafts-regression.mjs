import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const engine = process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium
const entry = join(repository, 'web/src/__settings_drafts_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'settings-drafts-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css') || id.includes('.svg?')) return '\0fixture-asset'
      if (id === './FilePreview' || id === './GitPDFPreview') return '\0fixture-reader'
    },
    load(id) {
      if (id === '\0fixture-asset') return 'export default ""'
      if (id === '\0fixture-reader') return 'export default function Reader(){return "Synthetic reader"}'
      if (id === entry) return `
        import {StrictMode} from 'react'
        import {createRoot} from 'react-dom/client'
        import App from './App'
        import {sessionExpired} from './api'
        window.expireFixtureSession = sessionExpired
        createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>)
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'components/workspace.css', 'components/settings.css']
  .map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://settings-drafts-fixture.invalid'
const host = { id: 'fixture', kind: 'local', label: 'Fixture', target: '', roots: [] }
const fixtures = [
  { endpoint: 'settings', section: 'Configuration', editor: '#config-editor', save: 'Save configuration', reload: /Reload latest config/,
    text: data => JSON.stringify(data.config, null, 2), edit: (data, label) => JSON.stringify({ ...data.config, listen: label }, null, 2) },
  { endpoint: 'ignore', section: 'Ignored files', editor: '#ignore-editor', save: 'Save ignore rules', reload: 'Reload rules',
    text: data => data.content, edit: (_data, label) => `# ${label}\nprivate-draft/\n` },
]
const browser = await engine.launch({ headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(7000)
  await context.addInitScript(() => {
    const scale = new URL(location.href).searchParams.get('headerFont')
    if (scale) localStorage.setItem('artiface.preferences.v1', JSON.stringify({ fontScale: Number(scale), density: 'compact', theme: 'light' }))
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  let session = { authenticated: true, mode: 'personal', role: 'personal', csrfToken: 'fixture' }
  const data = {
    settings: { config: { hosts: [host], sessionHours: 24, listen: 'baseline' }, revision: 'config-0', gitCommit: 'fixture-build' },
    ignore: { content: '# baseline\n', revision: 'ignore-0', path: '/synthetic/ignore', editable: true },
  }
  const fail = new Set()
  const writeFailures = new Map()
  const posts = []
  let catalogExtras = []
  let setupEnabled = true
  let hold = null
  let version = 0
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/' || url.pathname === '/admin/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    const endpoint = url.pathname.replace(/^\/api\/(?:admin\/)?/, '')
    let body
    let status = 200
    if (endpoint === 'session' || endpoint === 'login') {
      if (endpoint === 'session' && hold?.endpoint === endpoint) { hold.started(); await hold.wait }
      body = session
    }
    else if (endpoint === 'logout') { session = { ...session, authenticated: false }; body = {} }
    else if (endpoint === 'hosts') {
      if (hold?.endpoint === endpoint) { hold.started(); await hold.wait }
      if (fail.has(endpoint)) { status = 503; body = { error: 'Synthetic catalog refresh failure.' } }
      else body = { hosts: [...data.settings.config.hosts, ...catalogExtras], setupEnabled: setupEnabled && session.role !== 'user', revision: JSON.stringify([data.settings.config.hosts, setupEnabled, catalogExtras]) }
    }
    else if (endpoint === 'projects') {
      const submitted = request.postDataJSON()
      posts.push({ endpoint, ...submitted })
      if (hold?.endpoint === endpoint) { hold.started(); await hold.wait }
      const selected = data.settings.config.hosts.find(host => host.id === submitted.host)
      const root = { id: `added-${++version}`, label: submitted.label || 'Added project', path: submitted.path }
      const savedHost = selected ?? { id: `added-host-${version}`, kind: 'ssh', label: submitted.target, target: submitted.target, roots: [] }
      savedHost.roots.push(root)
      if (!selected) data.settings.config.hosts.push(savedHost)
      data.settings.revision = `projects-${version}`
      body = { host: savedHost, root }
    }
    else if (endpoint === 'workspace/projects') body = { projects: [], sourcesRevision: setupEnabled ? 'fixture' : 'fixture-unavailable' }
    else if (endpoint === 'users') body = { users: [] }
    else if (endpoint === 'password') {
      posts.push({ endpoint, path: url.pathname, ...request.postDataJSON() })
      if (hold?.endpoint === endpoint) { hold.started(); await hold.wait }
      const failure = writeFailures.get(endpoint)
      if (failure) { status = failure.status; body = { error: failure.error } }
      else { session = { ...session, authenticated: false }; body = {} }
    }
    else if (endpoint in data) {
      if (request.method() === 'POST') {
        const submitted = request.postDataJSON()
        posts.push({ endpoint, ...submitted })
        if (hold?.endpoint === endpoint) { hold.started(); await hold.wait }
        if (writeFailures.has(endpoint)) {
          status = writeFailures.get(endpoint).status
          body = { error: writeFailures.get(endpoint).error }
        } else if (submitted.revision !== data[endpoint].revision) {
          status = 409
          body = { error: 'Synthetic concurrent edit' }
        } else {
          data[endpoint] = { ...data[endpoint], ...(endpoint === 'settings' ? { config: submitted.config } : { content: submitted.content }),
            revision: `${endpoint}-${++version}` }
          body = data[endpoint]
        }
      } else if (fail.has(endpoint)) { status = 503; body = { error: 'Synthetic read failure' } }
      else body = data[endpoint]
    }
    return route.fulfill({ status: body ? status : 404, contentType: 'application/json', body: JSON.stringify(body ?? { error: 'Unknown fixture route' }) })
  })
  const sectionControl = async label => {
    const control = page.viewportSize().width <= 700
      ? page.locator('.settings-section-select')
      : page.locator('.settings-nav').getByRole('button', { name: label, exact: true })
    await expect(control).toBeVisible()
    return control
  }
  const chooseSection = async label => {
    const control = await sectionControl(label)
    if (page.viewportSize().width <= 700) await control.selectOption({ label })
    else await control.click()
    return control
  }
  const open = async fixture => {
    // Revalidation and history navigation can temporarily unmount Settings.
    const url = new URL(page.url())
    if (url.pathname !== '/admin/' && new URLSearchParams(url.hash.slice(1)).get('kind') !== 'settings') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
    }
    await expect(page.locator('.settings-page')).toBeVisible()
    await chooseSection(fixture.section)
  }
  const back = async () => {
    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
  }
  const warning = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  const reload = async (fixture, accept) => {
    const dialog = page.waitForEvent('dialog')
    const click = page.getByRole('button', { name: fixture.reload }).click()
    const confirmation = await dialog
    assert.equal(confirmation.type(), 'confirm')
    await confirmation[accept ? 'accept' : 'dismiss']()
    await click
  }
  const discard = async fixture => {
    await open(fixture)
    await page.locator(fixture.editor).waitFor()
    await page.locator('.settings-content').getByRole('button', { name: 'Discard draft', exact: true }).filter({ visible: true }).click()
  }
  // Start source cases directly in Settings without abandoning Overview requests.
  await page.goto(`${origin}/#kind=settings`)
  await expect(page.locator('.settings-page')).toBeVisible()
  await page.waitForLoadState('networkidle')

  const headerRoles = [
    { name: 'personal', mode: 'personal', role: 'personal', sections: ['Appearance', 'Ignored files', 'Sources', 'Configuration', 'Security', 'Install app', 'About'] },
    { name: 'team', mode: 'team', role: 'user', sections: ['Appearance', 'Sources', 'Install app', 'About'] },
    { name: 'admin', mode: 'team', role: 'admin', sections: ['Access', 'Ignored files', 'Sources', 'Configuration', 'Security', 'About'] },
  ]
  for (const width of [320, 390]) for (const scale of [1, 1.4]) for (const identity of headerRoles) {
    session = { authenticated: true, mode: identity.mode, role: identity.role, csrfToken: 'fixture' }
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`${origin}${identity.name === 'admin' ? '/admin/' : '/'}?header=${identity.name}-${width}&headerFont=${scale}#kind=settings`)
    await expect(page.locator('.settings-page')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const heading = identity.name === 'admin' ? 'Administration' : 'Settings'
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toHaveCount(1)
    await expect(page.getByRole('region', { name: heading, exact: true })).toBeVisible()
    let mobile = await sectionControl(identity.sections[0])
    await expect(mobile).toHaveAccessibleName(`${heading} section`)
    assert.deepEqual(await mobile.locator('option').allTextContents(), identity.sections)
    await expect(page.locator('.settings-nav')).toHaveCount(0)
    await mobile.focus()
    await mobile.press('End')
    await expect(mobile).toHaveValue('about')
    await expect(mobile).toBeFocused()

    // The current section receives focus when returning from mobile to desktop.
    await page.setViewportSize({ width: 820, height: 900 })
    const about = page.locator('.settings-nav').getByRole('button', { name: 'About', exact: true })
    await expect(about).toBeFocused()
    // Native horizontal scroll offsets round fractional layout sizes.
    await expect.poll(() => about.evaluate(button => {
      const bounds = button.getBoundingClientRect(), nav = button.parentElement.getBoundingClientRect()
      return bounds.left >= nav.left - 1 && bounds.right <= nav.right + 1
    })).toBe(true)
    await expect(page.locator('.settings-section-select')).toHaveCount(0)
    assert.deepEqual(await page.locator('.settings-nav button').allTextContents(), identity.sections)

    // Crossing 700px with an inactive navigation button focused must not change the section.
    const first = page.locator('.settings-nav').getByRole('button', { name: identity.sections[0], exact: true })
    await first.focus()
    await page.setViewportSize({ width: 701, height: 844 })
    await expect(first).toBeFocused()
    await page.setViewportSize({ width: 700, height: 844 })
    mobile = await sectionControl('About')
    await expect(mobile).toBeFocused()
    await expect(mobile).toHaveValue('about')
    await page.setViewportSize({ width, height: 844 })
    await expect(mobile).toBeFocused()
    await page.setViewportSize({ width: 701, height: 844 })
    await expect(about).toBeFocused()

    const backButton = page.getByRole('button', { name: 'Back to workspace', exact: true })
    await backButton.focus()
    await page.setViewportSize({ width, height: 844 })
    await expect(backButton).toBeFocused()
    await page.setViewportSize({ width: 820, height: 900 })
    await expect(backButton).toBeFocused()
    if (identity.name === 'admin') {
      const signout = page.getByRole('button', { name: 'Sign out', exact: true })
      await signout.focus()
      await page.setViewportSize({ width, height: 844 })
      await expect(signout).toBeFocused()
      await page.setViewportSize({ width: 820, height: 900 })
      await expect(signout).toBeFocused()
    }

    const manages = identity.role !== 'user'
    await chooseSection(manages ? 'Configuration' : 'Appearance')
    const field = manages ? page.locator('#config-editor') : page.getByRole('combobox', { name: 'Layout density', exact: true })
    await expect(field).toBeEnabled()
    const draft = fixtures[0].edit(data.settings, 'header-draft')
    if (manages) await field.fill(draft)
    await field.focus()
    await page.setViewportSize({ width, height: 844 })
    await expect(field).toBeFocused()
    await page.setViewportSize({ width: 820, height: 900 })
    await expect(field).toBeFocused()
    await page.setViewportSize({ width, height: 844 })
    await expect(field).toBeFocused()
    if (manages) await expect(field).toHaveValue(draft)

    const scroller = page.locator('.settings-page')
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
    mobile = await sectionControl('About')
    await mobile.focus()
    await mobile.selectOption({ label: 'About' })
    await expect(mobile).toBeFocused()
    assert.equal(await scroller.evaluate(element => element.scrollTop), 0)
    if (manages) {
      await mobile.selectOption({ label: 'Configuration' })
      await expect(field).toHaveValue(draft)
      await page.locator('.settings-content').getByRole('button', { name: 'Discard draft', exact: true }).filter({ visible: true }).click()
    }

    // A deliberate blur is not permission to restore old navigation focus later.
    await mobile.focus()
    await mobile.evaluate(element => element.blur())
    await page.setViewportSize({ width: 701, height: 844 })
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY')
    if (identity.name === 'admin') {
      await page.setViewportSize({ width, height: 844 })
      mobile = await sectionControl('About')
      await mobile.focus()
      await mobile.press('Tab')
      const signout = page.getByRole('button', { name: 'Sign out', exact: true })
      await expect(signout).toBeFocused()
      await signout.press('Enter')
      await expect(page.locator('#password')).toBeVisible()
    }
    await page.waitForLoadState('networkidle')
  }
  console.log('PASS: Header role filtering, 320/390px and large text, both breakpoint directions, unrelated focus, drafts/scroller reset, and admin sign-out')
  await page.evaluate(() => localStorage.removeItem('artiface.preferences.v1'))
  data.settings.sshDisabled = true
  for (const role of ['personal', 'user']) {
    session = { authenticated: true, mode: role === 'user' ? 'team' : 'personal', role, csrfToken: 'fixture' }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${origin}/?ssh-disabled=${role}#kind=settings`)
    await open({ section: 'Sources' })
    const notice = page.getByRole('status').filter({ hasText: 'SSH connectivity is disabled on this server.' })
    await expect(notice).toContainText('Local projects remain available.')
    if (role === 'personal') await expect(notice).toContainText('ARTIFACE_DISABLE_SSH=false')
    else await expect(notice).not.toContainText('ARTIFACE_DISABLE_SSH')
    await open({ section: 'Appearance' })
    await expect(notice).toHaveCount(0)
  }
  delete data.settings.sshDisabled
  session = { authenticated: true, mode: 'personal', role: 'personal', csrfToken: 'fixture' }

  const initialSettings = structuredClone(data.settings)
  const sourceHost = { ...host, roots: Array.from({ length: 16 }, (_, index) => ({
    id: `project-${index}`, label: `Project ${index + 1}`, path: `/synthetic/project-${index}`,
  })) }
  const holdSettings = () => {
    let release, started
    const arrived = new Promise(resolve => { started = resolve })
    hold = { endpoint: 'settings', started, wait: new Promise(resolve => { release = resolve }) }
    return { arrived, release: () => { release(); hold = null } }
  }
  // Native button pointer-focus behavior varies; use keyboard intent for focus assertions.
  const activateSource = async (control, key = 'Enter') => {
    await control.scrollIntoViewIfNeeded()
    await control.focus()
    await control.press(key)
  }
  for (const width of [1280, 390]) {
    data.settings = { ...structuredClone(initialSettings), config: { ...initialSettings.config, hosts: [structuredClone(sourceHost)] }, revision: `source-${width}` }
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(`${origin}/?source=${width}#kind=settings`)
    await open({ section: 'Sources' })
    const toggle = page.getByRole('checkbox', { name: 'Show Project 16 on Fixture', exact: true })
    const nav = await sectionControl('Sources')
    writeFailures.set('settings', { status: 503, error: 'Synthetic source save failure.' })
    for (const intent of ['stay', 'focus-nav', 'click-text', 'tab']) {
      await expect(toggle).toBeEnabled()
      const pending = holdSettings()
      await activateSource(toggle, 'Space')
      await pending.arrived
      await expect(toggle).toBeDisabled()
      await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('BODY')
      if (intent === 'focus-nav') await nav.focus()
      if (intent === 'click-text') await page.getByText('Project 16', { exact: true }).click()
      if (intent === 'tab') {
        await nav.focus()
        await page.keyboard.press('Tab')
        if (width === 390) {
          await expect(page.locator('.ssh-import-guide > summary')).toBeFocused()
          await page.keyboard.press('Tab')
        }
      }
      const movedFocus = await page.evaluateHandle(() => document.activeElement)
      // Device preferences remain usable during a server save; Tab can move
      // to another project's Git control and deliberately scroll away.
      if (width === 390 && intent === 'tab') {
        await expect(page.getByRole('checkbox', { name: 'Git status for Project 1 on Fixture', exact: true })).toBeFocused()
      }
      const sourceVisible = await toggle.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return bounds.bottom > 0 && bounds.top < innerHeight
      })
      const chosenScroll = await page.locator('.settings-page').evaluate(element => element.scrollTop)
      pending.release()
      await expect(toggle).toBeEnabled()
      const feedback = page.locator('.source-project').filter({ has: toggle }).getByRole('alert')
      await expect(feedback).toHaveText('Synthetic source save failure.')
      if (intent === 'stay' || sourceVisible) await expect(feedback, `${width}/${intent}: source feedback should stay in view`).toBeInViewport()
      else assert.equal(await page.locator('.settings-page').evaluate(element => element.scrollTop), chosenScroll,
        `${width}/${intent}: source completion scrolled away from the chosen control`)
      await expect(page.getByRole('alert')).toHaveCount(1)
      if (intent === 'stay') {
        await expect(toggle).toBeFocused()
        await expect(feedback).toBeInViewport({ ratio: 1 })
      }
      else {
        const focus = await movedFocus.evaluate(element => ({ same: element === document.activeElement,
          before: [element.tagName, element.className, element.getAttribute('aria-label')],
          after: [document.activeElement.tagName, document.activeElement.className, document.activeElement.getAttribute('aria-label')] }))
        assert(focus.same, `${intent}: source completion changed focus: ${JSON.stringify(focus)}`)
      }
      await movedFocus.dispose()
      await expect(toggle).toBeChecked()
    }
    const scrollToggle = page.getByRole('checkbox', { name: 'Show Project 8 on Fixture', exact: true })
    const scroller = page.locator('.settings-page')
    for (const intent of ['wheel', 'PageUp', 'PageDown', 'layout-scroll']) {
      const pending = holdSettings()
      await scrollToggle.evaluate(element => element.scrollIntoView({ block: 'center' }))
      await activateSource(scrollToggle, 'Space')
      await pending.arrived
      await expect(scrollToggle).toBeDisabled()
      await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('BODY')
      const start = await scroller.evaluate(element => element.scrollTop)
      if (intent === 'wheel') { await page.mouse.move(width / 2, 300); await page.mouse.wheel(0, -300) }
      else if (intent === 'layout-scroll') await scroller.evaluate(element => { element.scrollTop -= 200 })
      else await page.keyboard.press(intent)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop), { message: `${width}/${intent}: native or layout scroll must move before completion` }).not.toBe(start)
      // Let native wheel/key scrolling settle before measuring completion.
      await scroller.evaluate(async element => {
        let last = element.scrollTop, steady = 0
        for (let frame = 0; frame < 120 && steady < 6; frame++) {
          await new Promise(requestAnimationFrame)
          const current = element.scrollTop
          steady = current === last ? steady + 1 : 0
          last = current
        }
      })
      const position = await scroller.evaluate(element => element.scrollTop)
      pending.release()
      await expect(scrollToggle).toBeEnabled()
      await expect(page.locator('.source-project').filter({ has: scrollToggle }).getByRole('alert')).toHaveText('Synthetic source save failure.')
      if (intent === 'layout-scroll') await expect(scrollToggle).toBeFocused()
      else {
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY', `${intent}: completion restored focus after deliberate scrolling`)
        if (intent !== 'PageDown') assert(Math.abs(await scroller.evaluate(element => element.scrollTop) - position) <= 1, `${intent}: completion changed the chosen scroll position`)
      }
    }
    writeFailures.delete('settings')
    const pending = holdSettings()
    await activateSource(toggle, 'Space')
    await pending.arrived
    await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('BODY')
    pending.release()
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeEnabled()
    await expect(toggle).toBeFocused()
    await expect(page.locator('.source-project').filter({ has: toggle }).getByRole('status')).toHaveText('Settings saved.')

    // A source conflict keeps the loaded revision and remains locked after navigation.
    const revision = data.settings.revision
    data.settings = { ...data.settings, revision: `${revision}-external` }
    await activateSource(toggle, 'Space')
    await expect(page.locator('.source-project').filter({ has: toggle }).getByRole('alert')).toContainText('configuration changed elsewhere')
    await expect(toggle).toBeDisabled()
    assert.equal(posts.at(-1).revision, revision)
    await open(fixtures[0])
    await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Reload latest config', exact: false }).click()
    await expect(page.locator('#config-editor')).toBeEnabled()
    await open({ section: 'Sources' })

    // Removing a row leaves its status at that position and offers a focus target.
    await activateSource(page.getByRole('button', { name: 'Remove project Project 16 on Fixture', exact: true }))
    let dialog = page.getByRole('dialog')
    await activateSource(dialog.getByRole('button', { name: 'Remove project', exact: true }))
    await expect(dialog).toHaveCount(0)
    await expect(toggle).toHaveCount(0)
    const removedProject = page.getByRole('status').filter({ hasText: 'Project removed from Artiface. Files are unchanged.' })
    await expect(removedProject).toBeInViewport()
    await expect(removedProject).toBeFocused()
    assert.equal(data.settings.config.hosts[0].roots.length, 15)
    await activateSource(page.getByRole('button', { name: 'Remove host Fixture', exact: true }))
    dialog = page.getByRole('dialog')
    const removeHost = dialog.getByRole('button', { name: 'Remove host', exact: true })
    // A fast WebKit removal can detach the focused control without delivering blur.
    // Suppress that notification to exercise the same missing-blur case in either engine.
    await removeHost.evaluate(element => {
      element.addEventListener('blur', event => event.stopImmediatePropagation(), { once: true })
    })
    await activateSource(removeHost)
    await expect(dialog).toHaveCount(0)
    const removedHost = page.getByRole('status').filter({ hasText: 'Host removed from Artiface. Files are unchanged.' })
    await expect(removedHost).toBeInViewport()
    await expect(removedHost).toBeFocused()
    assert.equal(data.settings.config.hosts.length, 0)
    await expect(page.getByRole('button', { name: 'Import SSH config', exact: true })).toHaveCount(0)
    const writesBeforeGuide = posts.length
    const guide = page.locator('.ssh-import-guide')
    await activateSource(guide.locator('summary'))
    await expect(guide.getByLabel('SSH import command')).toContainText('docker compose run --rm -it')
    await expect(guide.getByLabel('SSH import command')).toContainText('$HOME/.ssh:/home/artiface/.ssh:ro')
    await guide.getByRole('button', { name: 'Native', exact: true }).click()
    await expect(guide.getByLabel('SSH import command')).toHaveText('artiface import-ssh --config /path/to/config.json')
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedImportCommand = text } } })
    })
    await guide.getByRole('button', { name: 'Copy command', exact: true }).click()
    await expect(guide.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.copiedImportCommand), 'artiface import-ssh --config /path/to/config.json')
    assert.equal(posts.length, writesBeforeGuide, 'The import guide must not mutate configuration')
    assert(await guide.evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'Import guide overflowed the settings viewport')
    await page.waitForLoadState('networkidle')
  }
  console.log('PASS: Source feedback stays local; held completion respects focus/pointer/Tab/wheel/scrolling-key intent but permits layout scrolling; conflicts keep revisions; removed rows retain visible, focused feedback')
  for (const width of [1280, 390]) for (const kind of ['host', 'project']) {
    data.settings = { ...structuredClone(initialSettings), config: { ...initialSettings.config, hosts: [structuredClone(sourceHost)] }, revision: `partial-${kind}-${width}` }
    catalogExtras = [{ id: 'imported', label: 'Imported SSH source', kind: 'ssh', target: 'synthetic-import', roots: [] }]
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(`${origin}/?partial=${kind}-${width}#kind=settings`)
    await open({ section: 'Sources' })
    await page.waitForLoadState('networkidle')
    const revision = data.settings.revision
    const writes = posts.length
    fail.add('hosts')
    await activateSource(page.getByRole('button', { name: kind === 'host' ? 'Remove host Fixture' : 'Remove project Project 16 on Fixture', exact: true }))
    await activateSource(page.getByRole('dialog').getByRole('button', { name: `Remove ${kind}`, exact: true }))
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const notice = page.getByRole('status').filter({ hasText: `${kind === 'host' ? 'Host' : 'Project'} removed from Artiface. Files are unchanged.` })
    await expect(notice).toBeFocused()
    await expect(page.locator('.source-card')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Remove host|Remove project|Add SSH host/ })).toHaveCount(0)
    assert.equal(posts.length, writes + 1)
    assert.equal(posts.at(-1).revision, revision)
    assert.notEqual(data.settings.revision, revision)
    assert.equal(kind === 'host' ? data.settings.config.hosts.length : data.settings.config.hosts[0].roots.length, kind === 'host' ? 0 : 15)

    const retry = page.getByRole('button', { name: /Retry source list|Refreshing sources…/ })
    await activateSource(retry)
    await expect(retry).toBeEnabled()
    await expect(retry).toBeFocused()
    assert.equal(posts.length, writes + 1, 'Retrying the catalog repeated the committed write')
    await expect(page.locator('.source-card')).toHaveCount(0)

    // A read-only retry must neither discard a newer draft nor clear its conflict.
    let draft
    if (kind === 'project') {
      await open(fixtures[0])
      draft = fixtures[0].edit(data.settings, 'retained-after-removal')
      await page.locator('#config-editor').fill(draft)
      const originalRevision = data.settings.revision
      data.settings = { ...data.settings, revision: `${originalRevision}-external` }
      await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toBeDisabled()
      assert.equal(posts.at(-1).revision, originalRevision)
      await open({ section: 'Sources' })
    }
    const beforeRetry = posts.length
    let release, started
    const arrived = new Promise(resolve => { started = resolve })
    hold = { endpoint: 'hosts', started, wait: new Promise(resolve => { release = resolve }) }
    fail.delete('hosts')
    await activateSource(retry)
    await arrived
    await expect(retry).toBeDisabled()
    const nav = await sectionControl('Sources')
    if (kind === 'project') await nav.focus()
    release()
    hold = null
    await expect(retry).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Imported SSH source', exact: true })).toBeVisible()
    await expect(page.getByText('synthetic-import', { exact: true })).toBeVisible()
    await expect(page.locator('.source-card')).toHaveCount(data.settings.config.hosts.length + 1)
    assert.equal(posts.length, beforeRetry, 'A catalog read issued a write')
    if (kind === 'host') {
      await expect(notice).toBeFocused()
      await back()
      await expect(page.getByText(/Couldn’t refresh projects:/)).toHaveCount(0)
    }
    else {
      await expect(nav).toBeFocused()
      await open(fixtures[0])
      await expect(page.locator('#config-editor')).toHaveValue(draft)
      await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toBeDisabled()
      await expect(page.getByRole('alert').filter({ hasText: 'configuration changed elsewhere' })).toBeVisible()
      await discard(fixtures[0])
    }
    await page.waitForLoadState('networkidle')
  }
  console.log('PASS: Committed removals survive catalog failure; read-only retries restore the source catalog without repeating writes, clearing conflicts/drafts, or stealing deliberate focus')
  catalogExtras = []
  for (const width of [1280, 390]) {
    const prepareAdd = async suffix => {
      data.settings = { ...structuredClone(initialSettings), revision: `add-${width}-${suffix}`,
        config: { ...initialSettings.config, hosts: Array.from({ length: 4 }, (_, index) => ({
          id: `add-${index}`, label: `Machine ${index + 1}`, kind: index ? 'ssh' : 'local',
          target: index ? `synthetic-${index}` : '',
          roots: Array.from({ length: 4 }, (_, root) => ({ id: `project-${root}`, label: `Existing project ${root + 1}`, path: `/synthetic/${index}/${root}` })),
        })) } }
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.goto(`${origin}/?source-add=${width}-${suffix}#kind=settings`)
      await open({ section: 'Sources' })
      const originButton = page.locator('.source-card').filter({ has: page.getByRole('heading', { name: 'Machine 4', exact: true }) })
        .getByRole('button', { name: 'Add project', exact: true })
      await originButton.scrollIntoViewIfNeeded()
      await originButton.focus()
      const position = await page.locator('.settings-page').evaluate(element => element.scrollTop)
      assert(position > 0, 'Fixture must start below the first source')
      await originButton.press('Enter')
      await expect(page.getByRole('heading', { name: 'Add a project on Machine 4', exact: true })).toBeFocused()
      return { originButton, position }
    }
    const { originButton, position } = await prepareAdd('cancel')
    await activateSource(page.getByRole('button', { name: 'Cancel', exact: true }))
    await expect(originButton).toBeFocused()
    assert(Math.abs(await page.locator('.settings-page').evaluate(element => element.scrollTop) - position) <= 1,
      'Cancelling project setup lost the initiating source position')
    if (width === 390) {
      const disabled = await prepareAdd('disabled-cancel')
      const updatedCatalog = page.waitForResponse(response => response.url().includes('/api/hosts'))
      setupEnabled = false
      await updatedCatalog
      await page.waitForLoadState('networkidle')
      await activateSource(page.getByRole('button', { name: 'Cancel', exact: true }))
      await expect(disabled.originButton).toBeDisabled()
      await expect(page.getByRole('heading', { name: 'Machine 4', exact: true })).toBeFocused()
      await expect(page.getByRole('button', { name: 'Add SSH host', exact: true })).toBeDisabled()
      setupEnabled = true
    }

    for (const intent of ['stay', 'pointer-submit', 'focus-nav', 'wheel', 'section-draft']) {
      await prepareAdd(intent)
      await page.locator('.project-setup input[name="path"]').fill('/synthetic/added')
      let release, started
      const arrived = new Promise(resolve => { started = resolve })
      hold = { endpoint: 'projects', started, wait: new Promise(resolve => { release = resolve }) }
      const submit = page.locator('.project-setup button[type="submit"]')
      if (intent === 'pointer-submit') await submit.click()
      else await activateSource(submit)
      await arrived
      await expect(submit).toBeDisabled()
      const nav = await sectionControl('Sources')
      let draft
      if (intent === 'focus-nav') await nav.focus()
      if (intent === 'wheel') {
        await page.evaluate(() => {
          window.sourceAddWheelSeen = false
          document.addEventListener('wheel', () => { window.sourceAddWheelSeen = true }, { once: true, capture: true })
        })
        await page.mouse.move(width / 2, 250)
        await page.mouse.wheel(0, -300)
        // The short form may not scroll; wait for delivery, not a scroll offset.
        await expect.poll(() => page.evaluate(() => window.sourceAddWheelSeen)).toBe(true)
      }
      if (intent === 'section-draft') {
        await open(fixtures[0])
        draft = fixtures[0].edit(data.settings, 'newer-draft-during-project-save')
        await page.locator('#config-editor').fill(draft)
      }
      if (intent === 'stay') {
        let catalogRelease, catalogStarted
        const catalogArrived = new Promise(resolve => { catalogStarted = resolve })
        hold = { endpoint: 'hosts', started: catalogStarted, wait: new Promise(resolve => { catalogRelease = resolve }) }
        release()
        await catalogArrived
        await expect(page.locator('.source-feedback')).not.toBeFocused()
        catalogRelease()
      } else release()
      hold = null
      await expect(page.locator('.project-setup')).toHaveCount(0)
      const notice = page.getByRole('status').filter({ hasText: 'Project saved.' })
      if (intent === 'stay' || intent === 'pointer-submit') {
        await expect(notice).toBeFocused()
        await expect(notice).toBeInViewport({ ratio: 1 })
        await expect(page.getByText('Added project', { exact: true })).toBeVisible()
      } else if (intent === 'focus-nav') {
        await expect(nav).toBeFocused()
        assert.equal(await page.locator('.settings-page').evaluate(element => element.scrollTop), 0)
      } else if (intent === 'wheel') {
        await expect(page.getByRole('button', { name: 'Add SSH host', exact: true })).toBeEnabled()
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY')
        assert.equal(await page.locator('.settings-page').evaluate(element => element.scrollTop), 0)
      } else {
        await expect(page.locator('#config-editor')).toHaveValue(draft)
        await expect(page.getByRole('alert').filter({ hasText: 'configuration changed elsewhere' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toBeDisabled()
        await discard(fixtures[0])
      }
      assert.deepEqual(posts.filter(post => post.endpoint === 'projects').at(-1),
        { endpoint: 'projects', host: 'add-3', target: 'synthetic-3', kind: 'ssh', path: '/synthetic/added' })
      await page.waitForLoadState('networkidle')
    }
  }
  console.log('PASS: Sources project setup entry/cancel context, catalog-settled completion, pointer/keyboard submission, preserved focus/wheel intent, and newer configuration draft conflict')
  data.settings = initialSettings
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(origin)

  await page.setViewportSize({ width: 390, height: 844 })
  for (const fixture of fixtures) {
    await open(fixture)
    const editor = page.locator(fixture.editor)
    const save = page.getByRole('button', { name: fixture.save, exact: true })
    const nav = await sectionControl(fixture.section)
    const feedbackID = fixture.endpoint === 'settings' ? 'config-feedback' : 'ignore-feedback'
    const feedback = page.locator(`#${feedbackID}`)
    await expect(editor).toBeEnabled()
    if (fixture.endpoint === 'settings') {
      const count = posts.length
      await editor.evaluate(element => { element.style.height = '704px' })
      await editor.fill('{ invalid JSON')
      await save.click()
      await expect(save).toBeFocused()
      await expect(save).toBeInViewport({ ratio: 1 })
      await expect(feedback).toBeInViewport({ ratio: 1 })
      await expect(editor).toHaveAttribute('aria-invalid', 'true')
      await expect(editor).toHaveAttribute('aria-describedby', feedbackID)
      assert.equal(posts.length, count, 'Local invalid JSON reached the server')
      await editor.evaluate(element => element.style.removeProperty('height'))
    }
    await editor.fill(fixture.edit(data[fixture.endpoint], 'validation-correction'))
    await expect(feedback).toHaveCount(0)
    await expect(editor).not.toHaveAttribute('aria-invalid', 'true')

    // Delayed validation stays attached to the editor without reclaiming navigation focus.
    let release, started
    let arrived = new Promise(resolve => { started = resolve })
    hold = { endpoint: fixture.endpoint, started, wait: new Promise(resolve => { release = resolve }) }
    writeFailures.set(fixture.endpoint, { status: 400, error: 'Synthetic editor validation failure.' })
    const revision = data[fixture.endpoint].revision
    await save.click()
    await arrived
    await expect(editor).toBeDisabled()
    await nav.focus()
    release()
    hold = null
    await expect(feedback).toContainText('Synthetic editor validation failure.')
    await expect(editor).toHaveAttribute('aria-invalid', 'true')
    await expect(editor).toHaveAttribute('aria-describedby', feedbackID)
    await expect(nav).toBeFocused()
    assert.equal(posts.at(-1).revision, revision)
    await editor.fill(fixture.edit(data[fixture.endpoint], 'after-validation'))
    await expect(feedback).toHaveCount(0)
    await expect(editor).not.toHaveAttribute('aria-invalid', 'true')

    // A service error is not a field error, and completion must respect deliberate scrolling.
    await editor.evaluate(element => { element.style.height = '1100px' })
    arrived = new Promise(resolve => { started = resolve })
    hold = { endpoint: fixture.endpoint, started, wait: new Promise(resolve => { release = resolve }) }
    writeFailures.set(fixture.endpoint, { status: 503, error: 'Synthetic editor service failure.' })
    await save.focus()
    await save.press('Enter')
    await arrived
    await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('BODY')
    const scroller = page.locator('.settings-page')
    const initialScroll = await scroller.evaluate(element => element.scrollTop)
    await page.mouse.move(195, 300)
    await page.mouse.wheel(0, -320)
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeLessThan(initialScroll)
    await scroller.evaluate(async element => {
      let last = element.scrollTop, steady = 0
      for (let frame = 0; frame < 120 && steady < 6; frame++) {
        await new Promise(requestAnimationFrame)
        const current = element.scrollTop
        steady = current === last ? steady + 1 : 0
        last = current
      }
    })
    const position = await scroller.evaluate(element => element.scrollTop)
    release()
    hold = null
    await expect(editor).toBeEnabled()
    await expect(feedback).toContainText('Synthetic editor service failure.')
    await expect(editor).not.toHaveAttribute('aria-invalid', 'true')
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY')
    assert(Math.abs(await scroller.evaluate(element => element.scrollTop) - position) <= 1, 'Editor completion changed the chosen scroll position')
    await editor.evaluate(element => element.style.removeProperty('height'))
    await editor.fill(fixture.edit(data[fixture.endpoint], 'after-service-failure'))
    await expect(feedback).toContainText('Synthetic editor service failure.')
    writeFailures.delete(fixture.endpoint)

    // Editing or discarding text cannot claim that a failed read recovered.
    fail.add(fixture.endpoint)
    await reload(fixture, true)
    const readError = page.getByRole('alert').filter({ hasText: 'Synthetic read failure' })
    await expect(readError).toBeVisible()
    await editor.fill(fixture.edit(data[fixture.endpoint], 'after-read-failure'))
    await expect(readError).toBeVisible()
    await discard(fixture)
    await expect(readError).toBeVisible()
    fail.delete(fixture.endpoint)
    await page.getByRole('button', { name: fixture.reload }).click()
    await expect(editor).toBeEnabled()
    await expect(readError).toHaveCount(0)

    // A conflict remains latched when the user changes the text afterward.
    await editor.fill(fixture.edit(data[fixture.endpoint], 'conflicted-editor'))
    const loadedRevision = data[fixture.endpoint].revision
    data[fixture.endpoint] = { ...data[fixture.endpoint], revision: `${loadedRevision}-editor-conflict` }
    await save.click()
    await expect(page.getByRole('alert').filter({ hasText: 'changed elsewhere' })).toBeVisible()
    assert.equal(posts.at(-1).revision, loadedRevision)
    await editor.fill(fixture.edit(data[fixture.endpoint], 'correction-during-conflict'))
    await expect(save).toBeDisabled()
    await expect(editor).not.toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('alert').filter({ hasText: 'changed elsewhere' })).toBeVisible()
    await reload(fixture, true)
    await expect(editor).toHaveValue(fixture.text(data[fixture.endpoint]))
  }
  console.log('PASS: Editor validation clears on correction; read/service/conflict errors retain their meaning; delayed responses preserve deliberate focus/scroll and original revisions')
  await page.setViewportSize({ width: 1280, height: 900 })

  const passwordPolicyError = 'password must contain at least 6 characters and at most 1024 bytes of valid UTF-8'
  for (const width of [1280, 390]) {
    session = { authenticated: true, mode: 'personal', role: 'personal', csrfToken: 'fixture' }
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(`${origin}/?password=${width}#kind=settings`)
    await open({ section: 'Security' })
    const form = page.locator('.password-settings')
    const current = page.locator('#current-password')
    const next = page.locator('#new-password')
    const confirm = page.locator('#confirm-password')
    const submit = form.getByRole('button', { name: /^Chang(?:e|ing) password/ })
    const activate = async () => { await submit.focus(); await submit.press('Enter') }
    const fill = async (value = '😀'.repeat(6)) => {
      await current.fill('synthetic-current')
      await next.fill(value)
      await confirm.fill(value)
    }
    const heldPassword = async (action, status, error) => {
      let release, started
      const arrived = new Promise(resolve => { started = resolve })
      hold = { endpoint: 'password', started, wait: new Promise(resolve => { release = resolve }) }
      if (status === 200) writeFailures.delete('password')
      else writeFailures.set('password', { status, error })
      await action()
      await arrived
      await expect(form).toHaveAttribute('aria-busy', 'true')
      return () => { release(); hold = null }
    }
    await expect(current).toBeEnabled()
    const count = posts.length
    await fill('😀'.repeat(5))
    await activate()
    await expect(next).toBeFocused()
    await expect(next).toHaveAttribute('aria-invalid', 'true')
    await expect(next).toHaveAttribute('aria-describedby', 'password-new-error')
    await current.fill('synthetic-unrelated-edit')
    await expect(page.locator('#password-new-error')).toBeVisible()
    await next.fill('😀'.repeat(6))
    await expect(page.locator('#password-new-error')).toHaveCount(0)
    await activate()
    await expect(confirm).toBeFocused()
    await expect(confirm).toHaveAttribute('aria-invalid', 'true')
    await next.fill('updated6')
    await expect(page.locator('#password-confirmation-error')).toHaveCount(0)
    assert.equal(posts.length, count, 'Local Unicode length/mismatch rejection reached the server')

    // Read-only pending fields retain their value, node focus, and selection; repeated submits stay single-flight.
    await fill()
    await current.focus()
    await current.evaluate(input => input.setSelectionRange(2, 7, 'forward'))
    let release = await heldPassword(() => form.evaluate(element => { element.requestSubmit(); element.requestSubmit() }), 500, 'Could not load configuration')
    await expect(current).toBeFocused()
    for (const input of [current, next, confirm]) {
      await expect(input).toHaveAttribute('readonly', '')
      await expect(input).toBeEnabled()
    }
    await expect(submit).toHaveAttribute('aria-disabled', 'true')
    assert.deepEqual(await current.evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 7])
    await current.press('x')
    await current.press('Enter')
    assert.equal(posts.length, count + 1)
    assert.deepEqual(posts.at(-1), { endpoint: 'password', path: '/api/password', currentPassword: 'synthetic-current', newPassword: '😀'.repeat(6) })
    release()
    await expect(form).toHaveAttribute('aria-busy', 'false')
    await expect(current).toBeFocused()
    await expect(current).toHaveValue('synthetic-current')
    assert.deepEqual(await current.evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 7])
    await expect(form.locator('[aria-invalid=true]')).toHaveCount(0)

    release = await heldPassword(activate, 403, 'Incorrect current password')
    await expect(submit).toBeFocused()
    release()
    await expect(current).toBeFocused()
    await expect(current).toHaveAttribute('aria-describedby', 'password-current-error')
    await next.fill('another6')
    await expect(page.locator('#password-current-error')).toBeVisible()
    await current.fill('synthetic-correction')
    await expect(page.locator('#password-current-error')).toHaveCount(0)

    await fill('界'.repeat(350))
    release = await heldPassword(activate, 400, passwordPolicyError)
    release()
    await expect(next).toBeFocused()
    await expect(page.locator('#password-new-error')).toHaveText(passwordPolicyError)
    await confirm.fill('unrelated6')
    await expect(page.locator('#password-new-error')).toBeVisible()
    await next.fill('corrected6')
    await expect(page.locator('#password-new-error')).toHaveCount(0)

    // CSRF, unknown validation failures, conflicts, rate limiting, and service faults are not credential errors.
    for (const [status, error] of [
      [403, 'Invalid session token; reload and try again'],
      [400, 'generate password salt: secure randomness is unavailable'],
      [409, 'Password changed elsewhere; sign in again'],
      [429, 'Too many failed attempts; try again in a minute'],
      [500, 'Could not save password'],
    ]) {
      await fill()
      release = await heldPassword(activate, status, error)
      release()
      await expect(page.locator('#password-form-error')).toHaveText(error)
      await expect(form.locator('[aria-invalid=true]')).toHaveCount(0)
      await expect(submit).toBeFocused()
      await current.fill('synthetic-edited-after-service-error')
      await expect(page.locator('#password-form-error')).toHaveText(error)
    }

    for (const intent of ['focus-return', 'pointer-text', 'wheel', 'PageUp', 'Tab']) {
      await page.setViewportSize({ width, height: 420 })
      await fill()
      release = await heldPassword(activate, 403, 'Incorrect current password')
      if (intent === 'focus-return') { await next.focus(); await submit.focus() }
      if (intent === 'pointer-text') await page.getByRole('heading', { name: 'Change admin password', exact: true }).click()
      if (intent === 'wheel') { await page.mouse.move(width / 2, 200); await page.mouse.wheel(0, -2000) }
      if (intent === 'PageUp' || intent === 'Tab') await page.keyboard.press(intent)
      if (intent === 'wheel' || intent === 'PageUp') await expect.poll(() => page.locator('.settings-page').evaluate(element => element.scrollTop)).toBe(0)
      const selected = await page.evaluateHandle(() => document.activeElement)
      release()
      await expect(form).toHaveAttribute('aria-busy', 'false')
      await expect(page.locator('#password-current-error')).toHaveText('Incorrect current password')
      assert(await selected.evaluate(element => element === document.activeElement), `${intent}: password completion stole focus`)
      if (intent === 'wheel' || intent === 'PageUp') assert.equal(await page.locator('.settings-page').evaluate(element => element.scrollTop), 0)
      await selected.dispose()
    }

    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await fill()
    release = await heldPassword(activate, 403, 'Incorrect current password')
    setupEnabled = false
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(current).toBeDisabled()
    const nav = await sectionControl('Security')
    await nav.focus()
    release()
    await expect(form).toHaveAttribute('aria-busy', 'false')
    setupEnabled = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(current).toBeEnabled()
    await expect(nav).toBeFocused()

    await fill()
    release = await heldPassword(activate, 200)
    release()
    await expect(form).toHaveCount(0)
    await expect(page.locator('#password')).toHaveValue('')
    const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
    assert(!storage.includes('synthetic-current') && !storage.includes('😀'.repeat(6)), 'Password state reached browser storage')
  }
  console.log('PASS: Password field correction, Unicode policy, exact endpoint errors, stable pending focus/selection, single-flight payloads, deliberate interaction, disabled capability, and success sign-out')
  writeFailures.delete('password')
  session = { authenticated: true, mode: 'personal', role: 'personal', csrfToken: 'fixture' }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(origin)

  for (const fixture of fixtures) {
    const editor = page.locator(fixture.editor)
    await open(fixture)
    await expect(editor).toBeEnabled()
    const draft = fixture.edit(data[fixture.endpoint], `${fixture.endpoint}-private-draft`)
    await editor.fill(draft)
    // Section navigation must reveal its heading without losing keyboard focus or either editor's draft.
    await page.setViewportSize({ width: 390, height: 500 })
    await chooseSection('Appearance')
    await page.getByRole('heading', { name: 'Automatic refresh', exact: true }).scrollIntoViewIfNeeded()
    const sectionButton = await sectionControl(fixture.section)
    await sectionButton.focus()
    await sectionButton.selectOption({ label: fixture.section })
    await expect(sectionButton).toBeFocused()
    const heading = await page.getByRole('heading', { name: fixture.section, exact: true }).boundingBox()
    const header = await page.locator('.settings-header').boundingBox()
    assert(heading && header && heading.y >= header.y + header.height && heading.y + heading.height <= 500,
      'Changing Settings sections left the new heading outside the visible content')
    await expect(editor).toHaveValue(draft)
    await page.setViewportSize({ width: 1280, height: 900 })
    await back()
    assert(await warning(), 'Leaving Settings removed the unsaved-edit warning')
    await page.goForward()
    await open(fixture)
    await expect(editor).toHaveValue(draft)
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
    await open(fixture)
    await expect(editor).toHaveValue(draft)
    await reload(fixture, false)
    await expect(editor).toHaveValue(draft)
    fail.add(fixture.endpoint)
    await reload(fixture, true)
    await expect(page.getByText(/Synthetic read failure/)).toBeVisible()
    await expect(editor).toHaveValue(draft)
    await expect(editor).toBeEnabled()
    fail.delete(fixture.endpoint)
    // The disk changes after the editor loaded, so the POST must carry its original revision.
    const originalRevision = data[fixture.endpoint].revision
    data[fixture.endpoint] = { ...data[fixture.endpoint], revision: `${fixture.endpoint}-external` }
    if (fixture.endpoint === 'settings') data.settings.config = { ...data.settings.config, listen: 'external' }
    else data.ignore.content = '# external\n'
    await page.getByRole('button', { name: fixture.save, exact: true }).click()
    await expect(page.getByText(/changed elsewhere/)).toBeVisible()
    assert.equal(posts.at(-1).revision, originalRevision)
    await back()
    await open(fixture)
    await expect(editor).toHaveValue(draft)
    await expect(page.getByRole('button', { name: fixture.save, exact: true })).toBeDisabled()
    await expect(page.getByText(/changed elsewhere/)).toBeVisible()
    await reload(fixture, true)
    await expect(editor).toHaveValue(fixture.text(data[fixture.endpoint]))
    await expect.poll(warning).toBe(false)
    // A fresh disk edit discovered on reopen must retain the draft without rebasing it.
    await editor.fill(draft)
    await back()
    data[fixture.endpoint] = { ...data[fixture.endpoint], revision: `${fixture.endpoint}-reopened` }
    await open(fixture)
    await expect(editor).toHaveValue(draft)
    await expect(page.getByText(/changed elsewhere/)).toBeVisible()
    await expect(page.getByRole('button', { name: fixture.save, exact: true })).toBeDisabled()
    await discard(fixture)
    await expect.poll(warning).toBe(false)
    await back()
  }
  console.log('PASS: Section navigation reveals headings and preserves keyboard focus/drafts; Back/Forward/reopen retention, dirty reload confirmation, failed reload retention, original revisions, and persistent conflicts')

  for (const fixture of fixtures) {
    await open(fixture)
    const draft = fixture.edit(data[fixture.endpoint], 'pending-save')
    await page.locator(fixture.editor).fill(draft)
    let release
    let started
    const arrived = new Promise(resolve => { started = resolve })
    hold = { endpoint: fixture.endpoint, started, wait: new Promise(resolve => { release = resolve }) }
    await page.getByRole('button', { name: fixture.save, exact: true }).click()
    await arrived
    await back()
    await open(fixture)
    await expect(page.locator(fixture.editor)).toBeDisabled()
    await expect(page.locator(fixture.editor)).toHaveValue(draft)
    release()
    hold = null
    await expect(page.locator(fixture.editor)).toBeEnabled()
    await expect(page.locator(fixture.editor)).toHaveValue(draft)
    await expect.poll(warning).toBe(false)
    await page.locator(fixture.editor).fill(fixture.edit(data[fixture.endpoint], 'edit-after-pending-save'))
    await discard(fixture)
    await expect(page.locator(fixture.editor)).toHaveValue(draft)
    await back()
  }
  console.log('PASS: In-flight saves survive Settings unmount and cannot overwrite newer typing')

  // Refresh editability and backing-file identity without replacing private text.
  await open(fixtures[1])
  const ignoreDraft = fixtures[1].edit(data.ignore, 'metadata-draft')
  await page.locator('#ignore-editor').fill(ignoreDraft)
  await back()
  data.ignore = { ...data.ignore, editable: false, path: '/synthetic/other-ignore' }
  await open(fixtures[1])
  await expect(page.getByText(/Editing ignore rules is unavailable/)).toBeVisible()
  await expect(page.locator('#ignore-editor')).toHaveValue(ignoreDraft)
  await expect(page.locator('#ignore-editor')).toHaveAttribute('readonly', '')
  await expect(page.getByText(/changed elsewhere/)).toBeVisible()
  await discard(fixtures[1])
  data.ignore = { ...data.ignore, editable: true }
  await back()

  // Both editors remain independently dirty, and neither writes private drafts to browser storage.
  for (const fixture of fixtures) {
    await open(fixture)
    await page.locator(fixture.editor).fill(fixture.edit(data[fixture.endpoint], 'private-simultaneous'))
  }
  await back()
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
  assert(!storage.includes('private-simultaneous'))
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.locator('#password')).toBeVisible()
  await expect.poll(warning).toBe(false)
  session = { authenticated: true, mode: 'personal', role: 'personal', csrfToken: 'new-fixture' }
  await page.locator('#password').fill('synthetic-password')
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  for (const fixture of fixtures) {
    await open(fixture)
    await expect(page.locator(fixture.editor)).toHaveValue(fixture.text(data[fixture.endpoint]))
  }
  await chooseSection('Security')
  await page.locator('#new-password').fill('never-retain-password')
  await back()
  await open(fixtures[0])
  await chooseSection('Security')
  await expect(page.locator('#new-password')).toHaveValue('')
  await back()

  // Expiry must clear drafts even when session revalidation returns the same identity.
  for (const nextSession of [
    session,
    { authenticated: true, mode: 'team', role: 'admin', userID: 'team-a', csrfToken: 'team-a' },
    { authenticated: true, mode: 'team', role: 'admin', userID: 'team-b', csrfToken: 'team-b' },
    { authenticated: true, mode: 'team', role: 'user', userID: 'team-b', csrfToken: 'restricted' },
  ]) {
    await open(fixtures[0])
    await page.locator('#config-editor').fill(fixtures[0].edit(data.settings, 'identity-private'))
    session = nextSession
    let release
    let started = false
    hold = { endpoint: 'session', started: () => { started = true }, wait: new Promise(resolve => { release = resolve }) }
    await page.evaluate(() => window.expireFixtureSession())
    await expect.poll(() => started).toBe(true)
    await expect(page.locator('.settings-page')).toHaveCount(0)
    await expect.poll(warning).toBe(false)
    const reopening = session.role === 'user' ? null : open(fixtures[0])
    await expect(page.locator('.app-start')).toBeVisible()
    release()
    hold = null
    await reopening
    await expect(page.locator('.settings-page')).toBeVisible()
    if (session.role === 'user') {
      await expect(page.locator('.settings-nav').getByRole('button', { name: 'Configuration', exact: true })).toHaveCount(0)
      await expect(page.locator('.settings-nav').getByRole('button', { name: 'Ignored files', exact: true })).toHaveCount(0)
    } else {
      await expect(page.locator('#config-editor')).toHaveValue(fixtures[0].text(data.settings))
    }
    await back()
  }
  console.log('PASS: Ignore metadata, simultaneous drafts, no storage/password retention, logout/expiry/account isolation, and canManage boundaries')

  session = { authenticated: true, mode: 'team', role: 'admin', csrfToken: 'admin' }
  await page.goto(`${origin}/admin/`)
  await open(fixtures[0])
  await page.locator('#config-editor').fill(fixtures[0].edit(data.settings, 'admin-private'))
  assert(await warning())
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.locator('#password')).toBeVisible()
  await expect.poll(warning).toBe(false)
  session = { ...session, authenticated: true }
  await page.locator('#password').fill('synthetic-password')
  await page.getByRole('button', { name: 'Open admin panel', exact: true }).click()
  await open(fixtures[0])
  await expect(page.locator('#config-editor')).toHaveValue(fixtures[0].text(data.settings))
  assert.deepEqual(errors, [])
  console.log('PASS: Admin draft cleanup; no browser errors')
} finally {
  await browser.close()
}
