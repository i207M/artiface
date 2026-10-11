import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, APIError, errorMessage, isAborted } from '../api'
import { parentPath } from '../location'
import type { FileLocation, Host, Location } from '../types'
import { browseSources, createBrowseDirectories } from './browseDirectories'

const storageKey = 'artiface.workspace.v1'
export interface OpenProject { host: string; root: string; directory: string | null; activePath: string | null; activeView?: 'diff'; expanded: boolean }
export interface OpenFile extends FileLocation { autoRefreshPaused: boolean }
interface WorkspaceSession { projects: OpenProject[]; tabs: OpenFile[] }
type ProjectRef = Pick<OpenProject, 'host' | 'root'>
interface SharedProjects { projects: ProjectRef[]; sourcesRevision: string }
interface ProjectChange { project: ProjectRef; open: boolean }
const empty: WorkspaceSession = { projects: [], tabs: [] }
export const projectKey = (project: { host: string; root: string }) => JSON.stringify([project.host, project.root])
export const tabKey = (tab: FileLocation) => JSON.stringify([tab.host, tab.root, tab.path, ...(tab.view === 'diff' ? ['diff'] : [])])
const validProject = (value: unknown): value is { host: string; root: string } =>
  Boolean(value && typeof value === 'object' && 'host' in value && typeof value.host === 'string' && value.host &&
    'root' in value && typeof value.root === 'string' && value.root)

function readSession(storageKey: string): WorkspaceSession {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
    if (!value || typeof value !== 'object' || !Array.isArray(value.projects) || !Array.isArray(value.tabs)) return empty
    const tabs: OpenFile[] = []
    for (const tab of Array.isArray(value.tabs) ? value.tabs : []) {
      if (!validProject(tab) || !('path' in tab) || typeof tab.path !== 'string' || !tab.path || tabs.some(item => tabKey(item) === tabKey(tab as FileLocation))) continue
      if ('view' in tab && tab.view !== undefined && tab.view !== 'diff') continue
      tabs.push({ host: tab.host, root: tab.root, path: tab.path, ...('view' in tab && tab.view === 'diff' ? { view: 'diff' as const } : {}), autoRefreshPaused: 'autoRefreshPaused' in tab && tab.autoRefreshPaused === true })
    }
    const projects: OpenProject[] = []
    for (const project of Array.isArray(value.projects) ? value.projects : []) {
      if (!validProject(project) || projects.some(item => projectKey(item) === projectKey(project))) continue
      const activePath = 'activePath' in project ? project.activePath : null
      const activeView = 'activeView' in project && project.activeView === 'diff' ? 'diff' : undefined
      projects.push({
        host: project.host, root: project.root,
        directory: 'directory' in project && typeof project.directory === 'string' ? project.directory : null,
        expanded: !('expanded' in project) || project.expanded !== false,
        activePath: typeof activePath === 'string' && tabs.some(tab => projectKey(tab) === projectKey(project) && tab.path === activePath && tab.view === activeView) ? activePath : null,
        ...(activeView ? { activeView } : {}),
      })
    }
    return { projects, tabs: tabs.filter(tab => projects.some(project => projectKey(project) === projectKey(tab))) }
  } catch { return empty }
}

export function useWorkspaceTabs(hosts: Host[] | null, userID?: string) {
  const sessionKey = userID ? `${storageKey}.${userID}` : storageKey
  const [session, renderSession] = useState(() => readSession(sessionKey))
  const currentSession = useRef(session)
  const [directories] = useState(() => createBrowseDirectories(userID))
  const directorySources = useRef<Map<string, string> | null>(null)
  const [ready, setReady] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [sourcesRevision, setSourcesRevision] = useState('')
  const pending = useRef(new Map<string, ProjectChange>())
  const syncNow = useRef<() => void>(() => {})
  const stopSync = useRef<() => void>(() => {})
  const setSession = useCallback((change: (current: WorkspaceSession) => WorkspaceSession) => {
    const next = change(currentSession.current)
    if (next === currentSession.current) return
    currentSession.current = next
    renderSession(next)
  }, [])
  useLayoutEffect(() => {
    if (!hosts) return
    const previous = directorySources.current
    const sources = browseSources(hosts)
    directorySources.current = sources
    directories.retain(sources)
    setSession(current => {
      let changed = false
      const projects = current.projects.map(project => {
        if (previous && previous.get(projectKey(project)) === sources.get(projectKey(project))) return project
        const directory = directories.get(project, sources)
        if (directory === project.directory) return project
        changed = true
        return { ...project, directory }
      })
      return changed ? { ...current, projects } : current
    })
  }, [hosts, directories, setSession])
  const clear = useCallback(() => {
    stopSync.current()
    pending.current.clear()
    try { sessionStorage.removeItem(sessionKey) } catch { /* Storage may be unavailable. */ }
    setSession(() => empty)
  }, [setSession, sessionKey])
  useEffect(() => {
    try {
      if (session.projects.length) sessionStorage.setItem(sessionKey, JSON.stringify(session))
      else sessionStorage.removeItem(sessionKey)
    } catch { /* The workspace still works without browser storage. */ }
  }, [session, sessionKey])
  useEffect(() => {
    window.addEventListener('artiface:unauthorized', clear)
    return () => window.removeEventListener('artiface:unauthorized', clear)
  }, [clear])

  const hasHosts = hosts !== null
  useEffect(() => {
    if (!hasHosts) return
    let stopped = false
    let busy = false
    let timer = 0
    let controller: AbortController | undefined
    let writing = false
    const apply = (snapshot: SharedProjects) => {
      const projects = new Map(snapshot.projects.map(project => [projectKey(project), project]))
      for (const [key, change] of pending.current) {
        if (change.open) projects.set(key, change.project)
        else projects.delete(key)
      }
      setSession(current => {
        const next = [...projects.values()].map(project => current.projects.find(item => projectKey(item) === projectKey(project))
          ?? { ...project, directory: directories.get(project, directorySources.current ?? new Map()), activePath: null, expanded: true })
        const tabs = current.tabs.filter(tab => projects.has(projectKey(tab)))
        if (next.length === current.projects.length && next.every((project, index) => project === current.projects[index]) && tabs.length === current.tabs.length) return current
        return { projects: next, tabs }
      })
      setSourcesRevision(snapshot.sourcesRevision)
      setReady(true)
    }
    async function sync() {
      if (stopped || busy || (document.hidden && !pending.current.size)) return
      clearTimeout(timer)
      busy = true
      const batch = new Map(pending.current)
      writing = batch.size > 0
      controller = new AbortController()
      let succeeded = false
      const acknowledge = () => {
        for (const [key, change] of batch) if (pending.current.get(key) === change) pending.current.delete(key)
      }
      try {
        const body = {
          open: [...batch.values()].filter(change => change.open).map(change => change.project),
          close: [...batch.values()].filter(change => !change.open).map(change => change.project),
        }
        const snapshot = await api<SharedProjects>('/api/workspace/projects', writing
          ? { body, keepalive: JSON.stringify(body).length < 60_000, signal: controller.signal }
          : { signal: controller.signal })
        if (stopped) return
        acknowledge()
        apply(snapshot)
        setSyncError('')
        succeeded = true
      } catch (failure) {
        if (stopped || isAborted(failure)) return
        // A deleted/hidden project cannot be reopened by retrying a stale action.
        if (failure instanceof APIError && failure.status === 400) acknowledge()
        setSyncError(errorMessage(failure))
      } finally {
        busy = false
        if (!stopped) timer = window.setTimeout(() => void sync(), succeeded && pending.current.size ? 0 : 5000)
      }
    }
    const wake = () => { void sync() }
    const stop = () => {
      stopped = true
      clearTimeout(timer)
      // Let an already-sent, idempotent write finish when a browser tab closes.
      if (!writing) controller?.abort()
    }
    syncNow.current = wake
    stopSync.current = stop
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    wake()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
    }
  }, [hasHosts, setSession, directories])

  const share = useCallback((project: ProjectRef, open: boolean) => {
    pending.current.set(projectKey(project), { project: { host: project.host, root: project.root }, open })
    syncNow.current()
  }, [])
  const retrySync = useCallback(() => syncNow.current(), [])
  const remember = useCallback((location: Location, background = false) => {
    if (!location.host || !location.root || (location.kind !== 'file' && location.kind !== 'directory')) return
    if (location.kind === 'directory' && !background && directorySources.current) directories.remember(location, location.path, directorySources.current)
    const opened = !currentSession.current.projects.some(project => projectKey(project) === projectKey(location))
    setSession(current => {
      const previous = current.projects.find(project => projectKey(project) === projectKey(location))
      const savedDirectory = directories.get(location, directorySources.current ?? new Map())
      const project: OpenProject = previous
        ? { ...previous, directory: previous.directory ?? savedDirectory ?? (location.kind === 'file' ? parentPath(location.path) : location.path), ...(!background ? location.kind === 'file' ? { activePath: location.path, activeView: location.view } : { activePath: null, activeView: undefined, directory: location.path } : {}) }
        : { host: location.host, root: location.root, directory: location.kind === 'file' ? savedDirectory ?? parentPath(location.path) : location.path, activePath: !background && location.kind === 'file' ? location.path : null, activeView: !background && location.kind === 'file' ? location.view : undefined, expanded: true }
      const newFile = location.kind === 'file' && !current.tabs.some(tab => tabKey(tab) === tabKey(location))
      if (previous && previous.activePath === project.activePath && previous.activeView === project.activeView && previous.directory === project.directory && !newFile) return current
      return {
        ...current,
        projects: previous ? current.projects.map(item => projectKey(item) === projectKey(project) ? project : item) : [...current.projects, project],
        tabs: newFile ? [...current.tabs, { host: location.host, root: location.root, path: location.path, ...(location.view ? { view: location.view } : {}), autoRefreshPaused: false }] : current.tabs,
      }
    })
    if (opened) share(location, true)
  }, [setSession, share, directories])
  const retain = useCallback((viable: (project: { host: string; root: string }) => boolean) => {
    setSession(current => {
      const projects = current.projects.filter(viable)
      const tabs = current.tabs.filter(viable)
      return projects.length === current.projects.length && tabs.length === current.tabs.length ? current : { ...current, projects, tabs }
    })
  }, [setSession])
  const close = useCallback((tab: FileLocation) => {
    setSession(current => {
      const tabs = current.tabs.filter(item => tabKey(item) !== tabKey(tab))
      return {
        ...current,
        tabs,
        projects: current.projects.map(project => {
          if (projectKey(project) !== projectKey(tab) || project.activePath !== tab.path || project.activeView !== tab.view) return project
          const next = tabs.find(item => projectKey(item) === projectKey(project))
          return { ...project, activePath: next?.path ?? null, activeView: next?.view }
        }),
      }
    })
  }, [setSession])
  const reorder = useCallback((tab: FileLocation, target: FileLocation, edge: 'before' | 'after') => {
    if (projectKey(tab) !== projectKey(target) || tabKey(tab) === tabKey(target)) return
    setSession(current => {
      const siblings = current.tabs.filter(item => projectKey(item) === projectKey(tab))
      const source = siblings.find(item => tabKey(item) === tabKey(tab))
      if (!source || !siblings.some(item => tabKey(item) === tabKey(target))) return current
      const ordered = siblings.filter(item => item !== source)
      ordered.splice(ordered.findIndex(item => tabKey(item) === tabKey(target)) + (edge === 'after' ? 1 : 0), 0, source)
      if (ordered.every((item, index) => item === siblings[index])) return current
      let index = 0
      return { ...current, tabs: current.tabs.map(item => projectKey(item) === projectKey(tab) ? ordered[index++] : item) }
    })
  }, [setSession])
  const closeProject = useCallback((project: { host: string; root: string }) => {
    setSession(current => ({
      ...current,
      projects: current.projects.filter(item => projectKey(item) !== projectKey(project)),
      tabs: current.tabs.filter(item => projectKey(item) !== projectKey(project)),
    }))
    share(project, false)
  }, [setSession, share])
  const toggleProject = useCallback((project: { host: string; root: string }) => {
    setSession(current => ({ ...current, projects: current.projects.map(item => projectKey(item) === projectKey(project) ? { ...item, expanded: !item.expanded } : item) }))
  }, [setSession])
  const setPaused = useCallback((tab: FileLocation, paused: boolean) => {
    setSession(current => ({ ...current, tabs: current.tabs.map(item => tabKey(item) === tabKey(tab) ? { ...item, autoRefreshPaused: paused } : item) }))
  }, [setSession])
  const browseDirectory = (project: ProjectRef) => currentSession.current.projects.find(item => projectKey(item) === projectKey(project))?.directory
    ?? directories.get(project, directorySources.current ?? new Map()) ?? ''
  return { ...session, ready, syncError, sourcesRevision, retrySync, remember, close, reorder, closeProject, toggleProject, setPaused, retain, clear, browseDirectory }
}
