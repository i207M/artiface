export interface MarkdownFontPoint {
  offset: number
  offsetTop: number
  font: string
}

function eligibleArticle(root: HTMLElement) {
  const article = root.querySelector<HTMLElement>('.markdown-viewer')
  // Images can change both text offsets (placeholders) and later geometry.
  return root.clientHeight > 0 && root.clientWidth > 0 && article?.getClientRects().length &&
    !article.querySelector('img, .missing-image') ? article : null
}

export function captureMarkdownFontPoint(root: HTMLElement): MarkdownFontPoint | null {
  const article = eligibleArticle(root)
  if (!article) return null
  const clip = root.getBoundingClientRect()
  const style = getComputedStyle(article)
  const lineHeight = parseFloat(style.lineHeight)
  const x = Math.max(clip.left + 1, article.getBoundingClientRect().left + parseFloat(style.paddingLeft) + 1)
  if (!Number.isFinite(lineHeight) || x >= clip.right) return null
  for (const inset of [1, lineHeight / 2, lineHeight * 1.5]) {
    const range = article.ownerDocument.caretRangeFromPoint?.(x, clip.top + inset)
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !article.contains(range.startContainer)) continue
    const node = range.startContainer as Text
    if (range.startOffset < node.length) range.setEnd(node, range.startOffset + 1)
    else if (range.startOffset > 0) range.setStart(node, range.startOffset - 1)
    const rect = range.getBoundingClientRect()
    if (rect.bottom <= clip.top + 1 || rect.top >= clip.bottom || rect.top >= clip.top + lineHeight * 2 ||
      rect.right <= clip.left || rect.left >= clip.right) continue
    const walker = article.ownerDocument.createTreeWalker(article, NodeFilter.SHOW_TEXT)
    let seen: Node | null
    let offset = 0
    while ((seen = walker.nextNode())) {
      if (seen === range.startContainer) return { offset: offset + range.startOffset, offsetTop: rect.top - clip.top, font: style.fontSize }
      offset += (seen as Text).length
    }
  }
  return null
}

export function restoreMarkdownFontPoint(root: HTMLElement, point: Partial<MarkdownFontPoint>) {
  const article = eligibleArticle(root)
  if (!article || typeof point.font !== 'string' || point.font === getComputedStyle(article).fontSize ||
    typeof point.offset !== 'number' || !Number.isSafeInteger(point.offset) || point.offset < 0 ||
    typeof point.offsetTop !== 'number' || !Number.isFinite(point.offsetTop)) return
  const walker = article.ownerDocument.createTreeWalker(article, NodeFilter.SHOW_TEXT)
  let node: Node | null
  let offset = point.offset
  while ((node = walker.nextNode())) {
    const text = node as Text
    if (offset >= text.length) { offset -= text.length; continue }
    const range = article.ownerDocument.createRange()
    range.setStart(text, offset)
    range.setEnd(text, offset + 1)
    const rect = range.getBoundingClientRect()
    if (!rect.height) return
    root.scrollTop += rect.top - root.getBoundingClientRect().top - point.offsetTop
    return
  }
}
