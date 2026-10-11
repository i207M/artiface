import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { expect } = require('@playwright/test')
const key = project => JSON.stringify([project.host, project.root])
const ref = ({ host, root }) => ({ host, root })
const endpoint = '/api/workspace/projects'
const session = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('artiface.workspace.v1') || 'null'))

// Uses disposable authenticated devices against the smoke fixture's configured projects.
export async function checkSharedProjects({ browser, origin, password, files, newProjectPath }) {
  const contexts = []
  const errors = []
  async function device() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    contexts.push(context)
    context.setDefaultTimeout(15_000)
    const login = await context.request.post(origin + '/api/login', { data: { password }, headers: { Origin: origin } })
    assert.equal(login.status(), 200)
    const { csrfToken } = await login.json()
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    return { context, page, headers: { Origin: origin, 'X-CSRF-Token': csrfToken } }
  }
  const admin = await device()
  const get = async () => {
    const response = await admin.context.request.get(origin + endpoint)
    assert.equal(response.status(), 200)
    return response.json()
  }
  const write = async body => {
    const response = await admin.context.request.post(origin + endpoint, { data: body, headers: admin.headers })
    assert.equal(response.status(), 200)
    return response.json()
  }
  const initial = await get()
  const hosts = (await (await admin.context.request.get(origin + '/api/hosts')).json()).hosts
  const projectName = file => hosts.find(host => host.id === file.host).roots.find(root => root.id === file.root).label
  const project = (page, file) => page.getByRole('button', {
    name: `Open project ${projectName(file)} on ${hosts.find(host => host.id === file.host).label}`, exact: true,
  })
  const open = async (page, file) => {
    await page.goto(origin + '/#' + new URLSearchParams({ ...file, kind: 'file' }))
    await expect(page.getByRole('tablist', { name: 'Project tabs' }).getByRole('tab', { name: file.path.split('/').at(-1), exact: true })).toHaveAttribute('aria-selected', 'true')
  }
  const wake = page => page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const savedKeys = async () => (await get()).projects.map(key).sort()
  const [first, second] = files
  let added
  try {
    await write({ close: initial.projects })
    const a = await device()
    await open(a.page, first)
    await expect.poll(savedKeys).toEqual([key(first)])
    const b = await device()
    await b.page.goto(origin + '/#kind=overview')
    await expect(project(b.page, first)).toBeVisible()
    assert.equal((await session(b.page)).tabs.length, 0, 'A fresh device inherited file tabs')

    if (newProjectPath) {
      // The first device must discover new source metadata as well as its shared reference.
      await b.page.getByRole('button', { name: 'Add project', exact: true }).click()
      await b.page.getByRole('button', { name: 'New project', exact: true }).click()
      await b.page.getByRole('combobox', { name: 'Machine', exact: true }).selectOption(first.host)
      await b.page.locator('.project-setup input[name="path"]').fill(newProjectPath)
      await b.page.getByLabel('Project name', { exact: false }).fill('Shared discovery fixture')
      const saving = b.page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'POST')
      await b.page.getByRole('button', { name: 'Add and open project', exact: true }).click()
      const result = await saving
      assert.equal(result.status(), 200)
      added = await result.json()
      const buttonName = `Open project Shared discovery fixture on ${hosts.find(host => host.id === first.host).label}`
      await expect(b.page.getByRole('button', { name: buttonName, exact: true })).toBeVisible()
      await wake(a.page)
      await expect(a.page.getByRole('button', { name: buttonName, exact: true })).toBeVisible()
      const latest = await (await admin.context.request.get(origin + '/api/settings')).json()
      const latestHost = latest.config.hosts.find(host => host.id === added.host.id)
      latestHost.roots = latestHost.roots.filter(root => root.id !== added.root.id)
      const removed = await admin.context.request.post(origin + '/api/settings', { data: { config: latest.config, revision: latest.revision }, headers: admin.headers })
      assert.equal(removed.status(), 200)
      added = undefined
      await wake(a.page)
      await wake(b.page)
      await expect(a.page.getByRole('button', { name: buttonName, exact: true })).toHaveCount(0)
      await expect(b.page.getByRole('button', { name: buttonName, exact: true })).toHaveCount(0)
    }

    // B retains an old project list while A closes its project.
    const stale = await get()
    const oldList = route => route.request().method() === 'GET'
      ? route.fulfill({ json: stale }) : route.continue()
    await b.page.route('**' + endpoint, oldList)
    await a.page.getByRole('button', { name: `Close project ${projectName(first)}`, exact: true }).click()
    await expect.poll(savedKeys).toEqual([])
    await open(b.page, second)
    await expect.poll(savedKeys).toEqual([key(second)])
    await b.page.unroute('**' + endpoint, oldList)
    await wake(a.page)
    await expect(project(a.page, second)).toBeVisible()
    assert.equal((await session(a.page)).tabs.length, 0, 'Another device opened a file tab here')
    assert.deepEqual((await session(b.page)).tabs.map(key), [key(second)])

    // Keep unsaved operations visible, then retry without losing another device's project.
    const failWrite = route => route.request().method() === 'POST' ? route.abort('failed') : route.continue()
    await a.page.route('**' + endpoint, failWrite)
    await open(a.page, first)
    await expect(a.page.getByRole('button', { name: 'Retry project sync', exact: true })).toBeVisible()
    assert.deepEqual(await savedKeys(), [key(second)])
    await a.page.unroute('**' + endpoint, failWrite)
    await a.page.getByRole('button', { name: 'Retry project sync', exact: true }).click()
    await expect.poll(savedKeys).toEqual([key(first), key(second)].sort())
    await wake(b.page)
    await expect(project(b.page, first)).toBeVisible()
    assert.deepEqual((await session(a.page)).tabs.map(key), [key(first)])
    assert.deepEqual((await session(b.page)).tabs.map(key), [key(second)])

    // Reloading a stale browser must not republish the projects in session storage.
    const beforeClose = await get()
    const staleRead = route => route.request().method() === 'GET'
      ? route.fulfill({ json: beforeClose }) : route.continue()
    await a.page.route('**' + endpoint, staleRead)
    await b.page.getByRole('button', { name: `Close project ${projectName(first)}`, exact: true }).click()
    await expect.poll(savedKeys).toEqual([key(second)])
    await a.page.unroute('**' + endpoint, staleRead)
    await a.page.reload()
    await expect(a.page.getByRole('heading', { name: 'Open files', exact: true })).toBeVisible()
    await expect(project(a.page, first)).toHaveCount(0)
    assert.equal((await session(a.page)).tabs.length, 0)
    assert.deepEqual(await savedKeys(), [key(second)], 'Reload resurrected a remotely closed project')

    await b.page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(b.page.getByLabel('Workspace password')).toBeVisible()
    assert.equal(await b.page.evaluate(() => sessionStorage.getItem('artiface.workspace.v1')), null)
    assert.deepEqual(await savedKeys(), [key(second)], 'Signing out deleted shared projects')
    const fresh = await device()
    await fresh.page.goto(origin + '/#kind=overview')
    await expect(project(fresh.page, second)).toBeVisible()
    assert.equal((await session(fresh.page)).tabs.length, 0)
    assert.deepEqual(errors, [])
  } finally {
    // Close devices before restoring the fixture list so they cannot republish local actions.
    for (const context of contexts.slice(1)) await context.close()
    if (added) {
      const latest = await (await admin.context.request.get(origin + '/api/settings')).json()
      const host = latest.config.hosts.find(host => host.id === added.host.id)
      host.roots = host.roots.filter(root => root.id !== added.root.id)
      await admin.context.request.post(origin + '/api/settings', { data: { config: latest.config, revision: latest.revision }, headers: admin.headers })
    }
    const current = await get()
    await write({ open: initial.projects.map(ref), close: current.projects.filter(project => !initial.projects.some(item => key(item) === key(project))) })
    await admin.context.close()
  }
}
