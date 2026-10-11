import assert from 'node:assert/strict'

globalThis.window = new EventTarget()
const { defaultImageView, imageLayout, imageCenter, imageScroll, imageViewGeneration, readImageView, retainImageView, retainOpenImageViews, clearImageViews,
  reusableImagePreview, retainImagePreview, forgetImagePreview } = await import('../web/src/imageView.ts')
const natural = { width: 1600, height: 1200 }
const viewport = { width: 640, height: 480 }
assert.equal(defaultImageView().background, 'theme')
const close = (actual, expected) => assert(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`)
const fit = imageLayout(natural, viewport, defaultImageView())
assert(fit.imageWidth <= viewport.width - 32 && fit.imageHeight <= viewport.height - 32)
assert.deepEqual({ width: fit.width, height: fit.height }, viewport)
assert.equal(imageLayout({ width: 50, height: 20 }, viewport, defaultImageView()).scale, 1, 'Fit enlarged a small image')
assert.equal(imageLayout(natural, viewport, { ...defaultImageView(), zoom: 10 }).scale, 4)
assert.equal(imageLayout(natural, viewport, { ...defaultImageView(), zoom: 0.1 }).scale, 0.25)
for (const rotation of [0, 90, 180, 270]) {
  const rotatedFit = imageLayout(natural, viewport, { ...defaultImageView(), rotation })
  assert(rotatedFit.imageWidth <= viewport.width - 32 + 0.000001 && rotatedFit.imageHeight <= viewport.height - 32 + 0.000001)
  const fitCenter = imageCenter(rotatedFit, 0, 0)
  close(fitCenter.x, 0.5)
  close(fitCenter.y, 0.5)
  const view = { ...defaultImageView(), zoom: 2, rotation, x: 0.4, y: 0.6 }
  const layout = imageLayout(natural, viewport, view)
  assert.equal(layout.imageWidth, 2 * (rotation % 180 ? natural.height : natural.width))
  assert.equal(layout.imageHeight, 2 * (rotation % 180 ? natural.width : natural.height))
  const position = imageScroll(layout, view)
  const center = imageCenter(layout, position.left, position.top)
  close(center.x, view.x)
  close(center.y, view.y)
  for (const zoom of [0.75, 1, 4]) {
    const changed = imageLayout(natural, { width: 500, height: 300 }, { ...view, zoom })
    const scroll = imageScroll(changed, center)
    const restored = imageCenter(changed, scroll.left, scroll.top)
    close(restored.x, center.x)
    close(restored.y, center.y)
  }
  const corner = imageScroll(layout, { x: -1, y: 2 })
  assert(corner.left >= 0 && corner.left <= layout.width - viewport.width)
  assert(corner.top >= 0 && corner.top <= layout.height - viewport.height)
}
const view = { zoom: 2, rotation: 90, background: 'light', x: 0.3, y: 0.7 }
const keys = Array.from({ length: 66 }, (_, index) => String(index))
retainOpenImageViews(keys)
const now = Date.now()
const loaded = { url: 'https://preview.invalid/p/loaded/first.png', path: 'resolved/first.png', version: 'v1',
  scripts: false, expiresAt: new Date(now + 60_000).toISOString() }
const fresh = { ...loaded, url: 'https://preview.invalid/p/fresh/first.png', expiresAt: new Date(now + 120_000).toISOString() }
const load = new AbortController()
for (const key of keys.slice(0, 64)) retainImagePreview(key, loaded, imageViewGeneration(), load.signal)
assert.deepEqual(reusableImagePreview('0', fresh, imageViewGeneration()), { ...fresh, url: loaded.url, expiresAt: loaded.expiresAt })
for (const patch of [{ version: 'v2' }, { path: 'other/first.png' }, { path: undefined }, { scripts: true },
  { url: 'https://other.invalid/p/fresh/first.png' }, { url: 'invalid' }, { expiresAt: new Date(now + 30_000).toISOString() }]) {
  assert.equal(reusableImagePreview('0', { ...fresh, ...patch }, imageViewGeneration()), undefined)
}
const actualNow = Date.now
try {
  Date.now = () => now + 60_001
  assert.equal(reusableImagePreview('0', fresh, imageViewGeneration()), undefined, 'Expired capability reused')
} finally { Date.now = actualNow }
const descriptor = reusableImagePreview('0', fresh, imageViewGeneration())
descriptor.url = 'https://preview.invalid/mutated'
assert.equal(reusableImagePreview('0', fresh, imageViewGeneration()).url, loaded.url)
retainImagePreview('64', loaded, imageViewGeneration(), load.signal)
assert.equal(reusableImagePreview('1', fresh, imageViewGeneration()), undefined, 'Descriptor LRU exceeded 64')
assert(reusableImagePreview('0', fresh, imageViewGeneration()))
forgetImagePreview('0', imageViewGeneration())
assert.equal(reusableImagePreview('0', fresh, imageViewGeneration()), undefined)
for (const key of keys.slice(0, 64)) retainImageView(key, view, imageViewGeneration())
assert.deepEqual(readImageView('0'), view)
retainImageView('64', view, imageViewGeneration())
assert.equal(readImageView('1'), undefined, 'View count was not bounded by LRU eviction')
assert.deepEqual(readImageView('0'), view)
const copy = readImageView('0')
copy.zoom = 4
copy.background = 'dark'
assert.equal(readImageView('0').zoom, 2, 'Caller mutated a cached view')
assert.equal(readImageView('0').background, 'light', 'Caller mutated a cached background')
retainOpenImageViews(['0'])
assert.equal(readImageView('64'), undefined, 'Closed tab retained image view')
assert.equal(reusableImagePreview('64', fresh, imageViewGeneration()), undefined, 'Closed tab retained a capability')
const cancelledLoad = new AbortController()
cancelledLoad.abort()
retainOpenImageViews([])
retainOpenImageViews(['0'])
retainImagePreview('0', loaded, imageViewGeneration(), cancelledLoad.signal)
assert.equal(reusableImagePreview('0', fresh, imageViewGeneration()), undefined, 'Cancelled owner recached a reopened tab')
retainImageView('closed', view, imageViewGeneration())
assert.equal(readImageView('closed'), undefined, 'Late unmount recached a closed tab')
for (const name of ['artiface:unauthorized', 'artiface:configuration-changed', 'pagehide']) {
  retainImageView('0', view, imageViewGeneration())
  retainImagePreview('0', loaded, imageViewGeneration(), load.signal)
  const staleGeneration = imageViewGeneration()
  window.dispatchEvent(new Event(name))
  assert.equal(readImageView('0'), undefined)
  assert.equal(reusableImagePreview('0', fresh, imageViewGeneration()), undefined)
  retainImageView('0', view, staleGeneration)
  retainImagePreview('0', loaded, staleGeneration, load.signal)
  assert.equal(readImageView('0'), undefined, `${name} allowed stale cache writes`)
  assert.equal(reusableImagePreview('0', fresh, imageViewGeneration()), undefined, `${name} allowed stale preview writes`)
}
clearImageViews()
delete globalThis.window
console.log('PASS: image geometry and bounded view/descriptor metadata; authorized identity/expiry matching, original expiry, closed/cancelled owners, and generation/session cleanup')
