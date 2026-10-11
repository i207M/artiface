import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { expect } = require('@playwright/test')
const timeout = 15_000
const fixture = { host: 'smoke', root: 'artifacts', path: 'reports/index.html' }
const frameID = 'artiface-preview-security-check'

function directives(policy) {
  return new Map(policy.split(';').filter(part => part.trim()).map(part => {
    const [name, ...values] = part.trim().split(/\s+/)
    return [name, values]
  }))
}

/**
 * Check project-authoritative scripts, same-port routing, and capability boundaries.
 * Uses a separate session and restores the fixture project's trust before returning.
 * Requires reports/index.html with #answer="loading", empty #cookies/#api, and its script.js fixture.
 * Resolves on success and throws an assertion on failure.
 */
export async function checkPreviewScriptBoundary({ page, origin, password }) {
  origin = new URL(origin).origin
  assert(password, 'A smoke-test password is required')
  const browser = page.context().browser()
  assert(browser, 'The supplied page must belong to a Playwright browser')
  const context = await browser.newContext()
  context.setDefaultTimeout(timeout)
  context.setDefaultNavigationTimeout(timeout)
  const probe = await context.newPage()
  const headers = { Origin: origin }
  let csrf
  let originalTrust
  let trustRead = false

  const post = (endpoint, data, token) => context.request.post(origin + endpoint, {
    data,
    headers: { ...headers, ...(token ? { 'X-CSRF-Token': token } : {}) },
    timeout,
  })

  async function setTrust(value) {
    const settings = await context.request.get(origin + '/api/settings')
    assert.equal(settings.status(), 200)
    const { config, revision } = await settings.json()
    const project = config.hosts.find(host => host.id === fixture.host).roots.find(root => root.id === fixture.root)
    if (!trustRead) { originalTrust = project.trustedScripts; trustRead = true }
    if (value === undefined) delete project.trustedScripts
    else project.trustedScripts = value
    const response = await post('/api/settings', { config, revision }, csrf)
    assert.equal(response.status(), 200, 'Saving project script trust failed')
  }

  async function capability({ expected = false, path = fixture.path } = {}) {
    const body = { ...fixture, path }
    const response = await post('/api/preview', body, csrf)
    assert.equal(response.status(), 200, 'Preview capability creation failed')
    const result = await response.json()
    const url = new URL(result.url)
    assert.equal(url.protocol, 'http:')
    assert.equal(url.port, new URL(origin).port, 'HTML requires a second forwarded port')
    assert.equal(url.origin, origin, 'Preview must use the app URL origin')
    assert(url.pathname.startsWith('/p/'), 'Expected a preview capability URL')
    assert.equal(result.scripts, expected, 'Preview returned client-controlled script permission')
    assert.equal(result.path, path === 'alias-report.html' ? 'reports/index.html' : path,
      'HTML alias did not use its canonical file path')
    return url.href
  }

  async function render(url, sandbox, scriptsAllowed, executes) {
    const responsePending = probe.waitForResponse(response => response.url() === url, { timeout })
    const attach = probe.evaluate(({ url, sandbox, frameID }) => {
      document.getElementById(frameID)?.remove()
      const iframe = document.createElement('iframe')
      iframe.id = frameID
      iframe.setAttribute('sandbox', sandbox)
      iframe.referrerPolicy = 'no-referrer'
      iframe.addEventListener('load', () => { iframe.dataset.loaded = 'true' }, { once: true })
      iframe.src = url
      document.body.append(iframe)
    }, { url, sandbox, frameID })
    const [response] = await Promise.all([responsePending, attach])
    assert.equal(response.status(), 200, 'Preview document failed to load')
    const policy = directives(response.headers()['content-security-policy'] ?? '')
    assert.deepEqual(policy.get('sandbox'), ['allow-scripts'],
      'The navigation bridge needs script execution, while the sandbox must keep an opaque origin')
    if (scriptsAllowed) {
      assert(policy.get('script-src')?.includes("'unsafe-inline'"),
        'Project trust must permit report scripts')
      assert(policy.get('script-src')?.includes(new URL(url).origin + '/p/'),
        'Project trust must permit local script assets')
    } else {
      assert.equal(policy.get('script-src')?.length, 1)
      assert.match(policy.get('script-src')[0], /^'nonce-[A-Za-z0-9_+/=-]+'$/,
        'Only the injected navigation bridge may execute without project trust')
    }
    await expect(probe.locator(`#${frameID}`)).toHaveAttribute('data-loaded', 'true')
    const frame = probe.frameLocator(`#${frameID}`)
    await expect(frame.locator('#answer')).toHaveText(executes ? '42' : 'loading')
    // This marker is set synchronously by script.js, before iframe load.
    // Its absence catches unwanted execution even if the asynchronous fetch is slow.
    await expect(frame.locator('#cookies')).toHaveText(executes ? 'isolated' : '')
    await expect(frame.locator('#api')).toHaveText(executes ? 'blocked' : '')
    const isolation = await frame.locator('body').evaluate(() => {
      let parentAccess = false, storageAccess = false
      try { void parent.document.body; parentAccess = true } catch {}
      try { void localStorage.length; storageAccess = true } catch {}
      return { origin: window.origin, parentAccess, storageAccess }
    })
    assert.deepEqual(isolation, { origin: 'null', parentAccess: false, storageAccess: false },
      'A shared URL must still give reports an opaque sandbox origin')
    await expect(frame.locator('body')).toHaveCSS('color', 'rgb(19, 78, 74)')
    await expect.poll(() => frame.locator('img').evaluate(
      image => image.complete && image.naturalWidth > 0,
    ), { timeout }).toBe(true)
  }

  try {
    const anonymous = await post('/api/preview', fixture)
    assert.equal(anonymous.status(), 401, 'Preview creation must require a session')
    const login = await post('/api/login', { password })
    assert.equal(login.status(), 200, 'Security probe login failed')
    csrf = (await login.json()).csrfToken
    assert(csrf, 'Login did not return a CSRF token')
    const withoutCSRF = await post('/api/preview', fixture)
    assert.equal(withoutCSRF.status(), 403, 'Preview creation must require CSRF protection')
    assert.equal((await post('/api/preview', { ...fixture, scripts: true }, csrf)).status(), 400,
      'Unknown per-file preview options were accepted')

    await probe.goto(origin + '/', { waitUntil: 'load' })
    const previewOrigin = origin
    const health = await context.request.head(previewOrigin + '/p/healthz', { headers })
    assert.equal(health.status(), 204)
    assert.equal(health.headers()['access-control-allow-origin'], origin)
    assert.equal(health.headers()['cache-control'], 'no-store')
    assert.equal(await probe.evaluate(async url => (await fetch(url, {
      method: 'HEAD', mode: 'cors', credentials: 'omit', cache: 'no-store',
    })).status, previewOrigin + '/p/healthz'), 204, 'Browser could not reach the preview through the app port')
    await setTrust(false)
    const defaultURL = await capability()
    await render(defaultURL, '', false, false)
    await render(await capability(), 'allow-scripts', false, false)

    // Client flags, a permissive iframe, and URL parameters cannot grant trust.
    const attemptedUpgrade = new URL(defaultURL)
    attemptedUpgrade.searchParams.set('scripts', 'true')
    await render(attemptedUpgrade.href, 'allow-scripts', false, false)
    const aliasURL = await capability({ path: 'alias-report.html' })
    await render(aliasURL, '', false, false)
    const aliasAsset = await context.request.get(new URL('assets/data-alias.json', aliasURL).href)
    assert.equal(aliasAsset.status(), 200, 'Contained relative asset symlink was rejected')
    assert.equal((await aliasAsset.json()).answer, 42)
    for (const path of ['escape', 'project-escape', 'assets/project-escape.json']) {
      assert.equal((await context.request.get(new URL(path, aliasURL).href)).status(), 403,
        `HTML capability escaped its canonical preview folder through ${path}`)
    }

    await setTrust(true)
    assert.equal((await context.request.get(defaultURL)).status(), 401, 'Project trust change did not revoke old capabilities')
    const activeURL = await capability({ expected: true })
    // A restrictive iframe remains an additional boundary for a trusted project.
    await render(activeURL, '', true, false)
    await render(activeURL, 'allow-scripts', true, true)
    await render(await capability({ expected: true, path: 'reports/second.html' }), 'allow-scripts', true, true)

    const scriptURL = new URL('assets/app-probe.js', activeURL)
    for (const source of [scriptURL.href, origin + '/assets/%2f..' + scriptURL.pathname]) {
      const result = await probe.evaluate(src => new Promise(resolve => {
        window.artifacePreviewExecutedInApp = false
        const script = document.createElement('script')
        const finish = event => {
          script.remove()
          resolve({ event, executed: window.artifacePreviewExecutedInApp })
        }
        script.onload = () => finish('load')
        script.onerror = () => finish('error')
        script.src = src
        document.body.append(script)
      }), source)
      assert.deepEqual(result, { event: 'error', executed: false },
        'A preview asset was executable as application code')
    }

    await setTrust(false)
    assert.equal((await context.request.get(activeURL)).status(), 401, 'Disabling project trust did not revoke active capabilities')
    await render(await capability(), 'allow-scripts', false, false)
    console.log('PASS: shared-origin previews retain opaque sandboxing, app script/worker separation, project-authoritative trust, canonical HTML aliases/assets, capability containment and revocation')
  } finally {
    try {
      if (csrf) {
        if (trustRead) await setTrust(originalTrust).catch(() => {})
        await context.request.post(origin + '/api/logout', {
          headers: { ...headers, 'X-CSRF-Token': csrf },
          timeout: 5_000,
        }).catch(() => {})
      }
    } finally {
      await context.close()
    }
  }
}
