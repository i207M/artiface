import { ArrowUpDown, Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fileSortChoices, fileSortValue } from './FileSortSelect'
import type { FileSort } from './fileTypes'

export default function FileSortButton({ sort, defaultSort, onChange }: {
  sort: FileSort | null; defaultSort: FileSort; onChange: (sort: FileSort | null) => void
}) {
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = sort ? fileSortValue(sort) : 'default'
  const defaultLabel = fileSortChoices.find(choice => fileSortValue(choice.sort) === fileSortValue(defaultSort))?.label
  const options = [{ label: `Default · ${defaultLabel}`, sort: null }, ...fileSortChoices]
  const currentLabel = options.find(choice => (choice.sort ? fileSortValue(choice.sort) : 'default') === selected)?.label
  useEffect(() => {
    if (!open) return
    const active = control.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
    active?.focus({ preventScroll: true })
    active?.scrollIntoView({ block: 'nearest' })
    const dismiss = (event: Event) => { if (!control.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return <div className="browse-sort-control" ref={control}>
    <button ref={trigger} className="icon-button" aria-label="Sort files" title={`Sort files · ${currentLabel}`} aria-expanded={open} aria-controls="browse-sort-panel" onClick={() => setOpen(!open)}><ArrowUpDown size={16} /></button>
    {open && <div className="browse-sort-panel" id="browse-sort-panel" role="group" aria-label="Sort order">
      {options.map(choice => {
        const value = choice.sort ? fileSortValue(choice.sort) : 'default'
        return <button key={value} aria-pressed={selected === value} onClick={() => {
          onChange(choice.sort)
          setOpen(false)
          trigger.current?.focus({ preventScroll: true })
        }}><Check size={16} aria-hidden="true" style={{ visibility: selected === value ? 'visible' : 'hidden' }} /><span>{choice.label}</span></button>
      })}
    </div>}
  </div>
}
