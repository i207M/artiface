import { ArrowDownToLine, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiURL } from '../api'
import { fileName, resolveLocalPath, safeExternalURL } from '../location'
import type { Location } from '../types'
import { isBinaryFile, readerType } from './fileTypes'

type Confirmation = { kind: 'external' | 'download' | 'blocked'; url: string; name: string }
type LinkTarget = { external: string } | { path: string; directory: boolean }
export const reportLinkKind = (target: { path: string; directory: boolean }) => target.directory ? 'directory'
  : readerType(target.path) === 'other' && !/\.(csv|tsv)$/i.test(target.path) ? 'auto' : 'file'

export function reportLink(path: string, href: string, projectRoot?: string): LinkTarget | null {
  href = href.trim()
  if (/[\u0000-\u001f\u007f\\]/.test(href)) return null
  if (href.startsWith('#') || href.startsWith('?')) return { path, directory: false }
  const pathname = href.split(/[?#]/)[0]
  const directory = pathname.endsWith('/') || /(^|\/)\.{1,2}$/.test(pathname)
  if (href.startsWith('//')) href = `${window.location.protocol}${href}`
  const external = safeExternalURL(href)
  if (external) return { external }
  if (href.startsWith('file://')) {
    try {
      const url = new URL(href)
      if (url.hostname && url.hostname !== 'localhost') return null
      href = url.pathname + url.search + url.hash
      const root = projectRoot?.replace(/\/+$/, '')
      const decoded = decodeURIComponent(url.pathname)
      if (root === undefined || (decoded !== root && !decoded.startsWith(`${root}/`))) return null
    } catch { return null }
  }
  if (href.startsWith('/')) {
    try {
      const root = projectRoot?.replace(/\/+$/, '')
      const decoded = decodeURIComponent(href.split(/[?#]/)[0])
      if (decoded === '/' || (root !== undefined && (decoded === root || decoded === `${root}/`))) {
        return { path: '', directory: true }
      }
      const relative = root && decoded.startsWith(`${root}/`) ? decoded.slice(root.length + 1) : decoded.slice(1)
      const resolved = resolveLocalPath('', relative.split('/').map(encodeURIComponent).join('/'))
      return resolved === null ? null : { path: resolved, directory: directory || resolved === '' }
    } catch { return null }
  }
  const resolved = resolveLocalPath(path, href)
  return resolved === null ? null : { path: resolved, directory: directory || resolved === '' }
}

export function useReportLinks(location: Location, onNavigate: (location: Location, keyboard?: boolean) => void, projectRoot?: string, active = true) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  useEffect(() => { if (!active) setConfirmation(null) }, [active])
  const open = useCallback((href: string, download = false, keyboard = false, basePath = location.path) => {
    if (!active) return
    const target = reportLink(basePath, href, projectRoot)
    if (!target) { setConfirmation({ kind: 'blocked', url: '', name: 'This link is outside the project or uses an unsupported address.' }); return }
    if ('external' in target) {
      setConfirmation({ kind: 'external', url: target.external, name: new URL(target.external).host })
    } else if (download || (!target.directory && isBinaryFile(target.path))) {
      setConfirmation({ kind: 'download', url: apiURL('file', { ...location, path: target.path }, true), name: fileName(target.path) })
    } else {
      onNavigate({ ...location, path: target.path, kind: reportLinkKind(target) }, keyboard)
    }
  }, [location.host, location.root, location.path, projectRoot, onNavigate, active])
  return { open, dialog: confirmation && active ? <LinkConfirmation value={confirmation} onClose={() => setConfirmation(null)} /> : null }
}

function LinkConfirmation({ value, onClose }: { value: Confirmation; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  // Safari needs the anchor to remain attached through its native default action.
  const follow = () => { window.setTimeout(onClose, 0) }
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.showModal()
    return () => {
      dialog.current?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return <dialog ref={dialog} className="report-link-dialog" aria-labelledby="report-link-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id="report-link-title">{value.kind === 'external' ? 'Open external website?' : value.kind === 'download' ? 'Download this file?' : 'Cannot open this link'}</h2>
    <p>{value.kind === 'external' ? 'This link will open in a new browser tab outside Artiface.' : value.kind === 'download' ? 'Save the original file to open it on your device.' : value.name}</p>
    {value.kind !== 'blocked' && <code>{value.kind === 'external' ? value.url : value.name}</code>}
    <div className="report-link-actions">
      <button className="button secondary" autoFocus onClick={onClose}>{value.kind === 'blocked' ? 'Close' : 'Cancel'}</button>
      {value.kind === 'external' && <a className="button primary" href={value.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={follow}><ExternalLink size={16} />Open website</a>}
      {value.kind === 'download' && <a className="button primary" href={value.url} download={value.name} onClick={follow}><ArrowDownToLine size={16} />Download</a>}
    </div>
  </dialog>
}
