import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, webkit, expect } = require('@playwright/test')
const entry = join(repository, 'web/src/__pdf_revalidation_fixture__.tsx')
const pdfModule = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'pdf-revalidation-fixture',
    resolveId(id) {
      if (id === entry) return id
      if (id.endsWith('.css') || id.includes('.svg?') || id.includes('?worker')) return '\0empty'
      if (id === 'pdfjs-dist/legacy/build/pdf.mjs') return '\0pdf'
    },
    load(id) {
      if (id === '\0empty') return 'export default ""'
      if (id === '\0pdf') return `
        export * from ${JSON.stringify(pdfModule)}
        import {getDocument as load} from ${JSON.stringify(pdfModule)}
        export function getDocument(options) {
          const task = load(options), f = window.fixture
          f.tasks.push(task.docId)
          const destroy = task.destroy.bind(task)
          task.destroy = () => { f.destroyed.push(task.docId); return destroy() }
          void task.promise.then(document => {
            const getPage = document.getPage.bind(document)
            document.getPage = async number => {
              const page = await getPage(number)
              if (f.holdPages && task.docId === f.tasks.at(-1)) await new Promise(resolve => f.pages.push(resolve))
              return page
            }
          }).catch(() => {})
          return task
        }`
      if (id === entry) return `
        import {createRoot} from 'react-dom/client'
        import {flushSync} from 'react-dom'
        import {WorkerMessageHandler} from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
        import PDFViewer from './components/PDFViewer'
        import {apiURL} from './api'
        import {retainOpenPDFs} from './pdfCache'
        import {setPreferences} from './preferences'
        globalThis.pdfjsWorker = {WorkerMessageHandler}
        const f = window.fixture = {tasks:[], destroyed:[], pages:[], states:[], holdPages:false}
        const root = createRoot(document.getElementById('root'))
        let visible = true, path = 'one.pdf', revision = 0, force = 0, controller = new AbortController()
        const locations = ['one.pdf', 'two.pdf'].map(path => ({host:'fixture',root:'root',path}))
        f.open = () => retainOpenPDFs(locations.map(location => apiURL('file', location)))
        f.close = () => retainOpenPDFs([])
        f.open()
        const state = value => f.states.push(value)
        const render = () => flushSync(() => root.render(visible
          ? <PDFViewer location={{host:'fixture',root:'root',path}} refreshToken={revision} forceRefreshToken={force}
              refreshSignal={controller.signal} onRefreshState={state} renderActions={extra => extra}/>
          : null))
        f.show = () => {visible=true;render()}
        f.hide = () => {visible=false;render()}
        f.refresh = (forced=false) => {revision++;if(forced)force++;controller=new AbortController();render()}
        f.abort = () => controller.abort()
        f.navigate = next => {path=next;render()}
        f.compression = value => setPreferences({pdfCompression:value})
        f.releasePages = () => {f.holdPages=false;f.pages.splice(0).forEach(resolve=>resolve())}
        f.invalidate = name => window.dispatchEvent(new Event('artiface:'+name))
        render()
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const css = (await Promise.all(['styles.css', 'viewers.css', 'components/pdfFind.css', 'components/pdfNavigation.css', 'components/pdfOverview.css']
  .map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')

function pdf(version) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    ...Array.from({length:3}, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 900] /Resources << >> /Contents 6 0 R >>'),
  ]
  const content = `${version % 2 ? '0.1 0.4 0.3' : '0.8 0.2 0.1'} rg 0 0 600 900 re f\n`
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)
  let data = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(data.length)
    data += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = data.length
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  data += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  return Buffer.from(data + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

const origin = 'http://pdf-revalidation-fixture.invalid'
const browser = await (process.env.ARTIFACE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
try {
  for (const compression of [false, true]) {
    const context = await browser.newContext({ viewport: {width:1000,height:800}, serviceWorkers:'block' })
    context.setDefaultTimeout(8000)
    await context.addInitScript(compression => {
      localStorage.setItem('artiface.preferences.v1', JSON.stringify({pdfCompression:compression}))
      window.unhandled = []
      window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason)))
    }, compression)
    const errors = [], requests = [], heldMetadata = [], heldFiles = [], heldImages = []
    let version = 1, metadataStatus = 200, fileStatus = 200, networkFailure = false
    let holdMetadata = false, holdFile = false, holdImage = false
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.stack ?? error.message))
    let images
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/empty') return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Image fixture</title>'})
      if (url.pathname === '/') return route.fulfill({ contentType:'text/html', body:
        `<!doctype html><meta charset="utf-8"><style>${css}#root{height:760px;display:flex;flex-direction:column}.pdf-toolbar>button,.pdf-toolbar>label{display:none}</style><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script>` })
      const captured = {url:url.pathname + url.search, version, status:metadataStatus, fileStatus, networkFailure}
      requests.push(captured)
      if (url.pathname === '/api/file-info' || url.pathname === '/api/pdf/info') {
        if (holdMetadata) await new Promise(resolve => heldMetadata.push(resolve))
        if (captured.networkFailure) return route.abort('failed')
        if (captured.status !== 200) return route.fulfill({status:captured.status, json:{error:`Metadata failed (${captured.status})`}})
        return route.fulfill({json:compression
          ? {id:`v${captured.version}`,version:`v${captured.version}`,pages:3,width:600,height:900,size:1024}
          : {version:`v${captured.version}`,size:pdf(captured.version).length}})
      }
      if (url.pathname === '/api/file') {
        if (holdFile) await new Promise(resolve => heldFiles.push(resolve))
        return route.fulfill({status:captured.fileStatus, contentType:'application/pdf', body:pdf(captured.version)})
      }
      if (url.pathname === '/api/pdf/page') {
        if (holdImage && url.searchParams.get('document') === `v${captured.version}`) await new Promise(resolve => heldImages.push(resolve))
        if (captured.fileStatus !== 200) return route.fulfill({status:captured.fileStatus,json:{error:'Page transfer failed'}})
        const number = Number(url.searchParams.get('document').slice(1))
        return route.fulfill({contentType:'image/jpeg',headers:{'X-PDF-Width':'600','X-PDF-Height':'900'},body:images[number % 2]})
      }
      return route.abort()
    })
    // Prepare encoded image fixtures before mounting the Compression reader.
    await page.goto(origin + '/empty')
    images = await page.evaluate(async () => {
      const result = []
      for (const color of ['#cc331a', '#1a664d']) {
        const canvas = document.createElement('canvas')
        canvas.width=1200;canvas.height=1800
        const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,1200,1800)
        result.push([...new Uint8Array(await (await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.95))).arrayBuffer())])
      }
      return result
    }).then(images => images.map(image => Buffer.from(image)))
    await page.goto(origin)
    const visible = page.locator('.pdf-canvas-area:visible')
    const canvas = () => visible.locator('canvas').first()
    const ready = async (color = 'green') => {
      await expect(visible).toHaveAttribute('aria-busy','false')
      await expect.poll(() => canvas().evaluate(canvas => {
        if (!canvas.width) return ''
        const [red,green] = canvas.getContext('2d').getImageData(4,4,1,1).data
        return red > green ? 'red' : 'green'
      })).toBe(color)
    }
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const finish = async () => { await expect.poll(() => page.evaluate(() => window.fixture.states.at(-1)?.loading)).toBe(false) }
    const release = queue => queue.splice(0).forEach(resolve => resolve())
    const downloads = () => requests.filter(request => /^\/api\/(?:file\?|pdf\/page\?)/.test(request.url)).length
    const remember = () => canvas().evaluate(canvas => {window.previousCanvas=canvas})
    const unchanged = async () => assert(await canvas().evaluate(canvas => canvas === window.previousCanvas), 'Unchanged or pending revalidation replaced the visible canvas')
    const refresh = () => page.evaluate(() => window.fixture.refresh())
    const reenter = async () => {
      await page.evaluate(() => window.fixture.hide())
      await expect(visible).toHaveCount(0)
      await page.evaluate(() => window.fixture.show())
    }

    await ready()
    await page.getByRole('spinbutton',{name:'Page number',exact:true}).fill('3')
    await page.getByRole('spinbutton',{name:'Page number',exact:true}).press('Enter')
    await page.getByRole('combobox',{name:'PDF zoom',exact:true}).selectOption('2')
    await ready()
    await visible.evaluate(element => element.scrollTo({top:160,left:80}))
    await expect.poll(() => visible.evaluate(element => [element.scrollTop,element.scrollLeft])).toEqual([160,80])
    holdMetadata = true
    const beforeReturn = downloads()
    await reenter()
    await expect.poll(() => heldMetadata.length).toBe(1)
    await ready()
    assert.equal(downloads(), beforeReturn, 'Reentry fetched cached PDF bytes or the cached current JPEG')
    await expect(page.getByRole('spinbutton',{name:'Page number',exact:true})).toHaveValue('3')
    await expect(page.getByRole('combobox',{name:'PDF zoom',exact:true})).toHaveValue('2')
    await expect.poll(() => visible.evaluate(element => [element.scrollTop,element.scrollLeft])).toEqual([160,80])
    await remember()
    holdMetadata=false;release(heldMetadata)
    await finish();await unchanged()
    console.log(`PASS ${compression ? 'Compression' : 'Original'}: cached pixels/page/zoom/scroll before held metadata; unchanged keeps the canvas and avoids downloads`)

    version=2;holdMetadata=true;holdFile=true;holdImage=true
    await reenter();await ready();await remember()
    await expect.poll(() => heldMetadata.length).toBe(1)
    if (!compression) await page.evaluate(() => {window.fixture.holdPages=true})
    holdMetadata=false;release(heldMetadata)
    await expect.poll(() => compression ? heldImages.length : heldFiles.length).toBeGreaterThan(0)
    await ready();await unchanged()
    if (!compression) {
      holdFile=false;release(heldFiles)
      await expect.poll(() => page.evaluate(() => window.fixture.pages.length)).toBeGreaterThan(0)
    }
    await expect(page.locator('[inert] .pdf-canvas-area')).toHaveCount(1)
    await ready();await unchanged()
    await page.getByRole('spinbutton',{name:'Page number',exact:true}).fill('2')
    await page.getByRole('spinbutton',{name:'Page number',exact:true}).press('Enter')
    await expect(page.locator('[inert] .pdf-canvas-area')).toHaveAttribute('aria-label','PDF page 2 of 3')
    await ready()
    await visible.evaluate(element => element.scrollTo({top:160,left:80}))
    await expect.poll(() => visible.evaluate(element => [element.scrollTop,element.scrollLeft])).toEqual([160,80])
    await page.locator('[inert] canvas').first().evaluate(canvas => {window.stagedCanvas=canvas})
    holdImage=false;release(heldImages)
    await page.evaluate(() => window.fixture.releasePages())
    await ready('red');await finish()
    assert(await canvas().evaluate(canvas => canvas === window.stagedCanvas), 'Ready replacement canvas was remounted at adoption')
    await expect(page.getByRole('spinbutton',{name:'Page number',exact:true})).toHaveValue('2')
    await expect.poll(() => visible.evaluate(element => [element.scrollTop,element.scrollLeft])).toEqual([160,80])
    const afterChange=downloads()
    await remember();await refresh();await finish();await unchanged()
    assert.equal(downloads(),afterChange,'Changed bytes were not acknowledged after adoption')
    await page.evaluate(() => window.fixture.abort())
    await expect(page.getByRole('status')).toHaveCount(0)
    console.log(`PASS ${compression ? 'Compression' : 'Original'}: changed document keeps old pixels through download and page rendering, then swaps the ready canvas without losing position`)

    for (const failure of ['network',503]) {
      networkFailure=failure==='network';metadataStatus=failure===503 ? 503 : 200
      await refresh();await finish();await ready('red');await unchanged()
      await expect(page.getByRole('status')).toContainText('Showing the previous PDF')
      await reenter();await ready('red');await finish()
      await expect(page.getByRole('status')).toContainText('Showing the previous PDF')
      await remember()
    }
    networkFailure=false;metadataStatus=200;version=3;fileStatus=503
    await refresh();await finish();await ready('red')
    await expect(page.getByRole('status')).toContainText('Showing the previous PDF')
    const failedDownload=downloads()
    fileStatus=200
    await refresh();await ready();await finish()
    assert(downloads()>failedDownload,'Failed replacement stamped the new version onto old bytes and masked its retry')
    console.log(`PASS ${compression ? 'Compression' : 'Original'}: network/503 preserves stale content with notice; a failed replacement never masks the newer version`)

    for (const status of [401,403,404]) {
      metadataStatus=status
      await refresh()
      await expect(visible).toHaveCount(0)
      await expect(page.getByText('Couldn’t open this PDF',{exact:true})).toBeVisible()
      metadataStatus=200;holdMetadata=true
      await reenter()
      await expect.poll(() => heldMetadata.length).toBe(1)
      await settle()
      await expect(visible).toHaveCount(0)
      holdMetadata=false;release(heldMetadata)
      await ready();await finish()
    }
    for (const status of [401,403,404]) {
      version++;fileStatus=status
      await refresh()
      await expect(visible).toHaveCount(0)
      fileStatus=200
      await refresh();await ready(version % 2 ? 'green' : 'red');await finish()
    }
    version=3
    await refresh();await ready();await finish()
    for (const event of ['configuration-changed','unauthorized']) {
      holdMetadata=true
      await refresh()
      await expect.poll(() => heldMetadata.length).toBe(1)
      await page.evaluate(event => window.fixture.invalidate(event),event)
      await expect(visible).toHaveCount(0)
      holdMetadata=false;release(heldMetadata)
      await settle()
      await expect(visible).toHaveCount(0)
      await refresh();await ready();await finish()
    }
    console.log(`PASS ${compression ? 'Compression' : 'Original'}: 401/403/404 and source/trust/session invalidation evict cached and active content; late metadata cannot restore it`)

    version=4;metadataStatus=401;holdMetadata=true
    await refresh()
    await expect.poll(() => heldMetadata.length).toBe(1)
    await page.evaluate(() => window.fixture.abort())
    await ready()
    version=5;metadataStatus=200;holdMetadata=false
    await refresh();await ready();await finish()
    await remember()
    release(heldMetadata);await settle();await unchanged()
    version=6;holdFile=true;holdImage=true
    await refresh()
    await expect.poll(() => compression ? heldImages.length : heldFiles.length).toBeGreaterThan(0)
    await page.evaluate(() => window.fixture.hide())
    holdFile=false;holdImage=false;release(heldFiles);release(heldImages)
    await settle()
    version=5;holdMetadata=true
    await page.evaluate(() => window.fixture.show())
    await ready()
    holdMetadata=false;release(heldMetadata)
    await finish()
    await page.getByRole('spinbutton',{name:'Page number',exact:true}).fill('2')
    await page.getByRole('spinbutton',{name:'Page number',exact:true}).press('Enter')
    await page.getByRole('combobox',{name:'PDF zoom',exact:true}).selectOption('1.5')
    await ready()
    version=6;holdMetadata=true
    await page.evaluate(() => window.fixture.navigate('two.pdf'))
    await expect.poll(() => heldMetadata.length).toBe(1)
    await expect(visible).toHaveCount(0)
    holdMetadata=false;release(heldMetadata)
    await ready('red');await finish()
    await expect(page.getByRole('spinbutton',{name:'Page number',exact:true})).toHaveValue('1')
    version=5;holdMetadata=true
    await page.evaluate(() => window.fixture.navigate('one.pdf'))
    await expect.poll(() => heldMetadata.length).toBe(1)
    await ready()
    await expect(page.getByRole('spinbutton',{name:'Page number',exact:true})).toHaveValue('2')
    await expect(page.getByRole('combobox',{name:'PDF zoom',exact:true})).toHaveValue('1.5')
    holdMetadata=false;release(heldMetadata)
    await finish()
    await page.evaluate(() => window.fixture.close())
    await expect(visible).toHaveCount(0)
    await page.evaluate(() => {window.fixture.hide();window.fixture.open()})
    await settle()
    const resources = await page.evaluate(() => ({tasks:window.fixture.tasks,destroyed:window.fixture.destroyed}))
    assert.deepEqual([...resources.destroyed].sort(),[...resources.tasks].sort(),'Workers leaked or were destroyed twice')
    assert.deepEqual(errors,[])
    assert.deepEqual(await page.evaluate(() => window.unhandled),[])
    console.log(`PASS ${compression ? 'Compression' : 'Original'}: abort/supersede/unmount races retain only the last adopted version and close every worker exactly once`)
    await context.close()
  }
} finally {
  await browser.close()
}
