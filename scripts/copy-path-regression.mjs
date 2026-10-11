import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../web/', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const origin = 'https://copy-path.invalid'
const filename = 'reports/a + ü%#&.txt'
const hosts = [
  { id: 'ssh', kind: 'ssh', target: 'research', label: 'Research', roots: [{ id: 'project', label: 'Remote project', path: '/remote/project/' }] },
  { id: 'local', kind: 'local', label: 'localhost', roots: [{ id: 'project', label: 'Local project', path: '/local/project' }] },
  { id: 'root', kind: 'local', label: 'Root', roots: [{ id: 'project', label: 'Filesystem root', path: '/' }] },
  { id: 'team', kind: 'ssh', target: '', label: 'Shared', roots: [{ id: 'project', label: 'Shared project', path: '' }] },
]
const projects = hosts.map(host => ({ host: host.id, root: 'project' }))
const bundle = await rolldown({
  cwd: web, input: 'fixture:copy-path', platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'copy-path',
    resolveId(id) {
      if (id === 'fixture:copy-path') return '\0fixture.tsx'
      if (id.endsWith('.css') || id.includes('.svg?')) return '\0asset'
      if (id === './PDFViewer') return '\0pdf.tsx'
      if (id === './useSourceHighlight') return '\0highlight'
    },
    load(id) {
      if (id === '\0asset') return 'export default ""'
      if (id === '\0highlight') return 'export const useSourceHighlight = () => null'
      // Exercise the PDF-specific Workspace branch and its FilePreview actions.
      if (id === '\0pdf.tsx') return 'export default function PDF({renderActions}){return <div className="pdf-toolbar">{renderActions()}</div>}'
      if (id === '\0fixture.tsx') return `
        import React from 'react'
        import {createRoot} from 'react-dom/client'
        import Workspace from '${web}/src/components/Workspace'
        import {useLocation} from '${web}/src/location'
        function Fixture() {
          const [location, navigate] = useLocation()
          window.fixtureNavigate = navigate
          return <Workspace location={location} navigate={navigate} canManage={location.host !== 'team'} onLogout={()=>{}}/>
        }
        createRoot(document.getElementById('root')).render(<Fixture/>)
      `
    },
  }],
})
const { output } = await bundle.generate({ format: 'iife', codeSplitting: false })
await bundle.close()
const script = output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'viewers.css', 'components/workspace.css'].map(path => readFile(`${web}/src/${path}`, 'utf8'))))
  .join('\n').replace(/@import[^;]+;/g, '')
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  context.setDefaultTimeout(5000)
  const errors = []
  let fileReads = 0
  await context.addInitScript(({ projects, filename }) => {
    localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300, gitStatus: false }))
    sessionStorage.setItem('artiface.workspace.v1', JSON.stringify({
      projects: projects.map(project => ({ ...project, expanded: true })),
      tabs: projects.map(project => ({ ...project, path: filename, autoRefreshPaused: true })),
    }))
    window.fixtureClipboard = navigator.clipboard
  }, { projects, filename })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
    let body
    if (url.pathname === '/api/hosts') body = { revision: 'fixture', setupEnabled: false, hosts }
    if (url.pathname === '/api/workspace/projects') body = { projects, sourcesRevision: 'fixture' }
    if (url.pathname === '/api/file-info') { fileReads++; body = { size: 12, modified: '2026-10-09T12:00:00Z', version: 'fixture' } }
    if (url.pathname === '/api/text') { fileReads++; body = { text: 'Example file', size: 12, version: 'fixture', truncated: false } }
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body ?? {}) })
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/#${new URLSearchParams({ ...projects[0], path: filename, kind: 'file' })}`)
  const reader = page.locator('.reader-panel:not([hidden])')
  const options = reader.getByRole('button', { name: 'Reader options', exact: true })
  const navigate = async (host, path = filename) => {
    await page.evaluate(location => window.fixtureNavigate(location), { host, root: 'project', path, kind: 'file' })
    await expect(reader.getByRole('heading', { name: path.split('/').at(-1), exact: true })).toBeAttached()
    if (!path.endsWith('.pdf')) await expect(reader.getByRole('region', { name: 'File source' })).toContainText('Example file')
  }
  const copy = async (expected, relative = false) => {
    await options.click()
    const readsBefore = fileReads
    await reader.getByRole('button', { name: 'Copy file path', exact: true }).click()
    await expect(page.locator('.toast')).toHaveText(new RegExp(relative ? 'Project-relative path copied' : 'File path copied'))
    assert.equal(await page.evaluate(() => window.fixtureClipboard.readText()), expected)
    await expect(options).toHaveAttribute('aria-expanded', 'false')
    await expect(options).toBeFocused()
    assert.equal(fileReads, readsBefore, 'Copying must not fetch the file or contact SSH')
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const host of hosts) {
      await navigate(host.id)
      const root = host.roots[0].path.replace(/\/+$/, '')
      await copy(host.id === 'team' ? filename : `${root}/${filename}`, host.id === 'team')
    }
    await navigate('ssh', 'reports/report.pdf')
    await copy('/remote/project/reports/report.pdf')
  }
  // Returning to a retained reader must copy its own project, not the previous tab's.
  await navigate('local')
  await copy(`/local/project/${filename}`)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }))
  await copy(`/local/project/${filename}`)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
  }))
  await copy(`/local/project/${filename}`)
  console.log('PASS local/SSH/PDF/retained tabs, literal filenames, filesystem root, Team relative paths, mobile and Clipboard API fallback')

  // If both clipboard methods fail, retain a selectable path and never claim success.
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await page.evaluate(() => { document.execCommand = () => false })
  await options.click()
  await reader.getByRole('button', { name: 'Copy file path', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Copy file path', exact: true })
  const field = dialog.getByRole('textbox', { name: 'File path' })
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue(`/local/project/${filename}`)
  await expect(field).toBeFocused()
  assert(await field.evaluate(element => element.selectionStart === 0 && element.selectionEnd === element.value.length))
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Copy dialog overflows mobile viewport')
  await expect(page.locator('.toast')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(options).toBeFocused()
  assert.deepEqual(errors, [])
  console.log('PASS blocked clipboard offers selected manual copy, closes with Escape and restores focus')
  await context.close()
} finally { await browser.close() }
