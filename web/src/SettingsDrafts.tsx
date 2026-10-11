import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { IgnoreResponse, SettingsResponse } from './types'

interface Draft<T> {
  base: T | null
  text: string
  conflict: boolean
  saving: boolean
}

interface SettingsDrafts {
  configuration: Draft<SettingsResponse>
  setConfiguration: Dispatch<SetStateAction<Draft<SettingsResponse>>>
  ignore: Draft<IgnoreResponse>
  setIgnore: Dispatch<SetStateAction<Draft<IgnoreResponse>>>
}

const Context = createContext<SettingsDrafts | null>(null)

export function configurationText(settings: SettingsResponse | null) {
  return settings ? JSON.stringify(settings.config, null, 2) : ''
}

export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  // Only these two editors survive navigation; password fields remain component-local.
  const [configuration, setConfiguration] = useState<Draft<SettingsResponse>>({ base: null, text: '', conflict: false, saving: false })
  const [ignore, setIgnore] = useState<Draft<IgnoreResponse>>({ base: null, text: '', conflict: false, saving: false })
  const baseText = useMemo(() => configurationText(configuration.base), [configuration.base])
  const dirty = configuration.text !== baseText || ignore.text !== (ignore.base?.content ?? '')

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  return <Context.Provider value={{ configuration, setConfiguration, ignore, setIgnore }}>{children}</Context.Provider>
}

export function useSettingsDrafts() {
  const drafts = useContext(Context)
  if (!drafts) throw new Error('Settings require an authenticated draft provider.')
  return drafts
}
