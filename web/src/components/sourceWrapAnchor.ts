export interface SourceWrapCorrection {
  schedule: (wrap: boolean, position: { top: number; left: number }) => void
  cancel: () => void
}

function visibleSourceAnchor(root: HTMLElement | null, visibleColumn = false) {
  const scroller = root?.querySelector<HTMLElement>('.source-scroll')
  const code = scroller?.querySelector<HTMLElement>('.source-code code')
  if (!scroller || !code || !scroller.getClientRects().length) return null
  const clip = scroller.getBoundingClientRect()
  // Sample visible code rather than the sticky line-number gutter.
  const gutterRight = scroller.querySelector('.line-numbers')?.getBoundingClientRect().right ?? clip.left
  const x = Math.max(clip.left + 1, code.getBoundingClientRect().left + 1, gutterRight + 1)
  const style = getComputedStyle(scroller)
  const lineHeight = parseFloat(style.lineHeight)
  if (!Number.isFinite(lineHeight) || x >= clip.right) return null
  // WebKit can return an off-screen file-start caret in glyph gaps or blank rows.
  for (const inset of [1, lineHeight / 2, lineHeight * 1.5]) {
    const range = code.ownerDocument.caretRangeFromPoint?.(x, clip.top + inset)
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !code.contains(range.startContainer)) continue
    const node = range.startContainer as Text
    const offset = range.startOffset
    if (offset < node.length) range.setEnd(node, offset + 1)
    else if (offset > 0) range.setStart(node, offset - 1)
    const rect = range.getBoundingClientRect()
    if (rect.bottom <= clip.top + 1 || rect.top >= clip.top + lineHeight * 2) continue
    if (visibleColumn && (rect.right <= gutterRight || rect.left >= clip.right)) continue
    return { scroller, code, range, node, data: node.data, top: rect.top - clip.top,
      left: rect.left - gutterRight, width: scroller.clientWidth, font: style.fontSize }
  }
  return null
}

export interface SourceFontPoint {
  offset: number
  offsetTop: number
  offsetLeft: number
  font: string
}

// React text preserves CRLF; parsed highlight HTML uses LF. Count either as one unit.
function sourceLength(text: string, end = text.length) {
  let length = end
  for (let index = text.indexOf('\r\n'); index >= 0 && index + 1 < end; index = text.indexOf('\r\n', index + 2)) length--
  return length
}

export function captureSourceFontPoint(root: HTMLElement | null): SourceFontPoint | null {
  const anchor = visibleSourceAnchor(root, true)
  if (!anchor) return null
  const walker = anchor.code.ownerDocument.createTreeWalker(anchor.code, NodeFilter.SHOW_TEXT)
  let node: Node | null
  let offset = 0
  while ((node = walker.nextNode())) {
    if (node === anchor.range.startContainer) return {
      offset: offset + sourceLength((node as Text).data, anchor.range.startOffset),
      offsetTop: anchor.top, offsetLeft: anchor.left, font: anchor.font,
    }
    offset += sourceLength((node as Text).data)
  }
  return null
}

export function restoreSourceFontPoint(root: HTMLElement, point: Partial<SourceFontPoint>, wrapped: boolean) {
  const scroller = root.querySelector<HTMLElement>('.source-scroll')
  const code = scroller?.querySelector<HTMLElement>('.source-code code')
  if (!scroller || !code || !scroller.getClientRects().length || typeof point.font !== 'string' ||
    point.font === getComputedStyle(scroller).fontSize || typeof point.offset !== 'number' ||
    !Number.isSafeInteger(point.offset) || point.offset < 0 ||
    typeof point.offsetTop !== 'number' || !Number.isFinite(point.offsetTop) ||
    typeof point.offsetLeft !== 'number' || !Number.isFinite(point.offsetLeft)) return
  const walker = code.ownerDocument.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let node: Node | null
  let offset = point.offset
  while ((node = walker.nextNode())) {
    const text = node as Text
    const length = sourceLength(text.data)
    if (offset >= length) { offset -= length; continue }
    // Resolve the normalized offset back into this render's actual text node.
    for (let index = text.data.indexOf('\r\n'); index >= 0 && index < offset; index = text.data.indexOf('\r\n', index + 2)) offset++
    const range = code.ownerDocument.createRange()
    range.setStart(text, offset)
    range.setEnd(text, offset + 1)
    const rect = range.getBoundingClientRect()
    const clip = scroller.getBoundingClientRect()
    const gutterRight = scroller.querySelector('.line-numbers')?.getBoundingClientRect().right ?? clip.left
    scroller.scrollTop += rect.top - clip.top - point.offsetTop
    if (!wrapped) scroller.scrollLeft += rect.left - gutterRight - point.offsetLeft
    return
  }
}

export function prepareSourceWrap(root: HTMLElement | null, control: HTMLElement, retain: () => void, settled: () => void): SourceWrapCorrection | null {
  let anchor = visibleSourceAnchor(root)
  if (!anchor) return null
  const listeners = new AbortController()
  let frame = 0
  let remember: (() => void) | null = retain
  let done: (() => void) | null = settled
  const cancel = () => {
    cancelAnimationFrame(frame)
    frame = 0
    listeners.abort()
    anchor = null
    remember = null
    const finish = done
    done = null
    finish?.()
  }
  const interrupt = (event: Event) => {
    // A second activation supersedes the pending layout, retaining its original anchor.
    if (event.target instanceof Node && control.contains(event.target) &&
      (event.type === 'click' || event.type === 'pointerdown' || event.type === 'touchstart' || event.type === 'focusin' ||
        (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')))) return
    cancel()
  }
  const options = { capture: true, passive: true, signal: listeners.signal }
  document.addEventListener('wheel', interrupt, options)
  document.addEventListener('keydown', interrupt, options)
  document.addEventListener('pointerdown', interrupt, options)
  document.addEventListener('touchstart', interrupt, options)
  document.addEventListener('focusin', interrupt, options)
  document.addEventListener('focusout', interrupt, options)
  document.addEventListener('click', interrupt, options)
  window.addEventListener('blur', cancel, options)
  window.addEventListener('pagehide', cancel, options)
  window.addEventListener('resize', cancel, options)
  window.addEventListener('hashchange', cancel, options)
  window.addEventListener('popstate', cancel, options)
  return {
    cancel,
    schedule(wrap, position) {
      cancelAnimationFrame(frame)
      if (!anchor) return
      frame = requestAnimationFrame(() => {
        const value = anchor
        const save = remember
        cancel()
        if (!value) return
        const { scroller, code, range, node } = value
        const top = Math.min(position.top, Math.max(0, scroller.scrollHeight - scroller.clientHeight))
        const left = Math.min(position.left, Math.max(0, scroller.scrollWidth - scroller.clientWidth))
        if (!scroller.isConnected || !scroller.getClientRects().length || !node.isConnected ||
          scroller.querySelector('.source-code code') !== code || !code.contains(node) || node.data !== value.data ||
          range.startContainer !== node || range.endContainer !== node ||
          scroller.parentElement?.classList.contains('source-wrap') !== wrap ||
          scroller.clientWidth !== value.width || getComputedStyle(scroller).fontSize !== value.font ||
          Math.abs(scroller.scrollTop - top) > 1 || Math.abs(scroller.scrollLeft - left) > 1) return
        scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - value.top
        save?.()
      })
    },
  }
}
