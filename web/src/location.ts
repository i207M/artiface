import { useCallback, useEffect, useState } from 'react'
import type { FileLocation, Location } from './types'

export function readLocation(): Location {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const kind = params.get('kind')
  return {
    host: params.get('host') ?? '',
    root: params.get('root') ?? '',
    path: params.get('path') ?? '',
    kind: kind === 'directory' || kind === 'file' || kind === 'auto' || kind === 'overview' || kind === 'settings' || kind === 'add-project'
      ? kind : 'overview',
    ...(kind === 'file' && params.get('view') === 'diff' ? { view: 'diff' as const } : {}),
  }
}

export function locationHash(location: Location) {
  return `#${new URLSearchParams({
    host: location.host,
    root: location.root,
    path: location.path,
    kind: location.kind,
    ...(location.kind === 'file' && location.view === 'diff' ? { view: 'diff' } : {}),
  })}`
}

export function useLocation() {
  const [location, setLocation] = useState(readLocation)
  useEffect(() => {
    const update = () => setLocation(readLocation())
    window.addEventListener('popstate', update)
    window.addEventListener('hashchange', update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener('hashchange', update)
    }
  }, [])
  const navigate = useCallback((next: Location, replace = false) => {
    const hash = locationHash(next)
    const same = locationHash(readLocation()) === hash
    const url = `${window.location.pathname}${hash}`
    if (!same || replace || window.location.hash !== hash || window.location.search) {
      window.history[replace || same ? 'replaceState' : 'pushState'](null, '', url)
    }
    setLocation(previous => locationHash(previous) === hash ? previous : next)
  }, [])
  return [location, navigate] as const
}

export function parentPath(path: string) {
  return path.split('/').slice(0, -1).join('/')
}

export function fileName(path: string) {
  return path.split('/').pop() || ''
}

export function fileTabName(file: FileLocation, fullPath = false) {
  return `${fullPath ? file.path : fileName(file.path)}${file.view === 'diff' ? ' · Diff' : ''}`
}

export function extension(path: string) {
  return fileName(path).split('.').pop()?.toLowerCase() ?? ''
}

// Relative Markdown links are resolved inside the configured project, never against /api.
export function resolveLocalPath(currentPath: string, href: string): string | null {
  if (!href || /[\u0000-\u001f\u007f\\]/.test(href) || href.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(href)) {
    return null
  }
  const pathname = href.split(/[?#]/)[0]
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith('/')) return null
  const parts = parentPath(currentPath).split('/').filter(Boolean)
  for (const part of decoded.split('/')) {
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (part && part !== '.') {
      parts.push(part)
    }
  }
  return parts.join('/')
}

export function safeExternalURL(href: string): string | null {
  if (/[\u0000-\u001f\u007f\\]/.test(href)) return null
  try {
    const url = new URL(href)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

export function localImageURL(href: string, previewURL: string): string | null {
  if (!href || /[\u0000-\u0020\u007f\\]/.test(href) || href.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null
  try {
    const base = new URL('.', previewURL)
    const target = new URL(href, previewURL)
    // The preview token is scoped to this parent directory; never let resolution discard it.
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return null
    const decoded = decodeURIComponent(target.pathname.slice(base.pathname.length))
    if (decoded.split('/').some((part) => part === '..' || part === '.') || /[\\\u0000-\u001f]/.test(decoded)) return null
    return target.href
  } catch {
    return null
  }
}

export function asFileLocation(location: Location): FileLocation {
  return { host: location.host, root: location.root, path: location.path }
}
