import { useEffect, useState } from 'react'
import { api, apiURL, errorMessage, isAborted } from '../api'
import type { Entry, FileLocation } from '../types'
import { tabKey } from './workspaceTabs'

export interface OverviewMetadata {
  modified?: string
  error?: string
}

// Overview reads metadata only, with at most two SSH requests in flight.
export function useOverviewMetadata(files: FileLocation[], active: boolean, seconds: number) {
  const [metadata, setMetadata] = useState<Record<string, OverviewMetadata>>({})
  // A file and its diff share one metadata request for the physical file.
  const locations = JSON.stringify([...new Map(files.filter(file => file.view !== 'history').map(({ host, root, path }) => {
    const file = { host, root, path }
    return [tabKey(file), file]
  })).values()])
  useEffect(() => {
    if (!active) return
    const files: FileLocation[] = JSON.parse(locations)
    const keys = new Set(files.map(tabKey))
    setMetadata(current => Object.fromEntries(Object.entries(current).filter(([key]) => keys.has(key))))
    let stopped = false
    let busy = false
    let timer = 0
    let cursor = 0
    let controller: AbortController | null = null
    const load = async () => {
      if (stopped || busy || document.hidden || !files.length) return
      busy = true
      const batch = new AbortController()
      controller = batch
      let index = 0
      const worker = async () => {
        while (!stopped && !batch.signal.aborted && index < files.length) {
          const file = files[(cursor + index++) % files.length]
          try {
            const entry = await api<Entry>(apiURL('file-info', file), { signal: batch.signal })
            if (!stopped && !batch.signal.aborted) setMetadata(current => ({ ...current, [tabKey(file)]: { modified: entry.modified } }))
          } catch (failure) {
            if (!stopped && !batch.signal.aborted && !isAborted(failure)) {
              setMetadata(current => ({ ...current, [tabKey(file)]: { ...current[tabKey(file)], error: errorMessage(failure) } }))
              // Fetch can become unavailable before pagehide during navigation.
              if (failure instanceof TypeError) break
            }
          }
        }
      }
      await Promise.all([worker(), worker()])
      // Resume after attempted rows so blocked URLs cannot starve later files.
      cursor = (cursor + index) % files.length
      busy = false
      if (!stopped && !document.hidden) timer = window.setTimeout(() => void load(), seconds * 1000)
    }
    const visible = () => {
      clearTimeout(timer)
      if (document.hidden) controller?.abort()
      else void load()
    }
    void load()
    document.addEventListener('visibilitychange', visible)
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible) }
  }, [locations, active, seconds])
  return metadata
}
