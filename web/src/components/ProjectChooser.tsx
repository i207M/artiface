import { FolderOpen, HardDrive, Plus, Search, Server, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, APIError, errorMessage } from '../api'
import type { Host, Project, SettingsResponse } from '../types'
import ProjectSetup from './ProjectSetup'
import type { ProjectSetupDraft } from './ProjectSetup'
import { RemoveDialog } from './SettingsPage'
import './settings.css'

function sourceLabel(host: Host) {
  return host.kind === 'local' && !host.label ? 'localhost' : host.label || host.id
}

interface RemovalFocus { element: HTMLElement; target: HTMLButtonElement | null; controller: AbortController; lost: boolean; done: boolean }

export default function ProjectChooser({ hosts, setupEnabled, onOpen, onSaved, onRemoved, onSettings }: {
  hosts: Host[]; setupEnabled: boolean
  onOpen: (host: Host, project: Project) => void
  onSaved: (host: Host, project: Project, current: boolean) => void
  onRemoved: (host: Host, project: Project) => void
  onSettings: () => void
}) {
  const [createdHosts, setCreatedHosts] = useState<Host[]>([])
  const machines = [...hosts, ...createdHosts.filter(created => !hosts.some(host => host.id === created.id))]
  const saved = machines.flatMap(host => host.roots.map(project => ({ host, project })))
  const [creating, setCreating] = useState(saved.length === 0)
  const [machine, setMachine] = useState(hosts.find(host => host.kind === 'local')?.id ?? hosts[0]?.id ?? '')
  const [drafts, setDrafts] = useState<Record<string, ProjectSetupDraft>>({})
  const [filter, setFilter] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const chooser = useRef<HTMLDivElement>(null)
  const newProject = useRef<HTMLButtonElement>(null)
  const removalFocus = useRef<RemovalFocus | null>(null)
  const createdFocus = useRef<string | null>(null)
  const [sshStatus, setSSHStatus] = useState<{ ready: boolean; disabled: boolean; error: string }>({ ready: false, disabled: false, error: '' })
  const [sshAttempt, setSSHAttempt] = useState(0)
  const query = filter.trim().toLocaleLowerCase()
  const filtered = saved.filter(({ host, project }) => `${project.label} ${sourceLabel(host)} ${project.path}`.toLocaleLowerCase().includes(query))
  const [removal, setRemoval] = useState<{ kind: 'project'; host: Host; project: Project } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const host = machines.find(item => item.id === machine)
  const sourceKey = host ? JSON.stringify([host.id, host.kind ?? 'ssh', host.target]) : 'manual'

  useEffect(() => {
    if (!setupEnabled) return
    const controller = new AbortController()
    const refresh = () => setSSHAttempt(value => value + 1)
    window.addEventListener('artiface:configuration-changed', refresh)
    void api<SettingsResponse>('/api/settings', { signal: controller.signal }).then(settings => {
      if (!controller.signal.aborted) setSSHStatus({ ready: true, disabled: Boolean(settings.sshDisabled), error: '' })
    }).catch(() => {
      if (!controller.signal.aborted) setSSHStatus({ ready: false, disabled: false, error: 'Could not check SSH availability.' })
    })
    return () => {
      controller.abort()
      window.removeEventListener('artiface:configuration-changed', refresh)
    }
  }, [setupEnabled, sshAttempt])
  useLayoutEffect(() => {
    if (!host || createdFocus.current !== host.id) return
    createdFocus.current = null
    chooser.current?.querySelector<HTMLInputElement>('.project-setup input[name="path"]')?.focus({ preventScroll: true })
  }, [machine, sourceKey])

  useEffect(() => () => removalFocus.current?.controller.abort(), [])
  useEffect(() => {
    const focus = removalFocus.current
    if (!focus?.done || busy || removal) return
    removalFocus.current = null
    const restore = !focus.controller.signal.aborted && document.hasFocus()
      && document.activeElement === document.body && (focus.lost || !focus.element.isConnected)
    focus.controller.abort()
    if (restore) {
      const target = focus.target?.isConnected ? focus.target
        : !saved.length ? newProject.current ?? searchInput.current : searchInput.current
      target?.focus()
    }
  }, [busy, removal, hosts])

  function rememberRemovalFocus() {
    removalFocus.current?.controller.abort()
    removalFocus.current = null
    const element = document.activeElement
    if (!(element instanceof HTMLElement) || !element.closest('dialog') || !chooser.current?.contains(element)) return null
    const index = filtered.findIndex(({ host, project }) => host.id === removal?.host.id && project.id === removal.project.id)
    const buttons = chooser.current.querySelectorAll<HTMLButtonElement>('.saved-project')
    const controller = new AbortController()
    const focus: RemovalFocus = { element, target: buttons[index + 1] ?? buttons[index - 1] ?? null, controller, lost: false, done: false }
    const options = { capture: true, signal: controller.signal }
    const cancel = () => controller.abort()
    element.addEventListener('blur', () => { if (element.matches(':disabled')) focus.lost = true; else cancel() }, { signal: controller.signal })
    document.addEventListener('focusin', event => { if (event.target !== element && event.target !== document.body) cancel() }, options)
    document.addEventListener('pointerdown', cancel, options)
    document.addEventListener('keydown', cancel, options)
    document.addEventListener('wheel', cancel, { ...options, passive: true })
    window.addEventListener('blur', cancel, { signal: controller.signal })
    removalFocus.current = focus
    return focus
  }

  function clearSearch() {
    setFilter('')
    searchInput.current?.focus()
  }

  async function removeProject() {
    if (!removal || busy || !setupEnabled) return
    const focus = rememberRemovalFocus()
    setBusy(true)
    setError('')
    try {
      const latest = await api<SettingsResponse>('/api/settings')
      const currentHost = latest.config.hosts.find(host => host.id === removal.host.id)
      const currentProject = currentHost?.roots.find(project => project.id === removal.project.id)
      if (currentHost && currentProject) {
        if (currentHost.target !== removal.host.target || (currentHost.kind ?? 'ssh') !== (removal.host.kind ?? 'ssh') || currentProject.path !== removal.project.path) {
          setRemoval({ kind: 'project', host: currentHost, project: currentProject })
          setError('This project changed since it was listed. Review its current location and confirm again.')
          return
        }
        await api<SettingsResponse>('/api/settings', { body: {
          revision: latest.revision,
          config: { ...latest.config, hosts: latest.config.hosts.map(host => host.id === currentHost.id
            ? { ...host, roots: host.roots.filter(project => project.id !== currentProject.id) } : host) },
        } })
      }
      if (focus) focus.done = true
      setRemoval(null)
      onRemoved(currentHost ?? removal.host, currentProject ?? removal.project)
    } catch (failure) {
      setError(failure instanceof APIError && failure.status === 409
        ? 'Settings changed elsewhere. The project was not removed. Confirm again to retry with the latest settings.'
        : errorMessage(failure))
    } finally {
      if (!focus?.done) {
        focus?.controller.abort()
        if (removalFocus.current === focus) removalFocus.current = null
      }
      setBusy(false)
    }
  }

  return (
    <div ref={chooser} className="project-chooser" onKeyDownCapture={event => { if (event.key === 'Enter' && event.repeat) event.preventDefault() }}>
      {(saved.length > 0 || !creating || !setupEnabled) && <div className="chooser-actions">
        {(!creating || !setupEnabled) && <p>{setupEnabled ? 'Open a saved project or add a folder from any machine.' : 'Open a project shared with you.'}</p>}
        {setupEnabled && (saved.length > 0 || !creating) && <button ref={newProject} className="button secondary" onClick={() => setCreating(!creating)}>
          {creating ? <FolderOpen size={16} /> : <Plus size={16} />}{creating ? 'Saved projects' : 'New project'}
        </button>}
      </div>}
      {creating && setupEnabled ? <ProjectSetup key={sourceKey} host={host} submitLabel="Add and open project"
        hosts={machines} sshDisabled={sshStatus.disabled} hostCreationEnabled={sshStatus.ready && !sshStatus.disabled}
        initialDraft={drafts[sourceKey]} onDraftChange={draft => setDrafts(current => ({ ...current, [sourceKey]: draft }))}
        onHostCreated={(created, draft) => {
          createdFocus.current = document.hasFocus() && (document.activeElement === document.body ||
            Boolean(document.activeElement?.closest('.ssh-host-form'))) ? created.id : null
          setCreatedHosts(current => [...current.filter(host => host.id !== created.id), created])
          setDrafts(current => {
            const next = { ...current, [JSON.stringify([created.id, created.kind ?? 'ssh', created.target])]: draft }
            delete next[sourceKey]
            return next
          })
          setMachine(created.id)
        }}
        onSaved={(savedHost, project, completion) => {
          setDrafts(current => {
            if (current[sourceKey] !== completion.draft) return current
            const next = { ...current }
            delete next[sourceKey]
            return next
          })
          onSaved(savedHost, project, completion.current)
        }} machineControl={
        <><div className="project-machine"><label htmlFor="new-project-machine">Machine</label><select id="new-project-machine" value={machine} onChange={event => setMachine(event.target.value)}>
          {machines.map(item => <option key={item.id} value={item.id}>{sourceLabel(item)}</option>)}
          <option value="" disabled={!sshStatus.ready || sshStatus.disabled}>New SSH host…</option>
        </select></div>
          {sshStatus.error && <p role="status">{sshStatus.error} <button type="button" className="text-button" onClick={() => setSSHAttempt(value => value + 1)}>Retry</button></p>}
          {!host && !sshStatus.ready && !sshStatus.error && <p role="status">Checking SSH availability…</p>}
        </>
      } /> : <>
        <div className="filter-input"><Search size={16} /><input ref={searchInput} aria-label="Search saved projects" placeholder="Find a project…" value={filter} onChange={event => setFilter(event.target.value)} />
          {filter && <button type="button" className="icon-button" aria-label="Clear search" title="Clear search" onClick={clearSearch}><X size={16} /></button>}
        </div>
        <div className="saved-projects">{filtered.map(({ host, project }) =>
          <div className="saved-project-card" key={`${host.id}/${project.id}`}>
            <button className="saved-project" onClick={() => onOpen(host, project)}>
              <FolderOpen size={23} /><span><strong>{project.label || project.id}</strong><span className="saved-project-host">{host.kind === 'local' ? <HardDrive size={14} /> : <Server size={14} />}{sourceLabel(host)}</span><code>{project.path}</code></span>
            </button>
            {setupEnabled && <button className="icon-button source-remove saved-project-remove" title="Remove project" aria-label={`Remove project ${project.label || project.id} on ${sourceLabel(host)}`} disabled={busy}
              onClick={() => { setError(''); setRemoval({ kind: 'project', host, project }) }}><Trash2 size={16} /></button>}
          </div>)}</div>
        {saved.length > 0 && !filtered.length && <p className="chooser-empty" role="status">No matching projects. <button type="button" className="text-button" onClick={clearSearch}>Clear search</button></p>}
        {!saved.length && <p className="chooser-empty">No projects are available. {setupEnabled ? <><button className="text-button" onClick={onSettings}>Open Settings</button> to manage sources.</> : 'Ask your admin for project access.'}</p>}
      </>}
      {removal && <RemoveDialog removal={removal} busy={busy} error={error} onClose={() => { setRemoval(null); setError('') }} onConfirm={() => void removeProject()} />}
    </div>
  )
}
