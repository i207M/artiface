import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, expect } = require('@playwright/test')
const artifacts = await mkdtemp(join(tmpdir(), 'artiface-login-'))
const origin = 'http://login-fixture.invalid'
const entry = join(repository, 'web/src/__login_fixture__.tsx')
const logo = await readFile(join(repository, 'web/public/favicon.svg'), 'utf8')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'isolated-login-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css')) return '\0fixture-css'
      if (id.includes('.svg?')) return '\0fixture-logo'
    },
    load(id) {
      if (id === '\0fixture-css') return ''
      if (id === '\0fixture-logo') return `export default ${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(logo)}`)}`
      if (id === entry) return `
        import {StrictMode} from 'react'
        import {createRoot} from 'react-dom/client'
        import Login from './components/Login'
        import './preferences'
        const mode = new URL(location.href).searchParams.get('mode') === 'personal' ? 'personal' : 'team'
        createRoot(document.getElementById('root')).render(
          <StrictMode><Login mode={mode} onSuccess={session => { window.fixtureSuccess = session }}/></StrictMode>
        )
      `
    },
  }],
})
const { output } = await bundle.generate({ format: 'iife', codeSplitting: false })
await bundle.close()
const script = output.find(item => item.type === 'chunk').code
const css = (await readFile(join(repository, 'web/src/styles.css'), 'utf8')).replace(/@import[^;]+;/g, '')
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>`
const browser = await chromium.launch({ headless: true })
const errors = []
const observations = []
try {
  for (const width of [1280, 390]) for (const mode of ['personal', 'team', 'admin']) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, serviceWorkers: 'block' })
    context.setDefaultTimeout(7000)
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
    await context.addInitScript(origin => {
      if (location.origin !== origin) return
      // Count attempts when fetch starts, independently of held network responses.
      const fetch = window.fetch.bind(window)
      window.fixtureAttempts = []
      window.fetch = (url, options) => {
        const path = new URL(String(url), location.href).pathname
        if (/^\/api\/(?:admin\/)?login$/.test(path)) {
          window.fixtureAttempts.push({ path, method: options.method, body: JSON.parse(options.body) })
        }
        return fetch(url, options)
      }
    }, origin)
    const page = await context.newPage()
    let pending = null
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      if (url.pathname === '/' || url.pathname === '/admin/') return route.fulfill({ contentType: 'text/html', body: html })
      if (/^\/api\/(?:admin\/)?login$/.test(url.pathname)) {
        const result = await new Promise(resolve => { pending = resolve })
        pending = null
        return route.fulfill(result)
      }
      return route.fulfill({ status: 404, json: { error: 'Unknown fixture route' } })
    })
    await page.goto(`${origin}${mode === 'admin' ? '/admin/' : '/'}?mode=${mode}`)
    const password = page.getByLabel(mode === 'admin' ? 'Admin password' : mode === 'team' ? 'Password' : 'Workspace password', { exact: true })
    const submit = page.locator('.login-submit')
    const form = page.locator('.login-card form')
    const brand = page.getByRole('link', { name: 'Artiface home', exact: true })
    const attempts = () => page.evaluate(() => window.fixtureAttempts)
    const reply = async (status, json) => {
      await expect.poll(() => pending !== null).toBe(true)
      await expect(form).toHaveAttribute('aria-busy', 'true')
      pending({ status, json })
      await expect(form).toHaveAttribute('aria-busy', 'false')
    }
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(mode === 'admin' ? 'Administration' : 'Sign in')
    await expect(brand).toHaveAttribute('href', '/#kind=overview')
    await expect(password).toHaveAttribute('name', 'password')
    await expect(password).toHaveAttribute('autocomplete', 'current-password')
    if (mode === 'team') {
      const username = page.getByLabel('Username', { exact: true })
      await expect(username).toBeFocused()
      await expect(username).toHaveAttribute('autocomplete', 'username')
      await expect(username).toHaveAttribute('autocapitalize', 'none')
      await username.fill('synthetic-user')
    } else {
      await expect(password).toBeFocused()
      await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0)
    }
    await password.fill('synthetic-password')
    await password.evaluate(input => input.setSelectionRange(3, 8, 'forward'))
    await page.getByRole('button', { name: 'Show password', exact: true }).click()
    await expect(password).toBeFocused()
    await expect(password).toHaveAttribute('type', 'text')
    assert.deepEqual(await password.evaluate(input => [input.selectionStart, input.selectionEnd]), [3, 8])
    await page.getByRole('button', { name: 'Hide password', exact: true }).click()
    await expect(password).toBeFocused()
    await expect(password).toHaveAttribute('type', 'password')
    assert.deepEqual(await password.evaluate(input => [input.selectionStart, input.selectionEnd]), [3, 8])
    await password.press('Tab')
    const reveal = page.getByRole('button', { name: 'Show password', exact: true })
    await expect(reveal).toBeFocused()
    const keyboardSelection = await password.evaluate(input => [input.selectionStart, input.selectionEnd, input.selectionDirection])
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Hide password', exact: true })).toBeFocused()
    assert.deepEqual(await password.evaluate(input => [input.selectionStart, input.selectionEnd, input.selectionDirection]), keyboardSelection)
    await page.keyboard.press('Space')
    assert.deepEqual(await password.evaluate(input => [input.selectionStart, input.selectionEnd, input.selectionDirection]), keyboardSelection)
    await password.focus()
    await password.press('Enter')
    await expect.poll(() => pending !== null).toBe(true)
    await expect(form).toHaveAttribute('aria-busy', 'true')
    await expect(password).toBeFocused()
    await password.press('Enter')
    await submit.evaluate(button => button.form.requestSubmit())
    assert.equal((await attempts()).length, 1, 'Pending sign-in started a duplicate request')
    assert.deepEqual((await attempts())[0], {
      path: mode === 'admin' ? '/api/admin/login' : '/api/login', method: 'POST',
      body: { password: 'synthetic-password', ...(mode === 'team' ? { username: 'synthetic-user' } : {}) },
    })
    await reply(401, { error: 'Incorrect credentials' })
    await expect(page.getByRole('alert')).toHaveText('Incorrect credentials')
    await expect(password).toBeFocused()
    await expect(password).toHaveValue('synthetic-password')
    await expect(password).toHaveAttribute('aria-invalid', 'true')
    await password.fill('synthetic-retry')
    await expect(page.getByRole('alert')).toHaveCount(0)
    assert.equal(await password.getAttribute('aria-invalid'), null)
    await submit.click()
    await expect.poll(() => pending !== null).toBe(true)
    assert(await form.evaluate(element => element.contains(document.activeElement)), 'Pointer submission lost credential-form focus')
    await reply(503, { error: 'Synthetic service unavailable' })
    await expect(page.getByRole('alert')).toHaveText('Synthetic service unavailable')
    await expect(password).toBeFocused()
    assert.equal(await password.getAttribute('aria-invalid'), null, 'Service errors incorrectly mark credentials invalid')
    if (mode === 'team') assert.equal(await page.getByLabel('Username', { exact: true }).getAttribute('aria-invalid'), null)

    // A late error must not pull focus away from a deliberate move outside the form.
    await password.press('Enter')
    await expect.poll(() => pending !== null).toBe(true)
    await brand.focus()
    await reply(503, { error: 'Synthetic service still unavailable' })
    await expect(brand).toBeFocused()
    if (width === 390) {
      await page.setViewportSize({ width, height: 550 })
      await page.evaluate(() => scrollTo(0, 0))
      const box = await submit.boundingBox()
      assert(box && box.y >= 0 && box.y + box.height <= 550, 'Short-screen sign-in hides the submit button below introductory content')
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Sign-in overflows horizontally')
    await page.screenshot({ path: join(artifacts, `${mode}-${width}-retry.png`), animations: 'disabled' })
    const session = { authenticated: true, mode: mode === 'personal' ? 'personal' : 'team', csrfToken: 'synthetic-token' }
    await password.fill('synthetic-success')
    await password.press('Enter')
    await reply(200, session)
    await expect.poll(() => page.evaluate(() => window.fixtureSuccess)).toEqual(session)
    await expect(password).toHaveValue('')
    observations.push({ mode, width, attempts: (await attempts()).length })
    if (mode === 'admin') {
      await brand.click()
      await expect.poll(() => new URL(page.url()).pathname).toBe('/')
    }
    await context.close()
    console.log(`PASS ${mode}/${width}: reveal caret, keyboard access, retry focus, single-flight submission, error scope, and unchanged authentication payload`)
  }
  assert.deepEqual(errors, [])
} finally {
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ observations, errors }, null, 2) + '\n')
  await browser.close()
  console.log(`Sign-in artifacts: ${artifacts}`)
}
