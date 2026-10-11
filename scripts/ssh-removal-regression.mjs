import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, webkit, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const engine = process.env.ARTIFACE_BROWSER === 'webkit' ? 'webkit' : 'chromium'
const artifacts = process.env.ARTIFACE_SSH_REMOVAL_ARTIFACTS || await mkdtemp(join(tmpdir(), 'artiface-ssh-removal-'))
await mkdir(artifacts, { recursive: true })
const entry = join(repository, 'web/src/__ssh_removal_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'ssh-removal-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css') || id.includes('.svg?')) return '\0asset'
      if (id === './AccessSettings') return '\0access'
    },
    load(id) {
      if (id === '\0asset') return 'export default ""'
      if (id === '\0access') return 'export default function Access(){return null}'
      if (id === entry) return `
        import {useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import {setCSRFToken,sessionExpired} from './api'
        import {SettingsDraftProvider,useSettingsDrafts} from './SettingsDrafts'
        import SettingsPage from './components/SettingsPage'
        setCSRFToken('fixture-csrf')
        window.expireSession=sessionExpired
        function Fixture() {
          const [visible,setVisible]=useState(true)
          const drafts=useSettingsDrafts()
          window.fixtureDraft=drafts.configuration
          window.changeDraft=text=>drafts.setConfiguration(previous=>({...previous,text}))
          window.showSettings=setVisible
          return visible ? <div className="standalone-settings"><SettingsPage initialSection="sources"
            admin={window.fixtureAdmin} onClose={()=>setVisible(false)} onChanged={()=>window.fixtureChanged++}/></div> : <div>Settings closed</div>
        }
        createRoot(document.getElementById('root')).render(<SettingsDraftProvider><Fixture/></SettingsDraftProvider>)
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const code = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'components/workspace.css', 'components/settings.css', 'components/settingsCredentials.css']
  .map(name => readFile(join(repository, 'web/src', name), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${code.replaceAll('</script', '<\\/script')}</script>`
const origin = 'https://ssh-removal-fixture.invalid'
const password = 'synthetic-admin-secret'
const wrongPassword = 'synthetic-wrong-secret'
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true })
const evidence = []
const errors = []

async function fixture({ configured = true, encrypted = true, disabled = false, admin = false, width = 1280 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(8000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.addInitScript(({ origin, configured, encrypted, disabled, admin, password }) => {
    if (location.origin !== origin) return
    window.fixtureAdmin = admin
    window.fixtureChanged = 0
    window.fixtureRequests = []
    window.fixtureFailure = null
    window.fixtureHold = false
    window.fixtureAborted = 0
    window.fixtureConfig = { hosts: [
      { id: 'local', kind: 'local', label: 'localhost', target: '', roots: [{ id: 'local-project', label: 'Local project', path: '/local' }] },
      { id: 'remote', kind: 'ssh', label: 'Remote', target: 'remote', roots: [{ id: 'remote-project', label: 'Remote project', path: '/reports' }] },
    ], listen: 'fixture-only', sessionHours: 24 }
    window.fixtureRevision = 'revision-1'
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
    const settings = () => ({
      config: window.fixtureConfig, revision: window.fixtureRevision, gitCommit: 'fixture',
      sshDisabled: disabled, ...(configured === null ? {} : { sshConfigured: configured }),
    })
    window.fetch = async (address, options = {}) => {
      const original = new URL(address, location.href).pathname
      const endpoint = original.replace('/api/admin/', '/api/')
      const body = options.body ? JSON.parse(options.body) : undefined
      if (endpoint === '/api/settings' && body) {
        window.fixtureRequests.push({ original, body })
        if (window.fixtureHold) await new Promise(resolve => {
          window.fixtureRelease = resolve
          options.signal?.addEventListener('abort', () => window.fixtureAborted++, { once: true })
        })
        if (window.fixtureFailure) return json({ error: window.fixtureFailure.message }, window.fixtureFailure.status)
        if (body.revision !== window.fixtureRevision) return json({ error: 'The configuration changed elsewhere.' }, 409)
        const removing = window.fixtureConfig.hosts.some(host => host.kind === 'ssh' && !body.config.hosts.some(next => next.target === host.target))
        if (removing && encrypted) {
          if (!body.adminPassword) return json({ error: 'Enter the admin password to remove saved SSH credentials.', sshCredentialsRequired: true }, 428)
          if (body.adminPassword !== password) return json({ error: 'Incorrect admin password' }, 403)
        }
        window.fixtureConfig = body.config
        window.fixtureRevision = 'revision-2'
        return json(settings())
      }
      if (endpoint === '/api/settings') return json(settings())
      if (endpoint === '/api/hosts') return json({ hosts: window.fixtureConfig.hosts, setupEnabled: true })
      if (endpoint === '/api/ignore') return json({ content: '', revision: 'ignore', editable: true, path: '/fixture/ignore' })
      throw new Error('Unexpected endpoint: ' + endpoint)
    }
  }, { origin, configured, encrypted, disabled, admin, password })
  const page = await context.newPage()
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort())
  await page.goto(`${origin}${admin ? '/admin/' : '/'}`)
  if (admin) await page.getByRole('button', { name: 'Sources', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove host Remote', exact: true })).toBeEnabled()
  return { context, page }
}

const posts = page => page.evaluate(() => window.fixtureRequests)
const field = page => page.getByRole('dialog').getByLabel('Admin password', { exact: true })
async function openRemoval(page, kind = 'host', name = 'Remote', host = 'Remote') {
  await page.getByRole('button', { name: kind === 'host' ? `Remove host ${name}` : `Remove project ${name} on ${host}`, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  return dialog
}
async function submit(page, value = password) {
  await field(page).fill(value)
  await page.getByRole('dialog').getByRole('button', { name: /^(Remove host|Save configuration)$/ }).click()
}
async function editorRemoval(page) {
  await page.getByRole('button', { name: 'Configuration', exact: true }).click()
  const config = await page.evaluate(() => ({ ...window.fixtureConfig, hosts: window.fixtureConfig.hosts.filter(host => host.id !== 'remote') }))
  const text = JSON.stringify(config, null, 2)
  await page.getByLabel('Configuration JSON').fill(text)
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await expect(field(page)).toBeFocused()
  return text
}
async function noStoredSecrets(page) {
  const values = await page.evaluate(() => JSON.stringify([window.fixtureDraft, Object.entries(localStorage), Object.entries(sessionStorage)]))
  for (const secret of [password, wrongPassword]) assert(!values.includes(secret), 'Password escaped into settings drafts or browser storage')
}

try {
  for (const admin of [false, true]) {
    const { context, page } = await fixture({ disabled: true, admin })
    await expect(page.getByRole('button', { name: 'Add SSH host', exact: true })).toBeDisabled()
    const dialog = await openRemoval(page)
    await expect(dialog).toContainText('saved SSH credentials and trusted keys will be removed')
    await expect(field(page)).toHaveAttribute('type', 'password')
    await field(page).fill(password)
    await page.evaluate(() => { window.oldPassword = document.querySelector('input[name="adminPassword"]') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.oldPassword.value), '')
    assert.equal((await posts(page)).length, 0)
    await expect(page.getByRole('button', { name: 'Remove host Remote', exact: true })).toBeFocused()
    await openRemoval(page)
    await expect(field(page)).toHaveValue('')
    await submit(page, wrongPassword)
    await expect(dialog.getByRole('alert')).toHaveText('Incorrect admin password')
    await expect(field(page)).toHaveValue('')
    await expect(field(page)).toBeFocused()
    assert.equal(await page.evaluate(() => window.fixtureDraft.conflict), false)
    await submit(page)
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Host removed from Artiface.' })).toBeFocused()
    const sent = await posts(page)
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[0].body.config, sent[1].body.config)
    assert.equal(sent[1].body.revision, 'revision-1')
    assert.equal(sent[1].original, admin ? '/api/admin/settings' : '/api/settings')
    assert(!('adminPassword' in sent[1].body.config))
    await noStoredSecrets(page)
    evidence.push(`${admin ? 'Team admin' : 'Owner'}: disabled SSH still removable; cancel clears inputs; wrong password retries captured deletion; status focus restored`)
    await context.close()
  }

  for (const [kind, name, host] of [['host', 'localhost', 'localhost'], ['project', 'Local project', 'localhost'], ['project', 'Remote project', 'Remote']]) {
    const { context, page } = await fixture()
    const dialog = await openRemoval(page, kind, name, host)
    await expect(field(page)).toHaveCount(0)
    await dialog.getByRole('button', { name: `Remove ${kind}`, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    assert(!('adminPassword' in (await posts(page))[0].body))
    evidence.push(`${kind} ${name}: password-free deletion with an existing vault`)
    await context.close()
  }

  for (const encrypted of [false, true]) {
    const { context, page } = await fixture({ configured: null, encrypted })
    const dialog = await openRemoval(page)
    await expect(field(page)).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Remove host', exact: true }).click()
    if (encrypted) {
      await expect(field(page)).toBeFocused()
      await submit(page)
    }
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Host removed from Artiface.' })).toBeFocused()
    const sent = await posts(page)
    assert.equal(sent.length, encrypted ? 2 : 1)
    if (encrypted) assert.deepEqual(sent[0].body, { config: sent[1].body.config, revision: sent[1].body.revision })
    evidence.push(encrypted ? 'Source 428 resumes the original dialog/save and restores status focus' : 'Missing sshConfigured preserves credential-free fixture behavior')
    await context.close()
  }

  {
    const { context, page } = await fixture()
    const text = await editorRemoval(page)
    await submit(page, wrongPassword)
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Incorrect admin password')
    const newer = JSON.stringify({ ...JSON.parse(text), listen: 'newer-unsaved-draft' }, null, 2)
    await page.evaluate(text => window.changeDraft(text), newer)
    await submit(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByLabel('Configuration JSON')).toHaveValue(newer)
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible()
    const sent = await posts(page)
    assert.equal(sent.length, 3)
    for (const request of sent) {
      assert.equal(request.body.revision, 'revision-1')
      assert.deepEqual(request.body.config, JSON.parse(text))
    }
    assert.equal(await page.evaluate(() => window.fixtureDraft.conflict), false)
    await noStoredSecrets(page)
    evidence.push('Configuration 428/wrong-password retries preserve original config/revision and a newer unsaved draft')
    await context.close()
  }

  {
    const { context, page } = await fixture()
    const text = await editorRemoval(page)
    await field(page).fill(password)
    await page.evaluate(() => { window.oldPassword = document.querySelector('input[name="adminPassword"]') })
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toBeFocused()
    await expect(page.getByLabel('Configuration JSON')).toHaveValue(text)
    assert.equal(await page.evaluate(() => window.oldPassword.value), '')
    assert.equal((await posts(page)).length, 1)
    await noStoredSecrets(page)
    evidence.push('Configuration prompt cancellation preserves the draft, clears detached password and restores Save focus without retry')
    await context.close()
  }

  for (const failure of [
    { status: 409, message: 'The configuration changed elsewhere.', conflict: true },
    { status: 409, message: 'SSH credentials changed elsewhere; restart the server before removing hosts', conflict: false },
    { status: 422, message: 'Cannot remove Remote while another host uses it as a jump host.', conflict: false },
  ]) {
    const { context, page } = await fixture()
    const text = await editorRemoval(page)
    await page.evaluate(failure => { window.fixtureFailure = failure }, failure)
    await submit(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('alert').filter({ hasText: failure.message })).toBeVisible()
    await expect(page.getByLabel('Configuration JSON')).toHaveValue(text)
    assert.equal(await page.evaluate(() => window.fixtureDraft.conflict), failure.conflict)
    evidence.push(`${failure.status}: ${failure.message} preserves the draft with correct conflict state`)
    await context.close()
  }

  for (const boundary of ['unmount', 'session']) {
    for (const sending of [false, true]) {
      const { context, page } = await fixture()
      await editorRemoval(page)
      await field(page).fill(password)
      await page.evaluate(() => { window.oldPassword = document.querySelector('input[name="adminPassword"]') })
      if (sending) {
        await page.evaluate(() => { window.fixtureHold = true })
        await page.getByRole('dialog').getByRole('button', { name: 'Save configuration', exact: true }).click()
        await expect.poll(async () => (await posts(page)).length).toBe(2)
      }
      await page.evaluate(boundary => { if (boundary === 'unmount') window.showSettings(false); else window.expireSession() }, boundary)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      assert.equal(await page.evaluate(() => window.oldPassword.value), '')
      if (sending) {
        await expect.poll(() => page.evaluate(() => window.fixtureAborted)).toBe(1)
        await page.evaluate(() => window.fixtureRelease())
      }
      await expect.poll(() => page.evaluate(() => window.fixtureDraft.saving)).toBe(false)
      assert.equal(await page.evaluate(() => window.fixtureChanged), 0)
      await noStoredSecrets(page)
      evidence.push(`${boundary} while ${sending ? 'sending' : 'awaiting password'}: fields cleared, save settled, late success ignored`)
      await context.close()
    }
  }

  {
    const { context, page } = await fixture()
    const text = await editorRemoval(page)
    await field(page).fill(password)
    await page.evaluate(() => {
      window.oldPassword = document.querySelector('input[name="adminPassword"]')
      window.dispatchEvent(new Event('pagehide'))
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toBeEnabled()
    assert.equal(await page.evaluate(() => window.oldPassword.value), '')
    await expect(page.getByLabel('Configuration JSON')).toHaveValue(text)
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
    await expect(field(page)).toHaveValue('')
    await submit(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible()
    evidence.push('Page hide clears pending credentials; returning to the same page permits a fresh save')
    await context.close()
  }

  {
    const { context, page } = await fixture({ width: 320 })
    const dialog = await openRemoval(page)
    await field(page).fill(password)
    await expect(async () => {
      const bounds = await dialog.boundingBox()
      const input = await field(page).boundingBox()
      assert(bounds.x >= 0 && bounds.x + bounds.width <= 320 && input.x >= bounds.x && input.x + input.width <= bounds.x + bounds.width)
      assert(bounds.y >= 0 && bounds.y + bounds.height <= 844)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    }).toPass()
    await page.screenshot({ path: join(artifacts, `phone-${engine}.png`) })
    evidence.push('320px phone dialog and password input fit the viewport')
    await context.close()
  }

  assert.deepEqual(errors, [])
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ engine, evidence, errors }, null, 2) + '\n')
  for (const item of evidence) console.log(`PASS: ${item}`)
} catch (error) {
  const page = browser.contexts().at(-1)?.pages()[0]
  if (page) await page.screenshot({ path: join(artifacts, `failure-${engine}.png`), fullPage: true })
  throw error
} finally {
  await browser.close()
  console.log(`SSH removal artifacts: ${artifacts}`)
}
