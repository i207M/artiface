import { ArrowRight, FolderOpen, LoaderCircle } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { api, errorMessage } from '../api'
import type { Host, Project } from '../types'
import FolderPicker from './FolderPicker'
import SSHHostForm from './SSHHostForm'

export interface ProjectSetupDraft {
  target: string
  path: string
  label: string
}

interface Props {
  host?: Host
  submitLabel?: string
  machineControl?: ReactNode
  initialDraft?: ProjectSetupDraft
  onDraftChange?: (draft: ProjectSetupDraft) => void
  hosts?: Host[]
  sshDisabled?: boolean
  hostCreationEnabled?: boolean
  onHostCreated?: (host: Host, draft: ProjectSetupDraft) => void
  onSaved: (host: Host, root: Project, completion: { current: boolean; draft: ProjectSetupDraft }) => void
  onCancel?: () => void
}

export default function ProjectSetup({ host: configuredHost, submitLabel = 'Add and open project', machineControl, initialDraft, onDraftChange, hosts, sshDisabled = false, hostCreationEnabled = true, onHostCreated, onSaved, onCancel }: Props) {
  const [createdHost, setCreatedHost] = useState<Host>()
  const host = configuredHost ?? createdHost
  const [draft, setDraft] = useState<ProjectSetupDraft>(initialDraft ?? { target: '', path: '', label: '' })
  const { target, path, label } = draft
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invalidPath, setInvalidPath] = useState(false)
  const [picking, setPicking] = useState(false)
  const pathInput = useRef<HTMLInputElement>(null)
  const revealPickedPath = useRef(false)
  const focusCreatedPath = useRef(false)
  const mounted = useRef(false)
  const machineLabel = host?.kind === 'local' && !host.label ? 'localhost' : host?.label || host?.id

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useLayoutEffect(() => {
    if (!host || !focusCreatedPath.current) return
    focusCreatedPath.current = false
    pathInput.current?.focus({ preventScroll: true })
  }, [host])

  useLayoutEffect(() => {
    if (picking || !revealPickedPath.current) return
    revealPickedPath.current = false
    const input = pathInput.current
    if (input) input.scrollLeft = input.scrollWidth
    // Closing the picker also reveals a selection whose path did not change.
  }, [path, picking])

  function updateDraft(patch: Partial<ProjectSetupDraft>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (patch.path?.startsWith('/')) setInvalidPath(false)
    onDraftChange?.(next)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !host || sshDisabled && host.kind !== 'local') return
    if (!path.startsWith('/')) {
      setInvalidPath(true)
      pathInput.current?.focus()
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api<{ host: Host; root: Project }>('/api/projects', {
        body: {
          host: host.id,
          target: host.target,
          kind: host?.kind || 'ssh',
          path: path.replace(/\/+$/, '') || '/',
          ...(label.trim() ? { label: label.trim() } : {}),
        },
      })
      onSaved(result.host, result.root, { current: mounted.current, draft })
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }

  function hostCreated(created: Host) {
    const next = { ...draft, target: created.target }
    focusCreatedPath.current = document.hasFocus() && (document.activeElement === document.body ||
      Boolean(document.activeElement?.closest('.ssh-host-form')))
    setCreatedHost(created)
    setDraft(next)
    onDraftChange?.(next)
    onHostCreated?.(created, next)
  }

  const sourceDisabled = sshDisabled && host?.kind !== 'local'
  return (
    <section className="project-setup" aria-labelledby="project-setup-title">
      <h2 id="project-setup-title">{machineControl ? 'Add a project' : host ? `Add a project on ${machineLabel}` : 'Add an SSH host'}</h2>
      {machineControl}
      {sourceDisabled && <p className="setup-source-note" role="status">SSH connectivity is disabled on this server. Local projects remain available.</p>}
      {host?.kind === 'local' && <p className="setup-source-note">Files on the computer running Artiface.</p>}
      {!host ? <SSHHostForm enabled={hostCreationEnabled && !sshDisabled} hosts={hosts} initialAlias={target}
        onAliasChange={target => updateDraft({ target })} onCreated={hostCreated} onCancel={onCancel} /> : <form className="project-setup-form" onSubmit={submit}>
        <label>{host.kind === 'local' ? 'Local folder' : 'Remote folder'}<span className="folder-input-row"><input ref={pathInput} name="path" value={path} onChange={event => updateDraft({ path: event.target.value })} placeholder="/absolute/path/to/artifacts" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={4096} required disabled={busy || sourceDisabled} aria-invalid={invalidPath || undefined} aria-describedby={invalidPath ? 'project-path-error folder-help' : 'folder-help'} /><button type="button" className="button secondary" onClick={() => setPicking(true)} disabled={busy || sourceDisabled}><FolderOpen size={16} /> Browse</button></span></label>
        {invalidPath && <p id="project-path-error" className="form-error project-path-error" role="alert">Enter an absolute folder path on the selected machine.</p>}
        <span className="field-help" id="folder-help">Only this folder and its subfolders will be available in this project.</span>
        <label>Project name <span className="optional-label">(optional)</span><input name="label" value={label} onChange={event => updateDraft({ label: event.target.value })} placeholder="Uses the folder name" autoComplete="off" maxLength={120} disabled={busy || sourceDisabled} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="setup-actions">
          {onCancel && <button type="button" className="button secondary" onClick={onCancel} disabled={busy}>Cancel</button>}
          <button className="button primary" type="submit" disabled={busy || sourceDisabled || !path}>{busy ? <><LoaderCircle className="spin" size={16} /> Saving…</> : <>{submitLabel} <ArrowRight size={16} /></>}</button>
        </div>
      </form>}
      {picking && host && !sourceDisabled && <FolderPicker host={host} target={host.target} kind={host.kind || 'ssh'} initialPath={path || undefined} onClose={() => setPicking(false)} onPick={folder => { revealPickedPath.current = true; updateDraft({ path: folder }); setPicking(false) }} />}
    </section>
  )
}
