import { fileTypeGroups, readerTypeDescriptions, readerTypeLabels } from './fileTypes'
import type { ReaderType } from './fileTypes'

export default function FileTypeOptions({ selected, onChange }: { selected: ReaderType[]; onChange: (types: ReaderType[]) => void }) {
  const renderGroup = (group: typeof fileTypeGroups[number]) => <div key={group.id} role="group" aria-label={group.label} className={`file-type-group ${group.types.length === 1 ? 'single-type-group' : ''}`}>
    {group.types.length > 1 && <div className="file-type-heading">{group.label}</div>}
    {group.types.map(type => <label className="file-type-option" key={type} title={readerTypeDescriptions[type]}>
      <input type="checkbox" checked={selected.includes(type)} onChange={event => onChange(
        event.target.checked ? [...selected, type] : selected.filter(item => item !== type),
      )} /><span>{readerTypeLabels[type]}</span>
    </label>)}
  </div>
  return <div className="file-type-options">
    {fileTypeGroups.filter(group => group.types.length > 1).map(renderGroup)}
    <div className="file-type-singles">{fileTypeGroups.filter(group => group.types.length === 1).map(renderGroup)}</div>
  </div>
}
