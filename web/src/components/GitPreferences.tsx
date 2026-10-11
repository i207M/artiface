import { usePreferences } from '../preferences'
import { projectKey } from './workspaceTabs'

export function ProjectGitPreference({ project, name }: { project: { host: string; root: string }; name: string }) {
  const [preferences, setPreferences] = usePreferences()
  const key = projectKey(project)
  return <label className="settings-check" title={preferences.gitStatus ? 'Show Git status for this project on this device' : 'Enable Git status in Appearance to use project overrides'}><input type="checkbox" aria-label={`Git status for ${name}`} disabled={!preferences.gitStatus} checked={!preferences.disabledGitProjects.includes(key)} onChange={event => {
    const others = preferences.disabledGitProjects.filter(item => item !== key)
    setPreferences({ disabledGitProjects: event.target.checked ? others : [...others, key] })
  }} />Git status</label>
}

export default function GitPreferences() {
  const [preferences, setPreferences] = usePreferences()
  return <div className="git-preferences">
    <label className="settings-check"><input type="checkbox" checked={preferences.gitStatus} onChange={event => setPreferences({ gitStatus: event.target.checked })} />Show Git status in Browse</label>
    <p className="settings-help">Git status checks pause for 10 minutes if they take too long or return too much data. Diffs load only when opened. These display choices apply on this device.</p>
  </div>
}
