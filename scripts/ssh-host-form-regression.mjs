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
const artifacts = process.env.ARTIFACE_SSH_FORM_ARTIFACTS || await mkdtemp(join(tmpdir(), 'artiface-ssh-host-form-'))
await mkdir(artifacts, { recursive: true })
const entry = join(repository, 'web/src/__ssh_host_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'ssh-host-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css')) return '\0style'
      if (id.includes('.svg?')) return '\0logo'
      if (id === './AccessSettings') return '\0access'
    },
    load(id) {
      if (id === '\0style') return 'export default ""'
      if (id === '\0logo') return 'export default ""'
      if (id === '\0access') return 'export default function Access(){return null}'
      if (id === entry) return `
        import {useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import {setCSRFToken} from './api'
        import {SettingsDraftProvider} from './SettingsDrafts'
        import ProjectChooser from './components/ProjectChooser'
        import ProjectSetup from './components/ProjectSetup'
        import SettingsPage from './components/SettingsPage'
        setCSRFToken('fixture-csrf')
        function Fixture() {
          const [hosts,setHosts]=useState(window.fixtureHosts)
          window.syncHosts=()=>setHosts(JSON.parse(JSON.stringify(window.fixtureHosts)))
          const saved=(host,root,current)=>{window.fixtureSaved.push({host,root,current});window.syncHosts()}
          return <SettingsDraftProvider>
            {window.fixtureSurface==='settings'
              ? <div className="standalone-settings"><SettingsPage initialSection="sources" admin={window.fixtureAdmin}
                  canManage={!window.fixtureReadOnly} onClose={()=>{}} onChanged={()=>window.fixtureChanged++}/></div>
              : <div className="project-content" style={{height:'100dvh',overflow:'auto'}}>
                {window.fixtureSurface==='draft'
                  ? <ProjectSetup initialDraft={{target:'draft-host',path:'/kept/project',label:'Kept project'}} hosts={hosts}
                      onDraftChange={draft=>window.fixtureDrafts.push(draft)} onSaved={(host,root,c)=>saved(host,root,c.current)}/>
                  : <ProjectChooser hosts={hosts} setupEnabled={!window.fixtureReadOnly} onOpen={()=>{}}
                      onSaved={saved} onRemoved={()=>{}} onSettings={()=>{}}/>}
                </div>}
          </SettingsDraftProvider>
        }
        createRoot(document.getElementById('root')).render(<Fixture/>)
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const code = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'components/workspace.css', 'components/settings.css', 'components/sshHostForm.css']
  .map(name => readFile(join(repository, 'web/src', name), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${code.replaceAll('</script', '<\\/script')}</script>`
const origin = 'https://ssh-host-fixture.invalid'
const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-fixture-only\n-----END OPENSSH PRIVATE KEY-----\n'
const longJump = `u@${'jump.'.repeat(49)}abc:2222`
assert.equal(longJump.length, 255)
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true })
const errors = []
const evidence = []

async function fixture({ width = 390, surface = 'chooser', disabled = false, readOnly = false, admin = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(8000)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  await context.addInitScript(({ origin, surface, disabled, readOnly, admin, longJump }) => {
    if (location.origin !== origin) return
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ theme: 'light', density: 'compact' }))
    window.fixtureSurface = surface
    window.fixtureReadOnly = readOnly
    window.fixtureAdmin = admin
    window.fixtureDisabled = disabled
    window.fixtureHosts = [
      { id: 'local', kind: 'local', label: 'localhost', target: '', roots: [{ id: 'saved', label: 'Saved', path: '/saved' }] },
      { id: 'gateway', kind: 'ssh', label: 'Gateway', target: 'gateway', roots: [] },
      { id: 'jump', kind: 'ssh', label: 'Imported jump', target: longJump, roots: [] },
    ]
    window.fixtureRequests = []
    window.fixtureDrafts = []
    window.fixtureSaved = []
    window.fixtureChanged = 0
    window.fixtureEvents = 0
    window.fixtureAborted = 0
    window.fixtureRevision = 1
    window.fixturePending = null
    window.fixtureHold = false
    window.fixtureFailure = null
    window.addEventListener('artiface:configuration-changed', () => window.fixtureEvents++)
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
    const create = body => {
      const host = { id: `host-${body.alias}`, kind: 'ssh', label: body.alias, target: body.alias, roots: [] }
      window.fixtureHosts.push(host)
      window.fixtureRevision++
      return json({ host })
    }
    window.fixtureRelease = () => {
      const pending = window.fixturePending
      window.fixturePending = null
      pending.resolve(create(pending.body))
    }
    window.fetch = async (address, options = {}) => {
      const original = new URL(address, location.href).pathname
      const endpoint = original.replace('/api/admin/', '/api/')
      const body = options.body ? JSON.parse(options.body) : undefined
      window.fixtureRequests.push({ original, endpoint, body, csrf: options.headers?.['X-CSRF-Token'] })
      if (endpoint === '/api/settings') return json({
        config: { hosts: window.fixtureHosts, listen: 'fixture-only', sessionHours: 24 },
        revision: String(window.fixtureRevision), sshDisabled: window.fixtureDisabled, gitCommit: 'fixture',
      })
      if (endpoint === '/api/hosts') return json({ hosts: window.fixtureHosts, setupEnabled: !readOnly, revision: String(window.fixtureRevision) })
      if (endpoint === '/api/ignore') return json({ content: '', revision: 'ignore', editable: !readOnly, path: '/synthetic/ignore' })
      if (endpoint === '/api/ssh/hosts') {
        if (window.fixtureFailure) return json({ error: window.fixtureFailure.message }, window.fixtureFailure.status)
        if (window.fixtureHold) return new Promise(resolve => {
          options.signal?.addEventListener('abort', () => window.fixtureAborted++, { once: true })
          window.fixturePending = { body, resolve }
        })
        return create(body)
      }
      if (endpoint === '/api/folders') {
        if (!window.fixtureHosts.some(host => host.id === body.host)) throw new Error('Folder browse preceded host creation')
        return json({ path: '/home/alice/reports', home: '/home/alice', parent: '/home/alice', entries: [] })
      }
      if (endpoint === '/api/projects') {
        const host = window.fixtureHosts.find(host => host.id === body.host)
        if (!host) throw new Error('Project save preceded host creation')
        const root = { id: 'new-project', path: body.path, label: body.label || 'Reports' }
        host.roots.push(root)
        window.fixtureRevision++
        return json({ host, root })
      }
      throw new Error(`Unexpected fixture endpoint: ${endpoint}`)
    }
  }, { origin, surface, disabled, readOnly, admin, longJump })
  const page = await context.newPage()
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort())
  await page.goto(`${origin}${admin ? '/admin/' : '/'}`)
  if (surface === 'settings') {
    if (admin) {
      if (width <= 700) await page.getByRole('combobox', { name: 'Administration section' }).selectOption('sources')
      else await page.getByRole('button', { name: 'Sources', exact: true }).click()
    }
    if (!readOnly) await expect(page.getByRole('heading', { name: 'Machines & Projects', exact: true })).toBeVisible()
  }
  return { context, page }
}

const input = (page, name) => page.locator(`.ssh-host-form [name="${name}"]`)
const requests = page => page.evaluate(() => window.fixtureRequests.filter(request => request.endpoint === '/api/ssh/hosts'))
async function start(page, surface = 'chooser') {
  if (surface === 'chooser') {
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    await expect(page.locator('#new-project-machine option[value=""]')).toBeEnabled()
    await page.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('')
  } else if (surface === 'settings') await page.getByRole('button', { name: 'Add SSH host', exact: true }).click()
  await expect(input(page, 'alias')).toBeEnabled()
}
async function fill(page, alias = 'new-box') {
  await input(page, 'alias').fill(alias)
  await input(page, 'hostname').fill('compute.example.org')
  await input(page, 'user').fill('alice')
  await input(page, 'sshPassword').fill('test-ssh-password')
  await input(page, 'adminPassword').fill('test-admin-password')
}
async function privateKey(page) {
  await page.getByRole('radio', { name: 'Private key', exact: true }).check()
  await expect(page.locator('.ssh-host-form input[type="file"]')).not.toHaveAttribute('accept')
  await page.getByLabel('Upload private key', { exact: true }).setInputFiles({ name: 'id_ed25519', mimeType: 'application/octet-stream', buffer: Buffer.from(key) })
  await expect(input(page, 'privateKey')).toHaveValue(key)
  await input(page, 'keyPassphrase').fill('test-key-passphrase')
  await input(page, 'adminPassword').fill('test-admin-password')
}
async function noStorage(page) {
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), window.fixtureDrafts]))
  for (const secret of ['test-ssh-password', 'test-admin-password', 'test-key-passphrase', 'synthetic-fixture-only']) {
    assert(!stored.includes(secret), 'Credentials escaped the component into storage or a draft')
  }
}
async function phoneBounds(page, name) {
  await expect(async () => {
    const result = await page.evaluate(() => ({
      viewport: innerWidth, width: document.documentElement.scrollWidth,
      fields: [...document.querySelectorAll('.ssh-host-form input,.ssh-host-form textarea')].map(element => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      }),
    }))
    assert(result.width <= result.viewport && result.fields.every(field => field.left >= 0 && field.right <= result.viewport + 1),
      `Phone form overflow: ${JSON.stringify(result)}`)
  }).toPass({ timeout: 5000 })
  await page.screenshot({ path: join(artifacts, `${name}-${engine}.png`), fullPage: true })
}

try {
  for (const width of [1280, 320]) {
    const { context, page } = await fixture({ width })
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    await page.locator('input[name="path"]').fill('/kept/local')
    await page.locator('input[name="label"]').fill('Local draft')
    await expect(page.locator('#new-project-machine option[value=""]')).toBeEnabled()
    await page.getByRole('combobox', { name: 'Machine' }).selectOption('')
    await fill(page)
    await expect(input(page, 'port')).toHaveValue('22')
    await page.getByText('Advanced', { exact: true }).click()
    await input(page, 'jump').fill('user@jump:2222')
    if (width === 320) await phoneBounds(page, 'password-phone')
    await page.evaluate(() => { window.savedSecretNodes = [...document.querySelectorAll('.ssh-host-form input[type=password]')] })
    await page.getByRole('button', { name: 'Save SSH host' }).click()
    await expect(page.getByRole('combobox', { name: 'Machine' })).toHaveValue('host-new-box')
    await expect(page.locator('.ssh-host-form')).toHaveCount(0)
    await expect(page.locator('.project-setup')).toHaveCount(1)
    assert(await page.evaluate(() => window.savedSecretNodes.every(input => input.value === '')))
    await expect(page.locator('input[name="path"]')).toBeFocused()
    const [sent] = await requests(page)
    assert.deepEqual(sent.body, { alias: 'new-box', hostname: 'compute.example.org', user: 'alice', port: 22,
      jump: 'user@jump:2222', sshPassword: 'test-ssh-password', adminPassword: 'test-admin-password' })
    assert.equal(sent.csrf, 'fixture-csrf')
    assert.equal(await page.evaluate(() => window.fixtureEvents), 1)
    assert.equal(await page.evaluate(() => window.fixtureRequests.filter(request => request.endpoint === '/api/folders').length), 0)
    await page.locator('input[name="path"]').fill('/new/remote')
    await page.locator('input[name="label"]').fill('Remote draft')
    await page.evaluate(() => window.syncHosts())
    await expect(page.locator('#new-project-machine option[value="host-new-box"]')).toHaveCount(1)
    await expect(page.locator('input[name="path"]')).toHaveValue('/new/remote')
    await page.getByRole('combobox', { name: 'Machine' }).selectOption('local')
    await expect(page.locator('input[name="path"]')).toHaveValue('/kept/local')
    await page.getByRole('combobox', { name: 'Machine' }).selectOption('host-new-box')
    await expect(page.locator('input[name="path"]')).toHaveValue('/new/remote')
    await page.getByRole('button', { name: 'Browse', exact: true }).click()
    await page.getByRole('button', { name: 'Select folder' }).click()
    await expect(page.locator('input[name="path"]')).toHaveValue('/home/alice/reports')
    await page.getByRole('button', { name: 'Add and open project' }).click()
    await expect.poll(() => page.evaluate(() => window.fixtureSaved.length)).toBe(1)
    assert.deepEqual(await page.evaluate(() => window.fixtureSaved[0].current), true)
    await noStorage(page)
    evidence.push(`password create, catalog selection, draft handoff, browse after save, project callback: ${width}px`)
    await context.close()
  }

  {
    const { context, page } = await fixture({ width: 320, surface: 'draft' })
    await start(page, 'draft')
    await fill(page, 'key-box')
    await privateKey(page)
    await page.getByText('Advanced', { exact: true }).click()
    await input(page, 'jump').fill(longJump)
    await phoneBounds(page, 'private-key-phone')
    await page.evaluate(() => { window.savedSecretNodes = [...document.querySelectorAll('.ssh-host-form input[type=password],.ssh-host-form textarea')] })
    await page.getByRole('button', { name: 'Save SSH host' }).click()
    await expect(page.locator('input[name="path"]')).toHaveValue('/kept/project')
    await expect(page.locator('input[name="label"]')).toHaveValue('Kept project')
    assert(await page.evaluate(() => window.savedSecretNodes.every(input => input.value === '')))
    const [sent] = await requests(page)
    assert.equal(sent.body.privateKey, key)
    assert.equal(sent.body.keyPassphrase, 'test-key-passphrase')
    assert.equal(sent.body.jump, longJump)
    assert(!('sshPassword' in sent.body))
    await noStorage(page)
    evidence.push('extensionless private-key upload, 255-byte imported jump, retained initial project path, phone layout')
    await context.close()
  }

  for (const admin of [false, true]) {
    const { context, page } = await fixture({ surface: 'settings', admin })
    await start(page, 'settings')
    await fill(page, admin ? 'admin-box' : 'settings-box')
    await page.getByRole('button', { name: 'Save SSH host' }).click()
    await expect(page.locator('input[name="path"]')).toBeVisible()
    assert.equal((await requests(page))[0].original, admin ? '/api/admin/ssh/hosts' : '/api/ssh/hosts')
    assert.equal(await page.evaluate(() => window.fixtureChanged), 1)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('heading', { name: admin ? 'admin-box' : 'settings-box', exact: true })).toBeVisible()
    evidence.push(`Settings host persists without a project; ${admin ? 'Team admin' : 'owner'} endpoint`)
    await context.close()
  }

  for (const surface of ['chooser', 'settings']) {
    const { context, page } = await fixture({ surface, disabled: true })
    if (surface === 'chooser') {
      await page.getByRole('button', { name: 'New project', exact: true }).click()
      await expect(page.locator('#new-project-machine option[value=""]')).toBeDisabled()
    } else {
      await expect(page.getByRole('button', { name: 'Add SSH host' })).toBeDisabled()
      await page.locator('.source-card').filter({ has: page.getByRole('heading', { name: 'localhost', exact: true }) })
        .getByRole('button', { name: 'Add project', exact: true }).click()
    }
    await expect(page.locator('input[name="path"]')).toBeEnabled()
    await page.locator('input[name="path"]').fill('/local/still-available')
    await page.locator('.project-setup-form button[type="submit"]').click()
    await expect.poll(() => page.evaluate(() => window.fixtureRequests.some(request => request.endpoint === '/api/projects'))).toBe(true)
    assert.equal((await requests(page)).length, 0)
    evidence.push(`disabled SSH still permits local projects: ${surface}`)
    await context.close()
  }

  for (const surface of ['chooser', 'settings']) {
    const { context, page } = await fixture({ surface, readOnly: true })
    await expect(page.locator('.ssh-host-form')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add SSH host' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New project', exact: true })).toHaveCount(0)
    evidence.push(`Team reader has no host creation flow: ${surface}`)
    await context.close()
  }

  for (const [message, expected] of [
    ['SSH credentials changed elsewhere; restart the server before adding hosts', 'SSH credentials changed elsewhere. Restart the server before adding hosts.'],
    ['An SSH host with this alias already exists', 'That SSH alias is already in use. Choose another name.'],
    ['test-ssh-password test-admin-password', 'Could not save the SSH host. Please try again.'],
  ]) {
    const { context, page } = await fixture()
    await start(page)
    await fill(page)
    await page.evaluate(message => { window.fixtureFailure = { status: 409, message } }, message)
    await page.getByRole('button', { name: 'Save SSH host' }).click()
    await expect(page.getByRole('alert')).toHaveText(expected)
    await expect(input(page, 'sshPassword')).toHaveAttribute('type', 'password')
    await expect(input(page, 'adminPassword')).toHaveAttribute('type', 'password')
    await noStorage(page)
    evidence.push(`safe conflict handling: ${expected}`)
    await context.close()
  }

  {
    const { context, page } = await fixture()
    await start(page)
    await fill(page)
    await page.getByRole('radio', { name: 'Private key', exact: true }).check()
    await page.getByLabel('Upload private key', { exact: true }).setInputFiles({ name: 'id_rsa', mimeType: 'application/octet-stream', buffer: Buffer.alloc(32769, 65) })
    await expect(page.getByRole('alert')).toHaveText('Choose a non-empty private key file of at most 32 KiB.')
    await expect(input(page, 'privateKey')).toHaveValue('')
    await input(page, 'privateKey').fill(key)
    await input(page, 'adminPassword').fill('é'.repeat(513))
    await page.getByRole('button', { name: 'Save SSH host' }).click()
    await expect(page.getByRole('alert')).toContainText('admin password to 1 KiB')
    assert.equal((await requests(page)).length, 0)
    await input(page, 'adminPassword').fill('test-admin-password')
    await page.getByRole('button', { name: 'Save SSH host' }).click()
    await expect(page.locator('input[name="path"]')).toBeVisible()
    assert.equal((await requests(page))[0].body.privateKey, key)
    assert(!('keyPassphrase' in (await requests(page))[0].body))
    evidence.push('oversized extensionless upload rejected; UTF-8 byte limits enforced; pasted key accepted')
    await context.close()
  }

  for (const action of ['newer edit', 'unmount']) {
    const { context, page } = await fixture()
    await start(page)
    await fill(page)
    await page.getByRole('radio', { name: 'Private key', exact: true }).check()
    await page.evaluate(() => {
      window.oldKey = document.querySelector('.ssh-host-form textarea')
      File.prototype.arrayBuffer = function () {
        return new Promise(resolve => {
          window.finishKeyRead = () => {
            window.keyBytes = new TextEncoder().encode('late-upload-content')
            resolve(window.keyBytes.buffer)
          }
        })
      }
    })
    await page.getByLabel('Upload private key', { exact: true }).setInputFiles({ name: 'id_rsa', mimeType: 'application/octet-stream', buffer: Buffer.from('held') })
    await expect.poll(() => page.evaluate(() => typeof window.finishKeyRead)).toBe('function')
    if (action === 'newer edit') await input(page, 'privateKey').fill('newer pasted key')
    else await page.getByRole('combobox', { name: 'Machine' }).selectOption('local')
    await page.evaluate(() => window.finishKeyRead())
    await expect.poll(() => page.evaluate(() => window.keyBytes.every(value => value === 0))).toBe(true)
    if (action === 'newer edit') await expect(input(page, 'privateKey')).toHaveValue('newer pasted key')
    else {
      assert.equal(await page.evaluate(() => window.oldKey.value), '')
      await page.getByRole('combobox', { name: 'Machine' }).selectOption('')
      await page.getByRole('radio', { name: 'Private key', exact: true }).check()
      await expect(input(page, 'privateKey')).toHaveValue('')
    }
    assert.equal((await requests(page)).length, 0)
    evidence.push(`late file upload cannot repopulate credentials or overwrite user intent: ${action}`)
    await context.close()
  }

  for (const boundary of ['unmount', 'unauthorized']) {
    const { context, page } = await fixture()
    await start(page)
    await fill(page)
    await page.evaluate(() => {
      window.fixtureHold = true
      window.secretNodes = [...document.querySelectorAll('.ssh-host-form input[type=password]')]
      const form = document.querySelector('.ssh-host-form')
      form.requestSubmit()
      form.requestSubmit()
    })
    await expect.poll(async () => (await requests(page)).length).toBe(1)
    if (boundary === 'unmount') await page.getByRole('combobox', { name: 'Machine' }).selectOption('local')
    else await page.evaluate(() => window.dispatchEvent(new Event('artiface:unauthorized')))
    await expect.poll(() => page.evaluate(() => window.fixtureAborted)).toBe(1)
    assert(await page.evaluate(() => window.secretNodes.every(input => input.value === '')))
    await page.evaluate(() => window.fixtureRelease())
    if (boundary === 'unmount') {
      await expect(page.getByRole('combobox', { name: 'Machine' })).toHaveValue('local')
      await page.getByRole('combobox', { name: 'Machine' }).selectOption('')
      await expect(input(page, 'sshPassword')).toHaveValue('')
      await expect(input(page, 'adminPassword')).toHaveValue('')
    } else {
      await expect(page.locator('.ssh-host-form')).toHaveCount(0)
      await expect(page.getByRole('status')).toContainText('Sign in again')
    }
    await noStorage(page)
    evidence.push(`single-flight submission, cleared detached inputs and ignored late response: ${boundary}`)
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
  console.log(`SSH host form artifacts: ${artifacts}`)
}
