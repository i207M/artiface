import type { Element, Root, RootContent } from 'hast'

function headingText(node: RootContent): string {
  if (node.type === 'text') return node.value
  if (node.type !== 'element') return ''
  if (node.tagName === 'img') return String(node.properties.alt ?? '')
  return node.children.map(headingText).join('')
}

// Build anchors before KaTeX expands formulas into multiple display representations.
export function markdownHeadings({ prefix }: { prefix: string }) {
  return (root: Root) => {
    const used = new Set<string>()
    const anchors = new Map<string, string>()
    const references: Element[] = []
    function visit(node: Root | RootContent) {
      const originalID = node.type === 'element' && typeof node.properties.id === 'string' ? node.properties.id : ''
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
        const title = headingText(node).replace(/\s+/g, ' ').trim()
        const base = title.normalize('NFKC').toLowerCase().trim()
          .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/g, '-') || 'section'
        let slug = base
        for (let suffix = 1; used.has(slug); suffix++) slug = `${base}-${suffix}`
        used.add(slug)
        node.properties.id = prefix + slug
        node.properties.dataMarkdownHeading = slug
        node.properties.dataMarkdownTitle = title || 'Untitled section'
        node.properties.tabIndex = -1
      } else if (node.type === 'element' && originalID) {
        // Generated footnote IDs share the article's namespace, apart from heading slugs.
        node.properties.id = `${prefix}anchor:${originalID}`
        if (node.tagName !== 'a') node.properties.tabIndex = -1
      }
      if (node.type === 'element') {
        if (originalID) anchors.set(originalID, String(node.properties.id))
        if (node.properties.dataFootnoteRef !== undefined || node.properties.dataFootnoteBackref !== undefined) references.push(node)
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(root)
    for (const node of references) {
      const href = node.properties.href
      const target = typeof href === 'string' && href.startsWith('#') ? anchors.get(href.slice(1)) : undefined
      // Encode the whole ID: Unicode footnote labels can already contain percent escapes.
      if (target) node.properties.href = `#${encodeURIComponent(target)}`
      const description = node.properties.ariaDescribedBy
      if (Array.isArray(description)) node.properties.ariaDescribedBy = description.map(id => anchors.get(String(id)) ?? id)
    }
  }
}
