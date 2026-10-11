import type { Host } from '../types'

type ProjectRef = { host: string; root: string }
type Directory = { source: string; path: string }
const projectKey = (project: ProjectRef) => JSON.stringify([project.host, project.root])

export function browseSources(hosts: Host[]) {
  return new Map(hosts.filter(host => !host.hidden).flatMap(host => host.roots.filter(root => !root.hidden).map(root => [
    projectKey({ host: host.id, root: root.id }),
    JSON.stringify([host.kind ?? 'ssh', host.target, root.path]),
  ])))
}

// Only Browse folders persist; open files remain in the separate tab session.
export function createBrowseDirectories(userID?: string) {
  const storageKey = `artiface.browse-directories.${JSON.stringify(userID ?? null)}`
  let directories = new Map<string, Directory>()
  let storageAvailable = true
  function read() {
    if (!storageAvailable) return
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || '{}')
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        directories = new Map(Object.entries(stored).filter((entry): entry is [string, Directory] => {
          const value = entry[1] as Partial<Directory> | null
          return Boolean(value && typeof value.source === 'string' && typeof value.path === 'string')
        }))
      }
    } catch { storageAvailable = false }
  }
  function write() {
    if (!storageAvailable) return
    try {
      if (directories.size) localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(directories)))
      else localStorage.removeItem(storageKey)
    } catch { storageAvailable = false }
  }
  return {
    get(project: ProjectRef, sources: Map<string, string>) {
      read()
      const saved = directories.get(projectKey(project))
      return saved?.source === sources.get(projectKey(project)) ? saved?.path ?? null : null
    },
    remember(project: ProjectRef, path: string, sources: Map<string, string>) {
      const key = projectKey(project), source = sources.get(key)
      if (!source) return
      read()
      if (directories.get(key)?.source === source && directories.get(key)?.path === path) return
      directories.set(key, { source, path })
      write()
    },
    retain(sources: Map<string, string>) {
      read()
      let changed = false
      for (const [key, saved] of directories) {
        if (saved.source !== sources.get(key)) { directories.delete(key); changed = true }
      }
      if (changed) write()
    },
  }
}
