import { AlertCircle, Braces, Check, File, FileCode2, FileDiff, FileImage, FileSymlink, FileText, Folder, FolderSymlink, Globe, LoaderCircle, NotebookPen, RefreshCw, Share2, Table2, Unlink2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Entry, FileLocation } from '../types'
import { isBinaryFile, readerType } from './fileTypes'
import brandMark from '../../public/favicon.svg?no-inline'

export function Brand({ large = false, onHome }: { large?: boolean; onHome?: () => void }) {
  return (
    <a className={`brand ${large ? 'brand-large' : ''}`} href="/#kind=overview" aria-label="Artiface home" title="Artiface home" onClick={event => { if (onHome && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onHome() } }}>
      <img className="brand-mark" src={brandMark} width={40} height={40} alt="" aria-hidden="true" />
      <span>artiface<span className="brand-dot">.</span></span>
    </a>
  )
}

export type FileKind = 'pdf' | 'markdown' | 'html' | 'tex' | 'image' | 'table' | 'code' | 'unsupported'

export function fileKind(path: string): FileKind {
  if (isBinaryFile(path)) return 'unsupported'
  if (/\.(csv|tsv)$/i.test(path)) return 'table'
  const type = readerType(path)
  if (type === 'pdf' || type === 'markdown' || type === 'html' || type === 'image') return type
  if (type === 'latex') return 'tex'
  return 'code'
}

export function EntryIcon({ entry, className = '' }: { entry: Pick<Entry, 'type' | 'path' | 'symlink' | 'resolvedPath'>; className?: string }) {
  if (entry.type === 'symlink') return <Unlink2 className={`file-icon ${className}`} size={18} />
  if (entry.type === 'directory') {
    const Icon = entry.symlink ? FolderSymlink : Folder
    return <Icon className={`file-icon folder-icon ${className}`} size={18} />
  }
  const kind = fileKind(entry.resolvedPath ?? entry.path)
  const Icon = entry.symlink ? FileSymlink : { pdf: FileText, markdown: NotebookPen, html: Globe, tex: Braces, image: FileImage, table: Table2, code: FileCode2, unsupported: File }[kind]
  return <Icon className={`file-icon kind-${kind} ${className}`} size={18} />
}

export function ProjectFolderIcon({ expanded }: { expanded: boolean }) {
  if (!expanded) return <Folder size={18} />
  // A symmetric front and base keep the tree guide visually centered, too.
  return <svg className="project-folder-open" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M3 10V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2" />
    <path d="M3 10h18a1 1 0 0 1 1 1.2l-2 7.2a2 2 0 0 1-1.9 1.6H5.9A2 2 0 0 1 4 18.4l-2-7.2A1 1 0 0 1 3 10Z" />
  </svg>
}

export function FileTabIcon({ file }: { file: FileLocation }) {
  return file.view === 'diff' ? <FileDiff size={18} className="file-icon kind-code" /> : <EntryIcon entry={{ type: 'file', path: file.path }} />
}

export function Loading({ message = 'Loading…', compact = false }: { message?: string; compact?: boolean }) {
  return <div className={`loading-state ${compact ? 'compact' : ''}`} role="status"><LoaderCircle className="spin" size={compact ? 17 : 24} /><span>{message}</span></div>
}

export function ErrorState({ title = 'Unable to load', message, retry, children }: { title?: string; message: string; retry?: () => void; children?: ReactNode }) {
  return (
    <div className="error-state" role="alert">
      <div className="state-symbol error-symbol"><AlertCircle size={25} /></div>
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="state-actions">
        {retry && <button className="button secondary" onClick={retry}><RefreshCw size={15} /> Try again</button>}
        {children}
      </div>
    </div>
  )
}

export function ShareButton({ copied, onClick, compact = false }: { copied: boolean; onClick: () => void; compact?: boolean }) {
  const Icon = copied ? Check : Share2
  return <button className={`button ${copied ? 'copy-success' : 'secondary'} ${compact ? 'icon-button' : ''}`} onClick={onClick} title={copied ? 'Link copied' : 'Share link · copy a link that requires sign-in'} aria-label={compact ? 'Share link' : undefined}><Icon size={15} />{!compact && (copied ? 'Link copied' : 'Share link')}</button>
}
