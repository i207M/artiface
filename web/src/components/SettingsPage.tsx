import { ArrowLeft, Check, ChevronDown, Code2, Download, FolderPlus, HardDrive, LoaderCircle, Monitor, Moon, RefreshCw, Server, Sun, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, APIError, errorMessage, isAborted, sessionExpired } from '../api'
import { configurationText, useSettingsDrafts } from '../SettingsDrafts'
import { resetPreferences, usePreferences } from '../preferences'
import { applyAppUpdate, installApp, useInstallApp } from '../pwa'
import type { Host, HostsResponse, Project, PublicConfig, SettingsResponse } from '../types'
import IgnoreSettings from './IgnoreSettings'
import PasswordSettings from './PasswordSettings'
import ProjectSetup from './ProjectSetup'
import FileTypeOptions from './FileTypeOptions'
import BrowsePreferences from './BrowsePreferences'
import GitPreferences, { ProjectGitPreference } from './GitPreferences'
import AccessSettings from './AccessSettings'
import SSHImportGuide from './SSHImportGuide'
import SettingsCredentialPrompt, { AdminPasswordField, takeAdminPassword, useAdminPassword } from './SettingsCredentialPrompt'
import './settings.css'

const scriptHelp = 'Applies to every HTML report in this project. Scripts can read its preview folder and contact external services.'

function configHost(host: Host): Host {
  return {
    id: host.id, label: host.label, target: host.target,
    ...(host.kind ? { kind: host.kind } : {}), hidden: Boolean(host.hidden),
    roots: host.roots.map(root => ({ id: root.id, label: root.label, path: root.path, hidden: Boolean(root.hidden), trustedScripts: Boolean(root.trustedScripts) })),
  }
}

function sourceLabel(host: Host) {
  return host.kind === 'local' && !host.label ? 'localhost' : host.label || host.id
}

type Removal = { kind: 'host'; host: Host } | { kind: 'project'; host: Host; project: Project }
interface SourceTarget { host?: Host; project?: Project; hostIndex: number; projectIndex: number }
interface SourceFeedback { target: SourceTarget; error: string; message: string }
interface SourceFocus { element: HTMLElement; lost: boolean; moved: boolean; done: boolean; stop: () => void }
const configurationConflictMessage = 'The configuration changed elsewhere. Your draft is kept. Copy any edits you need before reloading the latest configuration.'

export function RemoveDialog({ removal, busy, error, passwordRequired = false, onClose, onConfirm }: {
  removal: Removal; busy: boolean; error: string; passwordRequired?: boolean; onClose: () => void; onConfirm: (password?: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const password = useAdminPassword(passwordRequired)
  const name = removal.kind === 'host' ? sourceLabel(removal.host) : removal.project.label || removal.project.id
  useLayoutEffect(() => { if (error && !busy) password.current?.focus() }, [error, busy, password])
  useEffect(() => {
    const element = dialog.current
    const previousFocus = document.activeElement
    element?.showModal()
    element?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      element?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  return <dialog ref={dialog} className="settings-confirm" aria-labelledby="remove-source-title" aria-describedby="remove-source-description"
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(passwordRequired ? takeAdminPassword(password) : undefined) }}>
      <h2 id="remove-source-title">Remove {removal.kind} “{name}”?</h2>
      <p id="remove-source-description">{removal.kind === 'project'
        ? <>Remove this project from Artiface on {sourceLabel(removal.host)}. Its files and folders will remain on the machine.</>
        : <>Remove this host{removal.host.roots.length ? ` and its ${removal.host.roots.length} saved ${removal.host.roots.length === 1 ? 'project' : 'projects'}` : ''} from Artiface. {removal.host.kind !== 'local' && <>Its saved SSH credentials and trusted keys will be removed. Your original SSH config file will not change. </>}Files and folders will remain on the machine.</>}</p>
      {removal.kind === 'project' && <p className="settings-confirm-path"><code>{removal.host.kind === 'local' ? removal.project.path : `${removal.host.target}:${removal.project.path}`}</code></p>}
      {passwordRequired && <AdminPasswordField input={password} busy={busy} />}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="settings-actions">
        <button type="button" className="button secondary" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="button remove-confirm" disabled={busy}>{busy ? 'Removing…' : `Remove ${removal.kind}`}</button>
      </div>
    </form>
  </dialog>
}

export default function SettingsPage({ onClose, onChanged, initialSection = 'appearance', canManage = true, admin = false, catalogRevision }: {
  onClose: () => void; onChanged: () => void; initialSection?: 'appearance' | 'ignore' | 'sources'; canManage?: boolean; admin?: boolean
  catalogRevision?: string
}) {
  const [preferences, setPreferences] = usePreferences()
  const { configuration, setConfiguration, ignore } = useSettingsDrafts()
  const installation = useInstallApp()
  const scroller = useRef<HTMLElement>(null)
  const [section, setSection] = useState<'access' | 'appearance' | 'ignore' | 'sources' | 'config' | 'security' | 'install' | 'about'>(admin ? 'access' : !canManage && initialSection === 'ignore' ? 'appearance' : initialSection)
  const [mobileNavigation, setMobileNavigation] = useState(() => window.matchMedia('(max-width: 700px)').matches)
  const desktopNavigation = useRef<HTMLElement>(null)
  const mobileSection = useRef<HTMLSelectElement>(null)
  const navigationHandoff = useRef<HTMLElement | null>(null)
  const [settings, setSettings] = useState<SettingsResponse | null>(configuration.base)
  const [catalog, setCatalog] = useState<Host[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [setupEnabled, setSetupEnabled] = useState(false)
  const [working, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [configFeedback, setConfigFeedback] = useState<{ error: string; validation: boolean; local?: true } | null>(null)
  const configActions = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  const draft = configuration.text
  const baseText = useMemo(() => configurationText(configuration.base), [configuration.base])
  const dirty = draft !== baseText
  const sourcesLocked = dirty || configuration.conflict
  const ignoreDirty = ignore.text !== (ignore.base?.content ?? '')
  const busy = working || loading || configuration.saving || refreshingCatalog
  const discardOnLoad = useRef(false)
  const [adding, setAdding] = useState<Host | 'manual' | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [sourceFeedback, setSourceFeedback] = useState<SourceFeedback | null>(null)
  const sourceFeedbackElement = useRef<HTMLDivElement>(null)
  const sourcesHeading = useRef<HTMLHeadingElement>(null)
  const sourceFocus = useRef<SourceFocus | null>(null)
  const sourceAddOrigin = useRef<{ key: string; top: number; cancel: boolean } | null>(null)
  const [credentials, setCredentials] = useState<{ source: boolean; busy: boolean; error: string } | null>(null)
  const credentialReply = useRef<((password: string | null) => void) | null>(null)
  const activeSave = useRef<{ controller: AbortController; sensitive: boolean } | null>(null)
  const activeSession = useRef(true)
  const credentialOrigin = useRef<HTMLElement | null>(null)

  function cancelCredentials() {
    if (activeSave.current?.sensitive) activeSave.current.controller.abort()
    const reply = credentialReply.current
    credentialReply.current = null
    setCredentials(null)
    reply?.(null)
  }

  useLayoutEffect(() => {
    activeSession.current = true
    const hide = () => {
      credentialOrigin.current = null
      cancelCredentials()
      setRemoval(null)
    }
    const clear = () => {
      activeSession.current = false
      hide()
    }
    window.addEventListener('artiface:unauthorized', clear)
    window.addEventListener('pagehide', hide)
    return () => {
      clear()
      window.removeEventListener('artiface:unauthorized', clear)
      window.removeEventListener('pagehide', hide)
    }
  }, [])

  useEffect(() => {
    if (!canManage) { cancelCredentials(); setRemoval(null) }
  }, [canManage])

  useLayoutEffect(() => {
    if (busy || credentials || !credentialOrigin.current) return
    const origin = credentialOrigin.current
    credentialOrigin.current = null
    if (origin.isConnected && document.activeElement === document.body && document.hasFocus()) origin.focus()
  }, [busy, credentials])

  function submitCredentials(password: string) {
    const reply = credentialReply.current
    if (!reply) return
    credentialReply.current = null
    if (credentials?.source) rememberSourceFocus()
    setCredentials(current => current && { ...current, busy: true, error: '' })
    reply(password)
  }

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (section !== 'sources') { sourceAddOrigin.current = null; return }
    if (adding) {
      element.scrollTop = 0
      const heading = element.querySelector<HTMLElement>('.project-setup h2')
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
      return
    }
    const origin = sourceAddOrigin.current
    sourceAddOrigin.current = null
    if (!origin?.cancel) return
    element.scrollTop = origin.top
    const button = [...element.querySelectorAll<HTMLButtonElement>('[data-source-add]')]
      .find(button => button.dataset.sourceAdd === origin.key)
    const target = button && !button.disabled ? button
      : button?.closest('.source-card')?.querySelector<HTMLElement>('h3') ?? sourcesHeading.current
    if (!target || !document.hasFocus()) return
    if (target !== button) target.tabIndex = -1
    target.focus({ preventScroll: true })
    const bounds = target.getBoundingClientRect()
    const header = element.querySelector('.settings-header')?.getBoundingClientRect()
    if (bounds.top < (header?.bottom ?? 0) || bounds.bottom > element.getBoundingClientRect().bottom) {
      target.scrollIntoView({ block: 'center' })
    }
  }, [adding, section])

  useLayoutEffect(() => {
    const media = window.matchMedia('(max-width: 700px)')
    const changed = () => {
      const focused = document.activeElement
      const leaving = media.matches ? desktopNavigation.current?.contains(focused) : focused === mobileSection.current
      navigationHandoff.current = leaving && focused instanceof HTMLElement ? focused : null
      setMobileNavigation(media.matches)
    }
    changed()
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])

  useLayoutEffect(() => {
    const previous = navigationHandoff.current
    navigationHandoff.current = null
    if (!previous || !document.hasFocus() || (document.activeElement !== previous && document.activeElement !== document.body)) return
    const next = mobileNavigation ? mobileSection.current : desktopNavigation.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')
    next?.focus({ preventScroll: true })
    if (!mobileNavigation) next?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [mobileNavigation])

  useLayoutEffect(() => {
    // Local parsing finishes within the save action; delayed responses never move the view.
    if (configFeedback?.local) configActions.current?.scrollIntoView({ block: 'nearest' })
  }, [configFeedback])

  useEffect(() => () => {
    sourceFocus.current?.stop()
    sourceFocus.current = null
  }, [])

  useLayoutEffect(() => {
    const focus = sourceFocus.current
    if (!focus) return
    if (focus.moved || section !== 'sources') {
      sourceFocus.current = null
      focus.stop()
      return
    }
    if (!focus.done || busy || (removal && sourceFeedback?.message)) return
    // Fast removal can detach the focused control before the browser delivers blur.
    if ((!focus.lost && focus.element.isConnected) || document.activeElement !== document.body || !document.hasFocus()) return
    const target = focus.element.isConnected && !focus.element.matches(':disabled')
      ? focus.element : sourceFeedbackElement.current ?? sourcesHeading.current
    // A following catalog refresh may disable the restored control once more.
    // Keep tracking until the user moves away or starts another action.
    target?.focus({ preventScroll: target === focus.element })
    sourceFeedbackElement.current?.scrollIntoView({ block: 'nearest' })
  }, [busy, removal, section, sourceFeedback])

  useLayoutEffect(() => {
    // Keep navigation focus in place while showing the new section from the top.
    if (scroller.current) scroller.current.scrollTop = 0
  }, [section])

  // A save may finish in the previous Settings instance after navigation.
  useEffect(() => { if (configuration.base) setSettings(configuration.base) }, [configuration.base])

  useEffect(() => {
    const controller = new AbortController()
    const discard = discardOnLoad.current
    discardOnLoad.current = false
    setLoading(true)
    setError('')
    void Promise.all([
      api<SettingsResponse>('/api/settings', { signal: controller.signal }),
      api<HostsResponse>('/api/hosts', { signal: controller.signal }),
    ]).then(([data, hosts]) => {
      if (controller.signal.aborted) return
      setSettings(data)
      setConfiguration(previous => {
        if (previous.saving) return previous
        if (!discard && (previous.text !== configurationText(previous.base) || previous.conflict)) {
          return { ...previous, conflict: previous.conflict || previous.base?.revision !== data.revision }
        }
        return { base: data, text: configurationText(data), conflict: false, saving: false }
      })
      setCatalog(hosts.hosts)
      setCatalogError('')
      setSetupEnabled(hosts.setupEnabled)
      if (discard) { setConfigFeedback(null); setMessage('') }
    }).catch(failure => { if (!isAborted(failure)) setError(`${errorMessage(failure)} Your configuration draft has not been changed.`) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [attempt, catalogRevision, setConfiguration])

  function reloadConfiguration() {
    if (busy || (dirty && !window.confirm('Discard your unsaved configuration draft and reload the latest configuration?'))) return
    discardOnLoad.current = true
    setLoading(true)
    setAttempt(value => value + 1)
  }

  function targetSource(host?: Host, project?: Project): SourceTarget {
    const hostIndex = catalog.findIndex(item => item.id === host?.id)
    const projectIndex = host?.roots.findIndex(item => item.id === project?.id) ?? -1
    return { host, project, hostIndex: hostIndex < 0 ? catalog.length : hostIndex,
      projectIndex: projectIndex < 0 ? host?.roots.length ?? 0 : projectIndex }
  }

  function rememberSourceFocus(fallback?: HTMLElement) {
    sourceFocus.current?.stop()
    sourceFocus.current = null
    const element = document.activeElement === document.body && fallback ? fallback : document.activeElement
    if (!(element instanceof HTMLElement) || !scroller.current?.contains(element) || !element.matches('input,button')) return null
    const focus: SourceFocus = { element, lost: false, moved: false, done: false, stop: () => {} }
    const leave = () => {
      focus.moved = true
      focus.stop()
      if (focus.done && sourceFocus.current === focus) sourceFocus.current = null
    }
    const blur = () => { if (element.matches(':disabled')) focus.lost = true; else leave() }
    const move = (event: Event) => { if (event.target !== element && event.target !== document.body) leave() }
    const pointer = (event: PointerEvent) => { if (!element.contains(event.target as Node)) leave() }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab' || (document.activeElement === document.body
        && ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key))) leave()
    }
    element.addEventListener('blur', blur)
    document.addEventListener('focusin', move, true)
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('keydown', key, true)
    document.addEventListener('wheel', leave, { capture: true, passive: true })
    window.addEventListener('blur', leave)
    focus.stop = () => {
      element.removeEventListener('blur', blur)
      document.removeEventListener('focusin', move, true)
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('wheel', leave, true)
      window.removeEventListener('blur', leave)
    }
    sourceFocus.current = focus
    return focus
  }

  function addSource(host: Host | 'manual', button: HTMLButtonElement) {
    sourceFocus.current?.stop()
    sourceFocus.current = null
    sourceAddOrigin.current = { key: button.dataset.sourceAdd!, top: scroller.current?.scrollTop ?? 0, cancel: false }
    setSourceFeedback(null)
    setAdding(host)
  }

  function cancelSourceAdd() {
    sourceFocus.current?.stop()
    sourceFocus.current = null
    if (sourceAddOrigin.current) sourceAddOrigin.current.cancel = true
    setAdding(null)
  }

  async function save(config: PublicConfig, source?: SourceTarget, adminPassword?: string): Promise<boolean> {
    if (!settings || !configuration.base || busy || activeSave.current || configuration.conflict || !canManage || !setupEnabled || !activeSession.current) return false
    // Retries use this exact public configuration and revision, even if the draft changes.
    const body = { config: JSON.parse(JSON.stringify(config)) as PublicConfig, revision: configuration.base.revision }
    const submittedDraft = configuration.text
    const operation = { controller: new AbortController(), sensitive: adminPassword !== undefined }
    activeSave.current = operation
    if (source) rememberSourceFocus()
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (source) setSourceFeedback({ target: source, error: '', message: '' })
    setConfiguration(previous => ({ ...previous, saving: true }))
    if (source) setError('')
    else setConfigFeedback(null)
    setMessage('')
    let savedConfig = false
    try {
      let result: SettingsResponse
      for (;;) {
        try {
          result = await api<SettingsResponse>('/api/settings', {
            body: { ...body, ...(adminPassword !== undefined ? { adminPassword } : {}) },
            signal: operation.controller.signal,
          })
          if (operation.controller.signal.aborted) return false
          break
        } catch (failure) {
          const passwordError = failure instanceof APIError && (failure.status === 428
            || (adminPassword !== undefined && failure.status === 403 && failure.message === 'Incorrect admin password'))
          if (!passwordError) throw failure
          operation.sensitive = true
          adminPassword = undefined
          if (!activeSession.current || operation.controller.signal.aborted) return false
          if (!source) credentialOrigin.current = origin
          setCredentials({ source: Boolean(source), busy: false, error: failure.message })
          const password = await new Promise<string | null>(resolve => { credentialReply.current = resolve })
          if (password === null || operation.controller.signal.aborted) return false
          adminPassword = password
        }
      }
      adminPassword = undefined
      setCredentials(null)
      savedConfig = true
      setSettings(result)
      setConfiguration(previous => ({
        base: result, text: previous.text === submittedDraft ? configurationText(result) : previous.text, conflict: false, saving: true,
      }))
      onChanged()
      try {
        const hosts = await api<HostsResponse>('/api/hosts')
        setCatalog(hosts.hosts)
        setCatalogError('')
      } catch (failure) {
        // The write committed; a catalog refresh failure must not offer it again.
        setCatalog([])
        setCatalogError(errorMessage(failure))
      }
      const saved = result.restartRequired ? 'Sources saved. Restart the server to apply session or connection settings.' : 'Settings saved.'
      if (source) setSourceFeedback(current => current?.target === source ? { ...current, message: saved } : current)
      else { setError(''); setMessage(saved) }
      return true
    } catch (failure) {
      if (isAborted(failure) || operation.controller.signal.aborted) return false
      if (failure instanceof APIError && failure.status === 409
        && failure.message !== 'SSH credentials changed elsewhere; restart the server before removing hosts') {
        setConfiguration(previous => ({ ...previous, conflict: true }))
      } else if (source) setSourceFeedback(current => current?.target === source ? { ...current, error: errorMessage(failure) } : current)
      else setConfigFeedback({ error: errorMessage(failure), validation: !savedConfig && failure instanceof APIError && failure.status === 400 })
      return false
    } finally {
      adminPassword = undefined
      activeSave.current = null
      credentialReply.current = null
      setCredentials(null)
      if (source && sourceFocus.current) sourceFocus.current.done = true
      setConfiguration(previous => ({ ...previous, saving: false }))
    }
  }

  async function retryCatalog() {
    if (busy) return
    const focus = rememberSourceFocus()
    setRefreshingCatalog(true)
    try {
      const hosts = await api<HostsResponse>('/api/hosts')
      setCatalog(hosts.hosts)
      setSetupEnabled(hosts.setupEnabled)
      setCatalogError('')
      onChanged()
    } catch (failure) {
      setCatalogError(errorMessage(failure))
    } finally {
      if (focus && sourceFocus.current === focus) focus.done = true
      setRefreshingCatalog(false)
    }
  }

  function toggleHost(host: Host, hidden: boolean) {
    if (!settings) return
    const hosts = settings.config.hosts.some(item => item.id === host.id)
      ? settings.config.hosts.map(item => item.id === host.id ? { ...item, hidden } : item)
      : [...settings.config.hosts, { ...configHost(host), hidden }]
    void save({ ...settings.config, hosts }, targetSource(host))
  }

  function toggleRoot(host: Host, rootID: string, hidden: boolean) {
    if (!settings) return
    void save({ ...settings.config, hosts: settings.config.hosts.map(item => item.id === host.id
      ? { ...item, roots: item.roots.map(root => root.id === rootID ? { ...root, hidden } : root) }
      : item) }, targetSource(host, host.roots.find(root => root.id === rootID)))
  }

  function toggleScripts(host: Host, rootID: string, trustedScripts: boolean) {
    if (!settings) return
    void save({ ...settings.config, hosts: settings.config.hosts.map(item => item.id === host.id
      ? { ...item, roots: item.roots.map(root => root.id === rootID ? { ...root, trustedScripts } : root) }
      : item) }, targetSource(host, host.roots.find(root => root.id === rootID)))
  }

  async function removeSource(adminPassword?: string) {
    if (!settings || !removal || sourcesLocked || busy) return
    const { host } = removal
    const config = removal.kind === 'project'
      ? { ...settings.config, hosts: settings.config.hosts.map(item => item.id === host.id
          ? { ...item, roots: item.roots.filter(root => root.id !== removal.project.id) } : item) }
      : {
          ...settings.config,
          hosts: settings.config.hosts.filter(item => item.id !== host.id),
          ...(host.kind === 'local' ? { hideLocalSource: true } : {}),
        }
    const source = targetSource(host, removal.kind === 'project' ? removal.project : undefined)
    const saved = save(config, source, adminPassword)
    adminPassword = undefined
    if (await saved) {
      setRemoval(null)
      setSourceFeedback(current => current?.target === source
        ? { ...current, message: `${removal.kind === 'project' ? 'Project' : 'Host'} removed from Artiface. Files are unchanged.${removal.kind === 'host' && host.kind !== 'local' ? ' Saved SSH credentials and trusted keys were removed.' : ''}` } : current)
    }
  }

  function restoreLocal() {
    if (!settings) return
    void save({ ...settings.config, hideLocalSource: false }, targetSource())
  }

  function saveDraft() {
    try {
      const value = JSON.parse(draft)
      if (!value || typeof value !== 'object' || !Array.isArray(value.hosts)) throw new Error('Configuration must be an object containing a hosts array.')
      void save(value as PublicConfig)
    } catch (failure) {
      setConfigFeedback({ error: errorMessage(failure), validation: true, local: true })
      setMessage('')
    }
  }

  const localSourceFeedback = section === 'sources' && !adding && Boolean(sourceFeedback)
  const sourceError = configuration.conflict ? 'The configuration changed elsewhere. Open Configuration and reload it before changing sources.' : sourceFeedback?.error || ''
  const sourceNotice = sourceFeedback && (sourceError || sourceFeedback.message) && !removal
    ? <div ref={sourceFeedbackElement} tabIndex={-1} className={`${sourceError ? 'settings-error' : 'settings-message'} source-feedback`}
        role={sourceError ? 'alert' : 'status'}>{sourceError || sourceFeedback.message}</div> : null
  const sourceHosts: { id: string; host: Host | null }[] = catalog.map(host => ({ id: host.id, host }))
  if (sourceFeedback?.target.host && !sourceHosts.some(item => item.id === sourceFeedback.target.host!.id)) {
    sourceHosts.splice(sourceFeedback.target.hostIndex, 0, { id: sourceFeedback.target.host.id, host: null })
  }
  function sourceRoots(host: Host) {
    const roots: { id: string; root: Project | null }[] = host.roots.map(root => ({ id: root.id, root }))
    const target = sourceFeedback?.target
    if (target?.host?.id === host.id && target.project && !roots.some(item => item.id === target.project!.id)) {
      roots.splice(target.projectIndex, 0, { id: target.project.id, root: null })
    }
    return roots
  }
  const settingsError = error && <div id={section === 'config' ? 'config-read-error' : undefined} className="settings-error" role="alert">
    {error}{!settings && <button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Retry</button>}
  </div>
  const configDescription = [configFeedback && 'config-feedback', error && 'config-read-error', configuration.conflict && 'config-conflict'].filter(Boolean).join(' ') || undefined
  const sections = ([['access', 'Access'], ['appearance', 'Appearance'], ['ignore', 'Ignored files'], ['sources', 'Sources'], ['config', 'Configuration'], ['security', 'Security'], ['install', 'Install app'], ['about', 'About']] as const).filter(([id]) =>
    id === 'access' ? admin : id === 'sources' ? true : ['ignore', 'config', 'security'].includes(id) ? canManage : admin ? id === 'about' : true)

  function changeSection(next: typeof section) {
    if (next !== section) setSourceFeedback(null)
    setSection(next)
    setAdding(null)
  }
  const gitPreferenceHelp = <p className="settings-help">Git status preferences are saved on this device.{!preferences.gitStatus && <> Enable Git status in {admin ? 'the app’s Appearance settings' : <button className="text-button" onClick={() => changeSection('appearance')}>Appearance</button>} to use project overrides.</>}</p>

  return (
    <section ref={scroller} className="settings-page" aria-labelledby="settings-title" onSubmitCapture={event => {
      if (!adding || section !== 'sources' || !(event.target instanceof HTMLFormElement)) return
      const form = event.target
      if (!form.matches('.project-setup-form')) return
      const submitter = form.querySelector<HTMLButtonElement>('button[type="submit"]')
      if (submitter?.disabled || (!form.contains(document.activeElement) && document.activeElement !== document.body)) return
      rememberSourceFocus(submitter ?? undefined)
    }}>
      <header className="settings-header"><button className="icon-button settings-back" aria-label="Back to workspace" title="Back" onClick={onClose}><ArrowLeft size={20} /></button><h1 id="settings-title">{admin ? 'Administration' : 'Settings'}</h1>
      {mobileNavigation
        ? <div className="settings-mobile-navigation"><span aria-hidden="true">{admin ? 'Administration' : 'Settings'}</span>
          <select ref={mobileSection} className="settings-section-select" aria-label={admin ? 'Administration section' : 'Settings section'} value={section}
            onChange={event => changeSection(event.target.value as typeof section)}>
            {sections.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <ChevronDown size={16} aria-hidden="true" />
          </div>
        : <nav ref={desktopNavigation} className="settings-nav" aria-label="Settings sections">
            {sections.map(([id, label]) =>
              <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => changeSection(id)}>{label}</button>)}
          </nav>}{admin && <button className="button quiet team-admin-signout" disabled={busy} onClick={async () => {
        setBusy(true)
        try { await api('/api/logout', { body: {} }); sessionExpired() } catch (failure) { setError(errorMessage(failure)) } finally { setBusy(false) }
      }}>Sign out</button>}</header>
      {section !== 'config' && settingsError}
      {configuration.conflict && !localSourceFeedback && section !== 'config' && <div className="settings-error" role="alert">{configurationConflictMessage}</div>}
      {dirty && section !== 'config' && <div className="settings-message">You have an unsaved configuration draft. Save or discard it before changing sources.</div>}
      {ignoreDirty && section !== 'ignore' && <div className="settings-message">You have an unsaved draft in Ignored files.</div>}
      {section === 'sources' && settings?.sshDisabled && <div className="settings-message" role="status">
        SSH connectivity is disabled on this server. Local projects remain available.
        {canManage && <> Restart Artiface with <code>ARTIFACE_DISABLE_SSH=false</code> to enable SSH.</>}
      </div>}
      <div className={`settings-content${section === 'appearance' ? ' settings-appearance' : ''}`}>
        {section === 'access' && admin && <AccessSettings hosts={settings?.config.hosts ?? []} enabled={setupEnabled && !sourcesLocked && !ignoreDirty && !busy} />}
        {section === 'appearance' && <>
          <section className="settings-section"><h2>Appearance</h2><p>These preferences are saved on this device.</p>
            <div className="appearance-display-controls">
            <div className="preference-row theme-preference"><span id="theme-label">Theme</span><div className="segmented-control" role="group" aria-labelledby="theme-label">{([['system', Monitor, 'System'], ['light', Sun, 'Light'], ['dark', Moon, 'Dark']] as const).map(([value, Icon, label]) =>
              <button key={value} aria-pressed={preferences.theme === value} onClick={() => setPreferences({ theme: value })}><Icon size={16} />{label}</button>)}</div></div>
            <div className="preference-row"><label htmlFor="font-scale">Interface text size</label><select id="font-scale" value={preferences.fontScale} onChange={event => setPreferences({ fontScale: Number(event.target.value) })}>{[0.9, 1, 1.1, 1.2, 1.3, 1.4].map(scale => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}</select></div>
            <div className="preference-row"><label htmlFor="reader-font">Reader text size</label><select id="reader-font" value={preferences.readerFontSize} onChange={event => setPreferences({ readerFontSize: Number(event.target.value) })}>{[14, 16, 18, 20, 22, 24, 28].map(size => <option key={size} value={size}>{size} px</option>)}</select></div>
            <div className="preference-row density-preference"><label htmlFor="density">Layout density</label><select id="density" value={preferences.density} onChange={event => setPreferences({ density: event.target.value as 'compact' | 'comfortable' })}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></div>
            </div>
            <p className="settings-help">Compact fits more content. Comfortable adds space between controls.</p>
          </section>
          <section className="settings-section"><h2>Browse</h2>
            <BrowsePreferences appearance />
            <GitPreferences />
          </section>
          <section className="settings-section"><h2>Default file types</h2><p>Used until you customize a folder’s Types filter. Folder filters are saved on this device.</p>
            <FileTypeOptions selected={preferences.defaultReaderTypes} onChange={defaultReaderTypes => setPreferences({ defaultReaderTypes })} />
          </section>
          <section className="settings-section"><h2>Automatic refresh</h2><p>Check for changes in the current file or Browse tab, and update modification times in Overview. Each file tab has its own pause control.</p>
            <div className="preference-row"><label htmlFor="refresh-interval">Automatic refresh interval</label><select id="refresh-interval" value={preferences.autoRefreshSeconds} onChange={event => setPreferences({ autoRefreshSeconds: Number(event.target.value) })}>{[2, 5, 10, 30, 60, 120, 300].map(seconds => <option key={seconds} value={seconds}>{seconds < 60 ? `${seconds} seconds` : `${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`}</option>)}</select></div>
            <p className="settings-help">Background tabs are checked when you return to them. Shorter intervals make more connections to SSH machines.</p>
          </section>
          <section className="settings-section"><h2>PDF compression</h2>
            <label className="settings-check"><input type="checkbox" checked={preferences.pdfCompression} onChange={event => setPreferences({ pdfCompression: event.target.checked })} />Compression</label>
            <p>Load PDF pages as smaller images instead of transferring the original to this device. Turn off for selectable text and full detail. You can also switch in the PDF reader’s options.</p>
          </section>
          <button className="button secondary" onClick={resetPreferences}>Reset device preferences</button>
        </>}
        {canManage && <div hidden={section !== 'ignore'}><IgnoreSettings onChanged={onChanged} /></div>}
        {section === 'security' && canManage && <>
          {!admin && <section className="settings-section"><h2>Personal & Team modes</h2><p>Mode is chosen when the server starts. Use the admin panel to prepare team accounts and project access.</p><a className="button secondary" href="/admin/">Open admin panel</a></section>}
          <PasswordSettings enabled={setupEnabled && !dirty && !ignoreDirty && !busy} />
        </>}
        {section === 'sources' && !canManage && <section className="settings-section">
          <h2>Projects</h2>{gitPreferenceHelp}
          {loading ? <div className="settings-loading" role="status"><LoaderCircle className="spin" size={20} /> Loading projects…</div>
            : catalog.some(host => host.roots.length) ? <div className="source-card">
              {catalog.flatMap(host => host.roots.map(root => <div className="source-root" key={`${host.id}/${root.id}`}>
                <div className="source-root-details"><strong>{root.label || root.id}</strong><code>{sourceLabel(host)}</code>
                  <div className="source-preferences"><ProjectGitPreference project={{ host: host.id, root: root.id }} name={`${root.label || root.id} on ${sourceLabel(host)}`} /></div>
                </div>
              </div>))}
            </div> : <p>No projects are available.</p>}
        </section>}
        {section === 'sources' && canManage && <>
          {adding ? <ProjectSetup host={adding === 'manual' ? undefined : adding} hosts={catalog} sshDisabled={Boolean(settings?.sshDisabled)}
            hostCreationEnabled={setupEnabled && !sourcesLocked} submitLabel="Add project" onCancel={cancelSourceAdd}
            onHostCreated={host => {
              setCatalog(current => [...current.filter(item => item.id !== host.id), host])
              setAdding(host)
              setAttempt(value => value + 1)
              onChanged()
            }}
            onSaved={(host, root, completion) => {
              if (completion.current) {
                if (sourceFocus.current) sourceFocus.current.done = true
                setAdding(null)
                setSourceFeedback({ target: targetSource(host, root), error: '', message: 'Project saved.' })
              }
              // Wait for the final project row before restoring the completion view.
              setLoading(true)
              setAttempt(value => value + 1)
              onChanged()
            }} />
            : <>
              <section className="settings-section"><div className="settings-section-heading"><div><h2 ref={sourcesHeading} tabIndex={-1}>Machines & Projects</h2><p>Manage saved projects and machines. Local files are on the computer running Artiface.</p></div>{!catalogError && <div className="settings-actions">
                {settings && !catalog.some(host => host.kind === 'local') && <button className="button secondary" onClick={restoreLocal} disabled={!setupEnabled || sourcesLocked || busy}><HardDrive size={16} /> Add localhost</button>}
                <button className="button secondary" data-source-add="manual" onClick={event => addSource('manual', event.currentTarget)} disabled={!setupEnabled || settings?.sshDisabled || sourcesLocked || busy}><Server size={16} /> Add SSH host</button></div>}</div>
                <SSHImportGuide />
                {gitPreferenceHelp}
                {catalogError && <div className="settings-error" role="alert"><span>The source list could not be refreshed. {catalogError}{' '}
                  <button className="button secondary" disabled={busy} onClick={() => void retryCatalog()}>{refreshingCatalog ? 'Refreshing sources…' : 'Retry source list'}</button>
                </span></div>}
                {!sourceFeedback?.target.host && sourceNotice}
                {!settings && !error ? <div className="settings-loading"><LoaderCircle className="spin" size={20} /> Loading sources…</div>
                  : <div className="settings-sources">{sourceHosts.map(({ id, host }) => host ? <section className="source-card" key={id}>
                    <header><div className="source-title">{host.kind === 'local' ? <HardDrive size={20} /> : <Server size={20} />}<div><h3>{sourceLabel(host)}</h3>{host.kind !== 'local' && <p>{host.target}</p>}</div><button className="icon-button source-remove" aria-label={`Remove host ${sourceLabel(host)}`} title="Remove host" disabled={busy || sourcesLocked || !setupEnabled} onClick={() => { setError(''); setSourceFeedback(null); setRemoval({ kind: 'host', host }) }}><Trash2 size={16} /></button></div>
                      <div className="source-controls"><label className="settings-check"><input type="checkbox" aria-label={`Show ${sourceLabel(host)}`} checked={!host.hidden} disabled={busy || sourcesLocked || !setupEnabled} onChange={event => toggleHost(host, !event.target.checked)} />Show</label><button className="button secondary" data-source-add={`host:${host.id}`} onClick={event => addSource(host, event.currentTarget)} disabled={busy || sourcesLocked || !setupEnabled}><FolderPlus size={16} /> Add project</button></div>
                    </header>
                    {sourceFeedback?.target.host?.id === host.id && !sourceFeedback.target.project && sourceNotice}
                    {sourceRoots(host).map(({ id, root }) => <div className="source-project" key={id}>
                      {root && <div className="source-root">
                      <div className="source-root-details"><strong>{root.label || root.id}</strong><code>{root.path}</code>
                        <div className="source-preferences">
                          <label className="settings-check source-trust" title={scriptHelp}><input type="checkbox" checked={Boolean(root.trustedScripts)} disabled={busy || sourcesLocked || !setupEnabled} aria-label={`Allow scripts in ${root.label || root.id}`} aria-describedby={`trust-help-${host.id}-${root.id}`} onChange={event => toggleScripts(host, root.id, event.target.checked)} />Allow scripts</label>
                          <span className="sr-only" id={`trust-help-${host.id}-${root.id}`}>{scriptHelp}</span>
                          <ProjectGitPreference project={{ host: host.id, root: root.id }} name={`${root.label || root.id} on ${sourceLabel(host)}`} />
                        </div>
                      </div>
                      <div className="source-controls"><label className="settings-check"><input type="checkbox" aria-label={`Show ${root.label || root.id} on ${sourceLabel(host)}`} checked={!root.hidden} disabled={busy || sourcesLocked || !setupEnabled} onChange={event => toggleRoot(host, root.id, !event.target.checked)} />Show</label><button className="icon-button source-remove" aria-label={`Remove project ${root.label || root.id} on ${sourceLabel(host)}`} title="Remove project" disabled={busy || sourcesLocked || !setupEnabled} onClick={() => { setError(''); setSourceFeedback(null); setRemoval({ kind: 'project', host, project: root }) }}><Trash2 size={16} /></button></div>
                      </div>}
                      {sourceFeedback?.target.host?.id === host.id && sourceFeedback.target.project?.id === id && sourceNotice}
                    </div>)}
                    {!host.roots.length && <p className="source-empty">No saved projects.</p>}
                  </section> : <div key={id}>{sourceNotice}</div>)}</div>}
              </section>
            </>}
        </>}
        {section === 'config' && <section className="settings-section"><h2><Code2 size={19} /> Configuration</h2><p>Edit sources, project paths, visibility, and server settings. Password hashes and SSH credentials are not included.</p>
          <p className="settings-help">Source changes apply immediately. Changes to listeners, browser origins, or session duration require restarting the server.</p>
          {!settings && loading && <div className="settings-loading" role="status"><LoaderCircle className="spin" size={18} /> Loading configuration…</div>}
          {settings && <>
            <label className="sr-only" htmlFor="config-editor">Configuration JSON</label>
            <textarea id="config-editor" className="config-editor" value={draft} spellCheck={false}
              autoCapitalize="none" autoCorrect="off" disabled={busy} aria-invalid={configFeedback?.validation || undefined} aria-describedby={configDescription}
              onChange={event => {
                const text = event.target.value
                setConfiguration(previous => ({ ...previous, text }))
                setConfigFeedback(current => current?.validation ? null : current)
                setMessage('')
              }} />
          </>}
          <div ref={configActions} className="settings-editor-feedback">
            {settingsError}
            {configFeedback && <div id="config-feedback" className="settings-error" role="alert">{configFeedback.error}</div>}
            {configuration.conflict && <div id="config-conflict" className="settings-error" role="alert">{configurationConflictMessage}</div>}
            {message && <div className="settings-message" role="status"><Check size={16} />{message}</div>}
            <div className="settings-actions"><button className="button secondary" onClick={() => { setConfiguration({ base: settings, text: configurationText(settings), conflict: false, saving: false }); setConfigFeedback(null); setMessage('') }} disabled={!dirty || busy}>Discard draft</button><button className="button secondary" onClick={reloadConfiguration} disabled={busy}><RefreshCw size={16} /> Reload latest config</button><button className="button primary" disabled={!dirty || busy || !setupEnabled || configuration.conflict} onClick={saveDraft}>{configuration.saving ? 'Saving…' : 'Save configuration'}</button></div>
          </div>
        </section>}
        {section === 'install' && <section className="settings-section"><h2><Download size={20} /> Install Artiface</h2><p>Open Artiface in its own window on a computer, phone, or tablet.</p>
          {installation.installed ? <div className="settings-message"><Check size={17} />Running as an installed app.</div>
            : installation.canInstall ? <button className="button primary" onClick={() => void installApp()}><Download size={17} />Install on this device</button>
              : <div className="install-instructions"><p><strong>Chrome / Edge:</strong> choose Install app from the browser menu or address bar.</p><p><strong>iPhone / iPad:</strong> open the Share menu and choose Add to Home Screen.</p><p><strong>Safari on Mac:</strong> choose File → Add to Dock.</p></div>}
          {!installation.secureContext && <p className="settings-error">Installation requires HTTPS, or localhost on the device running the browser.</p>}
          {installation.error && <p className="settings-error">{installation.error}</p>}
          <p className="settings-help">The app shell can open offline. Local and SSH artifacts require a connection to the server and are not cached for offline use.</p>
          {installation.updateAvailable && <button className="button primary" onClick={applyAppUpdate} disabled={dirty || ignoreDirty}><RefreshCw size={17} />Reload app to update</button>}
        </section>}
        {section === 'about' && <section className="settings-section"><h2>About Artiface</h2><p>A browser for local and SSH artifacts.</p>
          {!settings && !error ? <div className="settings-loading"><LoaderCircle className="spin" size={20} /> Loading build details…</div>
            : settings && <dl className="about-details">
              <div><dt>Git commit</dt><dd><code aria-label="Git commit">{settings.gitCommit && settings.gitCommit !== 'unknown' ? settings.gitCommit : 'Unavailable'}</code>
                {settings.gitCommit?.endsWith('-dirty') && <p className="settings-help">Includes uncommitted changes.</p>}
              </dd></div>
              <div><dt>Build time</dt><dd>{settings.buildTime && Number.isFinite(Date.parse(settings.buildTime))
                ? <time aria-label="Build time" dateTime={settings.buildTime} title={settings.buildTime}>{new Date(settings.buildTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })}</time>
                : 'Unavailable'}</dd></div>
            </dl>}
        </section>}
      </div>
      {removal && <RemoveDialog removal={removal} busy={credentials?.source ? credentials.busy : busy}
        passwordRequired={removal.kind === 'host' && removal.host.kind !== 'local' && Boolean(settings?.sshConfigured || credentials?.source)}
        error={credentials?.source ? credentials.error : sourceError || error}
        onClose={() => { cancelCredentials(); setRemoval(null); setError('') }}
        onConfirm={password => { if (credentials?.source) submitCredentials(password ?? ''); else void removeSource(password) }} />}
      {credentials && !credentials.source && <SettingsCredentialPrompt busy={credentials.busy} error={credentials.error}
        onClose={cancelCredentials} onConfirm={submitCredentials} />}
    </section>
  )
}
