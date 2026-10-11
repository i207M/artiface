import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { rolldown } = await import(require.resolve('rolldown'))
const web = fileURLToPath(new URL('../web', import.meta.url))

// Count real Markdown/highlighting work and exercise DOM identity without a live server.
async function buildReader() {
  const bundle = await rolldown({
    cwd: web, input: 'fixture:markdown', platform: 'browser',
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
    onLog(level, log, next) { if (log.code !== 'MODULE_LEVEL_DIRECTIVE') next(level, log) },
    plugins: [{
      name: 'markdown-fixture',
      resolveId(id, importer) {
        if (id === 'fixture:markdown') return '\0fixture'
        if (id === 'react-markdown') return '\0markdown'
        if (id === '../highlight' && importer?.endsWith('/MarkdownViewer.tsx')) return '\0highlight'
        if (id.endsWith('.css')) return '\0css'
      },
      load(id) {
        if (id === '\0css') return ''
        if (id === '\0markdown') return `
          import React from 'react'
          import Markdown from ${JSON.stringify(require.resolve('react-markdown'))}
          export default function CountedMarkdown(props) {
            window.markdownRuns = (window.markdownRuns || 0) + 1
            return React.createElement(Markdown, props)
          }`
        if (id === '\0highlight') return `
          import { highlight as realHighlight } from ${JSON.stringify(`${web}/src/highlight.ts`)}
          export function highlight(...args) {
            window.highlightRuns = (window.highlightRuns || 0) + 1
            return realHighlight(...args)
          }`
        if (id === '\0fixture') return `
          import React from 'react'
          import { createRoot } from 'react-dom/client'
          import { flushSync } from 'react-dom'
          import MarkdownViewer from ${JSON.stringify(`${web}/src/components/MarkdownViewer.tsx`)}
          const root = createRoot(document.getElementById('root'))
          window.navigations = []
          let props = {
            text: window.markdownFixture,
            location: { host: 'host-a', root: 'root-a', path: 'reports/notes.md', kind: 'file' },
            previewURL: 'https://markdown-reader.invalid/p/first/notes.md',
            onNavigate: target => window.navigations.push({ callback: 'first', target })
          }
          window.updateMarkdown = ({ callback, ...patch } = {}) => {
            props = { ...props, ...patch, location: { ...(patch.location || props.location) } }
            if (callback) props.onNavigate = target => window.navigations.push({ callback, target })
            flushSync(() => root.render(React.createElement(MarkdownViewer, props)))
          }
          window.updateMarkdown()
        `
      },
    }],
  })
  try {
    const { output } = await bundle.generate({ format: 'iife', codeSplitting: false })
    return output.find(item => item.type === 'chunk').code
  } finally { await bundle.close() }
}

const markdown = [
  '# Reader fixture',
  '[Local **report**](sibling.md) · [Folder](subdir/) · [Parent](../summary.md)',
  '[Bare folder](subdir) · [Parent folder](..)',
  '[Section](#details) · [Next section](#details-1) · [Unicode section](#résumé-δ) · [Malformed fragment](#%E0%A4%A)',
  '[External](https://example.invalid/report?q=1)',
  '[Script](javascript:alert%281%29) · [HTTP](http://example.invalid/report)',
  '[Credentials](https://user:secret@example.invalid/report) · [Outside](../../escape.md)',
  '[Encoded absolute](%2Fetc%2Fpasswd)',
  '![Figure](plots/figure.svg)',
  '![Escaping image](../private.svg) · ![External image](https://example.invalid/image.svg)',
  '```js\nconst result = "<safe>";\n```',
  '| Result | Value |\n| --- | --- |\n| score | 42 |',
  '$x^2 + y^2$',
  '<script>window.markdownExecuted = true</script>',
  '## Details\n\nFirst section.',
  '## Details\n\nSecond section.',
  '## Résumé Δ\n\nUnicode section.',
].join('\n\n')

export async function checkMarkdownReader({ browser }) {
  const code = await buildReader()
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.href === 'https://markdown-reader.invalid/') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><div id="root"></div>',
    })
    if (url.origin === 'https://markdown-reader.invalid' && /^\/p\/(first|second)\/plots\/figure\.svg$/.test(url.pathname)) {
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>',
      })
    }
    errors.push(`Unexpected network request: ${url.origin}${url.pathname}`)
    return route.abort()
  })
  try {
    await page.goto('https://markdown-reader.invalid/')
    await page.evaluate(text => { window.markdownFixture = text }, markdown)
    await page.addScriptTag({ content: code })
    const local = page.getByRole('link', { name: 'Local report', exact: true })
    const image = page.locator('img[alt="Figure"]')
    await expect(local).toBeVisible()
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true)
    await expect(page.locator('.katex')).toBeVisible()
    await expect(page.locator('table')).toContainText('42')
    const initial = await page.evaluate(() => {
      window.originalCode = document.querySelector('pre code')
      window.originalImage = document.querySelector('img')
      window.originalLink = document.querySelector('a')
      const range = document.createRange()
      range.selectNodeContents(window.originalCode)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
      return { markdown: window.markdownRuns, highlight: window.highlightRuns, selection: getSelection().toString() }
    })
    assert(initial.selection.includes('const result'))
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.updateMarkdown())
    assert.deepEqual(await page.evaluate(() => ({
      markdown: window.markdownRuns, highlight: window.highlightRuns, selection: getSelection().toString(),
    })), initial, 'Unchanged reader updates reparsed Markdown or discarded the code selection')
    assert(await page.evaluate(() => window.originalCode === document.querySelector('pre code') &&
      window.originalImage === document.querySelector('img') && window.originalLink === document.querySelector('a')))
    await local.focus()
    await page.evaluate(() => window.updateMarkdown({ callback: 'latest' }))
    await expect(local).toBeFocused()
    assert.equal(await page.evaluate(() => window.markdownRuns), initial.markdown, 'Callback updates reparsed Markdown')
    await local.press('Enter')
    assert.deepEqual(await page.evaluate(() => window.navigations.at(-1)), {
      callback: 'latest', target: { host: 'host-a', root: 'root-a', path: 'reports/sibling.md', kind: 'file' },
    })
    await page.evaluate(() => window.updateMarkdown({
      location: { host: 'host-b', root: 'root-b', path: 'reports/notes.md', kind: 'file' },
    }))
    await expect(local).toBeFocused()
    await expect(local).toHaveAttribute('href', '#host=host-b&root=root-b&path=reports%2Fsibling.md&kind=file')
    assert.equal(await page.evaluate(() => window.markdownRuns), initial.markdown, 'Host changes reparsed unchanged Markdown')
    await local.click()
    assert.deepEqual(await page.evaluate(() => window.navigations.at(-1)), {
      callback: 'latest', target: { host: 'host-b', root: 'root-b', path: 'reports/sibling.md', kind: 'file' },
    })
    const modifiedClick = await page.evaluate(() => {
      const before = window.navigations.length
      let prevented
      document.addEventListener('click', event => {
        prevented = event.defaultPrevented
        event.preventDefault() // Observe native modifier behavior without opening another tab.
      }, { once: true })
      window.originalLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
      return { navigated: window.navigations.length !== before, prevented }
    })
    assert.deepEqual(modifiedClick, { navigated: true, prevented: true })
    console.log('PASS: unchanged Markdown skips parsing/highlighting and preserves selection, focus, and image identity with current navigation')

    const headings = page.locator('.markdown-viewer h2')
    const originalIDs = await headings.evaluateAll(elements => elements.map(element => element.id))
    assert.equal(new Set(originalIDs).size, 3, 'Duplicate headings reused an anchor')
    await page.evaluate(() => {
      const outside = document.createElement('h2')
      outside.id = document.querySelector('.markdown-viewer h2').id
      outside.dataset.markdownHeading = 'details'
      outside.textContent = 'Outside document'
      document.body.prepend(outside)
      window.anchorScroll = []
      document.querySelectorAll('.markdown-viewer h2').forEach(element => {
        element.scrollIntoView = options => window.anchorScroll.push({ slug: element.dataset.markdownHeading, ...options })
      })
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const [name, index] of [['Section', 0], ['Next section', 1], ['Unicode section', 2]]) {
      await page.getByRole('link', { name, exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(headings.nth(index)).toBeFocused()
      assert.equal(await page.evaluate(() => location.hash), '', 'A heading link changed the app route')
    }
    assert.deepEqual(await page.evaluate(() => window.anchorScroll), [
      { slug: 'details', behavior: 'auto', block: 'start' },
      { slug: 'details-1', behavior: 'auto', block: 'start' },
      { slug: 'résumé-δ', behavior: 'auto', block: 'start' },
    ])
    await page.evaluate(() => window.updateMarkdown())
    assert.deepEqual(await headings.evaluateAll(elements => elements.map(element => element.id)), originalIDs)
    console.log('PASS: duplicate/Unicode heading anchors stay scoped, preserve routes, move keyboard focus, and respect reduced motion')

    const external = page.getByRole('link', { name: 'External', exact: true })
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(external).toHaveAttribute('referrerpolicy', 'no-referrer')
    const pages = context.pages().length
    await external.click()
    const confirmation = page.getByRole('dialog', { name: 'Open external website?' })
    await expect(confirmation).toContainText('https://example.invalid/report?q=1')
    await expect(confirmation.getByRole('link', { name: 'Open website' })).toHaveAttribute('target', '_blank')
    assert.equal(context.pages().length, pages, 'An external site opened before confirmation')
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(external).toBeFocused()
    await page.getByRole('link', { name: 'HTTP', exact: true }).click()
    await expect(confirmation).toContainText('http://example.invalid/report')
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    for (const name of ['Script', 'Credentials', 'Outside', 'Encoded absolute']) {
      await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0)
    }
    await expect(page.locator('img')).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'Folder', exact: true })).toHaveAttribute('href', /kind=directory$/)
    await expect(page.getByRole('link', { name: 'Bare folder', exact: true })).toHaveAttribute('href', /kind=auto$/)
    await expect(page.getByRole('link', { name: 'Parent folder', exact: true })).toHaveAttribute('href', /kind=directory$/)
    await page.getByRole('link', { name: 'Malformed fragment', exact: true }).click()
    assert.equal(await page.evaluate(() => location.hash), '')
    await page.evaluate(() => window.updateMarkdown({
      location: { host: 'host-b', root: 'root-b', path: 'notes.md', kind: 'file' },
    }))
    await expect(page.getByRole('link', { name: 'Parent', exact: true })).toHaveCount(0)
    await expect(local).toHaveAttribute('href', '#host=host-b&root=root-b&path=sibling.md&kind=file')
    await local.click()
    assert.equal(await page.evaluate(() => window.navigations.at(-1).target.path), 'sibling.md')
    await image.dispatchEvent('error')
    await expect(image).toHaveCount(0)
    await page.evaluate(() => window.updateMarkdown({ callback: 'after-image-error' }))
    await expect(image).toHaveCount(0)
    await page.evaluate(() => window.updateMarkdown({ previewURL: 'https://markdown-reader.invalid/p/second/notes.md' }))
    await expect(image).toHaveAttribute('src', 'https://markdown-reader.invalid/p/second/plots/figure.svg')
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true)
    await page.evaluate(() => window.updateMarkdown({ text: window.markdownFixture.replace('const result = "<safe>";', 'const result = 2;') }))
    await expect(page.locator('pre code')).toHaveText('const result = 2;\n')
    assert.equal(await page.evaluate(() => window.highlightRuns), initial.highlight + 1)
    assert.equal(await page.evaluate(() => window.markdownExecuted), undefined)
    assert.deepEqual(errors, [])
    console.log('PASS: changed paths, content, and capabilities update safely; blocked URLs, image recovery, and fragment behavior stay intact')

    const footnoteText = Array.from({length:12},()=> 'A paragraph in this document.').join('\n\n') + '\n\nA note[^test], another reference[^test], and a Unicode note[^résumé].\n\n[Heading collision](#user-content-fn-test)\n\n## user-content-fn-test\n\n## Footnotes\n\n[^test]: Footnote **text**.\n\n[^résumé]: Unicode details.'
    await page.evaluate(text => window.updateMarkdown({ text }), footnoteText)
    const references = page.locator('.markdown-viewer > p sup a')
    const notes = page.locator('.footnotes li')
    const routeBeforeNotes = await page.evaluate(() => location.hash)
    const noteIDs = await page.locator('.markdown-viewer [id]').evaluateAll(nodes => nodes.map(node => node.id))
    assert.equal(new Set(noteIDs).size, noteIDs.length, 'Footnotes collided with heading IDs')
    await expect(references).toHaveCount(3)
    const description = await page.locator('.footnotes h2').getAttribute('id')
    for (let index = 0; index < 3; index++) await expect(references.nth(index)).toHaveAttribute('aria-describedby', description)
    await page.evaluate(() => {
      window.originalNote = document.querySelector('.footnotes li')
      window.originalReference = document.querySelector('.markdown-viewer > p sup a')
      const outside = window.originalNote.cloneNode(true)
      outside.id = window.originalNote.id
      outside.dataset.outsideNote = 'true'
      document.body.prepend(outside)
    })
    await references.first().focus()
    await references.first().press('Enter')
    await expect(notes.first()).toBeFocused()
    await notes.first().getByRole('link', { name: 'Back to reference 1-2', exact: true }).click()
    await expect(references.nth(1)).toBeFocused()
    await references.nth(2).click()
    await expect(notes.nth(1)).toBeFocused()
    await notes.nth(1).getByRole('link', { name: 'Back to reference 2', exact: true }).press('Enter')
    await expect(references.nth(2)).toBeFocused()
    await page.getByRole('link', { name: 'Heading collision', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'user-content-fn-test', exact: true })).toBeFocused()
    assert.equal(await page.evaluate(() => location.hash), routeBeforeNotes, 'Footnote navigation changed the app route')
    await page.evaluate(() => window.updateMarkdown())
    assert(await page.evaluate(() => window.originalNote === document.querySelector('.footnotes li') &&
      window.originalReference === document.querySelector('.markdown-viewer > p sup a')), 'Unchanged Markdown replaced footnotes')
    assert.deepEqual(await page.locator('.markdown-viewer [id]').evaluateAll(nodes => nodes.map(node => node.id)), noteIDs)
    await page.locator('[data-outside-note]').evaluate(node => node.remove())
    console.log('PASS: repeated/Unicode footnotes preserve scoped IDs, descriptions, keyboard return targets, heading links, routes and unchanged DOM')

    // This fits the input cap but previously expanded into roughly 150,000 DOM spans.
    const dense = JSON.stringify({ counts: Array.from({ length: 74_990 }, () => 0) })
    await page.evaluate(text => window.updateMarkdown({ text: '```json\n' + text + '\n```' }), dense)
    const largeCode = page.locator('pre code')
    await expect(largeCode.locator('*')).toHaveCount(0)
    assert.equal(await largeCode.textContent(), dense + '\n')
    assert.deepEqual(errors, [])
    console.log('PASS: a 150k JSON fence keeps its complete text without amplified highlight DOM')

    await page.evaluate(() => {window.originalArticle=document.querySelector('.markdown-viewer');window.updateMarkdown({text:''})})
    const empty = page.getByRole('status')
    await expect(empty).toHaveText('This file is empty.')
    for (const text of [' \n\t', '<!-- A deliberate comment-only document. -->', '# Ordinary content\n\nA paragraph.']) {
      await page.evaluate(text => window.updateMarkdown({text}), text)
      await expect(empty).toHaveCount(0)
      assert(await page.evaluate(() => window.originalArticle === document.querySelector('.markdown-viewer')), 'Empty state replaced the article')
    }
    await expect(page.getByRole('heading',{name:'Ordinary content',exact:true})).toBeVisible()
    assert.deepEqual(errors, [])
    console.log('PASS: only zero-length Markdown shows the quiet empty state; whitespace/comments and article identity remain intact')
  } finally { await context.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ headless: true })
  try { await checkMarkdownReader({ browser }) } finally { await browser.close() }
}
