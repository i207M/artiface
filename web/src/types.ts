export interface Project {
  id: string
  label: string
  path: string
  hidden?: boolean
  trustedScripts?: boolean
}

export interface Host {
  id: string
  label: string
  target: string
  roots: Project[]
  kind?: 'ssh' | 'local'
  hidden?: boolean
}

export interface HostsResponse {
  hosts: Host[]
  setupEnabled: boolean
  revision?: string
}

export interface Entry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modified: string
  symlink?: boolean
  resolvedPath?: string
}

export interface Location extends FileLocation {
  kind: 'file' | 'directory' | 'auto' | 'overview' | 'settings' | 'add-project'
}

export interface FileLocation {
  host: string
  root: string
  path: string
  view?: 'diff' | 'history'
  commit?: string
}

export interface TextResponse {
  text: string
  truncated: boolean
  size: number
  version: string
}

export interface PreviewResponse {
  url: string
  expiresAt: string
  scripts: boolean
  path?: string
  version: string
  scriptCheck?: string
  bridge?: boolean
}

export interface PublicConfig {
  hosts: Host[]
  sessionHours: number
  listen: string
  appOrigin?: string
  previewOrigin?: string
  hideLocalSource?: boolean
}

export interface SettingsResponse {
  gitCommit: string
  buildTime?: string
  config: PublicConfig
  revision: string
  restartRequired?: boolean
  sshLocked?: boolean
  sshDisabled?: boolean
  sshConfigured?: boolean
}

export interface IgnoreResponse {
  content: string
  revision: string
  path: string
  editable: boolean
}

export interface FolderListing {
  path: string
  parent: string | null
  home: string
  entries: Entry[]
}
export interface SessionInfo {
  authenticated: boolean
  csrfToken?: string
  mode: 'personal' | 'team'
  role?: 'personal' | 'admin' | 'user'
  userID?: string
  username?: string
}
