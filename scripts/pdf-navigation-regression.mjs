import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flattenOutline, outlinePage } from '../web/src/pdfOutline.ts'

const signal = () => new AbortController().signal
const calls = []
const document = { numPages: 12, async getDestination(name) { calls.push(name); return name === 'section' ? [{ num: 7, gen: 0 }] : null },
  async getPageIndex(ref) { calls.push(ref); return ref.num === 7 ? 8 : 12 } }
assert.equal(await outlinePage(document, [0, { name: 'Fit' }], signal()), 1)
assert.equal(await outlinePage(document, 'section', signal()), 9)
assert.deepEqual(calls, ['section', { num: 7, gen: 0 }])
for (const destination of [null, [], [-1], [12], [1.5], [Infinity], ['https://unsafe.invalid'], 'missing', [{ num: 99, gen: 0 }], [{ num: -1, gen: 0 }], [{ num: 7, gen: -1 }]]) {
  await assert.rejects(outlinePage(document, destination, signal()))
}
let release
const cancelled = new AbortController()
const pending = outlinePage({ ...document, getDestination: () => new Promise(resolve => { release = resolve }) }, 'held', cancelled.signal)
cancelled.abort(); release([2])
await assert.rejects(pending, { name: 'AbortError' })
const loop = { title: ' Loop ', dest: [0], items: [] }; loop.items.push(loop)
assert.deepEqual(flattenOutline([loop, { title: '<script>unsafe</script>', url: 'javascript:alert(1)' }]).items.map(item => [item.title, item.destination]),
  [['Loop', [0]], ['<script>unsafe</script>', null]])
assert.equal(flattenOutline(Array.from({ length: 501 }, (_, index) => ({ title: String(index), dest: [0] }))).items.length, 500)
let deep = { title: 'last', dest: [0] }
for (let index = 0; index < 40; index++) deep = { title: String(index), items: [deep] }
assert(flattenOutline([deep]).truncated)
assert.deepEqual(flattenOutline(null), { items: [], truncated: false })
console.log('PASS: Index/named/reference destinations, range validation, cancellation, unsafe links, cyclic/deep/large outlines, and empty outlines')

const repository = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { rolldown } = await import(require.resolve('rolldown'))
const { chromium, expect } = require('@playwright/test')
const outlineOnly = process.argv.includes('--outline-only')
const entry = join(repository, 'web/src/__pdf_navigation_fixture__.tsx')
const bundle = await rolldown({
  input: entry, platform: 'browser', logLevel: 'silent',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{
    name: 'pdf-navigation-fixture',
    resolveId(id, importer) {
      if (importer?.startsWith('\0') && ['react', 'react/jsx-runtime'].includes(id)) return require.resolve(id)
      if (id === entry) return id
      if (id.endsWith('.css') || id.includes('?worker') || id.includes('.svg?') || id.endsWith('pdfCompatibility')) return '\0empty'
      if (id === 'pdfjs-dist/legacy/build/pdf.mjs') return '\0pdf'
      if (id === '../api' || id === './api') return '\0api'
      if (id === './PDFPages') return '\0pages'
    },
    load(id) {
      if (id === '\0empty') return 'export default ""'
      if (id === '\0api') return `
        export class APIError extends Error { constructor(message,status=503) {super(message);this.status=status} }
        export const apiURL = (kind, location, download) => '/api/' + kind + '?' + new URLSearchParams({...location, ...(download ? {download:'1'} : {})})
        export const errorMessage = error => error.message
        export const isAborted = error => error?.name === 'AbortError'
        export const sessionExpired = () => {window.fixture.sessionExpirations++}
        export async function api(url, options={}) {
          const f = window.fixture
          f.requests.push(url)
          if (url.startsWith('/api/pdf/outline?')) {
            f.outlineSignal=options.signal
            if(f.failCompressedOutline) throw new APIError('Synthetic compressed outline failure')
            const result=f.compressedOutline
            return f.holdCompressedOutline ? new Promise(resolve=>{f.releaseCompressedOutline=()=>resolve(result)}) : result
          }
          if (url === '/api/pdf/info') {
            if(f.failureConfig?.infoStatus) throw new APIError('Synthetic compression failure',f.failureConfig.infoStatus)
            const result={id:f.infoVersion ? String(f.infoVersion).padStart(32,'0') : '0123456789abcdef0123456789abcdef',
              pages:1200, width:600, height:800, version:'v'+(f.infoVersion||0), size:1024}
            return f.holdInfo ? new Promise(resolve=>{f.releaseInfo=()=>{f.releaseInfo=null;resolve(result)}}) : result
          }
          if (url.startsWith('/api/file-info?')) {
            if(f.failureConfig?.metadataStatus) throw new APIError('Synthetic metadata failure',f.failureConfig.metadataStatus)
            return {size:f.failureConfig?.size ?? 1024, version:'v1'}
          }
          throw new Error('Unexpected API: ' + url)
        }`
      if (id === '\0pages') return `
        import {createElement, useEffect, useRef} from 'react'
        export default function PDFPages(props) {
          const position = useRef(props.initialPosition)
          window.fixture.readerDocument = props.document
          window.fixture.position = position
          window.fixture.move = next => { position.current = {...position.current, ...next}; props.onPosition(position.current) }
          useEffect(() => { position.current = props.request }, [props.request])
          useEffect(() => { props.onState({loading:false,scale:1}) }, [props.onState])
          useEffect(() => () => props.onLeave(position.current), [props.onLeave])
          return createElement('div', {className:'pdf-canvas-area', tabIndex:0, 'data-current-page':props.request.page,
            'data-zoom':props.zoom, 'data-initial-top':props.initialPosition.top, 'data-initial-left':props.initialPosition.left}, 'Reader page ' + props.request.page)
        }`
      if (id === '\0pdf') return `
        export const GlobalWorkerOptions = {}
        export const AnnotationMode = {ENABLE:1, DISABLE:0}
        const expired = {status:401, message:'Synthetic session expired'}
        export function makeDocument() {
          const f = window.fixture
          const docId = 'doc-' + (++f.serial)
          const task = {docId, destroy:async () => {f.destroyed.push(docId)}}
          const document = {numPages:1200, loadingTask:task,
            getOutline() {
              f.outlineReads++
              if (f.unauthorized === 'Outline') return Promise.reject(expired)
              return f.holdOutline ? new Promise((resolve,reject) => {f.releaseOutline=()=>resolve(f.outline);f.rejectOutline=()=>reject(expired)}) : Promise.resolve(f.outline)
            },
            getDestination(name) {
              f.destinations.push(name)
              if (f.unauthorized === 'Destination') return Promise.reject(expired)
              return f.holdDestination ? new Promise((resolve,reject) => {f.releaseDestination=()=>resolve([5]);f.rejectDestination=()=>reject(expired)}) : Promise.resolve([5])
            },
            getPageIndex(ref) {f.references.push(ref); return Promise.resolve(8)},
            getPage(number) {
              f.pages.push(number)
              const page = {rotate:0, getViewport({scale,rotation=0}) {return {width:(rotation%180?800:600)*scale,height:(rotation%180?600:800)*scale}},
                render() {f.renders.push(number); let reject
                  return {promise:f.holdRender ? new Promise((resolve, fail) => {reject=fail}) : Promise.resolve(),
                    cancel() {f.cancelled.push(number); reject?.(Object.assign(new Error('cancelled'),{name:'RenderingCancelledException'}))}}},
                cleanup() {f.cleaned.push(number)}}
              return f.holdPages ? new Promise(resolve => {f.releasePages.push(() => resolve(page))}) : Promise.resolve(page)
            }}
          task.promise = Promise.resolve(document)
          return document
        }
        export function getDocument(options) {
          const f=window.fixture
          f.originalLoads.push(options.url)
          if(f.failureConfig) {
            const failure=Object.assign(new Error('Synthetic PDF load failure'),f.failureConfig.pdfError)
            return {docId:'failed-'+(++f.serial),destroy:async()=>{},promise:Promise.reject(failure)}
          }
          return makeDocument().loadingTask
        }`
      if (id === entry) return `
        import {createRoot} from 'react-dom/client'
        import {flushSync} from 'react-dom'
        import PDFNavigation from './components/PDFNavigation'
        ${outlineOnly ? '' : "import PDFViewer from './components/PDFViewer'"}
        import ReaderActions from './components/ReaderActions'
        import {makeDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
        import {setPreferences} from './preferences'
        window.fixture = {serial:0, outlineReads:0, sessionExpirations:0, destinations:[], references:[], jumps:[], requests:[], originalLoads:[],
          pages:[], renders:[], cancelled:[], cleaned:[], destroyed:[], releasePages:[],
          compressedOutline:{items:[{title:'Server section',depth:0,page:77},{title:'External server link',depth:1,page:null},{title:'Invalid server page',depth:1,page:1201}],truncated:false},
          outline:[{title:'Index',dest:[0]},{title:'Named',dest:'section'},{title:'Reference',dest:[{num:7,gen:0}]},
            {title:'Outside',dest:[1200]},{title:'External',url:'https://unsafe.invalid'},{title:'<img src=x onerror=alert(1)>',dest:[1]}]}
        const f = window.fixture, root = createRoot(document.getElementById('root'))
        let source = makeDocument(), mode = 'navigation', revision = 0, viewerKey = 0
        const render = () => flushSync(() => root.render(mode === 'navigation'
          ? <div className="pdf-toolbar"><PDFNavigation document={source} onPage={page => f.jumps.push(page)}
              onOverview={() => f.overviews=(f.overviews||0)+1} onOriginal={() => f.originalRequested=true}/></div>
          : ${outlineOnly ? 'null' : `<PDFViewer key={viewerKey} location={{host:'fixture',root:'root',path:viewerKey ? 'error-'+viewerKey+'.pdf' : 'one.pdf'}} refreshToken={revision}
              renderActions={extra => <div className="file-actions"><ReaderActions paused busy={false} interval={10}
                onPause={() => {}} onRefresh={() => {}} copied={false} onCopy={() => {}} downloadURL="/original.pdf" name="one.pdf" extra={extra}/>
                <button className="icon-button expand-button" aria-label="Full screen" title="Full screen">↗</button></div>}/>`}))
        f.replace = () => {source=makeDocument(); render()}
        f.viewer = () => {mode='viewer'; render()}
        f.unmount = () => flushSync(() => root.render(null))
        f.refresh = () => {revision++;f.infoVersion=revision;render()}
        f.errorViewer = config => {f.failureConfig=config;setPreferences({pdfCompression:Boolean(config.compression)});viewerKey++;mode='viewer';render()}
        f.preferences = setPreferences
        render()
      `
    },
  }],
})
const output = await bundle.generate({ format: 'iife' })
await bundle.close()
const script = output.output.find(item => item.type === 'chunk').code
const styles = ['styles.css', 'viewers.css', 'components/pdfNavigation.css', ...(outlineOnly ? [] : ['components/pdfOverview.css'])]
const css = (await Promise.all(styles.map(path => readFile(join(repository, 'web/src', path), 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
const origin = 'http://pdf-navigation-fixture.invalid'
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, hasTouch: true, serviceWorkers: 'block' })
  context.setDefaultTimeout(5000)
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const compressedRequests = [], releaseImages = []
  let jpeg = '', delayImages = false, cancelledImages = 0
  page.on('requestfailed', request => { if (request.url().includes('/api/pdf/page?')) cancelledImages++ })
  await page.route('**/*', async route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/api/pdf/page?')) {
      compressedRequests.push(url)
      if (delayImages) await new Promise(resolve => releaseImages.push(resolve))
      return route.fulfill({contentType:'image/jpeg', headers:{'X-PDF-Width':'600','X-PDF-Height':'800'},body:Buffer.from(jpeg,'base64')})
    }
    return url === origin + '/' ? route.fulfill({ contentType:'text/html', body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}#root{height:650px;display:flex;flex-direction:column}</style><button id="outside">Outside control</button><div id="root"></div><script>${script.replaceAll('</script','<\\/script')}</script>` }) : route.abort()
  })
  await page.goto(origin + '/#host=fixture&root=root&path=one.pdf&kind=file')
  const route = page.url(), trigger = page.getByRole('button', { name:'PDF outline and pages', exact:true })
  const popup = page.getByRole('dialog', { name:'PDF navigation', exact:true })
  const outline = page.getByRole('navigation', { name:'PDF outline', exact:true })
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const open = async () => { await trigger.click(); await expect(popup).toBeVisible() }
  assert.equal(await page.evaluate(() => window.fixture.outlineReads), 0)
  for (const [name, expected] of [['Index',1],['Named',6],['Reference',9]]) {
    await open(); await outline.getByRole('button',{name,exact:true}).click()
    await expect(popup).toHaveCount(0)
    assert.equal(await page.evaluate(() => window.fixture.jumps.at(-1)), expected)
    assert.equal(page.url(), route)
  }
  assert.equal(await page.evaluate(() => window.fixture.outlineReads), 1, 'Reopening fetched all bookmarks again')
  await open()
  await expect(popup.getByRole('button', { name: 'Close PDF navigation', exact: true })).toBeFocused()
  const firstBookmark = outline.getByRole('button', { name: 'Index', exact: true })
  await firstBookmark.focus()
  const bookmarkActivity = () => page.evaluate(() => Object.fromEntries(
    ['outlineReads', 'destinations', 'references', 'jumps', 'requests', 'originalLoads'].map(key => [key, window.fixture[key]])))
  const beforeKeyboard = await bookmarkActivity()
  await page.keyboard.press('ArrowDown')
  await expect(outline.getByRole('button', { name: 'Named', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(firstBookmark).toBeFocused()
  await page.keyboard.press('End')
  await expect(outline.locator('button:not(:disabled)').last()).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(outline.getByRole('button', { name: 'Outside', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowUp')
  await expect(firstBookmark).toBeFocused()
  for (const properties of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
    assert(await firstBookmark.evaluate((element, properties) => element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'End', bubbles: true, cancelable: true, ...properties,
    })), properties), 'Outline consumed a modified or composing key')
    await expect(firstBookmark).toBeFocused()
  }
  assert.deepEqual(await bookmarkActivity(), beforeKeyboard, 'Moving outline focus resolved or loaded a page')
  assert.equal(page.url(), route)
  await page.keyboard.press('Enter')
  await expect(popup).toHaveCount(0)
  assert.equal(await page.evaluate(() => window.fixture.jumps.at(-1)), 1)
  await open()
  await firstBookmark.focus()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  console.log('PASS: PDF outline arrows/Home/End skip unavailable bookmarks without reads or navigation; modifiers, Enter and Escape remain intact')

  await open()
  assert(await popup.evaluate(element=>!element.closest('.pdf-toolbar')), 'Popup remained inside toolbar containment')
  await expect(outline.getByRole('button',{name:'External',exact:true})).toBeDisabled()
  await expect(outline.locator('a,img,script')).toHaveCount(0)
  await outline.getByRole('button',{name:'Outside',exact:true}).click()
  await expect(popup).toContainText('outside the document')
  await page.setViewportSize({width:320,height:740})
  await page.evaluate(() => window.fixture.preferences({fontScale:1.4}))
  await settle()
  assert(await popup.evaluate(element => {const r=element.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}), 'Navigation popup escapes 320px viewport')
  await page.keyboard.press('Escape'); await expect(popup).toHaveCount(0); await expect(trigger).toBeFocused()
  await open(); await page.locator('#outside').click(); await expect(popup).toHaveCount(0)
  await page.evaluate(() => {window.fixture.outline=null;window.fixture.replace()})
  await open(); await expect(popup).toContainText('no outline'); await page.getByRole('button',{name:'Page overview',exact:true}).click()
  assert.equal(await page.evaluate(() => window.fixture.overviews), 1)
  await page.evaluate(() => {window.fixture.holdOutline=true;window.fixture.replace()})
  await open(); await expect(popup).toContainText('Loading outline')
  await page.keyboard.press('Escape')
  await page.evaluate(() => {window.fixture.releaseOutline();window.fixture.holdOutline=false})
  await settle(); await expect(popup).toHaveCount(0)
  await page.evaluate(() => {window.fixture.outline=[{title:'Named',dest:'held'}];window.fixture.replace()})
  for (const close of ['escape','outside','replace']) {
    await open(); await page.evaluate(() => {window.fixture.holdDestination=true})
    const before = await page.evaluate(() => window.fixture.jumps.length)
    await outline.getByRole('button',{name:'Named',exact:true}).click()
    await page.waitForFunction(() => window.fixture.releaseDestination)
    if (close === 'escape') await page.keyboard.press('Escape')
    else if (close === 'outside') await page.locator('#outside').click()
    else await page.evaluate(() => window.fixture.replace())
    await expect(popup).toHaveCount(0)
    await page.evaluate(() => {window.fixture.releaseDestination();window.fixture.releaseDestination=null;window.fixture.holdDestination=false})
    await settle()
    assert.equal(await page.evaluate(() => window.fixture.jumps.length), before, `A late bookmark jumped after ${close}`)
  }
  for (const operation of ['Outline','Destination']) {
    const before = await page.evaluate(() => window.fixture.sessionExpirations)
    const jumps = await page.evaluate(() => window.fixture.jumps.length)
    await page.evaluate(operation => {window.fixture.unauthorized=operation;window.fixture.replace()}, operation)
    await open()
    if (operation === 'Destination') await outline.getByRole('button',{name:'Named',exact:true}).click()
    await expect(popup).toContainText('Synthetic session expired')
    assert.equal(await page.evaluate(() => window.fixture.sessionExpirations), before+1, `${operation} 401 did not expire the session once`)
    await page.keyboard.press('Escape')
    for (const close of ['escape','replace']) {
      await page.evaluate(operation => {
        const f=window.fixture
        f.unauthorized=null;f['hold'+operation]=true;f['reject'+operation]=null;f.replace()
      }, operation)
      await open()
      if (operation === 'Destination') await outline.getByRole('button',{name:'Named',exact:true}).click()
      await page.waitForFunction(operation => window.fixture['reject'+operation], operation)
      if (close === 'escape') await page.keyboard.press('Escape')
      else await page.evaluate(() => window.fixture.replace())
      await expect(popup).toHaveCount(0)
      await page.evaluate(operation => {window.fixture['reject'+operation]();window.fixture['hold'+operation]=false}, operation)
      await settle()
      assert.equal(await page.evaluate(() => window.fixture.sessionExpirations), before+1, `Late ${operation} 401 expired the session after ${close}`)
      await expect(popup).toHaveCount(0)
    }
    assert.equal(await page.evaluate(() => window.fixture.jumps.length), jumps, `${operation} 401 changed the page`)
    assert.equal(page.url(), route)
  }
  console.log('PASS: Original outline/destination 401 expires the session; late 401 after dismissal or document replacement does not')
  assert.deepEqual(errors, [])
  console.log('PASS: Popup destinations/route safety, no outline, Escape/outside/focus, narrow large text, and late bookmark cancellation')
  if (!outlineOnly) {
    await page.setViewportSize({width:1000,height:800})
    await page.evaluate(() => {window.fixture.preferences({fontScale:1,pdfCompression:false});window.fixture.viewer()})
    const reader = page.locator('.pdf-canvas-area'), zoom = page.getByRole('combobox',{name:'PDF zoom',exact:true})
    const overview = page.getByRole('region',{name:'PDF page overview',exact:true})
    const showPages = async () => {await open();await popup.getByRole('button',{name:'Page overview',exact:true}).click();await expect(overview).toBeVisible()}
    const closePages = async () => {await page.getByRole('button',{name:'Return to page',exact:true}).click();await expect(reader).toBeVisible();await settle()}
    const refresh = async () => {
      await page.evaluate(() => {
        const f=window.fixture
        f.previousDocument=f.readerDocument;f.holdInfo=true;f.refresh()
      })
      await page.waitForFunction(() => window.fixture.releaseInfo)
      assert(await page.evaluate(() => window.fixture.readerDocument === window.fixture.previousDocument), 'Pending refresh replaced the readable document')
      await page.evaluate(() => {window.fixture.holdInfo=false;window.fixture.releaseInfo()})
      await page.waitForFunction(() => window.fixture.readerDocument !== window.fixture.previousDocument)
    }
    await expect(reader).toBeVisible()
    assert(await trigger.evaluate(element=>Boolean(element.closest('.pdf-page-controls'))), 'Page-count trigger added a separate toolbar column')
    await zoom.selectOption('1.5')
    await page.evaluate(() => window.fixture.move({page:9,top:337,left:21}))
    await showPages()
    await expect(overview.getByRole('button',{name:'Open page 9',exact:true})).toBeFocused()
    await expect(overview.locator('canvas.is-ready').first()).toBeVisible()
    assert(await overview.locator('[data-thumbnail-page]').count() < 50)
    assert(await page.evaluate(() => window.fixture.pages.length) < 50, 'Overview fetched all 1,200 pages')
    await closePages()
    await expect(zoom).toHaveValue('1.5')
    await expect(reader).toHaveAttribute('data-initial-top','337')
    await expect(reader).toHaveAttribute('data-initial-left','21')
    await showPages()
    await overview.getByRole('button',{name:'Open page 12',exact:true}).click()
    await expect(reader).toHaveAttribute('data-current-page','12')
    await expect(zoom).toHaveValue('1.5')
    assert.equal(page.url(),route)
    assert.equal(await page.evaluate(() => window.fixture.originalLoads.length),1)
    assert.deepEqual(await page.evaluate(() => window.fixture.destroyed),[])
    console.log('PASS: Actual PDFViewer overview keeps zoom/close position, selects pages without routing, and bounds the mounted/fetched thumbnails')

    await page.evaluate(() => {window.fixture.holdPages=true;window.fixture.releasePages=[]})
    const rendersBefore = await page.evaluate(() => window.fixture.renders.length)
    await showPages()
    await page.waitForFunction(() => window.fixture.releasePages.length === 2)
    await closePages()
    await page.evaluate(() => {window.fixture.holdPages=false;window.fixture.releasePages.forEach(release => release())})
    await settle()
    assert.equal(await page.evaluate(() => window.fixture.renders.length),rendersBefore, 'Closed overview rendered a late getPage')
    await page.evaluate(() => {window.fixture.holdRender=true})
    const cancelBefore = await page.evaluate(() => window.fixture.cancelled.length)
    await showPages()
    await page.waitForFunction(before => window.fixture.renders.length === before+2,rendersBefore)
    await closePages()
    await expect.poll(() => page.evaluate(() => window.fixture.cancelled.length)).toBe(cancelBefore+2)
    await page.evaluate(() => {window.fixture.holdRender=false})
    await showPages()
    await page.keyboard.press('End')
    await expect(overview.getByRole('button',{name:'Open page 1200',exact:true})).toBeFocused()
    assert(await overview.locator('[data-thumbnail-page]').count() < 50)
    await page.setViewportSize({width:320,height:740})
    await page.evaluate(() => window.fixture.preferences({fontScale:1.4}))
    await settle()
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Overview overflows at 320px / 140% text')
    await page.keyboard.press('Escape'); await expect(reader).toBeFocused()
    console.log('PASS: Two-job thumbnail bound, late-page/render cancellation, virtualized last-page keyboard access, narrow large text and Escape')

    jpeg = await page.evaluate(() => {const canvas=document.createElement('canvas');canvas.width=12;canvas.height=16;return canvas.toDataURL('image/jpeg').split(',')[1]})
    await page.evaluate(() => window.fixture.preferences({pdfCompression:true}))
    await expect(page.locator('.pdf-compression')).toBeVisible()
    await open()
    await expect(outline.getByRole('button',{name:'Server section',exact:true})).toBeVisible()
    await expect(popup.getByRole('button',{name:'Use Original mode',exact:true})).toHaveCount(0)
    for (const name of ['External server link','Invalid server page']) {
      const bookmark=outline.getByRole('button',{name,exact:true})
      if(await bookmark.count()) await expect(bookmark).toBeDisabled()
    }
    await outline.getByRole('button',{name:'Server section',exact:true}).click()
    await expect(reader).toHaveAttribute('data-current-page','77')
    assert.equal(page.url(),route)
    const outlineURL=await page.evaluate(()=>window.fixture.requests.find(url=>url.startsWith('/api/pdf/outline?')))
    assert.equal(new URL(outlineURL,origin).searchParams.get('document'),'0123456789abcdef0123456789abcdef')
    await page.evaluate(()=>{window.fixture.compressedOutline={items:[],truncated:false}});await refresh()
    await open();await expect(popup).toContainText('no outline')
    await expect(popup.getByRole('button',{name:'Use Original mode',exact:true})).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.evaluate(()=>{window.fixture.failCompressedOutline=true});await refresh()
    await open();await expect(popup).toContainText('Synthetic compressed outline failure')
    await expect(popup.getByRole('button',{name:'Use Original mode',exact:true})).toBeVisible()
    await page.keyboard.press('Escape')
    await page.evaluate(()=>{window.fixture.failCompressedOutline=false;window.fixture.holdCompressedOutline=true});await refresh()
    await open();await page.waitForFunction(()=>window.fixture.releaseCompressedOutline)
    await page.keyboard.press('Escape')
    assert(await page.evaluate(()=>window.fixture.outlineSignal.aborted))
    await page.evaluate(()=>{window.fixture.releaseCompressedOutline();window.fixture.holdCompressedOutline=false;window.fixture.compressedOutline={items:[{title:'Fresh server section',depth:0,page:88}],truncated:false}})
    await settle();await open();await expect(outline.getByRole('button',{name:'Fresh server section',exact:true})).toBeVisible()
    await page.keyboard.press('Escape')
    await showPages()
    await expect(overview.locator('canvas.is-ready').first()).toBeVisible()
    await expect(overview.locator('.pdf-overview-placeholder')).toHaveCount(0)
    assert(compressedRequests.length > 0 && compressedRequests.length < 30)
    assert(compressedRequests.every(url => new URL(url).searchParams.get('size') === '320'))
    assert.equal(await page.evaluate(() => window.fixture.originalLoads.length),1, 'Compressed overview downloaded the Original PDF')
    await closePages()
    await page.getByRole('spinbutton',{name:'Page number',exact:true}).fill('500')
    await page.getByRole('spinbutton',{name:'Page number',exact:true}).press('Enter')
    await expect(reader).toHaveAttribute('data-current-page','500')
    delayImages=true
    const imagesBefore=compressedRequests.length
    const cancellationsBefore=cancelledImages
    await showPages()
    await expect.poll(() => compressedRequests.length).toBe(imagesBefore+2)
    await closePages()
    await expect.poll(() => cancelledImages).toBe(cancellationsBefore+2)
    delayImages=false;releaseImages.splice(0).forEach(release=>release())
    await settle()
    assert.equal(await page.evaluate(() => window.fixture.originalLoads.length),1)
    assert.deepEqual(errors,[])
    console.log('PASS: Compressed outlines navigate/cancel safely, fallback requires API failure, and 320px thumbnails cancel without fetching Original')

    await page.evaluate(() => window.fixture.preferences({fontScale:1.4,density:'comfortable'}))
    await settle()
    const toolbarHeight = await page.locator('.pdf-toolbar').evaluate(element => element.getBoundingClientRect().height)
    await showPages()
    const overviewToolbarHeight = await page.locator('.pdf-toolbar').evaluate(element => element.getBoundingClientRect().height)
    await closePages()
    // Change only the synthetic document's count to exercise the widest mobile page number.
    await page.evaluate(() => {
      window.fixture.readerDocument.numPages=99999
      window.fixture.preferences({fontScale:1.4,density:'comfortable'})
    })
    const pageNumber = page.getByRole('spinbutton',{name:'Page number',exact:true})
    await pageNumber.fill('50000')
    await pageNumber.press('Enter')
    await expect(reader).toHaveAttribute('data-current-page','50000')
    assert(await pageNumber.evaluate(input => {
      const style=getComputedStyle(input), text=document.createElement('span')
      text.style.cssText='position:fixed;visibility:hidden;white-space:pre'
      for (const property of ['fontFamily','fontSize','fontWeight','fontStyle','fontVariantNumeric','letterSpacing']) text.style[property]=style[property]
      text.textContent=input.value
      document.body.append(text)
      const width=text.getBoundingClientRect().width
      text.remove()
      const content=input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)
      return content+1>=width
    }), 'Enlarged page number does not fit its input')
    const toolbarFits = height => page.locator('.pdf-toolbar').evaluate((toolbar, height) => {
      const bounds=toolbar.getBoundingClientRect()
      const controls=[...toolbar.querySelectorAll('input,select,button')].filter(control=>control.getClientRects().length)
      return (height===undefined || bounds.height===height) && controls.every(control=>{
        const r=control.getBoundingClientRect()
        return r.left>=bounds.left && r.right<=bounds.right && r.width>=24 &&
          r.top>=bounds.top && r.bottom<=bounds.bottom &&
          control.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))
      })
    }, height)
    assert(await toolbarFits(toolbarHeight), 'Page number pushed essential controls out of the single-row toolbar')
    await showPages()
    assert(await toolbarFits(overviewToolbarHeight), 'Overview pushed essential controls out of the single-row toolbar')
    await closePages()
    console.log('PASS: 320px five-digit page number fits at 140% text without hiding reading/overview controls or increasing toolbar height')

    await page.setViewportSize({width:820,height:900})
    await page.locator('#root').evaluate(element=>{element.style.width='420px'})
    await settle()
    assert(await toolbarFits(), 'Reading controls escaped a 420px pane in a wide viewport')
    await showPages()
    assert(await toolbarFits(), 'Overview controls escaped a 420px pane in a wide viewport')
    await closePages()
    await page.evaluate(() => window.fixture.preferences({fontScale:1}))
    await page.locator('#root').evaluate(element=>{element.style.width='421px'})
    await settle()
    assert(await toolbarFits(), 'Reading controls escaped just above the minimum reader width')
    await showPages()
    assert(await toolbarFits(), 'Overview controls escaped just above the minimum reader width')
    await closePages()
    await page.evaluate(() => window.fixture.preferences({fontScale:1.4}))
    await page.locator('#root').evaluate(element=>{element.style.width=''})
    await page.setViewportSize({width:320,height:740})
    console.log('PASS: PDF controls fit the reader pane independently of viewport width')

    const committedZoom = await zoom.inputValue()
    for (const [value, committed] of [['17','17'],['17','17'],['','1'],['-8','1'],['2.6','3'],['100000','99999']]) {
      await pageNumber.fill(value)
      await pageNumber.press('Enter')
      await expect(reader).toBeFocused()
      await expect(pageNumber).toHaveValue(committed)
      await expect(reader).toHaveAttribute('data-current-page',committed)
    }
    await showPages()
    await pageNumber.fill('19')
    await pageNumber.press('Enter')
    await expect(overview).toHaveCount(0)
    await expect(reader).toBeFocused()
    await expect(reader).toHaveAttribute('data-current-page','19')
    await expect(zoom).toHaveValue(committedZoom)
    await pageNumber.fill('23')
    await zoom.click()
    await page.keyboard.press('Escape')
    await expect(zoom).toBeFocused()
    await expect(reader).toHaveAttribute('data-current-page','23')
    await pageNumber.fill('24')
    await pageNumber.press('Tab')
    await expect(trigger).toBeFocused()
    await expect(reader).toHaveAttribute('data-current-page','24')
    await pageNumber.fill('25')
    for (const properties of [{altKey:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},{isComposing:true},{prevented:true}]) {
      const unhandled = await pageNumber.evaluate((input,properties) => {
        const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...properties})
        if(properties.prevented) event.preventDefault()
        input.dispatchEvent(event)
        return !event.defaultPrevented
      },properties)
      assert.equal(unhandled,!properties.prevented,'Page Enter consumed a modified/composing key')
      await expect(pageNumber).toBeFocused()
      await expect(reader).toHaveAttribute('data-current-page','24')
    }
    // Interrupt while blur commits, before the reader's layout effect can restore focus.
    for (const intent of ['focus','focus-then-blur','pointer','key','window','unmount']) {
      await pageNumber.fill('26')
      await pageNumber.evaluate((input,intent) => input.addEventListener('blur',() => {
        const outside=document.getElementById('outside')
        if(intent==='focus' || intent==='focus-then-blur') {
          outside.focus()
          if(intent==='focus-then-blur') outside.blur()
        } else if(intent==='pointer') document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))
        else if(intent==='key') document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))
        else if(intent==='window') {window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'))}
        else {window.fixture.unmount();outside.focus()}
      },{once:true}),intent)
      await pageNumber.press('Enter')
      await settle()
      if(intent==='unmount') {
        await expect(reader).toHaveCount(0)
        await expect(page.locator('#outside')).toBeFocused()
      } else {
        await expect(reader).not.toBeFocused()
        await expect(reader).toHaveAttribute('data-current-page','26')
      }
    }
    await page.evaluate(() => window.fixture.viewer())
    await expect(reader).toBeVisible()
    console.log('PASS: Page Enter restores reading focus after commit, preserves validation/zoom/overview and pointer/Tab focus, and respects composition/modifiers and newer focus/input/window/unmount intent')

    const fatal = page.locator('.error-state')
    const download = fatal.getByRole('link', {name:'Download original',exact:true})
    for (const [name, config, available] of [
      ['password protected', {pdfError:{name:'PasswordException'}}, true],
      ['invalid existing file', {pdfError:{name:'InvalidPDFException'}}, true],
      ['empty existing file', {size:0,pdfError:{name:'InvalidPDFException'}}, true],
      ['file transfer failed after metadata', {pdfError:{status:503}}, true],
      ['metadata unavailable', {metadataStatus:503}, false],
      ['missing file', {metadataStatus:404}, false],
      ['expired metadata access', {metadataStatus:401}, false],
      ['denied metadata access', {metadataStatus:403}, false],
      ['file disappeared after metadata', {pdfError:{status:404}}, false],
      ['file access expired after metadata', {pdfError:{status:401}}, false],
      ['file access denied after metadata', {pdfError:{status:403}}, false],
      ['compression failed without metadata', {compression:true,infoStatus:503}, false],
    ]) {
      const expirations = await page.evaluate(() => window.fixture.sessionExpirations)
      await page.evaluate(config => window.fixture.errorViewer(config), config)
      await expect(fatal).toBeVisible()
      await expect(fatal.getByRole('button',{name:'Try again',exact:true})).toBeVisible()
      await expect(download, name).toHaveCount(available ? 1 : 0)
      if (available) {
        await expect(download).toBeVisible()
        const link = new URL(await download.getAttribute('href'), origin)
        assert.equal(link.pathname, '/api/file')
        assert.equal(link.searchParams.get('download'), '1')
        assert.equal(link.searchParams.get('host'), 'fixture')
        assert.equal(link.searchParams.get('root'), 'root')
        assert.equal(await download.getAttribute('download'), link.searchParams.get('path'))
      }
      if (name === 'password protected') await expect(fatal).toContainText('password protected')
      if (name === 'missing file') await expect(fatal).toContainText('No PDF was found')
      if (config.metadataStatus === 401 || config.pdfError?.status === 401) {
        assert.equal(await page.evaluate(() => window.fixture.sessionExpirations), expirations + 1, name)
      }
    }
    await page.evaluate(() => window.fixture.errorViewer({pdfError:{name:'PasswordException'}}))
    await expect(download).toBeVisible()
    await page.evaluate(() => {window.fixture.failureConfig={metadataStatus:404}})
    await fatal.getByRole('button',{name:'Try again',exact:true}).click()
    await expect(fatal).toContainText('No PDF was found')
    await expect(download).toHaveCount(0)
    assert.deepEqual(errors,[])
    console.log('PASS: PDF recovery requires existing-file metadata, includes zero-byte files, clears stale retry/access evidence, and preserves download/auth flow')
  }
} finally { await browser.close() }
