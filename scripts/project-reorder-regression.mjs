import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../web/', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const origin = 'https://project-reorder.invalid'
const roots = Array.from({ length: 18 }, (_, index) => ({ id: `p${index}`, label: `Project ${index}`, path: `/fixture/${index}` }))
const projects = roots.map(root => ({ host: 'fixture', root: root.id }))
let shared = projects.slice(0, 4)
const moves = []
const errors = []
let holdRead = false, heldRead
const bundle = await rolldown({
  cwd: web, input: 'fixture:project-reorder', platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'project-reorder',
    resolveId(id) {
      if (id === 'fixture:project-reorder') return '\0fixture.tsx'
      if (id === './FilePreview' || id === './GitPDFPreview') return '\0reader.tsx'
      if (id.endsWith('.css') || id.includes('.svg?')) return '\0asset'
    },
    load(id) {
      if (id === '\0asset') return 'export default ""'
      if (id === '\0reader.tsx') return `import {useState} from 'react'
        export default function Reader(){ const [value,setValue]=useState('')
          return <section className="file-preview"><input aria-label="Reader state" value={value} onChange={event=>setValue(event.target.value)}/></section> }`
      if (id === '\0fixture.tsx') return `
        import {createRoot} from 'react-dom/client'
        import Workspace from '${web}/src/components/Workspace'
        import {useLocation} from '${web}/src/location'
        function App(){const [location,navigate]=useLocation();return <Workspace location={location} navigate={navigate} onLogout={()=>{}}/>}
        createRoot(document.getElementById('root')).render(<App/>)
      `
    },
  }],
})
const { output } = await bundle.generate({ format: 'iife', codeSplitting: false })
await bundle.close()
const script = output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['components/workspace.css', 'viewers.css', 'styles.css'].map(path => readFile(`${web}/src/${path}`, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 700 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(7000)
  await context.addInitScript(({ projects }) => {
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ gitStatus: false, autoRefreshSeconds: 300 }))
    if (!sessionStorage.getItem('artiface.workspace.v1')) sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({
      projects: projects.map(project => ({ ...project, expanded: true })),
      tabs: [{ ...projects[0], path: 'notes.txt', autoRefreshPaused: true }],
    }))
  }, { projects: shared })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    let body
    if (url.pathname === '/api/hosts') body = { revision: 'fixture', setupEnabled: false, hosts: [{ id: 'fixture', label: 'Machine', kind: 'local', target: '', roots }] }
    if (url.pathname === '/api/workspace/projects') {
      if (route.request().method() === 'GET' && holdRead) { holdRead = false; heldRead = route; return }
      if (route.request().method() === 'POST') {
        const change = route.request().postDataJSON()
        for (const project of change.close ?? []) shared = shared.filter(item => item.root !== project.root)
        for (const project of change.open ?? []) if (!shared.some(item => item.root === project.root)) shared.push(project)
        for (const move of change.move ?? []) {
          moves.push(move)
          const source = shared.find(project => project.root === move.project.root)
          if (!source || !shared.some(project => project.root === move.target.root)) continue
          shared = shared.filter(project => project !== source)
          shared.splice(shared.findIndex(project => project.root === move.target.root) + (move.edge === 'after' ? 1 : 0), 0, source)
        }
      }
      body = { projects: shared, sourcesRevision: 'fixture' }
    }
    if (url.pathname === '/api/list') body = { entries: [] }
    if (!body) errors.push(`Unexpected request: ${url.pathname}`)
    return route.fulfill({ status: body ? 200 : 404, json: body ?? {} })
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/#host=fixture&root=p0&path=notes.txt&kind=file`)
  const list = page.getByRole('navigation', { name: 'Open projects' })
  const project = number => list.getByRole('button', { name: `Open project Project ${number} on Machine`, exact: true })
  const group = number => list.locator(`[data-project-key='["fixture","p${number}"]']`)
  const order = () => list.locator('[data-project-key]').evaluateAll(rows => rows.map(row => JSON.parse(row.dataset.projectKey)[1]))
  const reader = page.getByRole('textbox', { name: 'Reader state' })
  await expect(reader).toBeVisible()
  await expect.poll(order).toEqual(['p0', 'p1', 'p2', 'p3'])
  await reader.fill('Keep this reader mounted')
  await page.evaluate(() => { window.savedReader = document.querySelector('[aria-label="Reader state"]') })
  const route = page.url()
  const drag = async (source, target, edge) => {
    const box = await group(target).boundingBox()
    await project(source).dragTo(group(target), { targetPosition: { x: box.width / 2, y: edge === 'before' ? 2 : box.height - 2 } })
  }
  await drag(0, 2, 'after')
  await expect.poll(order).toEqual(['p1', 'p2', 'p0', 'p3'])
  await expect.poll(() => shared.map(project => project.root)).toEqual(['p1', 'p2', 'p0', 'p3'])
  assert.equal(page.url(), route, 'Project drag navigated away from the reader')
  assert(await reader.evaluate(element => element === window.savedReader), 'Project drag remounted the reader')
  await expect(reader).toHaveValue('Keep this reader mounted')
  await expect(group(0).getByRole('button', { name: 'Open notes.txt', exact: true })).toBeVisible()

  const savedOrder = await order(), writes = moves.length
  const begin = async number => {
    const box = await project(number).boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10, { steps: 5 })
    await expect(list.locator('.is-project-dragging')).toHaveCount(1)
  }
  await begin(0)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(list.locator('.is-project-dragging, .is-project-drop-before, .is-project-drop-after')).toHaveCount(0)
  assert.deepEqual(await order(), savedOrder)
  assert.equal(moves.length, writes, 'Cancelled project drag was saved')
  for (const type of ['touch', 'pen']) {
    assert(await project(0).evaluate((element, type) => {
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: type, button: 0 }))
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      return !element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    }, type), `${type} started a native mouse drag`)
  }
  await project(0).focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(order).toEqual(['p1', 'p0', 'p2', 'p3'])
  await expect(project(0)).toBeFocused()
  await expect.poll(() => shared.map(project => project.root)).toEqual(['p1', 'p0', 'p2', 'p3'])

  // A pending poll must not revert a drop before its move can be saved.
  holdRead = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => Boolean(heldRead), { timeout: 10000 }).toBe(true)
  const oldShared = [...shared]
  await drag(3, 1, 'before')
  await expect.poll(order).toEqual(['p3', 'p1', 'p0', 'p2'])
  await heldRead.fulfill({ json: { projects: oldShared, sourcesRevision: 'fixture' } })
  await expect.poll(() => shared.map(project => project.root)).toEqual(['p3', 'p1', 'p0', 'p2'])
  await expect.poll(order).toEqual(['p3', 'p1', 'p0', 'p2'])
  await page.reload()
  await expect.poll(order).toEqual(['p3', 'p1', 'p0', 'p2'])
  await expect(reader).toBeVisible()

  // Auto-scroll reaches projects below the visible sidebar.
  shared = [...projects]
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(order, { timeout: 10000 }).toHaveLength(18)
  await list.evaluate(element => { element.scrollTop = 0 })
  await begin(0)
  const bounds = await list.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 3)
  await page.mouse.move(bounds.x + bounds.width / 2 + 1, bounds.y + bounds.height - 3)
  await expect.poll(() => list.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
  const last = await group(17).boundingBox()
  await page.mouse.move(last.x + last.width / 2, last.y + last.height - 2, { steps: 3 })
  await page.mouse.move(last.x + last.width / 2, last.y + last.height - 2)
  await expect(group(17)).toHaveClass(/is-project-drop-after/)
  await page.mouse.up()
  await expect.poll(async () => (await order()).at(-1)).toBe('p0')
  await expect.poll(() => shared.at(-1).root).toBe('p0')
  assert.equal(page.url(), route)
  assert.deepEqual(errors, [])
  console.log('PASS: native project drag, cancellation, touch/pen scrolling, keyboard moves, stale poll protection, persisted order, reader preservation and vertical auto-scroll')
  await context.close()
} finally { await browser.close() }
