import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { usePreferences } from '../preferences'
import BrowsePreferences from './BrowsePreferences'
import { useAnchoredPopover } from './useAnchoredPopover'

export default function BrowseSettings({ onSettings }: { onSettings?: () => void }) {
  const [preferences] = usePreferences()
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useAnchoredPopover(open, trigger)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event) => { if (!panel.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div className="browse-settings-control" ref={panel}>
    <button ref={trigger} className={`icon-button ${preferences.flatBrowse ? 'is-active' : ''}`} aria-label="Browse settings" title="Browse settings" aria-expanded={open} aria-controls="browse-settings-panel" onClick={() => setOpen(!open)}><SlidersHorizontal size={16} /></button>
    {open && <div ref={popup} className="browse-settings-panel" id="browse-settings-panel" tabIndex={-1}>
      <strong>Browse settings</strong>
      <BrowsePreferences />
      {onSettings && <button className="text-button" title="Edit ignore rules in Settings" onClick={onSettings}>Ignored files in Settings</button>}
    </div>}
  </div>
}
