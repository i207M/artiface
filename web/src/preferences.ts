import { useSyncExternalStore } from 'react'
import { allReaderTypes, normalizeReaderTypes } from './components/fileTypes'
import type { FileSort, ReaderType } from './components/fileTypes'

export interface Preferences {
  theme: 'system' | 'light' | 'dark'
  fontScale: number
  readerFontSize: number
  readerToolbarVisible: boolean
  density: 'compact' | 'comfortable'
  sidebarMode: 'dock' | 'overlay'
  sidebarVisible: boolean
  sidebarWidth: number | null
  showHidden: boolean
  browseView: 'list' | 'icons'
  defaultBrowseSort: FileSort
  browseSort: FileSort | null
  flatBrowse: boolean
  gitStatus: boolean
  disabledGitProjects: string[]
  defaultReaderTypes: ReaderType[]
  folderReaderTypes: Record<string, ReaderType[]>
  autoRefreshSeconds: number
  pdfNavigation: 'horizontal' | 'vertical'
  pdfCompression: boolean
}

const key = 'artiface.preferences.v1'
export const defaultPreferences: Preferences = {
  theme: 'system', fontScale: 1, readerFontSize: 18, readerToolbarVisible: true, density: 'compact',
  sidebarMode: 'dock', sidebarVisible: true, sidebarWidth: null, showHidden: false,
  browseView: 'list', defaultBrowseSort: { column: 'name', direction: 'asc' }, browseSort: null,
  flatBrowse: false, gitStatus: true, disabledGitProjects: [], defaultReaderTypes: [...allReaderTypes], folderReaderTypes: {},
  autoRefreshSeconds: 10,
  pdfNavigation: 'horizontal',
  pdfCompression: false,
}

function normalizeSort(value: unknown): FileSort | null {
  if (!value || typeof value !== 'object') return null
  const sort = value as Record<string, unknown>
  if (typeof sort.column !== 'string' || !['name', 'type', 'size', 'modified'].includes(sort.column) || (sort.direction !== 'asc' && sort.direction !== 'desc')) return null
  return { column: sort.column as FileSort['column'], direction: sort.direction }
}

function normalize(value: unknown): Preferences {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const selectedTypes = Array.isArray(data.defaultReaderTypes) ? data.defaultReaderTypes : null
  const folderTypes = data.folderReaderTypes && typeof data.folderReaderTypes === 'object' && !Array.isArray(data.folderReaderTypes)
    ? Object.fromEntries(Object.entries(data.folderReaderTypes).filter(([, types]) => Array.isArray(types))
      .map(([folder, types]) => [folder, normalizeReaderTypes(types as unknown[])])) : {}
  return {
    theme: data.theme === 'light' || data.theme === 'dark' ? data.theme : 'system',
    fontScale: typeof data.fontScale === 'number' && Number.isFinite(data.fontScale) ? Math.min(1.4, Math.max(0.9, data.fontScale)) : 1,
    readerFontSize: typeof data.readerFontSize === 'number' && Number.isFinite(data.readerFontSize) ? Math.min(28, Math.max(14, data.readerFontSize)) : 18,
    readerToolbarVisible: data.readerToolbarVisible !== false,
    density: data.density === 'comfortable' ? 'comfortable' : 'compact',
    sidebarMode: data.sidebarMode === 'overlay' ? 'overlay' : 'dock',
    sidebarVisible: typeof data.sidebarVisible === 'boolean' ? data.sidebarVisible : true,
    sidebarWidth: typeof data.sidebarWidth === 'number' && Number.isFinite(data.sidebarWidth)
      ? Math.round(Math.min(520, Math.max(240, data.sidebarWidth))) : null,
    showHidden: data.showHidden === true,
    browseView: data.browseView === 'icons' ? 'icons' : 'list',
    defaultBrowseSort: normalizeSort(data.defaultBrowseSort) ?? defaultPreferences.defaultBrowseSort,
    browseSort: normalizeSort(data.browseSort),
    flatBrowse: data.flatBrowse === true,
    gitStatus: data.gitStatus !== false,
    disabledGitProjects: Array.isArray(data.disabledGitProjects) ? [...new Set(data.disabledGitProjects.filter((key): key is string => typeof key === 'string' && key.length <= 512))].slice(0, 256) : [],
    defaultReaderTypes: selectedTypes ? normalizeReaderTypes(selectedTypes) : [...defaultPreferences.defaultReaderTypes],
    folderReaderTypes: folderTypes,
    autoRefreshSeconds: typeof data.autoRefreshSeconds === 'number' && Number.isFinite(data.autoRefreshSeconds)
      ? Math.round(Math.min(300, Math.max(2, data.autoRefreshSeconds))) : 10,
    pdfNavigation: data.pdfNavigation === 'vertical' ? 'vertical' : 'horizontal',
    pdfCompression: data.pdfCompression === true,
  }
}

function read(): Preferences {
  try { return normalize(JSON.parse(localStorage.getItem(key) || 'null')) } catch { return normalize(null) }
}

let current = read()
const listeners = new Set<() => void>()
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')

function apply() {
  const root = document.documentElement
  const theme = current.theme === 'system' ? systemTheme.matches ? 'dark' : 'light' : current.theme
  root.dataset.theme = theme
  root.dataset.density = current.density
  root.style.colorScheme = theme
  root.style.setProperty('--font-scale', String(current.fontScale))
  root.style.setProperty('--reader-font-size', `${current.readerFontSize}px`)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121916' : '#f6f7f6')
}

function notify() {
  apply()
  for (const listener of listeners) listener()
}

export function setPreferences(patch: Partial<Preferences>) {
  current = normalize({ ...current, ...patch })
  try { localStorage.setItem(key, JSON.stringify(current)) } catch { /* Preferences still work in memory. */ }
  notify()
}

export function setFolderReaderTypes(folder: string, types: ReaderType[] | null) {
  const folderReaderTypes = { ...current.folderReaderTypes }
  if (types === null) delete folderReaderTypes[folder]
  else folderReaderTypes[folder] = types
  setPreferences({ folderReaderTypes })
}

export function resetPreferences() {
  current = normalize(defaultPreferences)
  try { localStorage.removeItem(key) } catch { /* Preferences still work in memory. */ }
  notify()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePreferences(): [Preferences, typeof setPreferences] {
  return [useSyncExternalStore(subscribe, () => current), setPreferences]
}

systemTheme.addEventListener('change', apply)
window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) { current = read(); notify() }
})
apply()
