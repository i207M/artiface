import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const entry = join(repository, 'web/src/__access_settings_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'access-settings-fixture',
    resolveId(id) { if (id === entry) return id },
    load(id) {
      if (id === entry) return `
        import {StrictMode} from 'react'
        import {createRoot} from 'react-dom/client'
        import {flushSync} from 'react-dom'
        import AccessSettings from './components/AccessSettings'
        const root = createRoot(document.getElementById('root'))
        let hosts = [{id:'fixture', label:'Fixture', kind:'local', target:'', roots:[
          {id:'revoked',label:'Revoked project',path:'/synthetic/revoked'},
          {id:'new',label:'New project',path:'/synthetic/new'}]}]
        let enabled = true
        const render = () => flushSync(() => root.render(<StrictMode><AccessSettings hosts={hosts} enabled={enabled}/></StrictMode>))
        window.refreshHosts = () => { hosts = [...hosts]; render() }
        window.replaceHosts = value => { hosts = value; render() }
        window.enableAccess = value => { enabled = value; render() }
        render()
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'components/settings.css'].map(path =>
  readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://access-settings-fixture.invalid'
const originalGrants = [{ host: 'fixture', root: 'revoked' }]
const newGrants = [{ host: 'fixture', root: 'new' }]
const clone = value => JSON.parse(JSON.stringify(value))
const browser = await (process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
const failures = []

async function check(name, run, contextOptions = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...contextOptions })
  context.setDefaultTimeout(3000)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const model = {
    access: { mode: 'team', revision: 'r1', users: [{ id: 'u1', username: 'alice', disabled: false, projects: clone(originalGrants) }] },
    posts: [], reads: 0, failReads: false, writeFailure: null, nextRead: null, nextWrite: null, pending: [],
  }
  const hold = kind => {
    let started, release
    const gate = { started: new Promise(resolve => { started = resolve }), wait: new Promise(resolve => { release = resolve }),
      arrive: () => started(), release: () => release() }
    model[kind === 'read' ? 'nextRead' : 'nextWrite'] = gate
    model.pending.push(gate)
    return gate
  }
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/admin/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    if (url.pathname !== '/api/admin/access') return route.fulfill({ status: 404, body: 'Unknown synthetic route' })
    if (request.method() === 'GET') {
      model.reads++
      const snapshot = clone(model.access)
      const gate = model.nextRead
      model.nextRead = null
      if (gate) { gate.arrive(); await gate.wait }
      if (model.failReads) return route.fulfill({ status: 503, json: { error: 'Synthetic access read failure.' } })
      return route.fulfill({ json: snapshot })
    }
    const submitted = request.postDataJSON()
    model.posts.push(submitted)
    const gate = model.nextWrite
    model.nextWrite = null
    if (gate) { gate.arrive(); await gate.wait }
    if (model.writeFailure) return route.fulfill({ status: model.writeFailure.status, json: { error: model.writeFailure.message } })
    if (submitted.user?.password && (Array.from(submitted.user.password).length < 6 || Buffer.byteLength(submitted.user.password) > 1024)) {
      return route.fulfill({ status: 400, json: { error: 'password must contain at least 6 characters and at most 1024 bytes of valid UTF-8' } })
    }
    if (submitted.revision !== model.access.revision) return route.fulfill({ status: 409, json: { error: 'Access settings changed elsewhere. Reload and try again.' } })
    if (submitted.user && !submitted.user.id && !submitted.user.password) return route.fulfill({ status: 400, json: { error: 'A password is required for a new user' } })
    if (submitted.user && model.access.users.some(user => user.id !== submitted.user.id && user.username === submitted.user.username.toLowerCase())) {
      return route.fulfill({ status: 400, json: { error: 'usernames must be unique lowercase identifiers using letters, numbers, underscores or hyphens' } })
    }
    const { password, ...savedUser } = submitted.user ?? {}
    model.access = { ...model.access, revision: `r${Number(model.access.revision.slice(1)) + 1}`,
      users: submitted.deleteUser ? model.access.users.filter(user => user.id !== submitted.deleteUser)
        : submitted.user.id ? model.access.users.map(user => user.id === submitted.user.id ? { ...user, ...savedUser } : user)
          : [...model.access.users, { ...savedUser, id: 'synthetic-created' }] }
    return route.fulfill({ json: model.access })
  })
  const externalChange = () => {
    model.access = { ...model.access, revision: 'r2', users: [{ ...model.access.users[0], username: 'alice-external', projects: clone(newGrants) }] }
  }
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  try {
    await page.goto(`${origin}/admin/`)
    await expect(page.getByRole('button', { name: 'Edit alice', exact: true })).toBeVisible()
    await run({ page, model, hold, externalChange, settle })
    assert.deepEqual(errors, [])
    console.log(`PASS: ${name}`)
  } catch (failure) {
    failures.push({ name, error: failure.message })
    console.error(`FAIL: ${name}\n${failure.message}`)
  } finally {
    for (const gate of model.pending) gate.release()
    await context.close()
  }
}

try {
  for (const intent of ['stay', 'only-user', 'focus-other', 'pointer-text', 'wheel']) {
    await check(`successful held deletion keeps local context with ${intent}`, async ({ page, model, hold }) => {
      if (intent !== 'only-user') {
        model.access.users.push(...Array.from({ length: 15 }, (_, index) => ({
          id: `user-${index}`, username: `reader-${index}`, disabled: false, projects: clone(originalGrants),
        })))
        await page.evaluate(() => window.refreshHosts())
        await expect(page.getByRole('button', { name: 'Edit reader-14', exact: true })).toBeVisible()
      }
      await page.getByRole('button', { name: 'Delete alice', exact: true }).click()
      const confirmation = page.getByRole('group', { name: 'Confirm user deletion' })
      const confirm = confirmation.getByRole('button', { name: 'Delete user', exact: true })
      const write = hold('write')
      await confirm.focus()
      await confirm.press('Enter')
      await write.started
      await expect(confirm).toBeDisabled()
      await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('BODY')
      if (intent === 'focus-other') await page.locator('summary').focus()
      if (intent === 'pointer-text') await page.getByRole('heading', { name: 'Users & project access', exact: true }).click()
      if (intent === 'wheel') {
        await page.evaluate(() => {
          window.fixtureWheel = false
          document.addEventListener('wheel', () => { window.fixtureWheel = true }, { once: true })
        })
        await page.mouse.move(200, 200)
        await page.mouse.wheel(0, -200)
        await expect.poll(() => page.evaluate(() => window.fixtureWheel)).toBe(true)
      }
      const moved = await page.evaluateHandle(() => document.activeElement)
      write.release()
      await expect(confirmation).toHaveCount(0)
      const notice = page.getByRole('status')
      await expect(notice).toHaveText('User deleted.')
      if (intent === 'stay' || intent === 'only-user') {
        await expect(notice).toBeFocused()
        await expect(notice).toBeInViewport()
        if (intent === 'stay') {
          await page.keyboard.press('Tab')
          await expect(page.getByRole('button', { name: 'Edit reader-0', exact: true })).toBeFocused()
        }
      } else assert(await moved.evaluate(element => element === document.activeElement), `${intent}: deletion stole deliberate focus`)
      await moved.dispose()
      assert.deepEqual(model.posts, [{ deleteUser: 'u1', revision: 'r1' }])
    }, { viewport: { width: 390, height: 844 }, hasTouch: true })
  }
  for (const intent of ['stay', 'focus-other', 'wheel', 'PageDown']) {
    await check(`held password validation preserves ${intent} intent and Unicode payload`, async ({ page, model, hold }) => {
      await page.getByRole('button', { name: 'Edit alice', exact: true }).click()
      const password = page.getByLabel('Reset password', { exact: true })
      const username = page.getByRole('textbox', { name: 'Username', exact: true })
      await password.fill('😀😀😀😀😀')
      const save = page.getByRole('button', { name: 'Save user', exact: true })
      const write = hold('write')
      await save.focus()
      await save.press('Enter')
      await write.started
      await expect(password).toBeDisabled()
      await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('BODY')
      if (intent === 'focus-other') await page.locator('summary').focus()
      if (intent === 'PageDown') await page.keyboard.press('PageDown')
      if (intent === 'wheel') {
        await page.evaluate(() => {
          window.fixtureWheel = false
          document.addEventListener('wheel', () => { window.fixtureWheel = true }, { once: true })
        })
        await page.mouse.move(200, 200)
        await page.mouse.wheel(0, -200)
        await expect.poll(() => page.evaluate(() => window.fixtureWheel)).toBe(true)
      }
      const moved = await page.evaluateHandle(() => document.activeElement)
      write.release()
      await expect(password).toHaveAttribute('aria-invalid', 'true')
      await expect(password).toHaveAttribute('aria-describedby', 'team-password-error')
      await expect(page.locator('#team-password-error')).toHaveText('password must contain at least 6 characters and at most 1024 bytes of valid UTF-8')
      await expect(page.getByRole('button', { name: 'Reload and discard edits', exact: true })).toHaveCount(0)
      if (intent === 'stay') { await expect(password).toBeFocused(); await expect(password).toBeInViewport() }
      else assert(await moved.evaluate(element => element === document.activeElement), 'Validation stole deliberate focus')
      await moved.dispose()
      assert.equal(model.posts[0].revision, 'r1')
      assert.deepEqual(model.posts[0].user.projects, originalGrants)
      await username.fill('alice-corrected')
      await expect(password).toHaveAttribute('aria-invalid', 'true')
      await password.fill('😀😀😀😀😀😀')
      await expect(password).not.toHaveAttribute('aria-invalid')
      await expect(page.getByRole('alert')).toHaveCount(0)
      await save.click()
      await expect(page.getByRole('status')).toContainText('User saved.')
      assert.equal(model.posts[1].revision, 'r1')
      assert.equal(model.posts[1].user.password, '😀😀😀😀😀😀')
      assert.deepEqual(model.posts[1].user.projects, originalGrants)
    }, { viewport: { width: 390, height: 844 }, hasTouch: true })
  }

  await check('username correction cannot hide a background revision conflict', async ({ page, model, settle }) => {
    model.access.users.push({ id: 'u2', username: 'bob', disabled: false, projects: [] })
    await page.evaluate(() => window.refreshHosts())
    await page.getByRole('button', { name: 'Edit alice', exact: true }).click()
    const username = page.getByRole('textbox', { name: 'Username', exact: true })
    await username.fill('bob')
    const save = page.getByRole('button', { name: 'Save user', exact: true })
    await save.focus()
    await save.press('Enter')
    await expect(username).toBeFocused()
    await expect(username).toHaveAttribute('aria-describedby', 'team-username-error')
    await page.getByLabel('Reset password', { exact: true }).fill('valid-password')
    await expect(username).toHaveAttribute('aria-invalid', 'true')
    model.access.revision = 'r2'
    await page.evaluate(() => window.refreshHosts())
    await expect(save).toBeDisabled()
    await username.fill('alice-corrected')
    await expect(page.locator('#team-username-error')).toHaveCount(0)
    await expect(page.getByRole('alert')).toContainText('Access settings changed elsewhere')
    await page.locator('form.team-user-editor').dispatchEvent('submit')
    await settle()
    await expect(save).toBeDisabled()
    assert.equal(model.posts.length, 1)
    assert.equal(model.posts[0].revision, 'r1')
    assert.deepEqual(model.access.users[0].projects, originalGrants)
  })

  await check('new-user missing/over-budget password feedback keeps server policy and optional reset payload', async ({ page, model }) => {
    await page.getByRole('button', { name: 'Add user', exact: true }).click()
    const username = page.getByRole('textbox', { name: 'Username', exact: true })
    const password = page.getByLabel('Password', { exact: true })
    await username.fill('new-user')
    await password.focus()
    await page.locator('form.team-user-editor').dispatchEvent('submit')
    await expect(password).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#team-password-error')).toHaveText('A password is required for a new user')
    await password.fill('界'.repeat(342))
    await page.getByRole('button', { name: 'Save user', exact: true }).click()
    await expect(password).toHaveAttribute('aria-invalid', 'true')
    await password.fill('界'.repeat(341))
    await page.getByRole('button', { name: 'Save user', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('User saved.')
    assert.equal(Buffer.byteLength(model.posts.at(-1).user.password), 1023)
    assert.equal(model.posts.at(-1).revision, 'r1')
    await page.getByRole('button', { name: 'Edit new-user', exact: true }).click()
    await page.getByRole('button', { name: 'Save user', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('User saved.')
    assert(!Object.hasOwn(model.posts.at(-1).user, 'password'))
    assert.equal(model.posts.at(-1).revision, 'r2')
  })

  await check('unrecognized password/service/CSRF failures keep form-level recovery on correction', async ({ page, model }) => {
    await page.getByRole('button', { name: 'Edit alice', exact: true }).click()
    const password = page.getByLabel('Reset password', { exact: true })
    for (const failure of [
      { status: 400, message: 'generate password salt: secure randomness is unavailable' },
      { status: 403, message: 'Invalid CSRF token' },
      { status: 503, message: 'Could not save access settings' },
    ]) {
      model.writeFailure = failure
      await password.fill('valid-password')
      await page.getByRole('button', { name: 'Save user', exact: true }).click()
      await expect(page.locator('.team-user-error')).toContainText(failure.message)
      await expect(password).not.toHaveAttribute('aria-invalid')
      await password.fill('corrected-password')
      await expect(page.locator('.team-user-error')).toContainText(failure.message)
      await expect(page.getByRole('button', { name: 'Reload and discard edits', exact: true })).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Save user', exact: true })).toBeEnabled()
    }
    assert(model.posts.every(post => post.revision === 'r1'))
    assert.deepEqual(model.access.users[0].projects, originalGrants)
  })

  for (const width of [1280, 390]) {
    for (const intent of ['stay', 'focus-other', 'pointer-text', 'Tab', 'wheel', 'PageUp', 'layout-scroll', 'disabled-actions']) {
      await check(`${width}px: held account save focus with ${intent}`, async ({ page, model, hold }) => {
        model.access.users.push(...Array.from({ length: 15 }, (_, index) => ({
          id: `user-${index + 1}`, username: `user-${String(index + 1).padStart(2, '0')}`, disabled: false, projects: clone(originalGrants),
        })))
        await page.evaluate(() => window.refreshHosts())
        const edit = page.getByRole('button', { name: 'Edit user-15', exact: true })
        await expect(edit).toBeVisible()
        await edit.focus()
        await edit.press('Enter')
        const form = page.locator('form.team-user-editor')
        await form.getByRole('textbox', { name: 'Username', exact: true }).fill('user-15-saved')
        const save = form.locator('button[type=submit]')
        const write = hold('write')
        await save.focus()
        await save.press('Enter')
        await write.started
        await expect(save).toBeDisabled()
        await expect.poll(() => page.evaluate(() => document.activeElement.tagName)).toBe('BODY')
        if (intent === 'focus-other') await page.locator('summary').focus()
        if (intent === 'pointer-text') await page.getByRole('heading', { name: 'Users & project access', exact: true }).click()
        if (intent === 'Tab' || intent === 'PageUp') await page.keyboard.press(intent)
        if (intent === 'wheel') {
          await page.evaluate(() => {
            window.fixtureWheel = false
            document.addEventListener('wheel', () => { window.fixtureWheel = true }, { once: true })
          })
          await page.mouse.move(width / 2, 250)
          await page.mouse.wheel(0, -200)
          // Wait for input delivery before allowing the held save to finish.
          await page.waitForFunction(() => window.fixtureWheel)
        }
        if (intent === 'layout-scroll') await page.evaluate(() => window.scrollBy(0, -200))
        if (intent === 'disabled-actions') await page.evaluate(() => window.enableAccess(false))
        const moved = await page.evaluateHandle(() => document.activeElement)
        write.release()
        await expect(form).toHaveCount(0)
        const saved = page.getByRole('button', { name: 'Edit user-15-saved', exact: true })
        await expect(saved).toHaveCount(1)
        assert.equal(model.posts.length, 1)
        assert.equal(model.posts[0].revision, 'r1')
        assert.deepEqual(model.posts[0].user.projects, originalGrants)
        if (intent === 'stay' || intent === 'layout-scroll') {
          await expect(saved).toBeFocused()
          await expect(saved).toBeInViewport()
          await page.keyboard.press('Tab')
          await expect(page.getByRole('button', { name: 'Delete user-15-saved', exact: true })).toBeFocused()
        } else if (intent === 'disabled-actions') {
          await expect(saved).toBeDisabled()
          await expect(page.getByRole('button', { name: 'Add user', exact: true })).toBeDisabled()
          await expect(page.getByRole('heading', { name: 'Users & project access', exact: true })).toBeFocused()
        } else assert(await moved.evaluate(element => element === document.activeElement), `${intent}: completion stole deliberate focus`)
        await moved.dispose()
      }, { viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 })
    }
    await check(`${width}px review: cancellation keeps focus local when access actions are disabled`, async ({ page, model }) => {
      for (const action of ['Edit alice', 'Delete alice', 'Add user']) {
        await page.evaluate(() => window.enableAccess(true))
        await page.getByRole('button', { name: action, exact: true }).click()
        await expect(page.locator('.team-user-editor')).toHaveCount(1)
        await page.evaluate(() => window.enableAccess(false))
        await expect(page.getByRole('button', { name: action, exact: true })).toBeDisabled()
        await expect(page.getByRole('button', { name: 'Add user', exact: true })).toBeDisabled()
        if (action === 'Edit alice') {
          await page.locator('form.team-user-editor').dispatchEvent('submit')
          await page.getByRole('button', { name: 'Cancel editing user', exact: true }).focus()
          await page.keyboard.press('Enter')
        } else await page.keyboard.press('Escape')
        await expect(page.locator('.team-user-editor')).toHaveCount(0)
        const heading = page.getByRole('heading', { name: 'Users & project access', exact: true })
        await expect(heading).toBeFocused()
        await expect(heading).toBeInViewport()
        await expect(page.getByRole('button', { name: 'Add user', exact: true })).toBeDisabled()
        await expect(page.getByRole('button', { name: 'Edit alice', exact: true })).toBeDisabled()
        assert.equal(model.posts.length, 0, 'Cancelling disabled access enabled a mutation')
      }
    }, { viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 })

    await check(`${width}px review: identical host/project/path labels distinguish SSH targets without changing grants`, async ({ page, model }) => {
      model.access.users[0].username = 'alice-targets'
      model.access.users[0].projects = [{ host: 'east', root: 'reports' }]
      await page.evaluate(() => window.replaceHosts([
        { id: 'east', label: 'Research', kind: 'ssh', target: 'synthetic-east', roots: [{ id: 'reports', label: 'Reports', path: '/synthetic/reports' }] },
        { id: 'west', label: 'Research', kind: 'ssh', target: 'synthetic-west', roots: [{ id: 'reports', label: 'Reports', path: '/synthetic/reports' }] },
        { id: 'local', label: 'Research', kind: 'local', target: '', roots: [{ id: 'reports', label: 'Reports', path: '/synthetic/reports' }] },
        { id: 'other', label: 'Research', kind: 'ssh', target: 'synthetic-other', roots: [{ id: 'reports', label: 'Reports', path: '/synthetic/other-reports' }] },
      ]))
      await page.getByRole('button', { name: 'Edit alice-targets', exact: true }).click()
      const east = page.getByRole('checkbox', { name: /Reports.*Research.*synthetic-east:\/synthetic\/reports/ })
      const west = page.getByRole('checkbox', { name: /Reports.*Research.*synthetic-west:\/synthetic\/reports/ })
      await expect(east).toBeChecked()
      await expect(west).not.toBeChecked()
      await expect(page.getByRole('checkbox', { name: /Reports.*Research.*local:\/synthetic\/reports/ })).not.toBeChecked()
      const distinctPath = page.getByRole('checkbox', { name: /Reports.*Research.*\/synthetic\/other-reports/ })
      await expect(distinctPath).toHaveAccessibleName('Reports Research /synthetic/other-reports')
      await west.check()
      await page.getByRole('button', { name: 'Save user', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('User saved.')
      assert.deepEqual(model.posts[0].user.projects, [{ host: 'east', root: 'reports' }, { host: 'west', root: 'reports' }])
      assert.equal(model.posts[0].revision, 'r1')
    }, { viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 })

    await check(`${width}px: account-local actions, distinct grants, conflicts and keyboard cancellation with 16 users`, async ({ page, model, hold }) => {
      model.access.users.push(...Array.from({ length: 15 }, (_, index) => ({
        id: `u${index + 2}`, username: `user-${String(index + 1).padStart(2, '0')}`, disabled: false, projects: [],
      })))
      await page.evaluate(() => window.replaceHosts([{ id: 'fixture', label: 'Fixture', kind: 'local', target: '', roots: [
        { id: 'revoked', label: 'Reports', path: '/synthetic/team-a/reports' },
        { id: 'new', label: 'Reports', path: '/synthetic/team-b/reports' },
      ] }]))
      await expect(page.getByRole('button', { name: 'Edit user-15', exact: true })).toBeVisible()
      const edit = page.getByRole('button', { name: 'Edit alice', exact: true })
      await edit.focus()
      await page.keyboard.press('Enter')
      const form = page.locator('form.team-user-editor')
      const username = page.getByRole('textbox', { name: 'Username', exact: true })
      await expect(username).toBeFocused()
      await expect(page.getByRole('heading', { name: 'Edit alice', exact: true })).toBeInViewport()
      const editorPosition = await form.boundingBox()
      const nextUserPosition = await page.getByRole('button', { name: 'Edit user-01', exact: true }).boundingBox()
      assert(editorPosition && nextUserPosition && editorPosition.y < nextUserPosition.y,
        'The selected account editor appeared after unrelated users')
      const original = page.getByRole('checkbox', { name: /Reports.*\/synthetic\/team-a\/reports/ })
      const additional = page.getByRole('checkbox', { name: /Reports.*\/synthetic\/team-b\/reports/ })
      await expect(original).toBeChecked()
      await expect(additional).not.toBeChecked()
      await additional.check()
      await username.fill('alice-draft')
      await page.getByLabel('Reset password', { exact: true }).fill('synthetic-password')
      model.access.revision = 'r2'
      const write = hold('write')
      await page.getByRole('button', { name: 'Save user', exact: true }).click()
      await write.started
      await page.keyboard.press('Escape')
      await expect(form).toBeVisible()
      await expect(page.getByRole('button', { name: 'Cancel editing user', exact: true })).toBeDisabled()
      write.release()
      await expect(form.getByRole('alert')).toContainText('Access settings changed elsewhere')
      await expect(form.getByRole('alert')).toBeInViewport()
      await expect(page.getByRole('alert')).toHaveCount(1)
      await expect(page.getByRole('button', { name: 'Save user', exact: true })).toBeDisabled()
      await expect(username).toHaveValue('alice-draft')
      await expect(additional).toBeChecked()
      assert.equal(model.posts[0].revision, 'r1')
      assert.deepEqual(model.posts[0].user.projects, [...originalGrants, ...newGrants])
      assert.deepEqual(model.access.users[0].projects, originalGrants, 'A rejected save changed grants')
      await page.getByRole('button', { name: 'Cancel editing user', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(form).toHaveCount(0)
      await expect(edit).toBeFocused()
      const remove = page.getByRole('button', { name: 'Delete alice', exact: true })
      await remove.focus()
      await page.keyboard.press('Enter')
      const confirmation = page.getByRole('group', { name: 'Confirm user deletion' })
      await expect(confirmation).toBeInViewport()
      const confirmationPosition = await confirmation.boundingBox()
      const nextAfterRemoval = await page.getByRole('button', { name: 'Edit user-01', exact: true }).boundingBox()
      assert(confirmationPosition && nextAfterRemoval && confirmationPosition.y < nextAfterRemoval.y,
        'The deletion confirmation appeared after unrelated users')
      await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(confirmation).toHaveCount(0)
      await expect(remove).toBeFocused()
      const add = page.getByRole('button', { name: 'Add user', exact: true })
      await add.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: 'New user', exact: true })).toBeInViewport()
      await page.keyboard.press('Escape')
      await expect(add).toBeFocused()
      assert.equal(model.posts.length, 1, 'Cancelling sent an extra request')

      // A removed account must not unmount its pending editor or rebase its revision.
      await edit.click()
      await username.fill('retained-draft')
      await page.getByLabel('Reset password', { exact: true }).fill('retained-synthetic-password')
      model.access = { ...model.access, revision: 'r3', users: model.access.users.filter(user => user.id !== 'u1') }
      const refresh = hold('read')
      await page.evaluate(() => window.refreshHosts())
      await refresh.started
      await expect(username).toHaveValue('retained-draft')
      refresh.release()
      await expect(edit).toHaveCount(0)
      await expect(username).toHaveValue('retained-draft')
      await expect(page.getByLabel('Reset password', { exact: true })).toHaveValue('retained-synthetic-password')
      await expect(form.getByRole('alert')).toContainText('changed elsewhere')
      await expect(page.getByRole('button', { name: 'Save user', exact: true })).toBeDisabled()
      await username.focus()
      await page.keyboard.press('Escape')
      await expect(form).toHaveCount(0)
      await expect(add).toBeFocused()

      // Successful deletion leaves its feedback at the removed row's position.
      await page.getByRole('button', { name: 'Delete user-15', exact: true }).click()
      const deleteUser = confirmation.getByRole('button', { name: 'Delete user', exact: true })
      await deleteUser.focus()
      await deleteUser.press('Enter')
      await expect(page.getByRole('status')).toHaveText('User deleted.')
      await expect(page.getByRole('status')).toBeFocused()
      await expect(page.getByRole('status')).toBeInViewport()
      assert.equal(model.posts.at(-1).revision, 'r3')
    }, { viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 })
  }

  await check('background reload cannot restore revoked grants from a stale edit', async ({ page, model, externalChange, settle }) => {
    await page.getByRole('button', { name: 'Edit alice', exact: true }).click()
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('alice-local')
    externalChange()
    await page.evaluate(() => window.refreshHosts())
    await expect(page.getByRole('button', { name: 'Edit alice-external', exact: true })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /Revoked project/ })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /New project/ })).not.toBeChecked()
    // Even a submitted form event must obey the conflict guard.
    await page.locator('form.team-user-editor').dispatchEvent('submit')
    await settle()
    assert.equal(model.posts.length, 0, 'Background reload silently rebased the edit and submitted stale grants')
    await expect(page.getByRole('button', { name: 'Save user', exact: true })).toBeDisabled()
    assert.deepEqual(model.access.users[0].projects, newGrants)
    await page.getByRole('button', { name: 'Reload and discard edits', exact: true }).click()
    await expect(page.locator('form.team-user-editor')).toHaveCount(0)
    await page.getByRole('button', { name: 'Edit alice-external', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /New project/ })).toBeChecked()
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('alice-local')
    await page.getByRole('button', { name: 'Save user', exact: true }).click()
    await expect(page.getByText('User saved. Project access applies immediately.')).toBeVisible()
    assert.equal(model.posts[0].revision, 'r2')
    assert(!Object.hasOwn(model.posts[0].user, 'revision'), 'Draft revision leaked into the user payload')
    assert.deepEqual(model.access.users[0].projects, newGrants)
  })

  await check('conflict pins edit revision; failed explicit reload retains form/password; successful reload discards', async ({ page, model, hold, externalChange }) => {
    await page.getByRole('button', { name: 'Edit alice', exact: true }).click()
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('alice-local')
    const password = page.getByLabel('Reset password', { exact: true })
    await password.fill('synthetic-password')
    externalChange()
    await page.getByRole('button', { name: 'Save user', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Access settings changed elsewhere')
    assert.equal(model.posts[0].revision, 'r1')
    await expect(page.getByRole('button', { name: 'Save user', exact: true })).toBeDisabled()
    const reload = page.getByRole('button', { name: 'Reload and discard edits', exact: true })
    model.failReads = true
    await reload.click()
    await expect(page.getByRole('alert')).toContainText('Synthetic access read failure')
    await expect(page.getByRole('textbox', { name: 'Username', exact: true })).toHaveValue('alice-local')
    await expect(password).toHaveValue('synthetic-password')
    await expect(page.getByRole('button', { name: 'Save user', exact: true })).toBeDisabled()
    assert.equal(model.posts.length, 1)
    model.failReads = false
    const pending = hold('read')
    await reload.click()
    await pending.started
    await expect(reload).toBeDisabled()
    await expect(page.getByRole('textbox', { name: 'Username', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Add user', exact: true })).toBeDisabled()
    pending.release()
    await expect(page.locator('form.team-user-editor')).toHaveCount(0)
    await page.getByRole('button', { name: 'Edit alice-external', exact: true }).click()
    await expect(password).toHaveValue('')
    const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
    assert(!storage.includes('synthetic-password') && !storage.includes('alice-local'))
  })

  await check('delete confirmation retains its revision through background reload and failed explicit reload', async ({ page, model, externalChange }) => {
    await page.getByRole('button', { name: 'Delete alice', exact: true }).click()
    externalChange()
    await page.evaluate(() => window.refreshHosts())
    await expect(page.getByRole('button', { name: 'Delete alice-external', exact: true })).toBeVisible()
    const confirmation = page.getByRole('group', { name: 'Confirm user deletion' })
    await expect(confirmation).toContainText('alice')
    await expect(confirmation.getByRole('button', { name: 'Delete user', exact: true })).toBeDisabled()
    assert.equal(model.posts.length, 0)
    model.failReads = true
    await page.getByRole('button', { name: 'Reload and cancel deletion', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Synthetic access read failure')
    await expect(confirmation).toBeVisible()
    await expect(confirmation.getByRole('button', { name: 'Delete user', exact: true })).toBeDisabled()
    model.failReads = false
    await page.getByRole('button', { name: 'Reload and cancel deletion', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await page.getByRole('button', { name: 'Delete alice-external', exact: true }).click()
    await confirmation.getByRole('button', { name: 'Delete user', exact: true }).click()
    await expect(page.getByText('User deleted.', { exact: true })).toBeVisible()
    assert.equal(model.posts[0].revision, 'r2')
    assert.equal(model.access.users.length, 0)
  })

  await check('server deletion conflict disables retry and honors enabled boundary', async ({ page, model, externalChange }) => {
    await page.getByRole('button', { name: 'Delete alice', exact: true }).click()
    await page.evaluate(() => window.enableAccess(false))
    const button = page.getByRole('group', { name: 'Confirm user deletion' }).getByRole('button', { name: 'Delete user', exact: true })
    await expect(button).toBeDisabled()
    await page.evaluate(() => window.enableAccess(true))
    externalChange()
    await button.click()
    await expect(page.getByRole('alert')).toContainText('Access settings changed elsewhere')
    assert.equal(model.posts[0].revision, 'r1')
    await expect(button).toBeDisabled()
    assert.equal(model.access.users.length, 1)
  })

  await check('late GET cannot replace a successful save or its revision; write blocks pending actions', async ({ page, model, hold, settle }) => {
    await page.getByRole('button', { name: 'Edit alice', exact: true }).click()
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('alice-saved')
    const staleRead = hold('read')
    await page.evaluate(() => window.refreshHosts())
    await staleRead.started
    const write = hold('write')
    await page.getByRole('button', { name: 'Save user', exact: true }).click()
    await write.started
    await expect(page.getByRole('button', { name: 'Add user', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Delete alice', exact: true })).toBeDisabled()
    write.release()
    await expect(page.getByRole('button', { name: 'Edit alice-saved', exact: true })).toBeVisible()
    staleRead.release()
    await settle()
    await expect(page.getByRole('button', { name: 'Edit alice-saved', exact: true })).toBeVisible()
    await expect(page.getByText('User saved. Project access applies immediately.')).toBeVisible()
    await page.getByRole('button', { name: 'Edit alice-saved', exact: true }).click()
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('alice-next')
    const secondWrite = hold('write')
    await page.getByRole('button', { name: 'Save user', exact: true }).click()
    await secondWrite.started
    const readsDuringWrite = model.reads
    await page.evaluate(() => window.refreshHosts())
    await settle()
    assert.equal(model.reads, readsDuringWrite, 'Background GET started during a save')
    secondWrite.release()
    await expect(page.getByRole('button', { name: 'Edit alice-next', exact: true })).toBeVisible()
    assert.equal(model.posts[1].revision, 'r2')
  })
} finally {
  await browser.close()
}
assert.equal(failures.length, 0, `${failures.length} Access settings regression(s) failed: ${failures.map(failure => failure.name).join('; ')}`)
