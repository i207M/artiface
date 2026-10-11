import { useId } from 'react'
import { usePreferences } from '../preferences'
import FileSortSelect from './FileSortSelect'

export default function BrowsePreferences({ appearance = false }: { appearance?: boolean }) {
  const [preferences, setPreferences] = usePreferences()
  const sortId = useId()
  const sortSelect = <FileSortSelect id={appearance ? sortId : undefined} label="Default sort order" sort={preferences.defaultBrowseSort} onChange={sort => {
    if (sort) setPreferences({ defaultBrowseSort: sort, browseSort: null })
  }} />
  const resetOrder = <button className={appearance ? 'button secondary' : 'text-button'} title="Apply your saved default sort order" disabled={preferences.browseSort === null} onClick={() => setPreferences({ browseSort: null })}>Use default order</button>
  return <>
    {appearance ? <div className="preference-row browse-default-sort">
      <label htmlFor={sortId}>Default sort order</label>
      <div className="appearance-sort-controls">{sortSelect}{resetOrder}</div>
    </div> : <>
      <label className="browse-default-sort"><span>Default sort order</span>{sortSelect}</label>
      {resetOrder}
    </>}
    <p className={appearance ? 'settings-help' : 'browse-sort-help'}>Changing the default applies it now. Column clicks override it until you choose the default again.</p>
    <label className="settings-check"><input type="checkbox" checked={preferences.flatBrowse} onChange={event => setPreferences({ flatBrowse: event.target.checked })} /><span>Show files from all subfolders</span></label>
    <p className={appearance ? 'settings-help' : undefined}>One flat view, starting in the current folder. Ignore rules and file type filters still apply.</p>
    <label className="settings-check"><input type="checkbox" checked={preferences.showHidden} onChange={event => setPreferences({ showHidden: event.target.checked })} /><span>Show dotfiles and hidden folders</span></label>
  </>
}
