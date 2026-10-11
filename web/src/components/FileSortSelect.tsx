import type { FileSort } from './fileTypes'

export const fileSortChoices: { label: string; browseLabel: string; sort: FileSort }[] = [
  { label: 'Name · A–Z', browseLabel: 'Name A–Z', sort: { column: 'name', direction: 'asc' } },
  { label: 'Name · Z–A', browseLabel: 'Name Z–A', sort: { column: 'name', direction: 'desc' } },
  { label: 'Type · A–Z', browseLabel: 'Type A–Z', sort: { column: 'type', direction: 'asc' } },
  { label: 'Type · Z–A', browseLabel: 'Type Z–A', sort: { column: 'type', direction: 'desc' } },
  { label: 'Size · Smallest first', browseLabel: 'Smallest first', sort: { column: 'size', direction: 'asc' } },
  { label: 'Size · Largest first', browseLabel: 'Largest first', sort: { column: 'size', direction: 'desc' } },
  { label: 'Modified · Oldest first', browseLabel: 'Oldest first', sort: { column: 'modified', direction: 'asc' } },
  { label: 'Modified · Newest first', browseLabel: 'Newest first', sort: { column: 'modified', direction: 'desc' } },
]
export const fileSortValue = (sort: FileSort) => `${sort.column}:${sort.direction}`

export default function FileSortSelect({ id, label, sort, defaultSort, onChange }: {
  id?: string; label: string; sort: FileSort | null; defaultSort?: FileSort; onChange: (sort: FileSort | null) => void
}) {
  const defaultChoice = defaultSort && fileSortChoices.find(choice => fileSortValue(choice.sort) === fileSortValue(defaultSort))
  return <select id={id} aria-label={label} value={sort ? fileSortValue(sort) : 'default'} onChange={event => onChange(fileSortChoices.find(choice => fileSortValue(choice.sort) === event.target.value)?.sort ?? null)}>
    {defaultSort && <option value="default" aria-label={`Default: ${defaultChoice?.label}`}>Default: {defaultChoice?.browseLabel}</option>}
    {fileSortChoices.map(choice => <option key={fileSortValue(choice.sort)} value={fileSortValue(choice.sort)} aria-label={defaultSort ? choice.label : undefined}>{defaultSort ? choice.browseLabel : choice.label}</option>)}
  </select>
}
