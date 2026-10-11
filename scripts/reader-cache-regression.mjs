import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, webkit, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
// WebKit's native download path can bypass Playwright routing.
const server = createServer((request, response) => {
  if (request.url.startsWith('/api/file?')) {
    counts.downloads++
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="archive.zip"' })
    response.end('fixture archive')
  } else { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const bridge = await readFile(`${repository}/internal/server/preview_bridge.js`, 'utf8')
const bundle = await rolldown({
  cwd: `${repository}/web`, input: 'fixture:reader-cache', platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'reader-cache',
    resolveId(id) {
      if (id === 'fixture:reader-cache') return '\0fixture.tsx'
      if (id.endsWith('.css') || id.includes('.svg?')) return '\0asset'
      if (id === './PDFViewer') return '\0pdf'
    },
    load(id) {
      if (id === '\0asset') return 'export default ""'
      if (id === '\0pdf') return 'export default function PDF(){return null}'
      if (id === '\0fixture.tsx') return `
        import React, {useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import ReaderDeck from '${repository}/web/src/components/ReaderDeck.tsx'
        import FilePreview from '${repository}/web/src/components/FilePreview.tsx'
        function Fixture() {
          const [location,setLocation]=useState({host:'fixture',root:'project',path:'reports/report.html',kind:'file'})
          const [tabs,setTabs]=useState([location])
          const [trusted,setTrusted]=useState(false)
          const host={id:'fixture',kind:'local',target:'',label:'Fixture',roots:[{id:'project',label:'Project',path:'/fixtures',trustedScripts:trusted}]}
          const navigate=next=>{
            window.lastFixtureNavigation=next
            if(next.kind==='file') setTabs(tabs=>tabs.some(tab=>tab.path===next.path)?tabs:[...tabs,next])
            setLocation(next)
          }
          window.openFixture=path=>navigate({host:'fixture',root:'project',path,kind:'file'})
          window.leaveFixture=()=>setLocation({...location,kind:'overview'})
          window.closeFixture=path=>setTabs(tabs=>tabs.filter(tab=>tab.path!==path))
          return <><nav aria-label="Fixture tabs">{tabs.map(tab=><button key={tab.path} onClick={()=>navigate({...tab,kind:'file'})}>{tab.path}</button>)}</nav>
            <div style={{height:'700px',display:'flex',flexDirection:'column'}}>
              <ReaderDeck location={location} tabs={tabs} hosts={[host]} render={(file,_host,root,active)=>
                <FilePreview location={file} active={active} projectRoot={root.path} copied={false} onCopyLink={()=>{}}
                  onExpand={()=>{}} onNavigate={navigate} projectTrustedScripts={trusted} onProjectScriptsAllowed={()=>setTrusted(true)}/>
              }/>
            </div></>
        }
        createRoot(document.getElementById('root')).render(<Fixture/>)
      `
    },
  }],
})
const result = await bundle.generate({ format: 'iife', codeSplitting: false })
await bundle.close()
const script = result.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['components/workspace.css', 'viewers.css', 'styles.css']
  .map(path => readFile(`${repository}/web/src/${path}`, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const browser = await (process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1000, height: 850 }, acceptDownloads: true })
context.setDefaultTimeout(10_000)
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const versions = new Map()
const previews = new Map()
const counts = { preview: 0, documents: 0, text: 0, downloads: 0, outside: 0 }
let trusted = false, sequence = 0, heldMetadata, heldDocument, holdMetadata = false, holdDocument = false, failDocument = false, truncateDocument = false, metadataStatus = 200
const reportPath = 'reports/report.html'
const version = path => `${versions.get(path) ?? 1}:${trusted}`
const metadata = path => ({ name: path.split('/').pop(), path, type: 'file', size: 800, modified: '2026-10-08T00:00:00Z', version: version(path), trustedScripts: trusted })
const report = (path, current) => `<!doctype html><html><head><style>body{color:#203746;font:16px system-ui}#details{margin-top:900px}</style></head><body>
  <h1>${path} ${current}</h1><label>Report selector<select><option>First</option><option>Second</option></select></label>
  <span id="script-state">blocked</span><script>document.getElementById('script-state').textContent='enabled'</script>
  <p><a href="../notes.md">Local note</a> <a href="../archive.zip">Archive</a> <a href="https://external.invalid/report?q=1">External report</a>
  <a href="#details">Section</a> <a href="javascript:alert(1)">Bad link</a>
  <a href="/">Project root</a> <a href="/fixtures">Absolute root</a>
  <a href="/fixtures/">Absolute root slash</a> <a href="file:///fixtures/">File root</a></p><h2 id="details">Details</h2>
  <script type="module">document.body.innerHTML='<h1>Module rendered report</h1><span id="script-state">enabled</span>'</script></body></html>`
const documentResponse = (token, entry) => {
  const nonce = 'fixtureNonce'
  return {
    contentType: 'text/html; charset=utf-8',
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src ${entry.scripts ? "'unsafe-inline'" : `'nonce-${nonce}'`}; sandbox allow-scripts; frame-ancestors ${origin}`,
    },
    body: `<!doctype html><meta name="color-scheme" content="light"><script nonce="${nonce}">${bridge}(${JSON.stringify(token)},${JSON.stringify(origin)},${JSON.stringify(nonce)});</script>${report(entry.path, entry.version)}<meta name="artiface-preview-complete" content="${nonce}">`,
  }
}
await context.route('**/*', async route => {
  const url = new URL(route.request().url())
  if (url.origin === 'https://external.invalid') {
    counts.outside++
    return route.fulfill({ contentType: 'text/html', body: '<h1>Confirmed external fixture</h1>' })
  }
  if (url.origin !== origin) return route.abort()
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
  if (url.pathname === '/p/healthz') return route.fulfill({ status: 204 })
  if (url.pathname.startsWith('/p/')) {
    counts.documents++
    const token = url.pathname.split('/')[2], entry = previews.get(token)
    if (failDocument) return route.fulfill({ status: 503, contentType: 'text/html', body: '<p>Temporary report failure</p>' })
    if (truncateDocument) {
      const response = documentResponse(token, entry)
      response.body = response.body.slice(0, response.body.indexOf('<h2 id="details">'))
      return route.fulfill(response)
    }
    if (holdDocument) { holdDocument = false; heldDocument = { route, response: documentResponse(token, entry) }; return }
    return route.fulfill(documentResponse(token, entry))
  }
  const body = route.request().postDataJSON?.()
  const path = url.searchParams.get('path') ?? body?.path ?? reportPath
  const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
  if (url.pathname === '/api/file-info') {
    if (holdMetadata && path === reportPath) { holdMetadata = false; heldMetadata = route; return }
    if (metadataStatus !== 200 && path === reportPath) return route.fulfill({ status: metadataStatus, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic metadata failure' }) })
    return json(metadata(path))
  }
  if (url.pathname === '/api/preview') {
    counts.preview++
    const token = `preview-${++sequence}`, entry = { path, version: version(path), scripts: trusted }
    previews.set(token, entry)
    return json({ ...entry, url: `${origin}/p/${token}/${path.split('/').pop()}`, bridge: path.endsWith('.html'),
      expiresAt: new Date(Date.now() + 900_000).toISOString(), ...(!trusted && path.endsWith('.html') ? { scriptCheck: token } : {}) })
  }
  if (url.pathname === '/api/preview/scripts') return json({ status: 'present', canAllow: true, projectLabel: 'Fixture project', revision: 'fixture-revision' })
  if (url.pathname === '/api/projects/trust') {
    assert.deepEqual(body, { host: 'fixture', root: 'project', revision: 'fixture-revision' })
    trusted = true
    return json({})
  }
  if (url.pathname === '/api/text') { counts.text++; return json({ text: `# ${path}\n\nCached Markdown content.`, size: 50, version: version(path), truncated: false }) }
  if (url.pathname === '/api/file') {
    return route.continue()
  }
  throw new Error(`Unexpected fixture route ${url.pathname}`)
})
await context.addInitScript(origin => {
  if (location.origin === origin && window.top === window) localStorage.setItem('artiface.preferences.v1', JSON.stringify({ theme: 'dark', autoRefreshSeconds: 300 }))
}, origin)
const pane = page.locator('.reader-panel:not([hidden])')
const frame = () => pane.frameLocator('iframe:not(.pending-preview)')
const choose = path => page.getByRole('navigation', { name: 'Fixture tabs' }).getByRole('button', { name: path, exact: true }).click()
try {
  await page.goto(origin)
  await expect(frame().getByRole('heading', { name: `${reportPath} 1:false`, exact: true })).toBeVisible()
  await expect(frame().locator('#script-state')).toHaveText('blocked')
  await expect(page.getByRole('button', { name: 'Allow JavaScript', exact: true })).toBeVisible()
  await expect(pane.locator('iframe:not(.pending-preview)')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await frame().getByLabel('Report selector').selectOption({ label: 'Second' })
  await frame().getByRole('link', { name: 'Local note', exact: true }).click()
  await expect(pane.getByRole('article', { name: 'Rendered Markdown' })).toContainText('notes.md')
  const downloaded = counts.documents, capabilities = counts.preview, textReads = counts.text
  holdMetadata = true
  await choose(reportPath)
  await expect(frame().getByLabel('Report selector')).toHaveValue('Second')
  await expect.poll(() => Boolean(heldMetadata)).toBe(true)
  assert.equal(counts.documents, downloaded, 'Returning to a tab recreated its iframe')
  assert.equal(counts.preview, capabilities, 'Returning to a tab requested another capability before metadata')
  await heldMetadata.fulfill({ contentType: 'application/json', body: JSON.stringify(metadata(reportPath)) })
  heldMetadata = null
  await choose('notes.md')
  assert.equal(counts.text, textReads, 'Returning to unchanged text downloaded it again')
  await page.evaluate(() => window.leaveFixture())
  await choose(reportPath)
  await expect(frame().getByLabel('Report selector')).toHaveValue('Second')
  assert.equal(counts.documents, downloaded, 'Leaving readers destroyed the cached report')
  console.log('PASS cached HTML DOM/controls and text survive tab/overview switches before slow metadata; unchanged files are not downloaded again')

  await frame().getByRole('link', { name: 'Archive', exact: true }).click()
  const downloadDialog = page.getByRole('dialog', { name: 'Download this file?' })
  await expect(downloadDialog).toContainText('archive.zip')
  assert.equal(counts.downloads, 0)
  const download = page.waitForEvent('download')
  await downloadDialog.getByRole('link', { name: 'Download', exact: true }).click()
  assert.equal((await download).suggestedFilename(), 'archive.zip')
  await frame().getByRole('link', { name: 'External report', exact: true }).click()
  const external = page.getByRole('dialog', { name: 'Open external website?' })
  await expect(external).toContainText('https://external.invalid/report?q=1')
  assert.equal(counts.outside, 0)
  await external.getByRole('button', { name: 'Cancel' }).click()
  await frame().getByRole('link', { name: 'External report', exact: true }).click()
  const popup = context.waitForEvent('page')
  await external.getByRole('link', { name: 'Open website' }).click()
  const outside = await popup
  await expect(outside.getByRole('heading')).toHaveText('Confirmed external fixture')
  await outside.close()
  await frame().getByRole('link', { name: 'Bad link', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Cannot open this link' })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  for (const name of ['Project root', 'Absolute root', 'Absolute root slash', 'File root']) {
    await frame().getByRole('link', { name, exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.lastFixtureNavigation)).toEqual({
      host: 'fixture', root: 'project', path: '', kind: 'directory',
    })
    await choose(reportPath)
  }
  console.log('PASS local links stay in app tabs; downloads and external tabs wait for confirmation; unsafe schemes are rejected')

  await choose('notes.md')
  versions.set(reportPath, 2)
  holdMetadata = true
  holdDocument = true
  await choose(reportPath)
  await expect(frame().getByRole('heading', { name: `${reportPath} 1:false`, exact: true })).toBeVisible()
  await expect.poll(() => Boolean(heldMetadata)).toBe(true)
  await heldMetadata.fulfill({ contentType: 'application/json', body: JSON.stringify(metadata(reportPath)) })
  heldMetadata = null
  await expect.poll(() => Boolean(heldDocument)).toBe(true)
  await expect(frame().getByLabel('Report selector')).toHaveValue('Second')
  await heldDocument.route.fulfill(heldDocument.response)
  heldDocument = null
  await expect(frame().getByRole('heading', { name: `${reportPath} 2:false`, exact: true })).toBeVisible()

  for (const failure of ['http', 'truncated']) {
    await choose('notes.md')
    versions.set(reportPath, (versions.get(reportPath) ?? 2) + 1)
    failDocument = failure === 'http'
    truncateDocument = failure === 'truncated'
    await choose(reportPath)
    await expect(pane.getByRole('status')).toContainText('Update pending')
    await expect(frame().getByRole('heading', { name: `${reportPath} 2:false`, exact: true })).toBeVisible()
  }
  failDocument = truncateDocument = false
  await page.getByRole('button', { name: 'Allow JavaScript', exact: true }).click()
  await expect(frame().locator('#script-state')).toHaveText('enabled')
  await expect(frame().getByRole('heading', { name: 'Module rendered report', exact: true })).toBeVisible()
  await expect(frame().locator('meta[name="artiface-preview-complete"]')).toHaveCount(0)
  console.log('PASS updated reports replace cached content only after bridge readiness; failed HTML responses preserve old content; explicit project trust enables report scripts')

  await choose('notes.md')
  metadataStatus = 503
  await choose(reportPath)
  await expect(frame().locator('#script-state')).toHaveText('enabled')
  await expect(pane.getByRole('status')).toContainText('Update pending')
  await choose('notes.md')
  metadataStatus = 403
  await choose(reportPath)
  await expect(pane.locator('iframe')).toHaveCount(0)
  await expect(pane.getByRole('heading', { name: 'Couldn’t prepare a preview' })).toBeVisible()
  metadataStatus = 200
  for (let index = 0; index < 10; index++) {
    await page.evaluate(path => window.openFixture(path), `note-${index}.md`)
    await expect(pane.getByRole('article')).toContainText(`note-${index}.md`)
  }
  await expect(page.locator('.reader-panel')).toHaveCount(8)
  await expect(page.locator('#reader-toolbar')).toHaveCount(1)
  await page.evaluate(() => window.closeFixture('note-2.md'))
  await expect(page.locator('.reader-panel')).toHaveCount(7)
  assert.deepEqual(errors, [])
  console.log('PASS temporary failures preserve cached content, access denial clears it, and retained readers stay bounded and release closed tabs')
} finally {
  await context.close()
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
