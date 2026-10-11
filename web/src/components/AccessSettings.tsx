import { Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { api, APIError, errorMessage, isAborted } from '../api'
import type { Host, SessionInfo } from '../types'

interface ProjectRef { host: string; root: string }
interface TeamUser { id: string; username: string; disabled: boolean; projects: ProjectRef[] }
interface PendingUser extends TeamUser { revision: string }
interface Access { mode: SessionInfo['mode']; users: TeamUser[]; revision: string }
type UserField = 'username' | 'password'
interface SaveFocus { element: HTMLElement; target: HTMLButtonElement | null; controller: AbortController; lost: boolean; done: boolean; field?: UserField }
const blankUser: TeamUser = { id: '', username: '', disabled: false, projects: [] }

export default function AccessSettings({ hosts, enabled }: { hosts: Host[]; enabled: boolean }) {
  const [access, setAccess] = useState<Access | null>(null)
  const [editing, setEditing] = useState<PendingUser | null>(null)
  const [password, setPassword] = useState('')
  const [removing, setRemoving] = useState<PendingUser | null>(null)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState<{ field: UserField; message: string } | null>(null)
  const [message, setMessage] = useState('')
  const [anchor, setAnchor] = useState<{ id: string; index: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const addUser = useRef<HTMLButtonElement>(null)
  const usersHeading = useRef<HTMLHeadingElement>(null)
  const messageElement = useRef<HTMLParagraphElement>(null)
  const fields = { username: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) }
  const read = useRef<AbortController | null>(null)
  const writing = useRef(false)
  const saveFocus = useRef<SaveFocus | null>(null)
  const discardOnLoad = useRef(false)
  const busy = saving || reloading
  const pending = editing ?? removing
  const conflicting = Boolean(pending && (conflict || pending.revision !== access?.revision))
  const problem = error || (conflicting ? 'Access settings changed elsewhere. Reload and discard the pending edit or deletion before continuing.' : '')
  const projects = hosts.flatMap(host => host.roots.map(project => ({ host, project })))
  const projectNames = new Map<string, number>()
  const projectLocations = new Map<string, number>()
  for (const { host, project } of projects) {
    const name = JSON.stringify([host.label || host.id, project.label || project.id])
    projectNames.set(name, (projectNames.get(name) ?? 0) + 1)
    const location = JSON.stringify([name, project.path])
    projectLocations.set(location, (projectLocations.get(location) ?? 0) + 1)
  }
  const users: { id: string; user: TeamUser | null }[] = (access?.users ?? []).map(user => ({ id: user.id, user }))
  // Keep pending edits and their feedback in place if a refresh or deletion removes the account.
  if (anchor?.id && !users.some(item => item.id === anchor.id) && (pending || problem || message)) {
    users.splice(anchor.index, 0, { id: anchor.id, user: null })
  }

  useEffect(() => () => saveFocus.current?.controller.abort(), [])
  useLayoutEffect(() => {
    const focus = saveFocus.current
    if (!focus || !focus.done || busy || removing || (editing && !focus.field)) return
    saveFocus.current = null
    const restore = !focus.controller.signal.aborted && document.hasFocus()
      && ((document.activeElement === document.body && (focus.lost || !focus.element.isConnected))
        || (focus.field && document.activeElement === focus.element))
    focus.controller.abort()
    if (restore) {
      if (focus.field) {
        const input = fields[focus.field].current
        if (!enabled || !input || input.disabled) return
        input.focus({ preventScroll: true })
        const bounds = input.getBoundingClientRect()
        const header = input.closest('.settings-page')?.querySelector('.settings-header')?.getBoundingClientRect()
        if (bounds.top < (header?.bottom ?? 0) || bounds.bottom > window.innerHeight) input.scrollIntoView({ block: 'center' })
      } else {
        const target = (!focus.target?.isConnected ? messageElement.current : null)
          ?? [focus.target, addUser.current].find(button => button?.isConnected && !button.disabled) ?? usersHeading.current
        target?.focus()
      }
    }
  }, [busy, editing, removing, enabled, fieldError])

  useEffect(() => {
    if (writing.current) return
    const controller = new AbortController()
    read.current = controller
    const discard = discardOnLoad.current
    const current = () => !controller.signal.aborted && read.current === controller
    void api<Access>('/api/access', { signal: controller.signal }).then(value => {
      if (!current()) return
      setAccess(value)
      setError('')
      if (discard) {
        setEditing(null)
        setRemoving(null)
        setPassword('')
        setFieldError(null)
        setConflict(false)
        setMessage('Access settings reloaded.')
      }
    }).catch(failure => {
      if (current() && !isAborted(failure)) setError(`${errorMessage(failure)}${discard ? ' Your pending edit or deletion is kept.' : ''}`)
    }).finally(() => {
      if (!current()) return
      read.current = null
      discardOnLoad.current = false
      setReloading(false)
    })
    return () => controller.abort()
  }, [attempt, hosts])

  function reload() {
    if (busy || writing.current) return
    read.current?.abort()
    read.current = null
    discardOnLoad.current = true
    setReloading(true)
    setAttempt(value => value + 1)
  }

  async function save(change: object, revision: string, success: string) {
    if (!access || busy || writing.current || conflicting || !enabled) return false
    writing.current = true
    setSaving(true)
    // A GET started before this mutation must not replace its result.
    read.current?.abort()
    read.current = null
    setError('')
    setFieldError(null)
    setMessage('')
    try {
      const result = await api<Access>('/api/access', { body: { ...change, revision } })
      setAccess(result)
      setConflict(false)
      setMessage(success)
      return true
    } catch (failure) {
      if (failure instanceof APIError && failure.status === 409) setConflict(true)
      const message = errorMessage(failure)
      const field = editing && failure instanceof APIError && failure.status === 400
        ? message === 'password must contain at least 6 characters and at most 1024 bytes of valid UTF-8' || message === 'A password is required for a new user' ? 'password'
          : message === 'usernames must be unique lowercase identifiers using letters, numbers, underscores or hyphens' ? 'username' : undefined
        : undefined
      if (field) {
        setFieldError({ field, message })
        if (saveFocus.current) {
          saveFocus.current.field = field
          saveFocus.current.done = true
        }
      } else setError(message)
      return false
    } finally { writing.current = false; setSaving(false) }
  }

  async function saveUser(event: FormEvent) {
    event.preventDefault()
    if (!editing || busy || writing.current) return
    const focus = rememberSaveFocus(event.currentTarget)
    const { revision, ...user } = editing
    if (await save({ user: { ...user, ...(password ? { password } : {}) } }, revision, 'User saved. Project access applies immediately.')) {
      if (focus) focus.done = true
      setEditing(null)
      setPassword('')
    } else if (!focus?.field) {
      focus?.controller.abort()
      if (saveFocus.current === focus) saveFocus.current = null
    }
  }

  function rememberSaveFocus(form: EventTarget & Element) {
    saveFocus.current?.controller.abort()
    saveFocus.current = null
    const element = document.activeElement
    if (!(element instanceof HTMLElement) || !form.contains(element)) return null
    const controller = new AbortController()
    const focus: SaveFocus = { element, target: trigger.current, controller, lost: false, done: false }
    const options = { capture: true, signal: controller.signal }
    const cancel = () => controller.abort()
    element.addEventListener('blur', () => { if (element.matches(':disabled')) focus.lost = true; else cancel() }, { signal: controller.signal })
    document.addEventListener('focusin', event => { if (event.target !== element && event.target !== document.body) cancel() }, options)
    document.addEventListener('pointerdown', cancel, options)
    document.addEventListener('keydown', cancel, options)
    document.addEventListener('wheel', cancel, { ...options, passive: true })
    window.addEventListener('blur', cancel, { signal: controller.signal })
    saveFocus.current = focus
    return focus
  }

  function edit(user: TeamUser, button: HTMLButtonElement) {
    if (!access || busy || writing.current || !enabled) return
    trigger.current = button
    setAnchor({ id: user.id, index: access.users.findIndex(item => item.id === user.id) })
    setEditing({ ...user, projects: [...(user.projects ?? [])], revision: access.revision })
    setPassword('')
    setRemoving(null)
    setConflict(false)
    setError('')
    setFieldError(null)
    setMessage('')
  }

  function remove(user: TeamUser, button: HTMLButtonElement) {
    if (!access || busy || writing.current || !enabled) return
    trigger.current = button
    setAnchor({ id: user.id, index: access.users.findIndex(item => item.id === user.id) })
    setRemoving({ ...user, revision: access.revision })
    setEditing(null)
    setPassword('')
    setConflict(false)
    setError('')
    setFieldError(null)
    setMessage('')
  }

  function cancel() {
    if (busy || writing.current) return
    setEditing(null)
    setRemoving(null)
    setPassword('')
    setConflict(false)
    setError('')
    setFieldError(null)
    const target = [trigger.current, addUser.current].find(button => button?.isConnected && !button.disabled) ?? usersHeading.current
    target?.focus()
  }

  function cancelOnEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  function clearFieldError(field: UserField) {
    setFieldError(previous => previous?.field === field ? null : previous)
  }

  function fieldFeedback(field: UserField) {
    return fieldError?.field === field
      ? <p id={`team-${field}-error`} className="form-error team-field-error" role="alert">{fieldError.message}</p>
      : null
  }

  const feedback = problem && <p className="form-error team-user-error" role="alert">{problem} <button type="button" className="text-button" disabled={busy} onClick={reload}><RefreshCw size={14} /> {editing ? 'Reload and discard edits' : removing ? 'Reload and cancel deletion' : 'Reload access settings'}</button></p>
  const activePanel = <>
      {removing && <div className="team-user-editor" role="group" aria-label="Confirm user deletion" onKeyDown={cancelOnEscape}><p>Delete <strong>{removing.username}</strong>? Their sessions and project access will end immediately.</p>
        {feedback}
        <div className="settings-actions"><button className="button secondary" autoFocus disabled={busy} onClick={cancel}>Cancel</button><button className="button remove-confirm" disabled={busy || conflicting || !enabled} onClick={async event => {
          const focus = rememberSaveFocus(event.currentTarget)
          if (await save({ deleteUser: removing.id }, removing.revision, 'User deleted.')) {
            if (focus) focus.done = true
            setRemoving(null)
          } else {
            focus?.controller.abort()
            if (saveFocus.current === focus) saveFocus.current = null
          }
        }}>Delete user</button></div></div>}
      {editing && <form className="team-user-editor" onSubmit={saveUser} onKeyDown={cancelOnEscape}>
        <div className="settings-section-heading"><h3>{editing.id ? `Edit ${editing.username}` : 'New user'}</h3><button type="button" className="icon-button" title="Cancel editing user" aria-label="Cancel editing user" disabled={busy} onClick={cancel}><X size={16} /></button></div>
        <div className="team-user-fields"><div><label htmlFor="team-username">Username</label><input ref={fields.username} id="team-username" value={editing.username} onChange={event => { setEditing({ ...editing, username: event.target.value }); clearFieldError('username') }} autoFocus autoCapitalize="none" autoComplete="off" spellCheck={false} pattern="[a-zA-Z0-9]([a-zA-Z0-9_]|-){0,63}" title="Letters, numbers, underscores and hyphens; stored in lowercase" required disabled={busy} aria-invalid={fieldError?.field === 'username' || undefined} aria-describedby={fieldError?.field === 'username' ? 'team-username-error' : undefined} />{fieldFeedback('username')}</div>
          <div><label htmlFor="team-password">{editing.id ? 'Reset password' : 'Password'}</label><input ref={fields.password} id="team-password" type="password" value={password} onChange={event => { setPassword(event.target.value); clearFieldError('password') }} autoComplete="new-password" placeholder={editing.id ? 'Leave blank to keep password' : 'At least 6 characters'} required={!editing.id} disabled={busy} aria-invalid={fieldError?.field === 'password' || undefined} aria-describedby={fieldError?.field === 'password' ? 'team-password-error' : undefined} />{fieldFeedback('password')}</div></div>
        <label className="settings-check"><input type="checkbox" checked={editing.disabled} disabled={busy} onChange={event => setEditing({ ...editing, disabled: event.target.checked })} />Disable account</label>
        <fieldset className="team-project-grants"><legend>Project access</legend>
          {!projects.length && <p>Add projects in Sources, then assign access here.</p>}
          {projects.map(({ host, project }) => {
            const selected = editing.projects.some(ref => ref.host === host.id && ref.root === project.id)
            const name = JSON.stringify([host.label || host.id, project.label || project.id])
            const ambiguous = (projectNames.get(name) ?? 0) > 1
            const samePath = (projectLocations.get(JSON.stringify([name, project.path])) ?? 0) > 1
            return <label className="team-project-grant" key={`${host.id}/${project.id}`}><input type="checkbox" checked={selected} disabled={busy} onChange={event => setEditing({ ...editing, projects: event.target.checked
              ? [...editing.projects, { host: host.id, root: project.id }]
              : editing.projects.filter(ref => ref.host !== host.id || ref.root !== project.id) })} />
              <span><strong>{project.label || project.id}</strong><small>{host.label || host.id}{host.hidden || project.hidden ? ' · Hidden' : ''}</small>
                {ambiguous && <code className="team-project-path">{samePath ? `${host.target || host.id}:${project.path}` : project.path}</code>}</span></label>
          })}
        </fieldset>
        {feedback}
        <button className="button primary" type="submit" disabled={busy || conflicting || !enabled}>{saving ? 'Saving…' : 'Save user'}</button>
      </form>}
      {!pending && feedback}
      {message && <p ref={messageElement} className="settings-message team-user-message" role="status" tabIndex={-1}>{message}</p>}
    </>

  return <>
    <section className="settings-section">
      <h2>Application mode</h2>
      {access && <p>Current mode: <strong>{access.mode === 'team' ? 'Team' : 'Personal'}</strong>. Mode is chosen when the server starts.</p>}
      <details><summary>Startup options</summary><p>Personal uses one password and is the default. Start with <code>--mode team</code> or <code>ARTIFACE_MODE=team</code> for individual logins and assigned projects.</p></details>
    </section>
    <section className="settings-section">
      <div className="settings-section-heading"><div><h2 ref={usersHeading} tabIndex={-1}>Users & project access</h2><p>In Team mode, users can open only their assigned projects.</p></div>
        <button ref={addUser} className="button secondary" disabled={!access || !enabled || busy} onClick={event => edit(blankUser, event.currentTarget)}><Plus size={16} />Add user</button>
      </div>
      {!access ? <p>Loading users…</p> : !access.users.length && !editing ? <p>No users yet.{access.mode === 'personal' && ' You can create accounts before enabling Team mode.'}</p> : null}
      {!anchor?.id && activePanel}
      <div className="team-users">{users.map(({ id, user }) => <div className="team-user-item" key={id}>
        {user && <div className="team-user-row">
          <div><strong>{user.username}</strong><small>{user.disabled ? 'Disabled' : 'Active'} · {(user.projects ?? []).length} {(user.projects ?? []).length === 1 ? 'project' : 'projects'}</small></div>
          <div className="settings-actions"><button className="icon-button" title={`Edit ${user.username}`} aria-label={`Edit ${user.username}`} disabled={busy || !enabled} onClick={event => edit(user, event.currentTarget)}><Pencil size={16} /></button>
            <button className="icon-button" title={`Delete ${user.username}`} aria-label={`Delete ${user.username}`} disabled={busy || !enabled} onClick={event => remove(user, event.currentTarget)}><Trash2 size={16} /></button></div>
        </div>}
        {anchor?.id === id && activePanel}
      </div>)}</div>
    </section>
  </>
}
