import { useEffect, useMemo, useRef, useState } from 'react'
import { api, apiURL, APIError, errorMessage, isAborted } from '../api'
import { parentPath } from '../location'
import type { Entry, Location } from '../types'

export interface GitChange { path: string; index: string; worktree: string; directory?: boolean }
export interface GitStatus {
  state: 'ready' | 'none' | 'paused' | 'busy' | 'unavailable'
  branch?: string
  changes?: GitChange[]
  message?: string
  checkedAt: string
  retryAt: string
}
export interface GitMark { code: string; label: string }
export function gitMark(change: GitChange): GitMark {
  const codes = change.index + change.worktree
  if (codes.includes('U') || codes === 'AA' || codes === 'DD') return { code: 'U', label: 'Merge conflict' }
  if (codes.includes('?')) return { code: '?', label: 'Untracked' }
  if (codes.includes('D')) return { code: 'D', label: 'Deleted' }
  if (codes.includes('A')) return { code: 'A', label: 'Added' }
  return { code: 'M', label: 'Modified' }
}

export function useGitStatus(location: Location, enabled: boolean, identity: string) {
  const url = apiURL('git/status', { ...location, path: '' })
  const key = JSON.stringify([url, identity])
  const [state, setState] = useState<{ key: string; data?: GitStatus; error?: string; checking?: boolean }>({ key: '' })
  const retry = useRef<() => void>(() => {})
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let busy = false
    let timer = 0
    let controller: AbortController | null = null
    let nextCheck = 0
    async function load(force = false) {
      if (stopped || busy || document.hidden) return
      clearTimeout(timer)
      busy = true
      controller = new AbortController()
      setState(previous => ({ ...(previous.key === key ? previous : { key }), checking: true }))
      let delay = 60_000
      try {
        const data = await api<GitStatus>(url + (force ? '&refresh=1' : ''), { signal: controller.signal })
        if (stopped) return
        setState({ key, data })
        delay = Math.max(30_000, Date.parse(data.retryAt) - Date.now() || 60_000)
      } catch (failure) {
        if (stopped || isAborted(failure)) return
        const denied = failure instanceof APIError && [401, 403, 404, 409].includes(failure.status)
        setState(previous => ({ ...(previous.key === key && !denied ? previous : { key }), checking: false, error: errorMessage(failure) }))
      } finally {
        busy = false
        if (!stopped) {
          nextCheck = Date.now() + delay
          timer = window.setTimeout(() => void load(), delay)
        }
      }
    }
    retry.current = () => void load(true)
    const wake = () => { if (!document.hidden && Date.now() >= nextCheck) void load() }
    document.addEventListener('visibilitychange', wake)
    void load()
    return () => {
      stopped = true
      controller?.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      retry.current = () => {}
    }
  }, [enabled, key, url])
  const current = enabled && state.key === key ? state : undefined
  const changes = current?.data?.changes
  const mark = useMemo(() => {
    const direct = new Map((changes ?? []).map(change => [change.path, change]))
    const folders = new Set<string>()
    for (const change of changes ?? []) {
      for (let parent = parentPath(change.path); parent; parent = parentPath(parent)) folders.add(parent)
    }
    return (entry: Entry): GitMark | undefined => {
      const change = direct.get(entry.path)
      if (change) return gitMark(change)
      if (entry.type === 'directory' && folders.has(entry.path)) return { code: 'M', label: 'Contains changes' }
      for (let parent = parentPath(entry.path); parent; parent = parentPath(parent)) {
        if (direct.get(parent)?.directory) return { code: '?', label: 'Untracked' }
      }
    }
  }, [changes])
  return { data: current?.data, error: current?.error, checking: current?.checking, mark, retry: () => retry.current() }
}
