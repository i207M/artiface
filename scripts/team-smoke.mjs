// Exercise startup mode, admin setup, and device/user isolation on disposable data.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const binary = resolve(process.argv[2] ?? join(repo, 'bin/artiface'))
const directory = await mkdtemp(join(tmpdir(), 'artiface-team-smoke-'))
const configFile = join(directory, 'config.json')
const reservation = createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const origin = `http://127.0.0.1:${port}`
const password = 'admin6'
let server, browser
let serverLog = ''
const pageErrors = []
const screenshots = join(repo, '.local/screenshots')
await mkdir(screenshots, { recursive: true })

async function start(mode) {
  serverLog = ''
  server = spawn(binary, ['serve', '--config', configFile, '--listen', `127.0.0.1:${port}`, ...(mode ? ['--mode', mode] : [])], {
    cwd: directory,
    env: { ...process.env, HOME: directory, ARTIFACE_PASSWORD: password, ARTIFACE_APP_ORIGIN: origin, ARTIFACE_MODE: 'team' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', data => { serverLog += data })
  server.stderr.on('data', data => { serverLog += data })
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) throw new Error(`Fixture server exited: ${serverLog}`)
    try { if ((await fetch(origin + '/api/session')).ok) return } catch { /* Starting. */ }
    await delay(50)
  }
  throw new Error('Fixture server did not become ready')
}

async function stop() {
  if (!server || server.exitCode !== null) return
  const exited = once(server, 'exit')
  server.kill('SIGTERM')
  const timeout = setTimeout(() => server.kill('SIGKILL'), 12_000)
  await exited
  clearTimeout(timeout)
}

function capture(page) { page.on('pageerror', error => pageErrors.push(error.message)); return page }
async function login(page, admin, username = 'alice', secret = 'alice6') {
  await page.goto(origin + (admin ? '/admin/' : '/'))
  if (!admin) await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel(admin ? 'Admin password' : 'Password', { exact: true }).fill(admin ? password : secret)
  await page.getByRole('button', { name: admin ? 'Open admin panel' : 'Open workspace', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
}

async function adminPost(context, endpoint, data) {
  const session = await (await context.request.get(origin + '/api/admin/session')).json()
  const response = await context.request.post(origin + '/api/admin/' + endpoint, { data, headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken } })
  assert.equal(response.status(), 200, await response.text())
  return response.json()
}

async function addUser(page, username, secret, project) {
  await page.getByRole('button', { name: 'Add user', exact: true }).click()
  const form = page.locator('.team-user-editor')
  await form.getByLabel('Username', { exact: true }).fill(username)
  await form.getByLabel('Password', { exact: true }).fill(secret)
  await form.getByRole('checkbox', { name: new RegExp(project) }).check()
  await form.getByRole('button', { name: 'Save user', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Edit ${username}`, exact: true })).toBeVisible()
}

try {
  for (const name of ['research', 'internal']) {
    await mkdir(join(directory, name))
    await writeFile(join(directory, name, 'notes.md'), `# ${name} notes\n`)
    await writeFile(join(directory, name, 'report.html'), `<!doctype html><h1>${name} report</h1>`)
  }
  // An explicit flag wins over ARTIFACE_MODE, and startup overrides do not edit
  // the saved configuration's default mode.
  await start('personal')
  assert.equal((await (await fetch(origin + '/api/session')).json()).mode, 'personal')
  browser = await chromium.launch({ headless: true })
  const owner = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  owner.setDefaultTimeout(20_000)
  const ownerPage = capture(await owner.newPage())
  await ownerPage.goto(origin)
  await expect(ownerPage.getByLabel('Username', { exact: true })).toHaveCount(0)
  await ownerPage.getByLabel('Workspace password', { exact: true }).fill(password)
  await ownerPage.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(ownerPage.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  const adminPage = capture(await owner.newPage())
  await login(adminPage, true)
  const research = await adminPost(owner, 'projects', { kind: 'local', path: join(directory, 'research'), label: 'Research' })
  await adminPost(owner, 'projects', { kind: 'local', path: join(directory, 'internal'), label: 'Internal' })
  await adminPage.reload()
  await expect(adminPage.getByRole('heading', { name: 'Users & project access' })).toBeVisible()
  await expect(adminPage.locator('select#application-mode')).toHaveCount(0)
  await addUser(adminPage, 'alice', 'alice6', 'Research')
  await addUser(adminPage, 'bob', 'bob123', 'Internal')
  await adminPage.screenshot({ path: join(screenshots, 'team-admin-desktop.png'), fullPage: true })
  const savedBefore = await readFile(configFile, 'utf8')
  assert.equal(JSON.parse(savedBefore).mode ?? 'personal', 'personal')
  await stop()
  // No flag: the environment selects Team on every start of this same config.
  await start()
  assert.equal((await (await fetch(origin + '/api/session')).json()).mode, 'team')
  assert.equal(await readFile(configFile, 'utf8'), savedBefore)
  await login(adminPage, true)
  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const aliceSecond = await browser.newContext()
  const bobContext = await browser.newContext()
  for (const context of [aliceContext, aliceSecond, bobContext]) context.setDefaultTimeout(20_000)
  const alice = capture(await aliceContext.newPage())
  const aliceDevice = capture(await aliceSecond.newPage())
  const bob = capture(await bobContext.newPage())
  await login(alice, false)
  await login(aliceDevice, false)
  await login(bob, false, 'bob', 'bob123')
  for (const [device, allowed] of [[alice, 'Research'], [bob, 'Internal']]) {
    await expect(device.getByRole('navigation', { name: 'Open projects' }).locator('.project-group')).toHaveCount(0)
    await device.getByRole('button', { name: 'Add project', exact: true }).click()
    await expect(device.locator('.saved-project')).toHaveCount(1)
    await expect(device.locator('.saved-project')).toContainText(allowed)
    await device.locator('.saved-project').click()
  }
  await expect(alice.getByRole('button', { name: /Open project Research on/ })).toBeVisible()
  await expect(alice.getByRole('button', { name: /Open project Internal on/ })).toHaveCount(0)
  await expect(bob.getByRole('button', { name: /Open project Internal on/ })).toBeVisible()
  await expect(bob.getByRole('button', { name: /Open project Research on/ })).toHaveCount(0)
  await alice.getByRole('button', { name: 'Close project Research', exact: true }).click()
  await expect(aliceDevice.getByRole('button', { name: /Open project Research on/ })).toHaveCount(0, { timeout: 15_000 })
  await expect(bob.getByRole('button', { name: /Open project Internal on/ })).toBeVisible()
  await alice.goto(origin + '/#kind=add-project')
  await expect(alice.getByRole('button', { name: 'New project', exact: true })).toHaveCount(0)
  await expect(alice.getByRole('button', { name: /Remove project/ })).toHaveCount(0)
  await expect(alice.locator('.saved-project')).toHaveCount(1)
  await alice.locator('.saved-project').click()
  await alice.getByRole('button', { name: 'Settings', exact: true }).click()
  for (const name of ['Configuration', 'Security', 'Ignored files', 'Access']) {
    await expect(alice.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await alice.getByRole('button', { name: 'Sources', exact: true }).click()
  await expect(alice.getByRole('checkbox', { name: /^Git status for Research on / })).toBeChecked()
  await expect(alice.getByRole('checkbox', { name: /Internal/ })).toHaveCount(0)
  await expect(alice.getByRole('button', { name: /Add SSH host|Import SSH config|Add project|Remove project|Remove host/ })).toHaveCount(0)
  await expect(alice.locator('.ssh-import-guide')).toHaveCount(0)
  await expect(alice.getByRole('checkbox', { name: /Allow scripts|^Show / })).toHaveCount(0)
  await alice.getByRole('checkbox', { name: /^Git status for Research on / }).uncheck()
  await alice.getByRole('button', { name: 'Appearance', exact: true }).click()
  await alice.getByRole('button', { name: 'Sources', exact: true }).click()
  await expect(alice.getByRole('checkbox', { name: /^Git status for Research on / })).not.toBeChecked()
  await alice.getByRole('button', { name: 'Install app', exact: true }).click()
  await expect(alice.getByText('For phones and tablets accessing another machine', { exact: false })).toHaveCount(0)
  const location = new URLSearchParams({ host: research.host.id, root: research.root.id, path: 'report.html', kind: 'file' })
  await alice.goto(origin + '/#' + location)
  const frame = alice.locator('.html-viewer iframe:not(.pending-preview)')
  await expect(frame.contentFrame().getByRole('heading', { name: 'research report' })).toBeVisible()
  const preview = await frame.getAttribute('src')
  await expect(aliceDevice.getByRole('button', { name: /Open project Research on/ })).toBeVisible()
  await expect(aliceDevice.locator('.project-file')).toHaveCount(0)
  await alice.screenshot({ path: join(screenshots, 'team-user-desktop.png'), fullPage: true })
  // Same browser can hold both independent cookies without privilege crossover.
  const aliceAdmin = capture(await aliceContext.newPage())
  await login(aliceAdmin, true)
  await alice.reload()
  await expect(frame.contentFrame().getByRole('heading', { name: 'research report' })).toBeVisible()
  await aliceAdmin.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(aliceAdmin.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible()
  assert.equal((await aliceContext.request.get(origin + '/api/hosts')).status(), 200)
  // Access revocation is enforced immediately for an already-issued preview,
  // then the user's live project catalog catches up without a page reload.
  await adminPage.getByRole('button', { name: 'Edit alice', exact: true }).click()
  await adminPage.getByRole('checkbox', { name: /Research/ }).uncheck()
  await adminPage.getByRole('button', { name: 'Save user', exact: true }).click()
  await expect(adminPage.locator('.team-user-editor')).toHaveCount(0)
  assert.equal((await aliceContext.request.get(preview)).status(), 401)
  await expect(alice.getByRole('button', { name: /Open project Research on/ })).toHaveCount(0, { timeout: 15_000 })
  await adminPage.getByRole('button', { name: 'Edit alice', exact: true }).click()
  await adminPage.getByRole('checkbox', { name: /Research/ }).check()
  await adminPage.getByLabel('Reset password', { exact: true }).fill('reset6')
  await adminPage.getByRole('button', { name: 'Save user', exact: true }).click()
  await expect(adminPage.locator('.team-user-editor')).toHaveCount(0)
  await alice.reload()
  await expect(alice.getByLabel('Username', { exact: true })).toBeVisible()
  await login(alice, false, 'alice', 'reset6')
  await alice.getByRole('button', { name: 'Sign out', exact: true }).click()
  await login(alice, false, 'bob', 'bob123')
  await expect(alice.locator('.project-file')).toHaveCount(0)
  await expect(alice.getByRole('button', { name: /Open project Research on/ })).toHaveCount(0)
  // Check the new admin UI and username login on narrow touch screens.
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  phoneContext.setDefaultTimeout(20_000)
  const phone = capture(await phoneContext.newPage())
  await login(phone, true)
  await phone.getByRole('button', { name: 'Edit bob', exact: true }).click()
  for (const width of [320, 390, 768]) {
    await phone.setViewportSize({ width, height: 844 })
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Admin overflow at ${width}px`)
    await phone.screenshot({ path: join(screenshots, `team-admin-${width}.png`), fullPage: true })
  }
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(origin)
  await expect(phone.getByLabel('Username', { exact: true })).toBeVisible()
  await phone.screenshot({ path: join(screenshots, 'team-login-mobile.png'), fullPage: true })
  assert.deepEqual(pageErrors, [])
  console.log('PASS: startup-only Personal/Team selection, admin setup, scoped projects, device sync, separate cookies, revocation, password reset, and mobile layouts')
} finally {
  await browser?.close()
  await stop()
  await rm(directory, { recursive: true, force: true })
}
