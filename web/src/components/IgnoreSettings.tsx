import { Check, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, APIError, errorMessage, isAborted } from '../api'
import { usePreferences } from '../preferences'
import type { IgnoreResponse } from '../types'
import { useSettingsDrafts } from '../SettingsDrafts'

export default function IgnoreSettings({ onChanged }: {
  onChanged: () => void
}) {
  const [preferences, setPreferences] = usePreferences()
  const { ignore, setIgnore } = useSettingsDrafts()
  const [file, setFile] = useState<IgnoreResponse | null>(ignore.base)
  const { text: draft, conflict, saving } = ignore
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState('')
  const [feedback, setFeedback] = useState<{ error: string; validation: boolean } | null>(null)
  const [message, setMessage] = useState('')
  const dirty = draft !== (ignore.base?.content ?? '')
  const busy = loading || saving
  const discardOnLoad = useRef(false)

  useEffect(() => { if (ignore.base) setFile(ignore.base) }, [ignore.base])

  useEffect(() => {
    const controller = new AbortController()
    const discard = discardOnLoad.current
    discardOnLoad.current = false
    setLoading(true)
    setReadError('')
    setMessage('')
    void api<IgnoreResponse>('/api/ignore', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      setFile(result)
      setFeedback(null)
      setIgnore(previous => {
        if (previous.saving) return previous
        if (!discard && (previous.text !== (previous.base?.content ?? '') || previous.conflict)) {
          return { ...previous, conflict: previous.conflict || previous.base?.revision !== result.revision || previous.base?.path !== result.path }
        }
        return { base: result, text: result.content, conflict: false, saving: false }
      })
    }).catch(failure => {
      if (!isAborted(failure)) setReadError(`${errorMessage(failure)} Your draft has not been changed.`)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [attempt, setIgnore])

  function reloadRules() {
    if (busy || (dirty && !window.confirm('Discard your unsaved ignore rules and reload the latest file?'))) return
    discardOnLoad.current = true
    setLoading(true)
    setAttempt(value => value + 1)
  }

  async function save() {
    if (!file?.editable || !ignore.base || busy || conflict || !dirty) return
    setIgnore(previous => ({ ...previous, saving: true }))
    setFeedback(null)
    setMessage('')
    try {
      const result = await api<IgnoreResponse>('/api/ignore', { body: { content: draft, revision: ignore.base.revision } })
      setFile(result)
      setIgnore({ base: result, text: result.content, conflict: false, saving: true })
      setReadError('')
      setMessage('Ignore rules saved. Browse will use the updated rules.')
      onChanged()
    } catch (failure) {
      if (failure instanceof APIError && failure.status === 409) {
        setIgnore(previous => ({ ...previous, conflict: true }))
      } else {
        setFeedback({ error: `${errorMessage(failure)} Your draft is kept.`, validation: failure instanceof APIError && failure.status === 400 })
      }
    } finally {
      setIgnore(previous => ({ ...previous, saving: false }))
    }
  }
  const description = [feedback && 'ignore-feedback', readError && 'ignore-read-error', conflict && 'ignore-conflict'].filter(Boolean).join(' ') || undefined

  return <section className="settings-section ignore-settings" aria-labelledby="ignore-settings-title">
    <h2 id="ignore-settings-title">Ignored files</h2>
    <p>Hide matching files and folders in Browse across all projects and machines.
      Direct file previews are unaffected.</p>
    <label className="settings-check"><input type="checkbox" checked={preferences.showHidden} onChange={event => setPreferences({ showHidden: event.target.checked })} /> Show hidden files and folders</label>
    <p className="settings-help">Saved on this device. Ignore rules below still apply.</p>
    <details className="ignore-pattern-help">
      <summary>Pattern syntax</summary>
      <p>Enter one pattern per line.
        Blank lines and lines starting with <code>#</code> are ignored; surrounding whitespace is trimmed.
        Matching is case-sensitive.</p>
      <p>A name such as <code>node_modules/</code> matches at any depth.
        A trailing <code>/</code> matches folders and hides their contents.
        A leading <code>/</code> or a slash inside the pattern anchors it to each project root.</p>
      <p><code>*</code> and <code>?</code> match within one path component.
        Use <code>**</code> as a whole component to match zero or more directories, for example <code>**/cache/</code>.
        Negation (<code>!</code>), escaping, character classes, and inline comments are unsupported.</p>
    </details>
    {file?.path && <p className="ignore-file-path"><code>{file.path}</code></p>}
    {file && !file.editable && <p className="settings-help">Editing ignore rules is unavailable on this server.</p>}
    {loading && <div className="settings-loading" role="status"><LoaderCircle className="spin" size={18} /> Loading ignore rules…</div>}
    {file && <>
      <label className="sr-only" htmlFor="ignore-editor">Ignore rules</label>
      <textarea id="ignore-editor" className="config-editor ignore-editor" value={draft} spellCheck={false}
        autoCapitalize="none" autoCorrect="off" disabled={busy} readOnly={!file.editable}
        aria-invalid={feedback?.validation || undefined} aria-describedby={description}
        onChange={event => {
          const text = event.target.value
          setIgnore(previous => ({ ...previous, text }))
          setFeedback(current => current?.validation ? null : current)
          setMessage('')
        }} />
    </>}
    {dirty && <p className="settings-help" role="status">You have unsaved ignore rules.</p>}
    <div className="settings-editor-feedback">
      {readError && <div id="ignore-read-error" className="settings-error" role="alert">{readError}</div>}
      {feedback && <div id="ignore-feedback" className="settings-error" role="alert">{feedback.error}</div>}
      {conflict && <div id="ignore-conflict" className="settings-error" role="alert">The ignore file changed elsewhere. Your draft is kept. Copy any edits you need before reloading the latest file.</div>}
      {message && <div className="settings-message" role="status"><Check size={16} />{message}</div>}
    </div>
    <div className="settings-actions">
      <button className="button secondary" disabled={!dirty || busy} onClick={() => { setIgnore({ base: file, text: file?.content ?? '', conflict: false, saving: false }); setMessage(''); setFeedback(null) }}>Discard draft</button>
      <button className="button secondary" disabled={busy} onClick={reloadRules}><RefreshCw size={16} />Reload rules</button>
      <button className="button primary" disabled={!file?.editable || !dirty || busy || conflict} onClick={() => void save()}>{saving ? 'Saving…' : 'Save ignore rules'}</button>
    </div>
  </section>
}
