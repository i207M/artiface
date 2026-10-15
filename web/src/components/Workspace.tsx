import { ArrowLeft, ArrowUp, ChevronDown, ChevronRight, ChevronUp, FolderOpen, Layers, LayoutGrid, List, LogOut, Minimize2, PanelLeft, PanelLeftClose, PanelLeftDashed, PanelLeftOpen, Pause, Plus, RefreshCw, Search, Settings, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { api, APIError, apiURL, errorMessage, isAborted } from '../api'
import { copyText } from '../clipboard'
import { relativeTime } from '../format'
import { fileTabName, locationHash, parentPath } from '../location'
import { setFolderReaderTypes, usePreferences } from '../preferences'
import { clearPDFCache, retainOpenPDFs } from '../pdfCache'
import { clearImageViews, retainOpenImageViews } from '../imageView'
import type { Entry, FileLocation, Host, HostsResponse, Location, Project } from '../types'
import { Brand, ShareButton, FileTabIcon, ErrorState, Loading, ProjectFolderIcon } from './Common'
import BrowseSettings from './BrowseSettings'
import BrowseResults from './BrowseResults'
import FileFilters from './FileFilters'
import FileList, { browsePageSize } from './FileList'
import FileSortSelect from './FileSortSelect'
import FileSortButton from './FileSortButton'
import FilePreview from './FilePreview'
import GitChanges from './GitChanges'
import GitDiffViewer from './GitDiffViewer'
import GitHistoryViewer from './GitHistoryViewer'
import { useGitStatus } from './useGitStatus'
import CopyPathDialog from './CopyPathDialog'
import ReaderDeck from './ReaderDeck'
import ProjectChooser from './ProjectChooser'
import OverviewColumns from './OverviewColumns'
import SettingsPage from './SettingsPage'
import SidebarResize from './SidebarResize'
import { useReorderDrag } from './useReorderDrag'
import Tabs from './Tabs'
import { allReaderTypes, readerType, sortEntries } from './fileTypes'
import type { SortColumn } from './fileTypes'
import { projectKey, tabKey, useWorkspaceTabs } from './workspaceTabs'
import type { OpenProject } from './workspaceTabs'
import { useOverviewMetadata } from './useOverviewMetadata'
import { useReaderFullscreen } from './useReaderFullscreen'
import { clearReaderViews, retainOpenReaderViews } from './useReaderView'
import { useBrowseReaderFocus } from './useBrowseReaderFocus'
import type { OverviewMetadata } from './useOverviewMetadata'
import './workspace.css'

type Navigate = (next: Location, replace?: boolean) => void
interface Listing { key: string; entries: Entry[] | null; error: string; warning?: string; pending?: boolean }
function isTransientFailure(failure: unknown) {
  return failure instanceof APIError ? failure.status >= 500 && failure.status < 600 : failure instanceof TypeError
}
function retainUnchangedEntries(previous: Entry[] | null, next: Entry[]): Entry[] {
  if (!previous || previous.length !== next.length) return next
  return next.every((entry, index) => {
    const old = previous[index]
    return old.name === entry.name && old.path === entry.path && old.type === entry.type &&
      old.size === entry.size && old.modified === entry.modified && old.symlink === entry.symlink &&
      old.resolvedPath === entry.resolvedPath
  }) ? previous : next
}
interface BrowsePage { signature: string; page: number }
interface BrowseScroll extends BrowsePage { top: number; view: 'list' | 'icons'; anchor?: { path: string; offset: number } }
const home: Location = { host: '', root: '', path: '', kind: 'overview' }
const isProjectLocation = (location: Location) => ['file', 'directory', 'auto'].includes(location.kind)

function OverviewModified({ metadata }: { metadata?: OverviewMetadata }) {
  return <small className="overview-modified" title={metadata?.error}>
    {metadata?.modified
      ? <time dateTime={metadata.modified} title={`Last modified ${new Date(metadata.modified).toLocaleString()}`}>Modified {relativeTime(metadata.modified)}{metadata.error ? ' · last known' : ''}</time>
      : metadata?.error ? 'Modification time unavailable' : 'Checking time…'}
  </small>
}

export default function Workspace({ location, navigate, onLogout, canManage = true, userID }: { location: Location; navigate: Navigate; onLogout: () => void; canManage?: boolean; userID?: string }) {
  const readerFocus = useBrowseReaderFocus(location)
  const [preferences, setPreferences] = usePreferences()
  const [hosts, setHosts] = useState<Host[] | null>(null)
  const { projects, tabs, ready: projectsReady, syncError, sourcesRevision, retrySync, remember, close, reorder, reorderProjects, closeProject, toggleProject, setPaused, retain, clear, browseDirectory } = useWorkspaceTabs(hosts, userID)
  const [hostsError, setHostsError] = useState('')
  const [hostsAttempt, setHostsAttempt] = useState(0)
  const [catalogRevision, setCatalogRevision] = useState('')
  const [setupEnabled, setSetupEnabled] = useState(false)
  const [listing, setListing] = useState<Listing>({ key: '', entries: null, error: '' })
  const [refresh, setRefresh] = useState(0)
  const listingRequest = useRef<{ key: string; reload: () => void } | null>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const retryFocus = useRef<{ key: string; button: HTMLButtonElement } | null>(null)
  const [folderFilters, setFolderFilters] = useState<Record<string, string>>({})
  const [browsePages, setBrowsePages] = useState<Record<string, BrowsePage>>({})
  const browseScroll = useRef(new Map<string, BrowseScroll>())
  const browseContent = useRef<HTMLDivElement>(null)
  const browseFiles = useRef<HTMLDivElement>(null)
  const browseSearch = useRef<HTMLInputElement>(null)
  const breadcrumbs = useRef<HTMLElement>(null)
  const overview = useRef<HTMLDivElement>(null)
  const overviewSpace = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (location.kind !== 'overview') return
    const cancel = () => { overviewSpace.current = null }
    window.addEventListener('blur', cancel)
    return () => { cancel(); window.removeEventListener('blur', cancel) }
  }, [location.kind])
  const finishFiltering = () => {
    const target = browseFiles.current?.querySelector<HTMLElement>('[aria-label="Directory results"]') ??
      document.getElementById('main-content')
    target?.focus({ preventScroll: true })
  }
  const mobilePageJump = useRef<HTMLSelectElement | null>(null)
  const attachPageJump = useCallback((element: HTMLSelectElement | null) => {
    if (!element && mobilePageJump.current === document.activeElement) {
      requestAnimationFrame(() => {
        const target = browseFiles.current?.querySelector<HTMLElement>('[data-page-control="select"]') ??
          browseFiles.current?.querySelector<HTMLElement>('[aria-label="Directory results"]') ??
          document.getElementById('main-content')
        target?.focus({ preventScroll: true })
      })
    }
    mobilePageJump.current = element
  }, [])
  const sort = preferences.browseSort ?? preferences.defaultBrowseSort
  const [phone, setPhone] = useState(() => matchMedia('(max-width: 700px)').matches)
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const { element: fullscreenElement, expanded, enter: enterFullscreen, exit: exitFullscreen } = useReaderFullscreen()
  const [copied, setCopied] = useState(false)
  const [manualCopyPath, setManualCopyPath] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const sidebar = useRef<HTMLElement>(null)
  const projectList = useRef<HTMLElement>(null)
  const sidebarToggle = useRef<HTMLButtonElement>(null)
  const returnSidebarFocus = useRef(true)
  const settingsReturn = useRef<Location>(home)
  const settingsSection = useRef<'appearance' | 'ignore' | 'sources'>('appearance')
  const settingsHasHistory = useRef(false)
  const addReturn = useRef<Location>(home)
  const chooserReturnFocus = useRef<{ location: Location; origin: HTMLButtonElement } | null>(null)
  useLayoutEffect(() => {
    const request = chooserReturnFocus.current
    chooserReturnFocus.current = null
    if (!request || !document.hasFocus() || locationHash(request.location) !== locationHash(location) ||
      request.origin.isConnected || document.activeElement !== document.body) return
    const target = (location.kind === 'directory'
      ? browseFiles.current?.querySelector<HTMLElement>('[aria-label="Directory results"]') ?? document.getElementById('browse-tab')
      : location.kind === 'overview' ? overview.current?.querySelector<HTMLElement>('.overview-intro > button') : null) ??
      document.getElementById('main-content')
    target?.focus({ preventScroll: true })
  }, [location])
  const previousProjects = useRef(new Set(projects.map(projectKey)))
  const rememberedLocation = useRef<Location | null>(null)
  const sourceIdentity = useRef<string | null>(null)
  const visibleHosts = useMemo(() => hosts?.filter(host => !host.hidden).map(host => ({ ...host, roots: host.roots.filter(root => !root.hidden) })), [hosts])
  const host = visibleHosts?.find(host => host.id === location.host)
  const project = host?.roots.find(project => project.id === location.root)
  const gitIdentity = JSON.stringify([location.host, location.root, host?.target, project?.path, catalogRevision, sourcesRevision])
  const gitEnabled = Boolean(projectsReady && project && location.kind === 'directory' && preferences.gitStatus && !preferences.disabledGitProjects.includes(projectKey(location)))
  const git = useGitStatus(location, gitEnabled, gitIdentity)
  function openGitDiff(path: string, commit?: string) {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const next: Location = { host: location.host, root: location.root, path, kind: 'file', view: 'diff', ...(commit ? { commit } : {}) }
    remember(next)
    go(next)
    readerFocus.begin(next, origin)
  }
  function openGitHistory() {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const next: Location = { host: location.host, root: location.root, path: '', kind: 'file', view: 'history' }
    remember(next)
    go(next)
    readerFocus.begin(next, origin)
  }
  const projectTabs = tabs.filter(tab => projectKey(tab) === projectKey(location))
  const activeTab = location.kind === 'file' ? tabs.find(tab => tabKey(tab) === tabKey(location)) : undefined
  const directory = location.kind === 'auto' ? parentPath(location.path) : location.path
  const folderKey = JSON.stringify([location.host, location.root, directory])
  const readerTypes = preferences.folderReaderTypes[folderKey] ?? preferences.defaultReaderTypes
  const flatBrowse = preferences.flatBrowse && location.kind === 'directory'
  const listingURL = project && (location.kind === 'directory' || location.kind === 'auto')
    ? apiURL('list', { host: location.host, root: location.root, path: directory }) + (flatBrowse ? `&recursive=1&showHidden=${preferences.showHidden ? '1' : '0'}` : '') : ''
  // IDs and URLs survive source moves; rows from the previous source must not.
  const listingKey = listingURL ? JSON.stringify([listingURL, host?.kind, host?.target, project?.path, project?.trustedScripts, catalogRevision, sourcesRevision]) : ''
  const filter = folderFilters[listingURL] ?? ''
  const entries = listing.key === listingKey ? listing.entries : null
  const listingError = listing.key === listingKey ? listing.error : ''
  const listingWarning = listing.key === listingKey ? listing.warning : ''
  const listingPending = listing.key === listingKey && Boolean(listing.pending)
  useLayoutEffect(() => {
    const origin = retryFocus.current
    retryFocus.current = null
    if (origin?.key === listingKey && entries !== null && !origin.button.isConnected && document.hasFocus() && document.activeElement === document.body) finishFiltering()
  }, [listingKey, entries])
  function refreshListing() {
    if (!listingPending && listingRequest.current?.key === listingKey) listingRequest.current.reload()
  }
  const overlay = phone || preferences.sidebarMode === 'overlay'
  const sidebarShown = !expanded && (phone ? mobileSidebar : preferences.sidebarVisible)
  const openProjects = useMemo(() => projects.flatMap(state => {
    const host = visibleHosts?.find(host => host.id === state.host)
    const project = host?.roots.find(project => project.id === state.root)
    return host && project ? [{ state, host, project, tabs: tabs.filter(tab => projectKey(tab) === projectKey(state)) }] : []
  }), [projects, tabs, visibleHosts])
  const projectDrag = useReorderDrag(projectList, openProjects.map(item => item.state), `${sidebarShown}:${overlay}:${locationHash(location)}`, reorderProjects, {
    key: projectKey, attribute: 'data-project-key', image: '.project-line',
    transferType: 'application/x-artiface-project', axis: 'vertical',
  })
  const overviewMachines = useMemo(() => {
    const projectsByLabel = new Map<string, Set<string>>()
    const hostsByLabel = new Map<string, Set<string>>()
    for (const { project, host } of openProjects) {
      if (!projectsByLabel.has(project.label)) projectsByLabel.set(project.label, new Set())
      projectsByLabel.get(project.label)!.add(host.id)
      if (!hostsByLabel.has(host.label)) hostsByLabel.set(host.label, new Set())
      hostsByLabel.get(host.label)!.add(host.id)
    }
    return new Map(openProjects.filter(({ project }) => projectsByLabel.get(project.label)!.size > 1)
      .map(({ state, host }) => [projectKey(state), hostsByLabel.get(host.label)!.size > 1 ? host.id : host.label]))
  }, [openProjects])
  const overviewMetadata = useOverviewMetadata(openProjects.flatMap(project => project.tabs), location.kind === 'overview', preferences.autoRefreshSeconds)

  useEffect(() => { retainOpenPDFs(tabs.filter(tab => !tab.view).map(tab => apiURL('file', tab))) }, [tabs])
  useEffect(() => { retainOpenImageViews(tabs.filter(tab => !tab.view && readerType(tab.path) === 'image').map(tab => apiURL('file', tab))) }, [tabs])
  useEffect(() => { retainOpenReaderViews(tabs.filter(tab => !tab.view && !['pdf', 'image'].includes(readerType(tab.path))).map(tab => apiURL('file', tab))) }, [tabs])
  useEffect(() => () => clearPDFCache(), [])
  useEffect(() => () => clearImageViews(), [])
  useEffect(() => () => clearReaderViews(), [])
  useEffect(() => {
    if (sourcesRevision) setHostsAttempt(value => value + 1)
  }, [sourcesRevision])
  useEffect(() => {
    const media = matchMedia('(max-width: 700px)')
    const changed = () => { setPhone(media.matches); setMobileSidebar(false) }
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void api<HostsResponse>('/api/hosts', { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return
      const identity = JSON.stringify([data.revision, data.hosts.filter(host => host.roots?.length).map(host =>
        [host.id, host.kind, host.target, host.roots.map(root => [root.id, root.path, root.trustedScripts])])])
      // Source edits from another device must invalidate documents from the old location.
      if (sourceIdentity.current !== null && sourceIdentity.current !== identity) { clearPDFCache(); clearImageViews(); clearReaderViews() }
      sourceIdentity.current = identity
      setCatalogRevision(data.revision ?? '')
      setHosts(data.hosts.map(host => ({ ...host, label: host.kind === 'local' && !host.label ? 'localhost' : host.label || host.id, roots: (host.roots ?? []).map(root => ({ ...root, label: root.label || root.id })) })))
      setSetupEnabled(data.setupEnabled)
      setHostsError('')
    }).catch(failure => {
      if (controller.signal.aborted || isAborted(failure)) return
      if (!isTransientFailure(failure)) {
        setHosts(null)
        setListing({ key: '', entries: null, error: '' })
        clearPDFCache()
        clearImageViews()
        clearReaderViews()
      }
      setHostsError(errorMessage(failure))
    })
    return () => controller.abort()
  }, [hostsAttempt])
  useEffect(() => {
    if (visibleHosts) retain(item => visibleHosts.some(host => host.id === item.host && host.roots.some(root => root.id === item.root)))
  }, [visibleHosts, retain])
  useEffect(() => {
    if (!projectsReady || !visibleHosts) return
    const wasOpen = previousProjects.current.has(projectKey(location))
    previousProjects.current = new Set(projects.map(projectKey))
    if (!isProjectLocation(location)) return
    if (wasOpen && (!host || !project || !projects.some(item => projectKey(item) === projectKey(location)))) {
      navigate(home, true)
      return
    }
    if (host && project && rememberedLocation.current !== location) {
      rememberedLocation.current = location
      remember(location)
    }
  }, [projectsReady, visibleHosts, host, project, projects, location, navigate, remember])
  useEffect(() => {
    if (!listingURL) return
    let stopped = false
    let busy = false
    let timer = 0
    let controller: AbortController | null = null
    setListing(current => current.key === listingKey ? current : { key: listingKey, entries: null, error: '' })
    const load = async () => {
      if (stopped || busy || document.hidden) return
      busy = true
      setListing(current => ({ ...current, pending: true }))
      controller = new AbortController()
      try {
        const result = await api<{ entries: Entry[]; warning?: string; truncated?: boolean }>(listingURL, { signal: controller.signal })
        if (!stopped) {
          if (retryButton.current && retryButton.current === document.activeElement) retryFocus.current = { key: listingKey, button: retryButton.current }
          setListing(current => ({
            key: listingKey,
            entries: retainUnchangedEntries(current.key === listingKey ? current.entries : null, result.entries ?? []),
            error: '', warning: result.warning || (result.truncated ? 'Showing a partial listing. Choose a smaller folder to see more files.' : ''),
          }))
        }
      } catch (failure) {
        if (!stopped && !isAborted(failure)) setListing(current => ({
          key: listingKey,
          entries: isTransientFailure(failure) && current.key === listingKey ? current.entries : null,
          warning: isTransientFailure(failure) && current.key === listingKey ? current.warning : '',
          error: errorMessage(failure),
        }))
      } finally {
        busy = false
        if (!stopped && !document.hidden) timer = window.setTimeout(() => void load(), preferences.autoRefreshSeconds * 1000)
      }
    }
    const visible = () => { clearTimeout(timer); if (!document.hidden) void load() }
    const request = { key: listingKey, reload: () => { if (!busy) { clearTimeout(timer); void load() } } }
    listingRequest.current = request
    void load()
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible)
      if (listingRequest.current === request) listingRequest.current = null
    }
  }, [listingURL, listingKey, refresh, preferences.autoRefreshSeconds])
  useEffect(() => {
    if (location.kind !== 'auto' || !entries) return
    const entry = entries.find(entry => entry.path === location.path)
    const path = entry?.type === 'file' || entry?.type === 'directory' ? entry.resolvedPath ?? entry.path : location.path
    navigate({ ...location, path, kind: !path || entry?.type === 'directory' ? 'directory' : 'file' }, true)
  }, [entries, location, navigate])
  useEffect(() => {
    setCopied(false)
    if (location.kind !== 'file' && expanded) exitFullscreen()
    document.title = location.kind === 'settings' ? 'Settings · Artiface' : location.kind === 'overview' ? 'Artiface' : `${location.kind === 'file' ? fileTabName(location) : project?.label || 'Projects'} · Artiface`
  }, [location, project?.label, expanded, exitFullscreen])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => { setToast(''); setCopied(false) }, 5000)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    if (!sidebarShown || !overlay || location.kind === 'settings') return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    returnSidebarFocus.current = true
    if (document.hasFocus() && document.activeElement === document.body) {
      sidebar.current?.querySelector<HTMLElement>('a,button')?.focus({ preventScroll: true })
    }
    const keyboard = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        if (phone) setMobileSidebar(false)
        else setPreferences({ sidebarVisible: false })
      }
      if (event.key !== 'Tab') return
      const controls = sidebar.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')
      if (!controls?.length) return
      const first = controls[0], last = controls[controls.length - 1]
      if (!sidebar.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keyboard)
    return () => {
      window.removeEventListener('keydown', keyboard)
      if (sidebar.current && !sidebar.current.inert && sidebar.current.getAttribute('aria-hidden') !== 'true') return
      if (!returnSidebarFocus.current || (document.activeElement !== document.body && !sidebar.current?.contains(document.activeElement))) return
      const target = previous && previous !== document.body && previous.isConnected && !previous.closest('[inert]') && previous.getClientRects().length
        ? previous : sidebarToggle.current
      target?.focus({ preventScroll: true })
    }
  }, [sidebarShown, overlay, phone, location.kind, setPreferences])
  function hideSidebar() { if (phone) setMobileSidebar(false); else setPreferences({ sidebarVisible: false }) }
  function setFilter(value: string) { setFolderFilters(current => ({ ...current, [listingURL]: value })) }
  function showSidebar() { if (expanded) exitFullscreen(); if (phone) setMobileSidebar(true); else setPreferences({ sidebarVisible: true }) }
  function go(next: Location) { chooserReturnFocus.current = null; returnSidebarFocus.current = false; overviewSpace.current = null; readerFocus.cancel(); rememberBrowseScroll(true); navigate(next); if (overlay) hideSidebar() }
  function navigateFromReader(next: Location, keyboard = false) {
    const origin = keyboard && document.activeElement instanceof HTMLElement ? document.activeElement : null
    go(next)
    if (keyboard && next.kind === 'file' && (location.kind !== 'file' || tabKey(next) !== tabKey(location))) readerFocus.begin(next, origin)
  }
  function goHome() { go(home) }
  function showSettings(section: 'appearance' | 'ignore' | 'sources') {
    settingsSection.current = section
    settingsReturn.current = location
    settingsHasHistory.current = true
    go({ ...home, kind: 'settings' })
  }
  function openSettings() { showSettings('appearance') }
  function returnFromSettings() {
    const previous = settingsReturn.current
    if (isProjectLocation(previous) && !visibleHosts?.some(host => host.id === previous.host && host.roots.some(root => root.id === previous.root))) {
      settingsHasHistory.current = false
      navigate(home, true)
      return
    }
    if (settingsHasHistory.current) { settingsHasHistory.current = false; window.history.back() }
    else navigate(settingsReturn.current, true)
  }
  function addProject() {
    if (location.kind === 'add-project') { if (overlay) hideSidebar(); return }
    addReturn.current = location
    go({ ...home, kind: 'add-project' })
  }
  function returnFromChooser(event: ReactMouseEvent<HTMLButtonElement>) {
    const next = addReturn.current
    const origin = event.detail === 0 && document.activeElement === event.currentTarget ? event.currentTarget : null
    go(next)
    if (!origin) return
    if (next.kind === 'file') readerFocus.begin(next, origin)
    else chooserReturnFocus.current = { location: next, origin }
  }
  function browse(item: { host: string; root: string }, path?: string) {
    go({ host: item.host, root: item.root, path: path ?? browseDirectory(item), kind: 'directory' })
  }
  function activateProject(item: OpenProject) {
    browse(item)
  }
  function selectTab(tab: FileLocation) { go({ ...tab, kind: 'file' }) }
  function openOverviewFile(tab: FileLocation, origin: HTMLButtonElement) {
    selectTab(tab)
    readerFocus.begin(tab, origin)
  }
  function overviewFileKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, tab: FileLocation) {
    if (event.nativeEvent.isComposing) { overviewSpace.current = null; return }
    if (event.key === ' ') {
      event.preventDefault()
      if (!event.repeat) overviewSpace.current = event.currentTarget
      return
    }
    overviewSpace.current = null
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) openOverviewFile(tab, event.currentTarget)
  }
  function overviewFileKeyUp(event: ReactKeyboardEvent<HTMLButtonElement>, tab: FileLocation) {
    if (event.key !== ' ') return
    event.preventDefault()
    const pressed = overviewSpace.current === event.currentTarget
    overviewSpace.current = null
    if (pressed && !event.repeat && !event.nativeEvent.isComposing) openOverviewFile(tab, event.currentTarget)
  }
  function closeOverviewFile(event: ReactMouseEvent<HTMLButtonElement>, tab: FileLocation) {
    if (event.detail === 0 && document.activeElement === event.currentTarget) {
      const row = event.currentTarget.closest('.overview-file')
      const projectIndex = openProjects.findIndex(item => projectKey(item.state) === projectKey(tab))
      const target = row?.nextElementSibling?.querySelector<HTMLButtonElement>('.overview-file-open')
        ?? row?.previousElementSibling?.querySelector<HTMLButtonElement>('.overview-file-open')
        ?? overview.current?.querySelectorAll<HTMLButtonElement>('.overview-project-open')[projectIndex]
        ?? overview.current?.querySelector<HTMLButtonElement>('.overview-intro > button')
      // The survivor already exists; focus it before removal so no late handoff can override new input.
      target?.focus()
    }
    closeTab(tab)
  }
  function closeSidebarFile(event: ReactMouseEvent<HTMLButtonElement>, tab: FileLocation) {
    const keyboard = event.detail === 0 && document.activeElement === event.currentTarget
    if (keyboard) {
      const row = event.currentTarget.closest('.project-file-row')
      const target = row?.nextElementSibling?.querySelector<HTMLButtonElement>('.project-file')
        ?? row?.previousElementSibling?.querySelector<HTMLButtonElement>('.project-file')
        ?? row?.closest('.project-group')?.querySelector<HTMLButtonElement>('.project-open')
      target?.focus()
    }
    closeTab(tab)
    if (keyboard) returnSidebarFocus.current = true
  }
  function closeSidebarProject(event: ReactMouseEvent<HTMLButtonElement>, project: OpenProject) {
    const keyboard = event.detail === 0 && document.activeElement === event.currentTarget
    if (keyboard) {
      const group = event.currentTarget.closest('.project-group')
      const target = group?.nextElementSibling?.querySelector<HTMLButtonElement>('.project-open')
        ?? group?.previousElementSibling?.querySelector<HTMLButtonElement>('.project-open')
        ?? sidebar.current?.querySelector<HTMLButtonElement>('.project-list-label button')
      target?.focus()
    }
    removeProject(project)
    if (keyboard) returnSidebarFocus.current = true
  }
  function moveSidebarFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
      ['ArrowUp', 'ArrowDown'].includes(event.key) && event.target instanceof HTMLButtonElement && event.target.matches('.project-open')) {
      event.preventDefault()
      const origin = event.target
      const key = origin.closest<HTMLElement>('[data-project-key]')?.dataset.projectKey
      const index = openProjects.findIndex(item => projectKey(item.state) === key)
      const target = openProjects[index + (event.key === 'ArrowUp' ? -1 : 1)]
      if (index >= 0 && target) {
        reorderProjects(openProjects[index].state, target.state, event.key === 'ArrowUp' ? 'before' : 'after')
        requestAnimationFrame(() => {
          if (origin.isConnected && document.hasFocus() && (document.activeElement === document.body || document.activeElement === origin)) origin.focus({ preventScroll: true })
        })
      }
      return
    }
    if (event.defaultPrevented || event.nativeEvent.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const origin = event.target
    if (!(origin instanceof HTMLButtonElement) || !origin.matches('.project-open, .project-file')) return
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.project-open, .project-file'))
      .filter(row => row.getClientRects().length)
    const index = rows.indexOf(origin)
    if (index < 0) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    rows[next].focus()
  }
  function closeTab(tab: FileLocation) {
    const siblings = tabs.filter(item => projectKey(item) === projectKey(tab))
    const index = siblings.findIndex(item => tabKey(item) === tabKey(tab))
    const remaining = siblings.filter(item => tabKey(item) !== tabKey(tab))
    close(tab)
    if (location.kind !== 'file' || tabKey(location) !== tabKey(tab)) return
    const next = remaining[Math.min(index, remaining.length - 1)]
    if (next) selectTab(next)
    else browse(tab)
  }
  function removeProject(item: OpenProject) {
    closeProject(item)
    if (!isProjectLocation(location) || projectKey(item) !== projectKey(location)) return
    const next = openProjects.find(other => projectKey(other.state) !== projectKey(item))
    if (next) activateProject(next.state)
    else goHome()
  }
  function openEntry(entry: Entry, background = false, keyboardOrigin?: HTMLAnchorElement) {
    if (entry.type !== 'file' && entry.type !== 'directory') return
    const next: Location = { host: location.host, root: location.root, path: entry.resolvedPath ?? entry.path, kind: entry.type }
    remember(next, background)
    if (background) setToast(`Opened ${entry.name} in a background tab.`)
    else {
      go(next)
      if (keyboardOrigin && entry.type === 'file') readerFocus.begin(next, keyboardOrigin)
    }
  }
  function projectSaved(savedHost: Host, root: Project, current: boolean) {
    setHosts(current => current?.some(host => host.id === savedHost.id) ? current.map(host => host.id === savedHost.id ? savedHost : host) : [...(current ?? []), savedHost])
    if (current) browse({ host: savedHost.id, root: root.id }, '')
    setHostsAttempt(value => value + 1)
  }
  function projectRemoved(removedHost: Host, removedProject: Project) {
    const removed = { host: removedHost.id, root: removedProject.id }
    closeProject(removed)
    setHosts(current => current?.map(host => host.id === removedHost.id ? { ...host, roots: host.roots.filter(root => root.id !== removedProject.id) } : host) ?? null)
    if (projectKey(addReturn.current) === projectKey(removed)) addReturn.current = home
    setHostsAttempt(value => value + 1)
  }
  async function copyLink() {
    try {
      await copyText(`${window.location.origin}${window.location.pathname}${locationHash(location)}`)
      setCopied(true); setToast('Link copied. Sign-in is required to open it.')
    } catch { setToast('Copy the link from your address bar.') }
  }
  async function copyFilePath(file: Location, root: Project) {
    // Team catalogs omit the absolute root; keep those paths project-relative.
    const path = root.path ? `${root.path.replace(/\/+$/, '')}/${file.path.replace(/^\/+/, '')}` : file.path
    try {
      await copyText(path)
      setCopied(false)
      setToast(root.path ? 'File path copied.' : 'Project-relative path copied.')
    } catch { setManualCopyPath(path) }
  }
  async function logout() {
    if (loggingOut) return
    setLoggingOut(true)
    try { await api('/api/logout', { body: {} }); clear(); onLogout() }
    catch (failure) { setToast(errorMessage(failure)); setLoggingOut(false) }
  }
  function changeSort(column: SortColumn) { setPreferences({ browseSort: { column, direction: sort.column === column && sort.direction === 'asc' ? 'desc' : 'asc' } }) }
  const query = filter.toLocaleLowerCase()
  const typesKey = readerTypes.join(',')
  const sorted = useMemo(() => sortEntries(entries ?? [], { column: sort.column, direction: sort.direction }, flatBrowse),
    [entries, sort.column, sort.direction, flatBrowse])
  const filtered = useMemo(() => {
    const types = new Set(typesKey.split(','))
    return sorted.filter(entry =>
      (preferences.showHidden || !(flatBrowse ? entry.path.slice(directory ? directory.length + 1 : 0).split('/').some(part => part.startsWith('.')) : entry.name.startsWith('.'))) &&
      (flatBrowse ? entry.path : entry.name).toLocaleLowerCase().includes(query) &&
      (entry.type === 'directory' || types.has(readerType(entry.resolvedPath ?? entry.path))))
  }, [sorted, query, preferences.showHidden, typesKey, flatBrowse, directory])
  // Any match before the hidden-file check is hidden when no visible matches remain.
  const hiddenMatches = !preferences.showHidden && filtered.length === 0 && sorted.some(entry =>
    (flatBrowse ? entry.path : entry.name).toLocaleLowerCase().includes(query) &&
    (entry.type === 'directory' || readerTypes.includes(readerType(entry.resolvedPath ?? entry.path))))
  const browseSignature = JSON.stringify([listingKey, query, typesKey, sort.column, sort.direction, preferences.showHidden, preferences.flatBrowse])
  const savedPage = browsePages[folderKey]
  const pageCount = Math.max(1, Math.ceil(filtered.length / browsePageSize))
  const page = Math.min(savedPage?.signature === browseSignature ? savedPage.page : 0, pageCount - 1)
  const pageDescription = `Page ${page + 1} of ${pageCount}; ${(page * browsePageSize + 1).toLocaleString()}–${Math.min((page + 1) * browsePageSize, filtered.length).toLocaleString()} of ${filtered.length.toLocaleString()} entries`
  const browseReady = location.kind === 'directory' && entries !== null && projectsReady && Boolean(project && host)
  const browserVisible = location.kind === 'directory' && projectsReady && Boolean(project && host)

  useLayoutEffect(() => {
    const area = breadcrumbs.current
    if (!browserVisible || !area) return
    const reveal = (target: HTMLElement | null) => {
      if (!target) return
      const bounds = target.getBoundingClientRect()
      const viewport = area.getBoundingClientRect()
      if (bounds.right > viewport.right) area.scrollLeft += bounds.right - viewport.right
      else if (bounds.left < viewport.left) area.scrollLeft += bounds.left - viewport.left
    }
    const current = () => area.querySelector<HTMLElement>('[aria-current="page"]')
    reveal(current())
    let width = area.clientWidth
    const observer = new ResizeObserver(() => {
      if (width === area.clientWidth) return
      width = area.clientWidth
      reveal(area.contains(document.activeElement) ? document.activeElement as HTMLElement : current())
    })
    const focused = (event: FocusEvent) => { if (event.target instanceof HTMLElement) reveal(event.target) }
    observer.observe(area)
    area.addEventListener('focusin', focused)
    return () => { observer.disconnect(); area.removeEventListener('focusin', focused) }
  }, [browserVisible, folderKey])

  function rememberBrowseScroll(anchor = false) {
    const content = browseContent.current
    if (!browseReady || !content || !browseFiles.current) return
    const position: BrowseScroll = { signature: browseSignature, page, top: content.scrollTop, view: preferences.browseView }
    if (anchor && content.scrollTop > 0) {
      const top = content.getBoundingClientRect().top
      const entry = [...browseFiles.current.querySelectorAll<HTMLElement>('[data-browse-entry]')]
        .find(element => element.getBoundingClientRect().bottom > top)
      if (entry) position.anchor = { path: entry.dataset.browseEntry!, offset: entry.getBoundingClientRect().top - top }
    }
    browseScroll.current.set(folderKey, position)
  }
  function changeBrowseView(view: 'list' | 'icons') {
    rememberBrowseScroll(true)
    setPreferences({ browseView: view })
  }
  function changePage(next: number) {
    browseScroll.current.delete(folderKey)
    setBrowsePages(current => ({ ...current, [folderKey]: { signature: browseSignature, page: next } }))
  }
  useLayoutEffect(() => {
    const content = browseContent.current
    if (!browseReady || !content || !browseFiles.current) return
    if (savedPage?.signature !== browseSignature || savedPage.page !== page) {
      setBrowsePages(current => ({ ...current, [folderKey]: { signature: browseSignature, page } }))
    }
    const saved = browseScroll.current.get(folderKey)
    let top = 0
    if (saved?.signature === browseSignature && saved.page === page) {
      top = saved.top
      if (saved.view !== preferences.browseView && saved.anchor) {
        const entry = [...browseFiles.current.querySelectorAll<HTMLElement>('[data-browse-entry]')]
          .find(element => element.dataset.browseEntry === saved.anchor!.path)
        if (entry) top = content.scrollTop + entry.getBoundingClientRect().top - content.getBoundingClientRect().top - saved.anchor.offset
      }
    }
    content.scrollTop = top
    browseScroll.current.set(folderKey, { signature: browseSignature, page, top: content.scrollTop, view: preferences.browseView })
    // A background refresh leaves the current page and scroll untouched unless it removes that page.
  }, [browseReady, folderKey, browseSignature, page, preferences.browseView])
  const gridSort = !phone && preferences.browseView === 'icons'
    ? <FileSortSelect label="Sort files" sort={preferences.browseSort} defaultSort={preferences.defaultBrowseSort} onChange={browseSort => setPreferences({ browseSort })} /> : undefined

  const retryListingControl = <button ref={retryButton} className="button secondary" aria-disabled={listingPending} aria-busy={listingPending} onClick={refreshListing}><RefreshCw size={15} className={listingPending ? 'spin' : undefined} />{listingPending ? 'Retrying…' : 'Try again'}</button>
  return <>
    {location.kind === 'settings' && <div className="standalone-settings"><SettingsPage canManage={canManage} initialSection={settingsSection.current} catalogRevision={catalogRevision} onClose={returnFromSettings} onChanged={() => { setHostsAttempt(value => value + 1); setRefresh(value => value + 1) }} /></div>}
    <div hidden={location.kind === 'settings'} inert={location.kind === 'settings'} ref={fullscreenElement} className={`workspace-shell ${sidebarShown && !overlay ? 'has-dock' : ''} ${expanded ? 'reader-expanded' : ''}`}>
    {expanded && <button className="button fullscreen-exit" title="Exit full screen (Escape)" onClick={exitFullscreen}><Minimize2 size={17} />Exit full screen</button>}
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
    <button className={`project-sidebar-backdrop${sidebarShown && overlay ? ' is-open' : ''}`} tabIndex={-1} aria-label="Close project sidebar" aria-hidden={!sidebarShown || !overlay} inert={!sidebarShown || !overlay} onClick={hideSidebar} />
    <aside ref={sidebar} onKeyDownCapture={event => { if (event.key === 'Enter' && event.repeat) event.preventDefault() }} id="project-sidebar" className={`projects-sidebar ${overlay ? 'is-overlay' : ''} ${sidebarShown ? 'is-open' : 'is-closed'}`} aria-label="Projects" role={sidebarShown && overlay ? 'dialog' : undefined} aria-modal={sidebarShown && overlay || undefined} aria-hidden={!sidebarShown} inert={!sidebarShown}>
      <div className="project-sidebar-header"><Brand onHome={goHome} /><div className="project-sidebar-controls">
        {!phone && <button className="icon-button" aria-label={preferences.sidebarMode === 'dock' ? 'Use overlay sidebar' : 'Dock sidebar'} title={preferences.sidebarMode === 'dock' ? 'Float sidebar over content' : 'Dock sidebar beside content'} onClick={() => setPreferences({ sidebarMode: preferences.sidebarMode === 'dock' ? 'overlay' : 'dock' })}>{preferences.sidebarMode === 'dock' ? <PanelLeftDashed size={17} /> : <PanelLeft size={17} />}</button>}
        {sidebarShown && <button ref={sidebarToggle} className="icon-button" aria-label="Hide project sidebar" title="Hide project sidebar" onClick={hideSidebar}><PanelLeftClose size={18} /></button>}
      </div></div>
      <button className={`overview-nav ${location.kind === 'overview' ? 'active' : ''}`} aria-current={location.kind === 'overview' ? 'page' : undefined} onClick={goHome}><Layers size={18} />Overview<span>{tabs.length}</span></button>
      <div className="project-list-label"><span>Projects</span><button className="icon-button" aria-label="Add project" title="Open or add a project" onClick={addProject}><Plus size={17} /></button></div>
      <nav ref={projectList} className="project-list" aria-label="Open projects" aria-describedby="project-list-keyboard-help" onKeyDown={moveSidebarFocus} {...projectDrag.listEvents}>
        <span id="project-list-keyboard-help" className="sr-only">Use Up/Down or Home/End to move between project and file names, Enter to open, and Tab to reach row controls. Drag project names or use Alt+Up/Down to reorder projects.</span>
        {!openProjects.length && <p className="project-list-empty">{projectsReady ? 'Open a project to start browsing.' : 'Loading shared projects…'}</p>}
        {openProjects.map(({ state, host, project, tabs: projectFiles }) => <div className={`project-group ${isProjectLocation(location) && projectKey(state) === projectKey(location) ? 'current-project' : ''}${projectDrag.feedback?.source === projectKey(state) ? ' is-project-dragging' : ''}${projectDrag.feedback?.target?.key === projectKey(state) ? ` is-project-drop-${projectDrag.feedback.target.edge}` : ''}`} key={projectKey(state)} data-project-key={projectKey(state)} role="group" aria-labelledby={`sidebar-project-label-${encodeURIComponent(projectKey(state))}`}>
          <div className="project-line">
            <button className="icon-button project-disclosure" aria-label={projectFiles.length ? `${state.expanded ? 'Collapse' : 'Expand'} project ${project.label}` : `${project.label} has no open files`}
              title={projectFiles.length ? `${state.expanded ? 'Hide' : 'Show'} open files in ${project.label}` : `No open files in ${project.label}`}
              aria-expanded={projectFiles.length ? state.expanded : undefined} disabled={!projectFiles.length} onClick={() => toggleProject(state)}>
              <ProjectFolderIcon expanded={state.expanded && projectFiles.length > 0} />
            </button>
            <button className="project-open" aria-label={`Open project ${project.label} on ${host.label}`}
              draggable={projectDrag.enabled} onPointerDown={projectDrag.pointerDown} onMouseDown={projectDrag.mouseDown} onDragStart={event => projectDrag.start(event, state)}
              aria-current={location.kind === 'directory' && projectKey(state) === projectKey(location) ? 'page' : undefined}
              onClick={() => activateProject(state)} title={`${project.label}\n${host.label}\n${project.path}${projectDrag.enabled ? '\nDrag to reorder projects' : ''}`}>
              <span id={`sidebar-project-label-${encodeURIComponent(projectKey(state))}`}><strong>{project.label}</strong><small>{host.label}</small></span>
            </button>
            <button className="icon-button project-close" aria-label={`Close project ${project.label}`} title="Close project and its tabs" onClick={event => closeSidebarProject(event, state)}><X size={14} /></button>
          </div>
          {state.expanded && projectFiles.length > 0 && <div className="project-children">
            {projectFiles.map(tab => <div className="project-file-row" key={tabKey(tab)}><button className={`project-file ${location.kind === 'file' && tabKey(tab) === tabKey(location) ? 'selected' : ''}`} title={fileTabName(tab, true)} aria-label={`Open ${fileTabName(tab, true)}`} aria-current={location.kind === 'file' && tabKey(tab) === tabKey(location) ? 'page' : undefined} onClick={() => selectTab(tab)}><FileTabIcon file={tab} /><span>{fileTabName(tab)}</span>{tab.autoRefreshPaused && !tab.view && <Pause size={11} aria-label="Automatic refresh paused" />}</button><button className="icon-button project-file-close" aria-label={`Close ${fileTabName(tab)}`} title={`Close ${fileTabName(tab)}`} onClick={event => closeSidebarFile(event, tab)}><X size={14} /></button></div>)}
          </div>}
        </div>)}
      </nav>
      <div className="project-sidebar-footer"><button className="button quiet" aria-label="Settings" title="Settings" onClick={openSettings}><Settings size={17} />Settings</button><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={loggingOut} onClick={() => void logout()}><LogOut size={17} /></button></div>
      {sidebarShown && !overlay && <SidebarResize width={preferences.sidebarWidth} fontScale={preferences.fontScale} />}
    </aside>
    <main className="workspace-main" id="main-content" tabIndex={-1} inert={sidebarShown && overlay}>
      <div className="project-topline">
        {syncError && <><span className="sr-only" role="status">Projects are not synced: {syncError}</span><button className="icon-button workspace-sync-error" aria-label="Retry project sync" title={`Projects are not synced: ${syncError}. Retry`} onClick={retrySync}><RefreshCw size={17} /></button></>}
        {!sidebarShown && <div className="collapsed-navigation"><button ref={sidebarToggle} className="icon-button" aria-label="Show project sidebar" title="Show project sidebar" onKeyDown={event => { if (event.key === 'Enter' && event.repeat) event.preventDefault() }} onClick={showSidebar}><PanelLeftOpen size={18} /></button><Brand onHome={goHome} /></div>}
        {location.kind === 'overview' ? <h1 className="page-title">Overview</h1>
          : location.kind === 'add-project' ? <><button autoFocus className="icon-button" aria-label="Back to workspace" title="Back" onClick={returnFromChooser}><ArrowLeft size={18} /></button><h1 className="page-title">Open a project</h1></>
            : project ? <>{(!sidebarShown || overlay) && <span className="project-context" title={`${project.label} · ${host?.label}`}>{project.label}</span>}<Tabs tabs={projectTabs} active={location.kind === 'file' ? tabKey(location) : null} onBrowse={() => browse(location)} onSelect={selectTab} onClose={closeTab} onReorder={reorder} /></> : <h1 className="page-title">Project</h1>}
        {location.kind === 'file' && project && <button className="icon-button reader-toolbar-toggle" aria-label={preferences.readerToolbarVisible ? 'Hide reader toolbar' : 'Show reader toolbar'} title={preferences.readerToolbarVisible ? 'Hide reader toolbar' : 'Show reader toolbar'} aria-expanded={preferences.readerToolbarVisible} aria-controls="reader-toolbar" onClick={() => setPreferences({ readerToolbarVisible: !preferences.readerToolbarVisible })}>{preferences.readerToolbarVisible ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>}
        {!sidebarShown && <div className="collapsed-actions">{location.kind !== 'add-project' && <button className="icon-button add-project-shortcut" aria-label="Add project" title="Open or add a project" onClick={addProject}><Plus size={17} /></button>}<button className="icon-button" aria-label="Settings" title="Settings" onClick={openSettings}><Settings size={17} /></button></div>}
      </div>
      {hostsError && hosts !== null && <div className="notice warning-notice" role="status">Couldn’t refresh projects: {hostsError} <button className="text-button" onClick={() => setHostsAttempt(value => value + 1)}>Retry loading projects</button></div>}
      <div ref={browseContent} onScroll={() => rememberBrowseScroll()} className={`project-content ${location.kind === 'file' ? 'reading-content' : ''} ${preferences.readerToolbarVisible ? '' : 'reader-toolbars-hidden'}`}>
        {hostsError && hosts === null ? <ErrorState title="Couldn’t load projects" message={hostsError} retry={() => setHostsAttempt(value => value + 1)} />
          : !projectsReady && syncError ? <ErrorState title="Couldn’t load shared projects" message={syncError} retry={retrySync} />
            : hosts === null || !projectsReady ? <Loading message="Opening your workspace…" />
            : location.kind === 'add-project' ? <ProjectChooser hosts={visibleHosts ?? []} setupEnabled={setupEnabled} onOpen={(host, project) => browse({ host: host.id, root: project.id })} onSaved={projectSaved} onRemoved={projectRemoved} onSettings={openSettings} />
              : location.kind === 'overview' ? <div className="project-overview" ref={overview}
                onPointerDownCapture={() => { overviewSpace.current = null }}
                onKeyDownCapture={event => { if (event.key === 'Enter' && event.repeat) event.preventDefault() }}>
                <div className="overview-intro"><p>{openProjects.length} {openProjects.length === 1 ? 'project' : 'projects'} · {tabs.length} open {tabs.length === 1 ? 'file' : 'files'}</p><button className="button secondary" onClick={addProject}><Plus size={16} />Open a project</button></div>
                <OverviewColumns hasFiles={tabs.length > 0}>
                  <section key="projects" className="overview-projects" aria-label="Projects">
                    <h2>Projects</h2>
                    {!openProjects.length && <p className="overview-empty">Open a project to browse its files.</p>}
                    {openProjects.map(({ state, project, host }) => <div className="overview-project" key={projectKey(state)}>
                      <button className="overview-project-open" onClick={() => browse(state)} title={`${project.label}\n${host.label}${project.path ? `\n${project.path}` : ''}`}>
                        <FolderOpen size={20} /><span className="overview-row-text"><strong>{project.label}</strong><span>{host.label}</span>{project.path && <small className="overview-project-path">{project.path}</small>}</span>
                      </button>
                    </div>)}
                  </section>
                  <section key="files" className="overview-files" aria-label="Open files">
                    <h2>Open files</h2>
                    {!tabs.length && <p className="overview-empty">Select files in a project to read them here.</p>}
                    {openProjects.flatMap(({ state, project, host, tabs }) => {
                      const machine = overviewMachines.get(projectKey(state))
                      const identity = machine ? `${project.label} · ${machine}` : project.label
                      return tabs.map(tab => <article className="overview-file" key={tabKey(tab)} aria-label={`${identity}: ${fileTabName(tab, true)}`}>
                        <button className="overview-file-open" aria-label={machine ? `Open ${fileTabName(tab, true)} in ${identity}` : `Open ${fileTabName(tab)}`} title={`${project.label} · ${host.label}\n${fileTabName(tab, true)}`} onClick={() => selectTab(tab)}
                          onKeyDown={event => overviewFileKeyDown(event, tab)} onKeyUp={event => overviewFileKeyUp(event, tab)}
                          onBlur={() => { overviewSpace.current = null }}>
                          <FileTabIcon file={tab} />
                          <span className="overview-row-text"><strong>{fileTabName(tab)}</strong><span className={`overview-file-context${machine ? ' has-machine' : ''}`}><span className="overview-file-location"><bdi dir="ltr">{project.label}{parentPath(tab.path) && <> · {parentPath(tab.path)}</>}</bdi></span>{machine && <bdi className="overview-file-machine" dir="ltr"> · {machine}</bdi>}</span></span>
                          <span className="overview-file-meta">{tab.view !== 'history' && !tab.commit && <OverviewModified metadata={overviewMetadata[tabKey({ ...tab, view: undefined })]} />}{tab.autoRefreshPaused && !tab.view && <Pause size={12} aria-label="Auto refresh paused"><title>Auto refresh paused</title></Pause>}</span>
                        </button>
                        <button className="icon-button overview-file-close" aria-label={machine ? `Close ${fileTabName(tab, true)} in ${identity}` : `Close ${fileTabName(tab)}`} title={`Close ${fileTabName(tab)}`} onClick={event => closeOverviewFile(event, tab)}><X size={14} /></button>
                      </article>)
                    })}
                  </section>
                </OverviewColumns>
              </div>
                : !project || !host ? <ErrorState title="Project unavailable" message={canManage ? 'Open a saved project, add a folder, or check project visibility in Settings.' : 'Open a project shared with you, or ask your admin for project access.'}>
                  <button className="button secondary" onClick={addProject}>Open a project</button>
                  {canManage && <button className="button secondary" onClick={openSettings}>Settings</button>}
                </ErrorState>
                  : location.kind === 'auto' ? listingError ? <ErrorState title="Couldn’t open this location" message={listingError}>{retryListingControl}</ErrorState> : <Loading message="Opening this location…" />
                    : location.kind === 'settings' ? null
                    : location.kind === 'file' ? !location.view && /\.pdf$/i.test(location.path) ? <div id="reader-panel" role="tabpanel" aria-labelledby={`file-tab-${encodeURIComponent(tabKey(location))}`} className="reader-panel"><FilePreview key={JSON.stringify([tabKey(location), host.kind, host.target, project.path, catalogRevision])} location={location} focusRequest={readerFocus.request} onNavigate={go} copied={copied} onCopyLink={copyLink} onCopyPath={() => copyFilePath(location, project)} onExpand={enterFullscreen} autoRefreshPaused={activeTab?.autoRefreshPaused ?? false} onToggleAutoRefresh={() => setPaused(location, !activeTab?.autoRefreshPaused)} projectTrustedScripts={project.trustedScripts ?? false} onProjectScriptsAllowed={() => setHostsAttempt(value => value + 1)} /></div> : null
                      : <div className="project-browser" id="browse-panel" role="tabpanel" aria-labelledby="browse-tab">
                        <h1 className="sr-only">{project.label}</h1>
                        <div className="browse-toolbar"><div className="browse-location-row"><nav ref={breadcrumbs} className="breadcrumbs" aria-label="Breadcrumb"><button onClick={() => browse(location, '')} title={project.path} aria-current={!directory ? 'page' : undefined}><FolderOpen size={15} /><span>{project.label}</span></button>{directory.split('/').filter(Boolean).map((part, index, parts) => <span className="breadcrumb-part" key={parts.slice(0, index + 1).join('/')}><ChevronRight size={12} /><button aria-current={index === parts.length - 1 ? 'page' : undefined} onClick={() => browse(location, parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}</nav>
                          {phone && (filtered.length > browsePageSize ? <>
                            <select ref={attachPageJump} className="browse-page-jump" aria-label="File page" aria-describedby="browse-page-description" title={pageDescription} value={page} onChange={event => changePage(Number(event.target.value))}>
                              {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{index + 1}/{pageCount}</option>)}
                            </select>
                            <span className="sr-only" id="browse-page-description" role="status">{pageDescription}</span>
                          </> : <span className="browse-entry-count" role="status">{entries === null ? '…' : `${filtered.length.toLocaleString()} ${filtered.length === 1 ? 'entry' : 'entries'}`}</span>)}
                          {directory && <button className="icon-button" aria-label="Up one directory" title="Parent folder" onClick={() => browse(location, parentPath(directory))}><ArrowUp size={16} /></button>}
                          {gitEnabled && <GitChanges key={gitIdentity} git={git} onDiff={openGitDiff} onHistory={openGitHistory} onSettings={() => showSettings('sources')} />}
                          <button className="icon-button" aria-label="Refresh files" title={listingPending ? 'Refreshing files…' : `Refresh files · also checked every ${preferences.autoRefreshSeconds}s`} aria-disabled={listingPending} aria-busy={listingPending} onClick={refreshListing}><RefreshCw size={16} className={listingPending && entries !== null ? 'spin' : undefined} /></button>
                          </div><div className="browse-controls-row">
                          <div className="filter-input browse-search" onFocus={event => {
                            if (!phone) return
                            // Keyboard focus can leave a popup open after its trigger becomes hidden.
                            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                              ':scope > :is(.file-filter-control, .browse-settings-control, .browse-sort-control) > button[aria-expanded="true"]',
                            ).forEach(trigger => trigger.click())
                          }} onKeyDown={event => {
                            if (phone && !event.nativeEvent.isComposing && (event.key === 'Escape' || (event.key === 'Enter' && event.target === browseSearch.current))) {
                              event.preventDefault()
                              event.stopPropagation()
                              finishFiltering()
                            }
                          }}>
                            <button className="icon-button browse-search-done" aria-label="Done filtering" title="Done filtering" onClick={finishFiltering} onBlur={event => {
                              // A wider viewport hides Done while a keyboard user may still be on it.
                              if (!event.relatedTarget && !event.currentTarget.getClientRects().length) requestAnimationFrame(() => {
                                if (document.activeElement === document.body) browseSearch.current?.focus({ preventScroll: true })
                              })
                            }}><ArrowLeft size={17} /></button>
                            <Search size={15} /><input ref={browseSearch} aria-label="Search directory" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint={phone ? 'done' : undefined} placeholder="Filter files…" value={filter} onChange={event => setFilter(event.target.value)} />
                            {filter && <button className="icon-button" aria-label="Clear directory search" title="Clear directory search" onClick={() => {
                              setFilter('')
                              browseSearch.current?.focus({ preventScroll: true })
                            }}><X size={14} /></button>}
                          </div>
                          <FileFilters folder={folderKey} /><BrowseSettings onSettings={canManage ? () => showSettings('ignore') : undefined} />
                          {phone ? <><FileSortButton sort={preferences.browseSort} defaultSort={preferences.defaultBrowseSort} onChange={browseSort => setPreferences({ browseSort })} />
                            <button className="icon-button browse-view-toggle" aria-label={preferences.browseView === 'list' ? 'Icon view' : 'List view'} title={preferences.browseView === 'list' ? 'Switch to icon view' : 'Switch to list view'} onClick={() => changeBrowseView(preferences.browseView === 'list' ? 'icons' : 'list')}>{preferences.browseView === 'list' ? <LayoutGrid size={16} /> : <List size={16} />}</button></>
                            : <><div className="view-toggle" aria-label="Directory view"><button aria-label="List view" title="List view" className={preferences.browseView === 'list' ? 'active' : ''} aria-pressed={preferences.browseView === 'list'} onClick={() => changeBrowseView('list')}><List size={16} /></button><button aria-label="Icon view" title="Icon view" className={preferences.browseView === 'icons' ? 'active' : ''} aria-pressed={preferences.browseView === 'icons'} onClick={() => changeBrowseView('icons')}><LayoutGrid size={16} /></button></div><ShareButton copied={copied} onClick={copyLink} compact /></>}
                          </div>
                        </div>
                        {gridSort && filtered.length <= browsePageSize && <div className="browse-grid-sort"><span>{filtered.length} entries</span>{gridSort}</div>}
                        {listingWarning && <p className="browse-warning" role="status">{listingWarning}</p>}
                        {listingError && entries && <p className="browse-stale" role="status">Couldn’t refresh: {listingError}. Retrying automatically.</p>}
                        <BrowseResults contentRef={browseFiles} entries={entries} settled={!listingPending && !listingError} signature={browseSignature} page={page} view={preferences.browseView}>{entries === null ? listingError ? <ErrorState title="Couldn’t browse this folder" message={listingError}>{retryListingControl}</ErrorState> : <Loading message="Reading folder…" /> : !filtered.length ? <div className="directory-empty"><FolderOpen size={30} /><h2>{hiddenMatches ? 'Hidden files are off' : filter || (entries?.length ?? 0) > 0 ? 'No matching files' : 'No visible files'}</h2><p>{hiddenMatches ? 'Show dotfiles and hidden folders in Browse settings.' : filter || (entries?.length ?? 0) > 0 ? 'Adjust the filename or file type filters.' : 'New files will appear automatically. Check Browse settings and Settings → Ignored files to show more.'}</p>
                          {readerTypes.length < allReaderTypes.length && <button type="button" className="text-button" onClick={() => {
                            setFolderReaderTypes(folderKey, allReaderTypes)
                            requestAnimationFrame(finishFiltering)
                          }}>Show all file types</button>}
                        </div> : <FileList entries={filtered} location={location} onOpen={openEntry} view={preferences.browseView} sort={sort} onSort={changeSort} page={page} onPageChange={changePage} pageJump={mobilePageJump} sortControl={gridSort} flat={flatBrowse} compactHeader={phone} query={query} gitMark={gitEnabled ? git.mark : undefined} onGitDiff={openGitDiff} />}</BrowseResults>
                      </div>}
        <ReaderDeck location={location} tabs={tabs} hosts={projectsReady ? visibleHosts ?? [] : []} revision={catalogRevision} render={(file, _host, root, active) => {
          if (file.view === 'history') return <GitHistoryViewer location={file} active={active} focusRequest={active ? readerFocus.request : null}
            copied={active && copied} onCopyLink={copyLink} onExpand={enterFullscreen} onDiff={openGitDiff} />
          if (file.view === 'diff') return <GitDiffViewer location={file} active={active} focusRequest={active ? readerFocus.request : null}
            copied={active && copied} onCopyLink={copyLink} onCopyPath={() => copyFilePath(file, root)} onExpand={enterFullscreen} />
          const tab = tabs.find(tab => tabKey(tab) === tabKey(file))
          return <FilePreview location={file} active={active} projectRoot={root.path}
            focusRequest={active ? readerFocus.request : null} onNavigate={navigateFromReader} copied={active && copied} onCopyLink={copyLink}
            onCopyPath={() => copyFilePath(file, root)}
            onExpand={enterFullscreen} autoRefreshPaused={tab?.autoRefreshPaused ?? false}
            onToggleAutoRefresh={() => setPaused(file, !tab?.autoRefreshPaused)} projectTrustedScripts={root.trustedScripts ?? false}
            onProjectScriptsAllowed={() => setHostsAttempt(value => value + 1)} />
        }} />
      </div>
    </main>
    {toast && <div className="toast" role="status"><span>{toast}</span><button className="icon-button" aria-label="Dismiss notification" title="Dismiss notification" onClick={() => setToast('')}><X size={16} /></button></div>}
    {manualCopyPath !== null && <CopyPathDialog path={manualCopyPath} onClose={() => setManualCopyPath(null)} />}
  </div></>
}
