import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface PDFOutlineItem {
  title: string
  depth: number
  destination: string | unknown[] | null
}

// Resolve only a selected destination; looking up every bookmark can be slow.
export async function outlinePage(document: PDFDocumentProxy, destination: PDFOutlineItem['destination'], signal: AbortSignal) {
  signal.throwIfAborted()
  const target = typeof destination === 'string' ? await document.getDestination(destination) : destination
  signal.throwIfAborted()
  const reference = Array.isArray(target) ? target[0] : undefined
  let index: number
  if (typeof reference === 'number' && Number.isInteger(reference)) index = reference
  else if (reference && typeof reference === 'object' && 'num' in reference && 'gen' in reference &&
    typeof reference.num === 'number' && Number.isInteger(reference.num) && reference.num > 0 &&
    typeof reference.gen === 'number' && Number.isInteger(reference.gen) && reference.gen >= 0) {
    index = await document.getPageIndex(reference as { num: number; gen: number })
  } else throw new Error('This bookmark does not point to a page.')
  signal.throwIfAborted()
  if (!Number.isInteger(index) || index < 0 || index >= document.numPages) throw new Error('This bookmark points outside the document.')
  return index + 1
}

export function flattenOutline(nodes: unknown) {
  const items: PDFOutlineItem[] = []
  const frames = [{ nodes: Array.isArray(nodes) ? nodes : [], index: 0, depth: 0 }]
  const seen = new Set<object>()
  let truncated = false
  while (frames.length) {
    const frame = frames[frames.length - 1]
    if (frame.index >= frame.nodes.length) { frames.pop(); continue }
    if (items.length >= 500) { truncated = true; break }
    const node: unknown = frame.nodes[frame.index++]
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    const value = node as Record<string, unknown>
    items.push({
      title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 4096) : 'Untitled section',
      depth: frame.depth,
      destination: typeof value.dest === 'string' || Array.isArray(value.dest) ? value.dest : null,
    })
    if (Array.isArray(value.items) && value.items.length) {
      if (frame.depth >= 31) truncated = true
      else frames.push({ nodes: value.items, index: 0, depth: frame.depth + 1 })
    }
  }
  return { items, truncated }
}
