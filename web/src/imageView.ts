import type { PreviewResponse } from './types'

export interface ImageView {
  zoom: 'fit' | number
  rotation: number
  background: 'theme' | 'light' | 'dark'
  x: number
  y: number
}
export interface ImageSize { width: number; height: number }
export interface ImageLayout extends ImageSize {
  scale: number
  imageWidth: number
  imageHeight: number
  viewport: ImageSize
  rotation: number
}

export const imageZooms = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]
export const defaultImageView = (): ImageView => ({ zoom: 'fit', rotation: 0, background: 'theme', x: 0.5, y: 0.5 })
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function imageLayout(natural: ImageSize, viewport: ImageSize, view: ImageView): ImageLayout {
  const rotation = ((view.rotation % 360) + 360) % 360
  const width = rotation % 180 ? natural.height : natural.width
  const height = rotation % 180 ? natural.width : natural.height
  const scale = view.zoom === 'fit'
    ? Math.min(1, Math.max(1, viewport.width - 32) / width, Math.max(1, viewport.height - 32) / height)
    : clamp(view.zoom, 0.25, 4)
  return {
    scale, rotation, viewport, imageWidth: width * scale, imageHeight: height * scale,
    width: Math.max(viewport.width, width * scale + 32), height: Math.max(viewport.height, height * scale + 32),
  }
}

export function imageCenter(layout: ImageLayout, left: number, top: number) {
  const x = clamp((left + layout.viewport.width / 2 - (layout.width - layout.imageWidth) / 2) / layout.imageWidth, 0, 1)
  const y = clamp((top + layout.viewport.height / 2 - (layout.height - layout.imageHeight) / 2) / layout.imageHeight, 0, 1)
  if (layout.rotation === 90) return { x: y, y: 1 - x }
  if (layout.rotation === 180) return { x: 1 - x, y: 1 - y }
  if (layout.rotation === 270) return { x: 1 - y, y: x }
  return { x, y }
}

export function imageScroll(layout: ImageLayout, center: Pick<ImageView, 'x' | 'y'>) {
  const { x, y } = center
  const rotated = layout.rotation === 90 ? { x: 1 - y, y: x } : layout.rotation === 180 ? { x: 1 - x, y: 1 - y }
    : layout.rotation === 270 ? { x: y, y: 1 - x } : { x, y }
  return {
    left: clamp((layout.width - layout.imageWidth) / 2 + rotated.x * layout.imageWidth - layout.viewport.width / 2, 0, layout.width - layout.viewport.width),
    top: clamp((layout.height - layout.imageHeight) / 2 + rotated.y * layout.imageHeight - layout.viewport.height / 2, 0, layout.height - layout.viewport.height),
  }
}

// Bounded view/preview metadata only; image resources remain browser-managed.
const views = new Map<string, ImageView>()
const previews = new Map<string, PreviewResponse>()
let openFiles = new Set<string>()
let generation = 0
export const imageViewGeneration = () => generation

export function reusableImagePreview(key: string, fresh: PreviewResponse, ownerGeneration: number) {
  const previous = previews.get(key)
  if (ownerGeneration !== generation || !openFiles.has(key) || !previous ||
    !fresh.path || previous.path !== fresh.path || previous.version !== fresh.version ||
    previous.scripts !== fresh.scripts || !(Date.parse(previous.expiresAt) > Date.now()) ||
    !(Date.parse(fresh.expiresAt) >= Date.parse(previous.expiresAt))) return
  try {
    if (new URL(previous.url).origin !== new URL(fresh.url).origin) return
  } catch { return }
  previews.delete(key)
  previews.set(key, previous)
  return { ...fresh, url: previous.url, expiresAt: previous.expiresAt }
}

export function retainImagePreview(key: string, preview: PreviewResponse, ownerGeneration: number, signal: AbortSignal) {
  if (signal.aborted || ownerGeneration !== generation || !openFiles.has(key) ||
    !preview.path || !preview.version || !(Date.parse(preview.expiresAt) > Date.now())) return
  previews.delete(key)
  previews.set(key, { url: preview.url, path: preview.path, version: preview.version,
    scripts: preview.scripts, expiresAt: preview.expiresAt })
  if (previews.size > 64) previews.delete(previews.keys().next().value!)
}

export function forgetImagePreview(key: string, ownerGeneration: number) {
  if (ownerGeneration === generation) previews.delete(key)
}

export function readImageView(key: string) {
  const view = views.get(key)
  if (!view) return
  views.delete(key)
  views.set(key, view)
  return { ...view }
}

export function retainImageView(key: string, view: ImageView, ownerGeneration: number) {
  if (ownerGeneration !== generation || !openFiles.has(key)) return
  views.delete(key)
  views.set(key, { ...view })
  if (views.size > 64) views.delete(views.keys().next().value!)
}

export function retainOpenImageViews(keys: string[]) {
  openFiles = new Set(keys)
  for (const key of views.keys()) if (!openFiles.has(key)) views.delete(key)
  for (const key of previews.keys()) if (!openFiles.has(key)) previews.delete(key)
}

export function clearImageViews() {
  generation++
  views.clear()
  previews.clear()
}

window.addEventListener('artiface:unauthorized', clearImageViews)
window.addEventListener('artiface:configuration-changed', clearImageViews)
window.addEventListener('pagehide', clearImageViews)
