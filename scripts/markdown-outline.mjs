import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const web = fileURLToPath(new URL('../web', import.meta.url))
const origin = 'https://markdown-outline.invalid'
const notes = { host: 'fixture', root: 'reports', path: 'notes.md', kind: 'file' }
const figures = { ...notes, path: 'figures.md' }
const richText = [
  '# Intro **formatted**',
  '```js\nconst selected = "<safe>";\n```',
  '## **Details**',
  ...Array.from({ length: 16 }, (_, i) => `Paragraph ${i}. ${'Readable synthetic content. '.repeat(14)}`),
  '### `Child code`',
  '## Details',
  '## Résumé Δ',
  '## Math $x^2$',
  '## ![Diagram](plot.svg)',
].join('\n\n')

async function buildReader() {
  const bundle = await rolldown({
    cwd: web, input: 'fixture:outline', platform: 'browser',
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
    onLog(level, log, next) { if (log.code !== 'MODULE_LEVEL_DIRECTIVE') next(level, log) },
    plugins: [{
      name: 'markdown-outline-fixture',
      resolveId(id) {
        if (id === 'fixture:outline') return '\0fixture'
        if (id === 'react-markdown') return '\0markdown'
        if (id === './PDFViewer') return '\0pdf'
        if (id === './useSourceHighlight') return '\0highlight'
        if (id.endsWith('.css') || id.includes('.svg?')) return '\0asset'
      },
      load(id) {
        if (id === '\0asset') return 'export default ""'
        if (id === '\0pdf') return 'export default function PDF(){return null}'
        if (id === '\0highlight') return 'export const useSourceHighlight = () => null'
        if (id === '\0markdown') return `
          import React from 'react'
          import Markdown from ${JSON.stringify(require.resolve('react-markdown'))}
          export default function CountedMarkdown(props) {
            window.markdownRuns = (window.markdownRuns || 0) + 1
            return React.createElement(Markdown, props)
          }`
        if (id === '\0fixture') return `
          import React, {useState} from 'react'
          import {createRoot} from 'react-dom/client'
          import {flushSync} from 'react-dom'
          import FilePreview from ${JSON.stringify(`${web}/src/components/FilePreview.tsx`)}
          import {setPreferences} from ${JSON.stringify(`${web}/src/preferences.ts`)}
          import {retainOpenReaderViews} from ${JSON.stringify(`${web}/src/components/useReaderView.tsx`)}
          import {apiURL} from ${JSON.stringify(`${web}/src/api.ts`)}
          const initial=${JSON.stringify(notes)}
          retainOpenReaderViews([initial,{...initial,path:'figures.md'}].map(file=>apiURL('file',file)))
          window.setReaderPreferences=setPreferences
          function Fixture() {
            const [location,setLocation]=useState(initial)
            const [refreshToken,setRefreshToken]=useState(0)
            window.showFile=next=>flushSync(()=>setLocation(next))
            window.changeMarkdown=text=>{
              window.fixtureFiles['notes.md']={text,version:String(++window.fixtureVersion)}
              flushSync(()=>setRefreshToken(value=>value+1))
            }
            return React.createElement(FilePreview,{
              location,refreshToken,copied:false,autoRefreshPaused:true,onNavigate(){},onCopyLink(){},
              onExpand(){document.getElementById('workspace').classList.add('reader-expanded')}
            })
          }
          createRoot(document.getElementById('root')).render(React.createElement(Fixture))
        `
      },
    }],
  })
  try {
    return (await bundle.generate({ format: 'iife', codeSplitting: false })).output.find(item => item.type === 'chunk').code
  } finally { await bundle.close() }
}

export async function checkMarkdownOutline({ browser }) {
  const code = await buildReader()
  const css = (await Promise.all(['styles.css', 'viewers.css', 'components/markdownOutline.css']
    .map(path => readFile(`${web}/src/${path}`, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '')
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(5000)
  const page = await context.newPage()
  const errors = []
  let held = false
  const images = []
  const image = height => ({ contentType: 'image/svg+xml', headers: { 'Cache-Control': 'no-store' },
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${height}"><rect width="300" height="${height}" fill="teal"/></svg>` })
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.href === `${origin}/`) return route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><button id="outside">Outside reader</button><div class="workspace-shell" id="workspace"><div class="project-content" style="height:600px"><div id="root" style="height:100%"></div></div></div>` })
    if (url.origin === origin && /^\/p\/notes-\d+\/plot.svg$/.test(url.pathname)) return route.fulfill(image(30))
    if (url.origin === origin && /^\/p\/figures-\d+\/plot.svg$/.test(url.pathname)) {
      if (held) { images.push(route); return }
      return route.fulfill(image(5000))
    }
    errors.push(`Unexpected fixture request: ${url.pathname}`)
    return route.abort()
  })
  try {
    await page.goto(`${origin}/#host=fixture&root=reports&path=notes.md&kind=file`)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(richText => {
      localStorage.setItem('artiface.preferences.v1', JSON.stringify({ autoRefreshSeconds: 300 }))
      window.fixtureVersion = 1
      window.fixtureFiles = {
        'notes.md': { text: richText, version: '1' },
        'figures.md': { text: '# Figures\n\n![Tall figure](plot.svg)\n\n## End', version: 'figure-1' },
      }
      window.observedMutations = []
      const Observer = MutationObserver
      window.MutationObserver = class extends Observer {
        constructor(callback) { super(callback); this.record = { active: false }; window.observedMutations.push(this.record) }
        observe(...args) { this.record.active = true; return super.observe(...args) }
        disconnect() { this.record.active = false; return super.disconnect() }
      }
      let preview = 0
      window.fetch = async (address, options = {}) => {
        const url = new URL(address, location.href)
        const path = url.pathname === '/api/preview' ? JSON.parse(options.body).path : url.searchParams.get('path')
        const file = window.fixtureFiles[path]
        let body
        if (url.pathname === '/api/text') body = { ...file, size: file.text.length, truncated: false }
        else if (url.pathname === '/api/preview') body = {
          url: `${location.origin}/p/${path === 'figures.md' ? 'figures' : 'notes'}-${++preview}/report`,
          version: file.version, expiresAt: '2099-01-01T00:00:00Z', scripts: false,
        }
        else if (url.pathname === '/api/file-info') body = { version: file.version, size: file.text.length }
        else throw new Error(`Unexpected fetch: ${address}`)
        return new Response(JSON.stringify(body))
      }
    }, richText)
    await page.addScriptTag({ content: code })
    const trigger = page.getByRole('button', { name: 'Document outline', exact: true })
    const popup = page.getByRole('dialog', { name: 'Document outline', exact: true })
    const article = page.locator('.markdown-viewer')
    const content = page.locator('.preview-content')
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const hash = await page.evaluate(() => location.hash)
    await expect(article).toBeVisible()
    await expect(page.locator('img[alt="Diagram"]')).toHaveAttribute('src', /^https:\/\/markdown-outline\.invalid\/p\/notes-\d+\/plot\.svg$/)
    const original = await page.evaluate(() => {
      window.originalArticle = document.querySelector('.markdown-viewer')
      window.originalParent = window.originalArticle.parentElement
      window.originalCode = window.originalArticle.querySelector('pre code')
      const range = document.createRange()
      range.selectNodeContents(window.originalCode)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
      return { text: window.originalArticle.textContent, selection: getSelection().toString(), parses: window.markdownRuns }
    })
    await trigger.click()
    await expect(popup).toBeVisible()
    assert.deepEqual(await page.evaluate(() => ({
      text: document.querySelector('.markdown-viewer').textContent,
      selection: getSelection().toString(), parses: window.markdownRuns,
    })), original)
    assert(await page.evaluate(() => document.querySelector('.markdown-viewer') === window.originalArticle &&
      window.originalArticle.parentElement === window.originalParent && window.originalCode === window.originalArticle.querySelector('pre code')))
    assert(await popup.evaluate(element => element.parentElement.classList.contains('preview-content') && !element.closest('.preview-toolbar')))
    await expect(popup.getByRole('link')).toHaveCount(7)
    await expect(popup.locator('[data-outline-heading="intro-formatted"]')).toContainText('Intro formatted')
    await expect(popup.locator('[data-outline-heading="math-x2"]')).toContainText('Math x^2')
    await expect(popup.locator('[data-outline-heading="diagram"]')).toContainText('Diagram')
    assert(await popup.locator('[data-outline-heading="child-code"]').evaluate(element => parseFloat(getComputedStyle(element).paddingInlineStart)) >
      await popup.locator('[data-outline-heading="details"]').evaluate(element => parseFloat(getComputedStyle(element).paddingInlineStart)))
    await page.keyboard.press('Escape')
    await expect(popup).toHaveCount(0)
    await expect(trigger).toBeFocused()
    for (const slug of ['details', 'details-1', 'résumé-δ']) {
      await trigger.click()
      await popup.locator(`[data-outline-heading="${slug}"]`).click()
      await expect(article.locator(`[data-markdown-heading="${slug}"]`)).toBeFocused()
      await expect(popup).toHaveCount(0)
      assert.equal(await page.evaluate(() => location.hash), hash)
    }
    console.log('PASS: outline preserves article/selection/parsing, safe formatted/math titles, repeated/Unicode targets and route hash')

    await trigger.click()
    await popup.locator('[data-outline-heading="details"]').focus()
    await page.evaluate(() => window.changeMarkdown('# Updated **title**\n\n## New section'))
    await expect(popup.getByRole('link')).toHaveCount(2)
    await expect(popup.locator('[data-outline-heading="updated-title"]')).toBeFocused()
    await popup.locator('[data-outline-heading="new-section"]').press('Enter')
    await expect(article.locator('[data-markdown-heading="new-section"]')).toBeFocused()
    await trigger.click()
    await page.evaluate(() => window.changeMarkdown('A document without headings.'))
    await expect(popup.getByRole('status')).toHaveText('No headings in this document.')
    await page.getByRole('button', { name: 'Outside reader' }).click()
    await expect(popup).toHaveCount(0)
    await page.evaluate(() => window.changeMarkdown('# Closed update'))
    await expect(article).toHaveText('Closed update')
    const before = await page.evaluate(() => window.observedMutations.filter(observer => observer.active).length)
    await trigger.click()
    await expect(popup.locator('[data-outline-heading="closed-update"]')).toBeVisible()
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.observedMutations.filter(observer => observer.active).length), before)
    console.log('PASS: open outline updates and repairs removed focus, empty state works, closed outline disconnects its observer')

    await page.evaluate(() => window.changeMarkdown(Array.from({ length: 620 }, (_, index) => `## Section ${index}`).join('\n\n')))
    await expect(article.locator('h2')).toHaveCount(620)
    await page.setViewportSize({ width: 320, height: 640 })
    await page.evaluate(() => window.setReaderPreferences({ density: 'comfortable', fontScale: 1.4 }))
    assert(await page.locator('.preview-toolbar').evaluate(element => element.scrollWidth <= element.clientWidth),
      'Markdown toolbar overflowed at 320px with enlarged text')
    await content.evaluate(element => {
      const heading = element.querySelector('[data-markdown-heading="section-20"]')
      element.scrollTop += heading.getBoundingClientRect().top - element.getBoundingClientRect().top
    })
    const readerTop = await content.evaluate(element => element.scrollTop)
    await trigger.click()
    await expect(popup.getByRole('link')).toHaveCount(500)
    await expect(popup.getByRole('status')).toHaveText('Showing the first 500 headings.')
    await expect(popup.locator('[data-outline-heading="section-20"]')).toBeFocused()
    await expect(popup.locator('[data-outline-heading="section-20"]')).toBeInViewport()
    await expect(popup.getByRole('button', { name: 'Close outline', exact: true })).toBeInViewport()
    // Resize events and popup placement can settle after setViewportSize returns.
    const assertBounds = () => expect(async () => {
      const bounds = await popup.boundingBox()
      const viewport = page.viewportSize()
      assert(bounds && bounds.x >= 9 && bounds.y >= 9 && bounds.x + bounds.width <= viewport.width - 9 && bounds.y + bounds.height <= viewport.height - 9,
        `Outline outside viewport: ${JSON.stringify({ bounds, viewport })}`)
    }).toPass({ timeout: 5000 })
    await assertBounds()
    await page.keyboard.press('End')
    await expect(popup.locator('[data-outline-heading="section-499"]')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(popup.locator('[data-outline-heading="section-0"]')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(popup.locator('[data-outline-heading="section-1"]')).toBeFocused()
    assert.equal(await content.evaluate(element => element.scrollTop), readerTop, 'Outline focus moved the article scroll position')
    await page.setViewportSize({ width: 640, height: 320 })
    await assertBounds()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(trigger).toHaveCount(0)
    await page.getByRole('button', { name: 'Rendered', exact: true }).click()
    await trigger.click()
    await page.evaluate(() => window.setReaderPreferences({ readerToolbarVisible: false }))
    await expect(popup).toHaveCount(0)
    await expect(trigger).toHaveCount(0)
    await page.evaluate(() => window.setReaderPreferences({ readerToolbarVisible: true }))
    await trigger.click()
    await page.evaluate(() => document.getElementById('workspace').classList.add('reader-expanded'))
    await expect(popup).toHaveCount(0)
    await expect(trigger).toBeHidden()
    await page.evaluate(() => document.getElementById('workspace').classList.remove('reader-expanded'))
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    console.log('PASS: bounded 500-heading list, 320px/rotated placement, arrow keys and Source/hidden-toolbar/fullscreen dismissal')

    await page.setViewportSize({ width: 1000, height: 800 })
    await page.evaluate(() => window.setReaderPreferences({ fontScale: 1, density: 'compact' }))
    await page.evaluate(figures => window.showFile(figures), figures)
    const tall = page.getByRole('img', { name: 'Tall figure', exact: true })
    await expect.poll(() => tall.evaluate(image => image.naturalHeight)).toBe(5000)
    await content.evaluate(element => { element.scrollTop = 2000 })
    await page.evaluate(notes => window.showFile(notes), notes)
    held = true
    await page.evaluate(figures => window.showFile(figures), figures)
    await expect.poll(() => images.length).toBe(1)
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBe(0)
    await trigger.click()
    await popup.locator('[data-outline-heading="figures"]').click()
    await expect(article.locator('h1')).toBeFocused()
    held = false
    await Promise.all(images.splice(0).map(route => route.fulfill(image(5000))))
    await expect.poll(() => tall.evaluate(image => image.naturalHeight)).toBe(5000)
    await settle()
    assert.equal(await content.evaluate(element => element.scrollTop), 0, 'Late image restoration overwrote outline navigation')
    assert.equal(await page.evaluate(() => location.hash), hash)
    assert.deepEqual(errors, [])
    console.log('PASS: outline navigation cancels a pending ReaderPosition image restore without changing the hash')

    await page.evaluate(notes => window.showFile(notes), notes)
    await page.evaluate(() => window.changeMarkdown('# Notes\n\nA reference[^detail].\n\n[Section link](#later)\n\n' +
      Array.from({length:30}, () => 'A paragraph of report content.').join('\n\n') + '\n\n## Later\n\nEnd of report.\n\n[^detail]: Footnote details.'))
    await expect(article.locator('.footnotes')).toBeVisible()
    await content.evaluate(element => { element.scrollTop = 0 })
    await page.evaluate(() => scrollTo(0, 0))
    assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'The hidden footnote label escaped the reader and enlarged the page')
    const frameTop = await content.evaluate(element => element.getBoundingClientRect().top)
    await page.getByRole('link', {name:'Section link',exact:true}).click()
    await expect(article.locator('[data-markdown-heading="later"]')).toBeFocused()
    assert.equal(await content.evaluate(element => element.getBoundingClientRect().top), frameTop, 'Heading navigation moved the reader toolbar')
    await trigger.click()
    await popup.locator('[data-outline-heading="notes"]').click()
    await expect(article.locator('h1')).toBeFocused()
    assert.equal(await content.evaluate(element => element.getBoundingClientRect().top), frameTop, 'Outline navigation moved the reader toolbar')
    assert.equal(await page.evaluate(() => scrollY), 0)
    assert.equal(await page.evaluate(() => location.hash), hash)
    assert.deepEqual(errors, [])
    console.log('PASS: hidden footnote labels stay inside the reader; heading and outline jumps retain the app layout and route')
  } finally { await context.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ headless: true })
  try { await checkMarkdownOutline({ browser }) } finally { await browser.close() }
}
