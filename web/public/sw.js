// Vite substitutes a content-derived version and public shell assets at build time.
const CACHE = 'artiface-shell-__BUILD_ID__'
const SHELL = ['__SHELL_ASSETS__']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)))
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('artiface-shell-') && key !== CACHE) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  // Never intercept authenticated APIs, preview origins, or file downloads.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  const navigation = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')
  const asset = !url.search && (
    url.pathname.startsWith('/assets/') || url.pathname.startsWith('/pdfjs/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' || url.pathname === '/favicon.svg'
  )
  if (!navigation && !asset) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    if (navigation) {
      try {
        const response = await fetch(request)
        if (response.ok && response.type === 'basic' && !response.redirected) await cache.put('/index.html', response.clone())
        return response
      } catch {
        return await cache.match('/index.html') || new Response(
          '<!doctype html><meta name="viewport" content="width=device-width"><title>Artiface offline</title><h1>Artiface is offline</h1><p>Reconnect to your server to browse files.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        )
      }
    }
    const cached = await cache.match(url.pathname)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && response.type === 'basic' && !response.redirected) await cache.put(url.pathname, response.clone())
    return response
  })())
})
