import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const entry = join(repository, 'web/src/__ssh_host_key_fixture__.tsx')
const bundle = await rolldown({
  cwd: join(repository, 'web'), input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'ssh-host-key-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css') || id.includes('.svg?')) return '\0asset'
      if (id === './components/Workspace' || id === './components/SettingsPage') return '\0workspace.tsx'
    },
    load(id) {
      if (id === '\0asset') return 'export default ""'
      if (id === '\0workspace.tsx') return `
        import {createElement,useState} from 'react'
        import FolderPicker from '${repository}/web/src/components/FolderPicker.tsx'
        import {api,sessionExpired} from '${repository}/web/src/api.ts'
        export default function Workspace({onLogout}) {
          const [folder,setFolder]=useState(false)
          window.logoutFixture=async()=>{await api('/api/logout',{body:{}});if(onLogout)onLogout();else sessionExpired()}
          return createElement('main',null,createElement('h1',null,'Authenticated fixture'),
            createElement('button',{onClick:()=>setFolder(true)},'Browse SSH'),
            folder&&createElement(FolderPicker,{target:'report-server',initialPath:'/reports',onPick:()=>setFolder(false),onClose:()=>setFolder(false)}))
        }
      `
      if (id === entry) return `
        import {createElement,StrictMode} from 'react'
        import {createRoot} from 'react-dom/client'
        import App from './App'
        import {api,sessionExpired} from './api'
        const root=createRoot(document.getElementById('root'))
        window.results={}
        window.controllers=new Map()
        window.changes=0
        addEventListener('artiface:configuration-changed',()=>window.changes++)
        window.startFixture=(id,url='/api/check',body,withSignal=true)=>{
          const controller=new AbortController()
          window.controllers.set(id,controller)
          window.results[id]={pending:true}
          api(url,{body,...(withSignal?{signal:controller.signal}:{})}).then(
            value=>window.results[id]={value:value??null},
            error=>window.results[id]={error:error.message,name:error.name,status:error.status,token:error.sshHostKey?.token}
          )
        }
        window.abortFixture=id=>window.controllers.get(id).abort()
        window.expireFixture=sessionExpired
        window.unmountFixture=()=>root.unmount()
        root.render(createElement(StrictMode,null,createElement(App)))
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'components/settings.css', 'components/sshHostKey.css']
  .map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://ssh-host-key-fixture.invalid'
const fingerprint = `SHA256:${'a'.repeat(43)}`
const previousFingerprint = `SHA256:${'b'.repeat(43)}`
const owner = { authenticated: true, mode: 'personal', role: 'personal', csrfToken: 'owner-csrf' }
const admin = { authenticated: true, mode: 'team', role: 'admin', csrfToken: 'admin-csrf' }
const user = { authenticated: true, mode: 'team', role: 'user', userID: 'reader', csrfToken: 'user-csrf' }
const browser = await (process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
const errors = []

function hold() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

async function fixture({ session = owner, adminPage = false, changed = false, width = 1000, sessionGate = null, ready = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(5000)
  // Early Safari 17 has no AbortSignal.any.
  await context.addInitScript(() => { Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true }) })
  const page = await context.newPage()
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack) })
  const state = {
    session: { ...session }, requests: [], accepted: new Set(), changed,
    detailsFailure: null, acceptFailure: null, sessionGate, detailsGate: null, responseGate: null, ordinaryConflict: false,
    tokenFor: () => 'key-0',
  }
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/' || url.pathname === '/admin/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    const endpoint = url.pathname.replace(/^\/api\/(?:admin\/)?/, '')
    const body = request.method() === 'POST' ? request.postDataJSON() : null
    state.requests.push({ endpoint, method: request.method(), path: url.pathname, body, csrf: request.headers()['x-csrf-token'] })
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) }).catch(() => {})
    if (endpoint === 'session') {
      if (state.sessionGate) await state.sessionGate.promise
      return json(state.session)
    }
    if (endpoint === 'logout') {
      state.session.authenticated = false
      return route.fulfill({ status: 204 })
    }
    if (endpoint === 'ssh/hosts') return json({ host: { id: 'new-host' } }, 201)
    if (endpoint === 'ssh/host-key') {
      if (state.detailsGate) await state.detailsGate.promise
      if (state.detailsFailure) return json({ error: state.detailsFailure.message }, state.detailsFailure.status)
      return json({
        token: body.token, target: 'report-server', host: 'jump-host <literal>',
        address: 'bastion.example:2222', keyType: 'ssh-ed25519', fingerprint,
        changed: state.changed, previousFingerprints: state.changed ? [previousFingerprint] : [],
        ...state.detailOverrides,
      })
    }
    if (endpoint === 'ssh/host-key/accept') {
      if (state.acceptFailure) return json({ error: state.acceptFailure.message }, state.acceptFailure.status)
      state.accepted.add(body.token)
      return route.fulfill({ status: 204 }).catch(() => {})
    }
    if (endpoint === 'check' || endpoint === 'folders') {
      const token = state.tokenFor(url, body)
      if (state.responseGate) await state.responseGate.promise
      if (state.ordinaryConflict) return json({ error: 'Ordinary configuration conflict' }, 409)
      if (token && !state.accepted.has(token)) return json({ error: 'SSH host key needs confirmation', sshHostKey: { token } }, 409)
      return json(endpoint === 'folders' ? { path: '/reports', parent: '/', home: '/home/owner', entries: [] }
        : { ok: true, body })
    }
    throw new Error(`Unexpected fixture request: ${endpoint}`)
  })
  await page.goto(origin + (adminPage ? '/admin/' : '/'))
  if (ready) await expect(page.getByRole('heading', { name: 'Authenticated fixture' })).toBeVisible().catch(async failure => {
    console.error('Fixture startup:', errors, await page.locator('body').innerText())
    throw failure
  })
  return { page, state, close: () => context.close() }
}

const calls = (state, endpoint) => state.requests.filter(request => request.endpoint === endpoint)
const start = (page, id, body, withSignal = true, url = '/api/check') =>
  page.evaluate(({ id, url, body, withSignal }) => window.startFixture(id, url, body, withSignal), { id, url, body, withSignal })
const result = async (page, id) => {
  await expect.poll(() => page.evaluate(id => window.results[id]?.pending === true, id)).toBe(false)
  return page.evaluate(id => window.results[id], id)
}
const dialog = page => page.getByRole('dialog', { name: /SSH host key/ })
async function accept(page, password = 'fixture password') {
  await dialog(page).getByLabel(/^(Workspace|Admin) password$/).fill(password)
  await dialog(page).getByRole('button', { name: 'Accept and retry', exact: true }).click()
}

try {
  {
    const gate = hold()
    const { page, state, close } = await fixture({ sessionGate: gate, ready: false })
    try {
      await start(page, 'checking')
      assert.equal((await result(page, 'checking')).status, 409)
      assert.equal(calls(state, 'ssh/host-key').length, 0)
      gate.release()
      await expect(page.getByRole('heading', { name: 'Authenticated fixture' })).toBeVisible()
      state.ordinaryConflict = true
      await start(page, 'ordinary-conflict')
      const failure = await result(page, 'ordinary-conflict')
      assert.equal(failure.error, 'Ordinary configuration conflict')
      assert.equal(failure.token, undefined)
      await expect(dialog(page)).toHaveCount(0)
      assert.equal(calls(state, 'ssh/host-key').length, 0)
      console.log('PASS auth-not-ready requests and ordinary 409 errors never open SSH confirmation')
    } finally { gate.release(); await close() }
  }
  {
    const { page, state, close } = await fixture()
    try {
      await page.getByRole('button', { name: 'Browse SSH' }).click()
      await expect(page.getByRole('dialog', { name: 'Unknown SSH host key' })).toBeVisible()
      await start(page, 'parallel', { target: 'report-server', path: '/reports' })
      await start(page, 'aborted')
      await page.evaluate(() => window.abortFixture('aborted'))
      assert.equal((await result(page, 'aborted')).name, 'AbortError')
      await expect(dialog(page)).toHaveCount(1)
      await expect(dialog(page).getByText(fingerprint, { exact: true })).toBeVisible()
      assert.equal(calls(state, 'ssh/host-key').length, 1, 'Same-token requests fetched duplicate details')
      assert.equal(calls(state, 'ssh/host-key/accept').length, 0)
      state.acceptFailure = { status: 403, message: 'Incorrect admin password' }
      await accept(page, 'wrong fixture password')
      await expect(dialog(page).getByRole('alert')).toHaveText('Incorrect admin password')
      await expect(dialog(page).getByLabel('Workspace password')).toHaveValue('')
      await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0)
      state.acceptFailure = null
      await accept(page)
      assert.deepEqual((await result(page, 'parallel')).value, { ok: true, body: { target: 'report-server', path: '/reports' } })
      await expect(dialog(page)).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: 'Choose a folder' })).toBeVisible()
      await expect(page.getByRole('dialog', { name: 'Choose a folder' }).getByLabel('Folder path', { exact: true })).toHaveValue('/reports')
      assert.equal(await page.evaluate(() => window.changes), 1)
      assert(calls(state, 'ssh/host-key/accept').every(request => request.csrf === owner.csrfToken))
      assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('fixture password')), false)
      assert.equal(calls(state, 'folders').length, 2, 'Folder browsing was not retried')
      console.log('PASS unknown key, nested FolderPicker, same-token coalescing, independent abort, password retry, POST replay and no password storage')
    } finally { await close() }
  }
  {
    const { page, state, close } = await fixture({ session: admin, adminPage: true, changed: true, width: 320 })
    try {
      await start(page, 'changed')
      await expect(page.getByRole('dialog', { name: 'SSH host key changed' })).toBeVisible()
      await expect(dialog(page).getByText(previousFingerprint, { exact: true })).toBeVisible()
      await expect(dialog(page).getByText('jump-host <literal>', { exact: true })).toBeVisible()
      await expect(dialog(page).locator('img')).toHaveCount(0)
      assert(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1))
      await accept(page)
      assert.equal((await result(page, 'changed')).value.ok, true)
      assert(state.requests.every(request => request.path.startsWith('/api/admin/')))
      assert(calls(state, 'ssh/host-key/accept').every(request => request.csrf === admin.csrfToken))
      await start(page, 'host-created', {}, true, '/api/ssh/hosts')
      await result(page, 'host-created')
      assert.equal(await page.evaluate(() => window.changes), 2)
      console.log('PASS changed-key fingerprint/hop/address display, narrow layout, admin routing and host-creation event')
    } finally { await close() }
  }
  {
    const { page, state, close } = await fixture({ session: user })
    try {
      await start(page, 'user')
      const failure = await result(page, 'user')
      assert.equal(failure.status, 409)
      assert.match(failure.error, /administrator/)
      await expect(dialog(page)).toHaveCount(0)
      assert.equal(calls(state, 'ssh/host-key').length, 0)
      assert.equal(calls(state, 'ssh/host-key/accept').length, 0)
      assert.equal(await page.getByText(fingerprint, { exact: true }).count(), 0)
      console.log('PASS regular Team users receive an ask-admin error without fetching key details')
    } finally { await close() }
  }
  {
    const { page, state, close } = await fixture()
    try {
      await page.clock.install()
      await page.getByRole('button', { name: 'Browse SSH' }).click()
      await start(page, 'cancel-a')
      await start(page, 'cancel-b')
      await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Choose a folder' })).toBeVisible()
      for (const id of ['cancel-a', 'cancel-b']) assert.equal((await result(page, id)).status, 409)
      await start(page, 'refresh')
      assert.match((await result(page, 'refresh')).error, /one minute/)
      assert.equal(calls(state, 'ssh/host-key').length, 1)
      assert.equal(calls(state, 'ssh/host-key/accept').length, 0)
      state.tokenFor = () => 'other-host'
      await start(page, 'other-host')
      await accept(page)
      assert.equal((await result(page, 'other-host')).value.ok, true)
      await page.clock.fastForward(60_001)
      state.tokenFor = () => 'key-0'
      await start(page, 'retry-after-cooldown')
      await expect(page.getByRole('dialog', { name: 'Unknown SSH host key' })).toBeVisible()
      await accept(page)
      assert.equal((await result(page, 'retry-after-cooldown')).value.ok, true)
      console.log('PASS cancel suppresses the same host token for one minute without blocking another host')
    } finally { await close() }
  }
  for (const mode of ['abort', 'logout', 'replace', 'unmount']) {
    const { page, state, close } = await fixture()
    try {
      await start(page, mode, undefined, mode === 'abort')
      await expect(dialog(page).getByLabel('Workspace password')).toBeVisible()
      await dialog(page).getByLabel('Workspace password').fill('discard this password')
      await dialog(page).getByLabel('Workspace password').evaluate(input => { window.oldPasswordInput = input })
      if (mode === 'abort') await page.evaluate(() => window.abortFixture('abort'))
      if (mode === 'logout') await page.evaluate(() => window.logoutFixture())
      if (mode === 'replace') {
        state.session = { ...user }
        await page.evaluate(() => window.expireFixture())
        await expect(page.getByRole('heading', { name: 'Authenticated fixture' })).toBeVisible()
      }
      if (mode === 'unmount') await page.evaluate(() => window.unmountFixture())
      assert.equal((await result(page, mode)).name, 'AbortError')
      await expect(dialog(page)).toHaveCount(0)
      assert.equal(calls(state, 'ssh/host-key/accept').length, 0)
      assert.equal(await page.evaluate(() => window.oldPasswordInput.value), '')
      assert(await page.locator('input[type="password"]').evaluateAll(inputs => inputs.every(input => input.value !== 'discard this password')))
      if (mode === 'replace') {
        await start(page, 'new-user')
        assert.match((await result(page, 'new-user')).error, /administrator/)
        assert.equal(calls(state, 'ssh/host-key').length, 1)
      }
    } finally { await close() }
  }
  console.log('PASS last-waiter abort, logout, role/session replacement and unmount clear pending dialogs and promises')
  {
    const { page, state, close } = await fixture()
    const gate = hold()
    try {
      state.responseGate = gate
      await start(page, 'late')
      await expect.poll(() => calls(state, 'check').length).toBe(1)
      await page.evaluate(() => window.abortFixture('late'))
      gate.release()
      assert.equal((await result(page, 'late')).name, 'AbortError')
      await expect(dialog(page)).toHaveCount(0)
      assert.equal(calls(state, 'ssh/host-key').length, 0)
      state.responseGate = null
      state.detailsGate = hold()
      await start(page, 'details-abort')
      await expect.poll(() => calls(state, 'ssh/host-key').length).toBe(1)
      await page.evaluate(() => window.abortFixture('details-abort'))
      state.detailsGate.release()
      assert.equal((await result(page, 'details-abort')).name, 'AbortError')
      await expect(dialog(page)).toHaveCount(0)
      console.log('PASS late challenge responses and aborted details fetches cannot reopen a dialog')
    } finally { gate.release(); state.detailsGate?.release(); await close() }
  }
  for (const phase of ['accept', 'mismatch']) {
    const { page, state, close } = await fixture()
    try {
      if (phase === 'accept') state.acceptFailure = { status: 409, message: 'SSH credentials changed; retry the connection' }
      if (phase === 'mismatch') state.detailOverrides = { token: 'wrong-token' }
      await start(page, 'stale')
      if (phase === 'accept') await accept(page)
      await expect(dialog(page).getByRole('alert')).toBeVisible()
      await expect(dialog(page).getByRole('button', { name: 'Accept and retry' })).toHaveCount(0)
      await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
      assert.equal((await result(page, 'stale')).status, 409)
      assert.equal(calls(state, 'ssh/host-key/accept').length, phase === 'accept' ? 1 : 0)
    } finally { await close() }
  }
  console.log('PASS stale and mismatched tokens cannot be accepted or recursively prompt')
  {
    const { page, state, close } = await fixture()
    try {
      state.detailsFailure = { status: 409, message: 'Confirmation expired; retry the connection' }
      await start(page, 'expired')
      assert.equal((await result(page, 'expired')).status, 409)
      assert.equal(calls(state, 'check').length, 2, 'Expired details should retry the original request only once')
      assert.equal(calls(state, 'ssh/host-key').length, 2)
      assert.equal(calls(state, 'ssh/host-key/accept').length, 0)
      await expect(dialog(page)).toHaveCount(0)
      state.detailsFailure = null
      await start(page, 'fresh-after-expiry')
      await accept(page)
      assert.equal((await result(page, 'fresh-after-expiry')).value.ok, true)
      console.log('PASS stale details retry once automatically without applying a cancel cooldown')
    } finally { await close() }
  }
  {
    const { page, state, close } = await fixture()
    try {
      state.tokenFor = url => url.searchParams.has('second') ? `second-${state.accepted.size}` : 'first'
      await start(page, 'first')
      await expect(page.getByRole('dialog', { name: 'Unknown SSH host key' })).toBeVisible()
      await start(page, 'second', undefined, true, '/api/check?second=1')
      await expect.poll(() => calls(state, 'check').length).toBe(2)
      await accept(page)
      assert.equal((await result(page, 'first')).value.ok, true)
      await expect.poll(() => calls(state, 'ssh/host-key').length).toBe(2)
      assert.equal(calls(state, 'ssh/host-key')[1].body.token, 'second-1')
      // Hold the current token stable once approved, as a now-trusted host does.
      state.tokenFor = () => 'second-1'
      await accept(page)
      assert.equal((await result(page, 'second')).value.ok, true)
      assert.deepEqual(calls(state, 'ssh/host-key').map(call => call.body.token), ['first', 'second-1'])
      console.log('PASS distinct queued hosts retry for fresh tokens after envelope-changing acceptance')
    } finally { await close() }
  }
  for (const length of [9, 10]) {
    const { page, state, close } = await fixture()
    try {
      state.tokenFor = () => state.accepted.size < length ? `hop-${state.accepted.size}` : null
      await start(page, 'chain')
      for (let index = 0; index < 9; index++) {
        await expect.poll(() => calls(state, 'ssh/host-key').length).toBe(index + 1)
        await accept(page)
      }
      const final = await result(page, 'chain')
      if (length === 9) assert.equal(final.value.ok, true)
      else { assert.equal(final.status, 409); assert.match(final.error, /after retrying/) }
      assert.equal(calls(state, 'ssh/host-key/accept').length, 9)
      await expect(dialog(page)).toHaveCount(0)
    } finally { await close() }
  }
  console.log('PASS nine jump-host keys succeed and a further challenge stops with a bounded error')
  for (const cancellation of ['session', 'request']) {
    const { page, state, close } = await fixture()
    const gate = hold()
    try {
      await start(page, 'retry-cancel', undefined, cancellation === 'request')
      await expect(page.getByRole('dialog', { name: 'Unknown SSH host key' })).toBeVisible()
      state.responseGate = gate
      await accept(page)
      await expect.poll(() => calls(state, 'check').length).toBe(2)
      if (cancellation === 'session') await page.evaluate(() => window.expireFixture())
      else await page.evaluate(() => window.abortFixture('retry-cancel'))
      assert.equal((await result(page, 'retry-cancel')).name, 'AbortError')
      gate.release()
      await expect(dialog(page)).toHaveCount(0)
    } finally { gate.release(); await close() }
  }
  console.log('PASS session expiry and caller abort cancel in-flight retries without AbortSignal.any')
  assert.deepEqual(errors, [], 'Unexpected browser errors')
} finally {
  await browser.close()
}
