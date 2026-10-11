import { useEffect, useState } from 'react'
import { adminPage, api, errorMessage, isAborted, setCSRFToken } from './api'
import { Brand, ErrorState, Loading } from './components/Common'
import Login from './components/Login'
import Workspace from './components/Workspace'
import { useLocation } from './location'
import type { SessionInfo } from './types'
import SettingsPage from './components/SettingsPage'
import { SettingsDraftProvider } from './SettingsDrafts'
import SSHHostKeyConfirmation from './components/SSHHostKeyConfirmation'

export default function App() {
  const [auth, setAuth] = useState<'checking' | 'login' | 'ready' | 'error'>('checking')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [session, setSession] = useState<SessionInfo>({ authenticated: false, mode: 'personal' })
  const [location, navigate] = useLocation()

  useEffect(() => {
    const controller = new AbortController()
    let failed = false
    const reconnect = () => {
      if (!failed) return
      failed = false
      setAttempt(value => value + 1)
    }
    window.addEventListener('online', reconnect)
    setAuth('checking')
    api<SessionInfo>('/api/session', { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return
        setCSRFToken(result.csrfToken)
        setSession(result)
        setAuth(result.authenticated ? 'ready' : 'login')
      })
      .catch((failure: unknown) => {
        if (isAborted(failure)) return
        failed = true
        setError(navigator.onLine ? errorMessage(failure) : 'You’re offline. Reconnect to your server to browse files; artifact contents are not stored offline.')
        setAuth('error')
      })
    return () => { controller.abort(); window.removeEventListener('online', reconnect) }
  }, [attempt])

  useEffect(() => {
    const expire = () => { setAuth('checking'); setAttempt(value => value + 1) }
    window.addEventListener('artiface:unauthorized', expire)
    return () => window.removeEventListener('artiface:unauthorized', expire)
  }, [])

  if (auth === 'login') return <Login mode={session.mode} onSuccess={result => { setSession(result); setAuth('ready') }} />
  if (auth === 'ready') return <SettingsDraftProvider key={JSON.stringify([adminPage, session.mode, session.role, session.userID, session.csrfToken, attempt])}>
    <SSHHostKeyConfirmation canManage={session.mode === 'personal' && session.role !== 'user' || session.role === 'admin'}
      passwordLabel={session.mode === 'personal' ? 'Workspace password' : 'Admin password'} />
    {adminPage ? <div className="standalone-settings"><SettingsPage admin onClose={() => { window.location.href = '/' }} onChanged={() => {}} /></div>
      : <Workspace userID={session.userID} canManage={session.role !== 'user'} location={location} navigate={navigate} onLogout={() => {
        setCSRFToken()
        if (session.role === 'user') navigate({ host: '', root: '', path: '', kind: 'overview' }, true)
        setAuth('login')
      }} />}
  </SettingsDraftProvider>
  return <div className="app-start"><Brand large />{auth === 'checking' ? <Loading message="Opening your workspace…" /> : <ErrorState title="Couldn’t reach your workspace" message={error} retry={() => setAttempt(attempt + 1)} />}</div>
}
