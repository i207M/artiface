import { useCallback, useEffect, useRef, useState } from 'react'

export function useReaderFullscreen() {
  const element = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const previousFocus = useRef<HTMLElement | null>(null)
  const exit = useCallback(() => {
    setExpanded(false)
    if (element.current && document.fullscreenElement === element.current && document.exitFullscreen) void document.exitFullscreen().catch(() => {})
    const target = previousFocus.current
    previousFocus.current = null
    const leavingFocus = document.activeElement
    requestAnimationFrame(() => {
      // A native fullscreenchange can arrive after the user has moved focus.
      if (previousFocus.current || !target?.isConnected) return
      if (document.activeElement === leavingFocus || document.activeElement === document.body) target.focus()
    })
  }, [])
  const enter = useCallback(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setExpanded(true)
    // Mobile browsers without the API still get a viewport-filling reader.
    if (element.current?.requestFullscreen) void element.current.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  }, [])
  useEffect(() => {
    const changed = () => { if (!document.fullscreenElement) exit() }
    document.addEventListener('fullscreenchange', changed)
    const current = element.current
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      if (current && document.fullscreenElement === current && document.exitFullscreen) void document.exitFullscreen().catch(() => {})
    }
  }, [exit])
  useEffect(() => {
    if (!expanded) return
    const reader = element.current?.querySelector<HTMLElement>('.pdf-canvas-area,.source-scroll') ??
      element.current?.querySelector<HTMLElement>('.preview-content')
    reader?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) exit() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [expanded, exit])
  return { element, expanded, enter, exit }
}
