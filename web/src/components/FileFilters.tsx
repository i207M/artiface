import { ListFilter } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { setFolderReaderTypes, usePreferences } from '../preferences'
import { allReaderTypes } from './fileTypes'
import FileTypeOptions from './FileTypeOptions'
import { useAnchoredPopover } from './useAnchoredPopover'

export default function FileFilters({ folder }: { folder: string }) {
  const [preferences] = usePreferences()
  const [open, setOpen] = useState(false)
  const customTypes = preferences.folderReaderTypes[folder]
  const selected = customTypes ?? preferences.defaultReaderTypes
  const filtered = selected.length < allReaderTypes.length
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useAnchoredPopover(open, trigger)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event) => { if (!panel.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss); document.removeEventListener('keydown', escape) }
  }, [open])
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  return <div className="file-filter-control" ref={panel}>
    <button ref={trigger} className={`button secondary ${filtered ? 'is-active' : ''}`} aria-label="File type filters" title="File type filters" aria-expanded={open} aria-controls="file-filter-panel" onClick={() => setOpen(!open)}><ListFilter size={16} /><span>Types{filtered ? ` · ${selected.length}` : ''}</span></button>
    {open && <div ref={popup} className="file-filter-panel" id="file-filter-panel" tabIndex={-1}>
      <p>{customTypes === undefined ? 'Using your default file types.' : 'Custom file types for this folder.'} {preferences.flatBrowse ? 'Applies to this folder and its subfolders.' : 'Folders remain visible.'}</p>
      <FileTypeOptions selected={selected} onChange={types => setFolderReaderTypes(folder, types)} />
      <div className="file-filter-actions">
        <button className="text-button" title="Use the default file types from Appearance" disabled={customTypes === undefined} onClick={() => { setFolderReaderTypes(folder, null); close() }}>Use defaults</button>
        <button className="text-button" onClick={() => { setFolderReaderTypes(folder, allReaderTypes); close() }}>Show all types</button>
      </div>
    </div>}
  </div>
}
