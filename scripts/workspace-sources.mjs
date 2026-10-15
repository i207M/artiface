import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const web = fileURLToPath(new URL('../web', import.meta.url))
const origin = 'https://workspace-sources.invalid'
const project = { host: 'fixture', root: 'reports' }
const catalog = {
  revision: 'catalog-1', setupEnabled: false,
  hosts: [{ id: project.host, kind: 'ssh', target: 'fixture-a', label: 'Fixture host',
    roots: [{ id: project.root, label: 'Fixture project', path: '/synthetic/a', trustedScripts: false }] }],
}
const row = name => ({ name, path: name, type: 'file', size: 40, modified: '2026-09-21T12:00:00Z' })

// The real Workspace and session hooks run against controlled, synthetic responses.
// Only the reader is replaced so its DOM/state can detect unintended unmounts.
async function buildWorkspace() {
  const bundle = await rolldown({
    cwd: web, input: 'fixture:workspace-sources', platform: 'browser',
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
    onLog(level, log, next) { if (log.code !== 'MODULE_LEVEL_DIRECTIVE') next(level, log) },
    plugins: [{
      name: 'workspace-sources-fixture',
      resolveId(id) {
        if (id === 'fixture:workspace-sources') return '\0fixture'
        if (id === './FilePreview' || id === './GitPDFPreview') return '\0reader'
        if (id.endsWith('.css')) return '\0css'
        if (id.includes('.svg?')) return '\0logo'
      },
      load(id) {
        if (id === '\0css') return ''
        if (id === '\0logo') return `export default ${JSON.stringify('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>'))}`
        if (id === '\0reader') return `
          import React, {useState} from 'react'
          export default function Reader() {
            const [value, setValue] = useState('')
            return React.createElement('div', {'data-fixture-reader': true, style: {height: 180, overflow: 'auto'}},
              React.createElement('input', {'aria-label': 'Reader state', value, onChange: event => setValue(event.target.value)}),
              React.createElement('div', {style: {height: 1800}}, 'Synthetic selectable content'))
          }`
        if (id === '\0fixture') return `
          import React from 'react'
          import {createRoot} from 'react-dom/client'
          import Workspace from ${JSON.stringify(`${web}/src/components/Workspace.tsx`)}
          import {useLocation} from ${JSON.stringify(`${web}/src/location.ts`)}
          function Fixture() {
            const [location, navigate] = useLocation()
            const [userID] = React.useState(() => new URL(window.location.href).searchParams.get('user') || undefined)
            window.navigateFixture = navigate
            return React.createElement(Workspace, {location, navigate, userID, onLogout() {}})
          }
          createRoot(document.getElementById('root')).render(React.createElement(Fixture))
        `
      },
    }],
  })
  try {
    const { output } = await bundle.generate({ format: 'iife', codeSplitting: false })
    return output.find(item => item.type === 'chunk').code
  } finally { await bundle.close() }
}

export async function checkWorkspaceSources({ browser }) {
  const code = await buildWorkspace()
  const css = (await Promise.all(['styles.css', 'viewers.css', 'components/workspace.css']
    .map(path => readFile(`${web}/src/${path}`, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
  context.setDefaultTimeout(5000)
  const errors = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  const settle = page => page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const requests = (page, kind) => page.evaluate(kind => window.fixtureRequests[kind].map(request =>
    ({ id: request.id, aborted: request.signal.aborted, done: request.done })), kind)
  const answer = async (page, kind, id, body, status = 200) => {
    await page.evaluate(({ kind, id, body, status }) => {
      const request = window.fixtureRequests[kind][id]
      if (request.done) throw new Error('Request already answered')
      request.done = true
      // Deliberately ignore cancellation here: guards must reject a late response too.
      if (status === 'network') {
        request.consumed = true
        request.reject(new TypeError('Synthetic network failure'))
      } else {
        const response = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
        const json = response.json.bind(response)
        response.json = async () => {
          try { return await json() } finally { request.consumed = true }
        }
        request.resolve(response)
      }
    }, { kind, id, body, status })
    await expect.poll(() => page.evaluate(({ kind, id }) => {
      const request = window.fixtureRequests[kind][id]
      // The API rejects an aborted response before reading its body.
      return request.signal.aborted || request.consumed
    }, { kind, id })).toBe(true)
    await settle(page)
  }
  const nextRequest = async (page, kind, action) => {
    const before = (await requests(page, kind)).length
    await action()
    await expect.poll(async () => (await requests(page, kind)).length).toBe(before + 1)
    return before
  }
  const last = async (page, kind) => (await requests(page, kind)).at(-1).id
  const bump = async page => {
    const before = (await requests(page, 'hosts')).length
    await page.evaluate(() => {
      window.shared.sourcesRevision += '-next'
      window.dispatchEvent(new Event('focus'))
    })
    await expect.poll(async () => (await requests(page, 'hosts')).length).toBe(before + 1)
    return before
  }
  const start = async (kind = 'file', initial = true) => {
    const page = await context.newPage()
    await page.goto(`${origin}/#host=fixture&root=reports&path=${kind === 'file' ? 'notes.md' : ''}&kind=${kind}`)
    await page.addScriptTag({ content: code })
    await expect.poll(async () => (await requests(page, 'hosts')).length).toBe(1)
    if (initial) {
      await answer(page, 'hosts', 0, catalog)
      await expect.poll(async () => (await requests(page, 'hosts')).length).toBe(2)
      await answer(page, 'hosts', 1, catalog)
      if (kind === 'file') await expect(page.locator('[data-fixture-reader]')).toBeVisible()
      else {
        await answer(page, 'list', await last(page, 'list'), { entries: [row('source-a.md')] })
        await expect(page.locator('[data-browse-entry="source-a.md"]')).toBeVisible()
      }
    }
    return page
  }
  await context.route('**/*', route => route.request().url().startsWith(`${origin}/`)
    ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>${css}</style><div id="root"></div>` })
    : route.abort())
  await context.addInitScript(({ project, origin }) => {
    // Context init scripts also run on the opaque initial about:blank document.
    if (location.origin !== origin) return
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300, gitStatus: false }))
    sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({
      projects: [{ ...project, directory: '', activePath: 'notes.md', expanded: true }],
      tabs: [{ ...project, path: 'notes.md', autoRefreshPaused: true }],
    }))
    window.shared = { projects: [project], sourcesRevision: 'sync-1' }
    window.fixtureRequests = { hosts: [], list: [] }
    const nativeSetTimeout = window.setTimeout
    window.setTimeout = (callback, delay, ...args) =>
      // No wall-clock polling: focus and visibility events drive the real hooks.
      nativeSetTimeout(callback, delay === 5000 || delay === 300000 ? 3600000 : delay, ...args)
    window.fetch = (url, { signal, body } = {}) => {
      const pathname = new URL(url, location.href).pathname
      if (pathname === '/api/workspace/projects') {
        if (body) {
          const changes = JSON.parse(body), key = project => JSON.stringify([project.host, project.root])
          const opened = new Map(window.shared.projects.map(project => [key(project), project]))
          for (const project of changes.close) opened.delete(key(project))
          for (const project of changes.open) opened.set(key(project), project)
          window.shared.projects = [...opened.values()]
        }
        return Promise.resolve(new Response(JSON.stringify(window.shared)))
      }
      if (pathname === '/api/file-info') return Promise.resolve(new Response(JSON.stringify({ modified: '2026-09-21T12:00:00Z', size: 40 })))
      const kind = pathname === '/api/hosts' ? 'hosts' : pathname === '/api/list' ? 'list' : null
      if (!kind) throw new Error(`Unexpected synthetic request: ${url}`)
      const queue = window.fixtureRequests[kind]
      return new Promise((resolve, reject) => queue.push({ id: queue.length, signal, resolve, reject, done: false }))
    }
  }, { project, origin })
  try {
    const page = await start('directory')
    let current = structuredClone(catalog)
    // Each field matters even if IDs, URLs, and all other source fields stay stable.
    for (const [field, change] of [
      ['root path', value => { value.hosts[0].roots[0].path = '/synthetic/b' }],
      ['SSH target', value => { value.hosts[0].target = 'fixture-b' }],
      ['source kind', value => { value.hosts[0].kind = 'local' }],
      ['access revision', value => { value.revision = 'catalog-access-2' }],
      ['HTML trust', value => { value.hosts[0].roots[0].trustedScripts = true }],
    ]) {
      const oldList = await nextRequest(page, 'list', () => page.getByRole('button', { name: 'Refresh files', exact: true }).click())
      const hostRequest = await bump(page)
      await expect.poll(async () => (await requests(page, 'list')).length).toBe(oldList + 2)
      assert((await requests(page, 'list'))[oldList].aborted, `${field}: old listing was not aborted on revision change`)
      await expect(page.locator('[data-browse-entry]')).toHaveCount(0)
      const beforeCatalog = await last(page, 'list')
      change(current)
      const newList = await nextRequest(page, 'list', () => answer(page, 'hosts', hostRequest, current))
      assert(newList > beforeCatalog, `${field}: source identity did not restart the listing`)
      assert((await requests(page, 'list'))[beforeCatalog].aborted)
      await answer(page, 'list', newList, { entries: [row('current-source.md')] })
      await answer(page, 'list', oldList, { entries: [row('stale-source.md')] })
      await answer(page, 'list', beforeCatalog, { error: 'Late old source error' }, 503)
      await expect(page.locator('[data-browse-entry="current-source.md"]')).toBeVisible()
      await expect(page.locator('[data-browse-entry="stale-source.md"]')).toHaveCount(0)
      await expect(page.getByText('Late old source error', { exact: false })).toHaveCount(0)
    }
    // Hidden tabs invalidate immediately, but defer the replacement read until visible.
    const hiddenOld = await nextRequest(page, 'list', () => page.getByRole('button', { name: 'Refresh files', exact: true }).click())
    const pendingHost = await bump(page)
    await expect.poll(async () => (await requests(page, 'list')).length).toBe(hiddenOld + 2)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const hiddenCount = (await requests(page, 'list')).length
    current.hosts[0].roots[0].path = '/synthetic/hidden-change'
    await answer(page, 'hosts', pendingHost, current)
    await answer(page, 'list', hiddenOld, { entries: [row('hidden-old.md')] })
    assert.equal((await requests(page, 'list')).length, hiddenCount)
    await expect(page.locator('[data-browse-entry]')).toHaveCount(0)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect.poll(async () => (await requests(page, 'list')).length).toBe(hiddenCount + 1)
    await answer(page, 'list', await last(page, 'list'), { entries: [row('visible-new.md')] })
    await expect(page.locator('[data-browse-entry="visible-new.md"]')).toBeVisible()
    console.log('PASS: stable-ID source/access changes abort old listings, reject late success/errors, and defer hidden-tab reads')

    // Folder polling retains rows only on transient failure, not denied/deleted paths.
    for (const status of [503, 'network', 403, 401, 404]) {
      const folder = await start('directory')
      const pending = await nextRequest(folder, 'list', () => folder.getByRole('button', { name: 'Refresh files', exact: true }).click())
      await answer(folder, 'list', pending, { error: 'Synthetic folder failure' }, status)
      await expect(folder.locator('[data-browse-entry="source-a.md"]')).toHaveCount(status === 503 || status === 'network' ? 1 : 0)
      if (status === 403 || status === 404) {
        await expect(folder.getByRole('heading', { name: 'Couldn’t browse this folder' })).toBeVisible()
        await folder.getByRole('button', { name: 'Try again', exact: true }).click()
        await expect(folder.locator('[data-browse-entry]')).toHaveCount(0)
      }
      await folder.close()
    }
    console.log('PASS: listing network/5xx keeps rows; 401/403/404 removes stale rows, including during retry')

    const reader = await start()
    await reader.getByRole('textbox', { name: 'Reader state' }).fill('keep this reading state')
    await reader.evaluate(() => {
      window.originalReader = document.querySelector('[data-fixture-reader]')
      window.originalReader.scrollTop = 420
      const range = document.createRange()
      range.selectNodeContents(window.originalReader.lastChild)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
    })
    const assertReader = async () => {
      assert.deepEqual(await reader.evaluate(() => ({
        same: document.querySelector('[data-fixture-reader]') === window.originalReader,
        scroll: window.originalReader.scrollTop, selection: getSelection().toString(),
      })), { same: true, scroll: 420, selection: 'Synthetic selectable content' })
      await expect(reader.getByRole('textbox', { name: 'Reader state' })).toHaveValue('keep this reading state')
    }
    for (const status of [503, 'network']) {
      await answer(reader, 'hosts', await bump(reader), { error: 'Synthetic catalog failure' }, status)
      await expect(reader.getByRole('button', { name: 'Retry loading projects' })).toBeVisible()
      await assertReader()
      const retry = await nextRequest(reader, 'hosts', () => reader.getByRole('button', { name: 'Retry loading projects' }).click())
      await assertReader()
      await answer(reader, 'hosts', retry, catalog)
      await expect(reader.getByRole('button', { name: 'Retry loading projects' })).toHaveCount(0)
      await assertReader()
    }
    // A superseded catalog request cannot turn a successful retry into an error.
    const superseded = await bump(reader)
    const replacement = await bump(reader)
    assert((await requests(reader, 'hosts'))[superseded].aborted)
    await answer(reader, 'hosts', replacement, catalog)
    await answer(reader, 'hosts', superseded, { error: 'Late catalog denial' }, 403)
    await assertReader()
    await expect(reader.getByRole('alert')).toHaveCount(0)
    console.log('PASS: transient catalog failures/retry preserve reader DOM, state, selection and scroll; late catalog failures are ignored')

    const initial = await start('file', false)
    await answer(initial, 'hosts', 0, { error: 'Initial service failure' }, 503)
    await expect(initial.getByRole('heading', { name: 'Couldn’t load projects' })).toBeVisible()
    await expect(initial.locator('[data-fixture-reader]')).toHaveCount(0)
    const initialRetry = await nextRequest(initial, 'hosts', () => initial.getByRole('button', { name: 'Try again', exact: true }).click())
    await expect(initial.locator('[data-fixture-reader]')).toHaveCount(0)
    await answer(initial, 'hosts', initialRetry, catalog)
    await expect(initial.locator('[data-fixture-reader]')).toBeVisible()
    for (const status of [401, 403]) {
      const denied = await start()
      await answer(denied, 'hosts', await bump(denied), { error: 'Access denied' }, status)
      await expect(denied.getByRole('heading', { name: 'Couldn’t load projects' })).toBeVisible()
      await expect(denied.locator('[data-fixture-reader]')).toHaveCount(0)
      const deniedRetry = await nextRequest(denied, 'hosts', () => denied.getByRole('button', { name: 'Try again', exact: true }).click())
      await expect(denied.locator('[data-fixture-reader]')).toHaveCount(0)
      await answer(denied, 'hosts', deniedRetry, { error: 'Still offline' }, 503)
      await expect(denied.locator('[data-fixture-reader]')).toHaveCount(0)
      await denied.close()
    }
    for (const kind of ['file', 'directory']) {
      const removed = await start(kind)
      let oldList
      if (kind === 'directory') {
        oldList = await nextRequest(removed, 'list', () => removed.getByRole('button', { name: 'Refresh files', exact: true }).click())
      }
      await answer(removed, 'hosts', await bump(removed), { ...catalog, revision: 'removed', hosts: [] })
      if (oldList !== undefined) {
        assert((await requests(removed, 'list'))[oldList].aborted)
        await answer(removed, 'list', oldList, { entries: [row('removed-source.md')] })
      }
      await expect(removed.locator('[data-fixture-reader], [data-browse-entry]')).toHaveCount(0)
      await expect(removed.getByRole('button', { name: 'Open notes.md', exact: true })).toHaveCount(0)
      await removed.close()
    }
    console.log('PASS: initial catalog failures, 401/403, and confirmed removal fail closed without retry resurrection')

    const reopen = async (user, sources = catalog) => {
      const page = await context.newPage()
      await page.goto(`${origin}/?user=${user}#kind=overview`)
      await page.evaluate(() => sessionStorage.clear())
      await page.addScriptTag({ content: code })
      await expect.poll(async () => (await requests(page, 'hosts')).length).toBe(1)
      await answer(page, 'hosts', 0, sources)
      await expect.poll(async () => (await requests(page, 'hosts')).length).toBe(2)
      await answer(page, 'hosts', 1, sources)
      await expect(page.locator('.project-open')).toBeVisible()
      await expect(page.locator('.project-file')).toHaveCount(0)
      return page
    }
    const browse = async (page, path, action = () => page.locator('.project-open').click()) => {
      const request = await nextRequest(page, 'list', action)
      assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('path'), path)
      await answer(page, 'list', request, { entries: [{ ...row('result.md'), path: `${path ? path + '/' : ''}result.md` }] })
      await expect(page.locator('[data-browse-entry]')).toHaveCount(1)
    }
    const alice = await reopen('alice')
    const folder = 'reports/2026 + figures'
    await browse(alice, folder, () => alice.evaluate(({ project, folder }) =>
      window.navigateFixture({ ...project, path: folder, kind: 'directory' }), { project, folder }))
    await alice.evaluate(project => window.navigateFixture({ ...project, path: 'elsewhere/notes.md', kind: 'file' }), project)
    await expect(alice.locator('[data-fixture-reader]')).toBeVisible()
    await browse(alice, folder, () => alice.getByRole('tab', { name: 'Browse', exact: true }).click())
    await alice.getByRole('button', { name: 'Close project Fixture project', exact: true }).click()
    await expect(alice.locator('.project-open')).toHaveCount(0)
    await alice.getByRole('button', { name: 'Add project', exact: true }).click()
    await browse(alice, folder, () => alice.locator('.saved-project').click())
    await alice.close()

    const restored = await reopen('alice')
    await browse(restored, folder)
    await restored.close()
    const bob = await reopen('bob')
    await browse(bob, '')
    await bob.close()

    // Cosmetic/trust edits retain the folder; changing the actual source discards it.
    const renamed = structuredClone(catalog)
    renamed.hosts[0].label = 'Renamed host'
    renamed.hosts[0].roots[0].trustedScripts = true
    const sameSource = await reopen('alice', renamed)
    await browse(sameSource, folder)
    const repointed = structuredClone(renamed)
    repointed.hosts[0].roots[0].path = '/synthetic/replacement'
    await answer(sameSource, 'hosts', await bump(sameSource), repointed)
    await browse(sameSource, '')
    await sameSource.close()
    const reverted = await reopen('alice')
    await browse(reverted, '')
    await reverted.close()

    // Disabled storage and quota failures retain folders in memory for this app session.
    for (const mode of ['disabled', 'quota']) {
      const unavailable = await reopen(`no-storage-${mode}`)
      await unavailable.evaluate(mode => {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem
        Storage.prototype.getItem = function(key) { if (this === localStorage && mode === 'disabled') throw new Error('Storage disabled'); return get.call(this, key) }
        Storage.prototype.setItem = function(key, value) { if (this === localStorage) throw new Error('Storage write failed'); return set.call(this, key, value) }
      }, mode)
      await browse(unavailable, folder, () => unavailable.evaluate(({ project, folder }) =>
        window.navigateFixture({ ...project, path: folder, kind: 'directory' }), { project, folder }))
      await unavailable.evaluate(project => window.navigateFixture({ ...project, path: 'notes.md', kind: 'file' }), project)
      await expect(unavailable.locator('[data-fixture-reader]')).toBeVisible()
      await browse(unavailable, folder)
      await unavailable.getByRole('button', { name: 'Close project Fixture project', exact: true }).click()
      await expect(unavailable.locator('.project-open')).toHaveCount(0)
      await unavailable.getByRole('button', { name: 'Add project', exact: true }).click()
      await browse(unavailable, folder, () => unavailable.locator('.saved-project').click())
      await unavailable.close()
    }
    console.log('PASS: Browse folder survives file switches, project close/reopen and fresh browser tabs; paths stay account-local and source-bound; blocked storage stays usable')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ headless: true })
  try { await checkWorkspaceSources({ browser }) } finally { await browser.close() }
}
