import { ImageOff } from 'lucide-react'
import { createContext, memo, useContext, useId, useMemo, useState } from 'react'
import type { ComponentProps } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { highlight } from '../highlight'
import { localImageURL, locationHash } from '../location'
import { markdownHeadings } from '../markdownHeadings'
import type { Location } from '../types'
import { reportLink, reportLinkKind, useReportLinks } from './ReportLinks'

interface Props {
  text: string
  location: Location
  previewURL?: string
  onNavigate: (location: Location, keyboard?: boolean) => void
  onLink?: (href: string, download?: boolean, keyboard?: boolean) => void
  projectRoot?: string
}

const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins: NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
  [rehypeKatex, { trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }],
]
// Links need current navigation without making parsing depend on callback identity.
const NavigationContext = createContext<{ location: Location; onLink: (href: string, download?: boolean, keyboard?: boolean) => void; projectRoot?: string } | null>(null)

function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <span className="missing-image" role="img" aria-label={alt || 'Image unavailable'}><ImageOff size={16} /><span>{alt || 'Image unavailable'}<small>Local image unavailable or outside the preview directory</small></span></span>
  return <img src={src} alt={alt || ''} title={title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

function HighlightedCode({ text, language, className }: { text: string; language: string; className?: string }) {
  const rendered = useMemo(() => highlight(text, language), [text, language])
  return rendered === null ? <code className={className}>{text}</code> : <code className={className} dangerouslySetInnerHTML={{ __html: rendered }} />
}

function MarkdownLink({ href, children, title, id, className, 'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy }: ComponentProps<'a'>) {
  const { location, onLink, projectRoot } = useContext(NavigationContext)!
  const attributes = { id, className, 'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy }
  if (!href) return <span className="blocked-link" title="This link’s URL is not allowed">{children}</span>
  if (href.startsWith('#')) return <a {...attributes} href={href} title={title} onClick={(event) => {
    event.preventDefault()
    try {
      const fragment = decodeURIComponent(href.slice(1))
      const article = event.currentTarget.closest<HTMLElement>('.markdown-viewer')
      const target = fragment ? article?.querySelector<HTMLElement>(`[data-markdown-heading="${CSS.escape(fragment)}"]`)
        ?? article?.querySelector<HTMLElement>(`[id="${CSS.escape(fragment)}"]`) : article
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    } catch { /* Invalid fragment: leave the current location intact. */ }
  }}>{children}</a>
  const target = reportLink(location.path, href, projectRoot)
  if (!target) return <span className="blocked-link">{children}</span>
  const url = 'external' in target ? target.external : locationHash({ ...location, path: target.path, kind: reportLinkKind(target) })
  const follow: NonNullable<ComponentProps<'a'>['onClick']> = event => {
    if (event.button > 1) return
    event.preventDefault()
    onLink(href, false, event.detail === 0)
  }
  return <a {...attributes} href={url} title={title} onClick={follow} onAuxClick={follow} rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>
}

function MarkdownImageRenderer({ src, alt, title }: ComponentProps<'img'>) {
  return <MarkdownImage key={typeof src === 'string' ? src : ''} src={typeof src === 'string' ? src : undefined} alt={alt} title={title} />
}

function MarkdownCode({ className, children }: ComponentProps<'code'>) {
  const language = /(?:^|\s)language-([\w+-]+)/.exec(className || '')?.[1]
  if (!language) return <code className={className}>{children}</code>
  return <HighlightedCode text={String(children)} language={language} className={className} />
}

const components = { a: MarkdownLink, img: MarkdownImageRenderer, code: MarkdownCode }
const MarkdownContent = memo(function MarkdownContent({ text, path, previewURL, headingPrefix, projectRoot }: { text: string; path: string; previewURL?: string; headingPrefix: string; projectRoot?: string }) {
  const plugins = useMemo<NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>>(
    () => [[markdownHeadings, { prefix: headingPrefix }], ...rehypePlugins], [headingPrefix])
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={remarkPlugins}
      rehypePlugins={plugins}
      urlTransform={(url, key) => {
        if (key === 'src') return previewURL ? localImageURL(url, previewURL) || '' : ''
        if (url.startsWith('#')) return url
        return reportLink(path, url, projectRoot) !== null ? url : ''
      }}
      components={components}
    >{text}</ReactMarkdown>
  )
})

export default function MarkdownViewer({ text, location, previewURL, onNavigate, onLink, projectRoot }: Props) {
  const headingPrefix = `artiface-heading-${useId()}-`
  const { host, root, path, kind } = location
  const links = useReportLinks(location, onNavigate, projectRoot)
  const follow = onLink ?? links.open
  const navigation = useMemo(() => ({ location: { host, root, path, kind }, onLink: follow, projectRoot }), [host, root, path, kind, follow, projectRoot])
  return <NavigationContext.Provider value={navigation}>
    <article className="markdown-viewer" aria-label="Rendered Markdown" tabIndex={0}>
      <MarkdownContent text={text} path={path} previewURL={previewURL} headingPrefix={headingPrefix} projectRoot={projectRoot} />
      {text.length === 0 && <p className="reader-empty" role="status">This file is empty.</p>}
    </article>
    {links.dialog}
  </NavigationContext.Provider>
}
