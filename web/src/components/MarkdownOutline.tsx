import { ListTree, X } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPopover } from './useAnchoredPopover'
import './markdownOutline.css'

const headingLimit = 500
interface Heading { slug: string; title: string; level: number }
interface Outline { headings: Heading[]; ready: boolean; limited: boolean }

function readOutline(content: HTMLElement | null): Outline {
  const article = content?.querySelector('.markdown-viewer')
  const headings: Heading[] = []
  if (!article) return { headings, ready: false, limited: false }
  for (const element of article.querySelectorAll<HTMLElement>('[data-markdown-heading]')) {
    if (!/^H[1-6]$/.test(element.tagName)) continue
    if (headings.length === headingLimit) return { headings, ready: true, limited: true }
    headings.push({
      slug: element.dataset.markdownHeading!,
      title: element.dataset.markdownTitle || element.textContent?.replace(/\s+/g, ' ').trim() || 'Untitled section',
      level: Number(element.tagName.slice(1)),
    })
  }
  return { headings, ready: true, limited: false }
}

export default function MarkdownOutline({ content }: { content: RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState(false)
  const [outline, setOutline] = useState<Outline>({ headings: [], ready: false, limited: false })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useAnchoredPopover(open, trigger)
  const focusRequested = useRef<'open' | 'changed' | null>(null)
  const id = `markdown-outline-${useId()}`

  function close(focus = false) {
    setOpen(false)
    if (focus) trigger.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!open || !content.current) return
    let frame = 0
    const update = () => {
      frame = 0
      if (!trigger.current?.getClientRects().length) { setOpen(false); return }
      const next = readOutline(content.current)
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
      if (focused && popup.current?.contains(focused) && focused.dataset.outlineHeading &&
        !next.headings.some(heading => heading.slug === focused.dataset.outlineHeading)) focusRequested.current = 'changed'
      setOutline(current => current.ready === next.ready && current.limited === next.limited &&
        current.headings.length === next.headings.length && current.headings.every((heading, index) =>
          heading.slug === next.headings[index].slug && heading.title === next.headings[index].title && heading.level === next.headings[index].level)
        ? current : next)
    }
    const observer = new MutationObserver(records => {
      if (!trigger.current?.getClientRects().length) { setOpen(false); return }
      // The portal is a sibling of the article; its own list updates need no rescan.
      if (!frame && records.some(record => !popup.current?.contains(record.target))) frame = requestAnimationFrame(update)
    })
    observer.observe(content.current, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['data-markdown-heading', 'data-markdown-title'] })
    const shell = trigger.current?.closest('.workspace-shell')
    if (shell) observer.observe(shell, { attributes: true, attributeFilter: ['class'] })
    update()
    const outside = (event: Event) => {
      const target = event.target as Node | null
      if (target && !trigger.current?.contains(target) && !popup.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, content, popup])

  useLayoutEffect(() => {
    if (!open || !focusRequested.current) return
    const opening = focusRequested.current === 'open'
    focusRequested.current = null
    let target = popup.current?.querySelector<HTMLElement>('[data-outline-heading]')
    if (opening && content.current) {
      const top = content.current.getBoundingClientRect().top + 1
      let slug: string | undefined
      let count = 0
      for (const heading of content.current.querySelectorAll<HTMLElement>('.markdown-viewer [data-markdown-heading]')) {
        if (!/^H[1-6]$/.test(heading.tagName)) continue
        if (count++ === headingLimit || heading.getBoundingClientRect().top > top) break
        slug = heading.dataset.markdownHeading
      }
      if (slug) target = popup.current?.querySelector<HTMLElement>(`[data-outline-heading="${CSS.escape(slug)}"]`) ?? target
    }
    ;(target ?? popup.current)?.focus()
  }, [open, outline, popup, content])

  function select(slug: string) {
    const article = content.current?.querySelector('.markdown-viewer')
    const target = article?.querySelector<HTMLElement>(`[data-markdown-heading="${CSS.escape(slug)}"]`)
    if (!target) { setOutline(readOutline(content.current)); return }
    close()
    target.focus({ preventScroll: true })
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }

  function keyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const links = [...(popup.current?.querySelectorAll<HTMLAnchorElement>('[data-outline-heading]') ?? [])]
    const index = links.indexOf(document.activeElement as HTMLAnchorElement)
    if (links.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
        : event.key === 'ArrowDown' ? Math.min(links.length - 1, index + 1) : index < 0 ? links.length - 1 : Math.max(0, index - 1)
      links[next].focus()
    } else if (event.key === 'Tab') {
      const controls = popup.current?.querySelectorAll<HTMLElement>('button,a[href]')
      if (controls?.length && ((event.shiftKey && document.activeElement === controls[0]) ||
        (!event.shiftKey && document.activeElement === controls[controls.length - 1]))) {
        event.preventDefault()
        close(true)
      }
    }
  }

  return <div className="markdown-outline-control">
    <button ref={trigger} className="icon-button" aria-label="Document outline" title="Document outline"
      aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined}
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        if (open) { close(true); return }
        setOutline(readOutline(content.current))
        focusRequested.current = 'open'
        setOpen(true)
      }}><ListTree size={17} /></button>
    {open && content.current && createPortal(
      <div ref={popup} className="markdown-outline-panel" id={id} role="dialog" aria-label="Document outline"
        tabIndex={-1} onKeyDown={keyboard}>
        <div className="markdown-outline-header"><strong>Outline</strong><button className="icon-button" aria-label="Close outline" title="Close outline" onClick={() => close(true)}><X size={16} /></button></div>
        {!outline.headings.length ? <p role="status">{outline.ready ? 'No headings in this document.' : 'Loading outline…'}</p>
          : <nav aria-label="Document headings"><ol>{outline.headings.map(heading =>
            <li key={heading.slug}><a href={`#${encodeURIComponent(heading.slug)}`} data-outline-heading={heading.slug} data-outline-level={heading.level}
              style={{ paddingInlineStart: 10 + (heading.level - 1) * 8 }}
              onClick={event => { event.preventDefault(); select(heading.slug) }} onAuxClick={event => event.preventDefault()}>
              <span className="sr-only">Heading level {heading.level}, </span>{heading.title}
            </a></li>)}</ol></nav>}
        {outline.limited && <p className="markdown-outline-note" role="status">Showing the first {headingLimit} headings.</p>}
      </div>, content.current)}
  </div>
}
