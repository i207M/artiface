import { useLayoutEffect, useRef } from 'react'
import { setPreferences } from '../preferences'

export default function SidebarResize({ width: preferredWidth, fontScale }: {
  width: number | null; fontScale: number
}) {
  const handle = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = handle.current
    const workspace = element?.closest<HTMLElement>('.workspace-shell')
    if (!element || !workspace) return
    const defaultWidth = Math.min(350, Math.max(250, 260 * fontScale))
    const minimum = 240
    let available = 0
    let maximum = minimum
    let width = defaultWidth
    let frame = 0
    let pointer: { id: number; x: number; width: number } | null = null
    let keyboardStart: number | null = null
    const clamp = (value: number) => Math.min(maximum, Math.max(minimum, Math.round(value)))
    const paint = (value: number) => {
      width = clamp(value)
      workspace.style.setProperty('--project-sidebar-width', `${width}px`)
      element.setAttribute('aria-valuenow', String(width))
      element.setAttribute('aria-valuetext', `${width} pixels`)
    }
    const stopFrame = () => { cancelAnimationFrame(frame); frame = 0 }
    const stopPointer = (save: boolean) => {
      if (!pointer) return
      const start = pointer
      pointer = null
      stopFrame()
      paint(save ? width : start.width)
      document.body.classList.remove('resizing-project-sidebar')
      workspace.classList.remove('is-resizing-sidebar')
      if (element.hasPointerCapture(start.id)) element.releasePointerCapture(start.id)
      if (save && width !== start.width) setPreferences({ sidebarWidth: width })
    }
    const stopKeyboard = (save: boolean) => {
      if (keyboardStart === null) return
      const start = keyboardStart
      keyboardStart = null
      if (!save) paint(start)
      if (save && width !== start) setPreferences({ sidebarWidth: width })
    }
    const measure = () => {
      if (workspace.clientWidth === available) return
      available = workspace.clientWidth
      // Keep a usable reader beside the sidebar, without overwriting the user's wider preference.
      maximum = Math.max(minimum, Math.min(520, Math.floor(available - 420)))
      stopPointer(false)
      stopKeyboard(false)
      element.setAttribute('aria-valuemin', String(minimum))
      element.setAttribute('aria-valuemax', String(maximum))
      paint(preferredWidth ?? defaultWidth)
    }
    const down = (event: PointerEvent) => {
      if (pointer || !event.isPrimary || event.button !== 0) return
      event.preventDefault()
      stopKeyboard(false)
      element.focus({ preventScroll: true })
      element.setPointerCapture(event.pointerId)
      pointer = { id: event.pointerId, x: event.clientX, width }
      workspace.classList.add('is-resizing-sidebar')
      document.body.classList.add('resizing-project-sidebar')
    }
    const move = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id) return
      width = clamp(pointer.width + event.clientX - pointer.x)
      // Only the grid variable and separator value change during a drag.
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(width) })
    }
    const up = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id) return
      width = clamp(pointer.width + event.clientX - pointer.x)
      stopPointer(true)
    }
    const cancel = (event: PointerEvent) => {
      if (pointer?.id === event.pointerId) stopPointer(false)
    }
    const reset = () => {
      stopPointer(false)
      stopKeyboard(false)
      paint(defaultWidth)
      if (preferredWidth !== null) setPreferences({ sidebarWidth: null })
    }
    const resizeKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || pointer) return
      if (event.key === 'Enter') { event.preventDefault(); reset(); return }
      if (!resizeKeys.includes(event.key)) return
      event.preventDefault()
      keyboardStart ??= width
      const step = event.shiftKey ? 40 : 10
      paint(event.key === 'Home' ? minimum : event.key === 'End' ? maximum
        : width + (event.key === 'ArrowLeft' ? -step : step))
    }
    const keyup = (event: KeyboardEvent) => {
      if (resizeKeys.includes(event.key)) stopKeyboard(true)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!pointer && keyboardStart === null)) return
      event.preventDefault()
      event.stopPropagation()
      stopPointer(false)
      stopKeyboard(false)
    }
    const blur = () => { stopPointer(false); stopKeyboard(true) }
    const windowBlur = () => { stopPointer(false); stopKeyboard(false) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', cancel)
    element.addEventListener('lostpointercapture', cancel)
    element.addEventListener('dblclick', reset)
    element.addEventListener('keydown', keydown)
    element.addEventListener('keyup', keyup)
    element.addEventListener('blur', blur)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', windowBlur)
    return () => {
      observer.disconnect()
      stopPointer(false)
      stopKeyboard(false)
      stopFrame()
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', cancel)
      element.removeEventListener('lostpointercapture', cancel)
      element.removeEventListener('dblclick', reset)
      element.removeEventListener('keydown', keydown)
      element.removeEventListener('keyup', keyup)
      element.removeEventListener('blur', blur)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', windowBlur)
      if (document.activeElement === element) requestAnimationFrame(() => {
        // A phone layout removes the separator; keep keyboard users on the sidebar toggle.
        if (!element.isConnected && workspace.isConnected && document.activeElement === document.body) {
          workspace.querySelector<HTMLElement>('[aria-label="Show project sidebar"], [aria-label="Hide project sidebar"]')
            ?.focus({ preventScroll: true })
        }
      })
    }
  }, [preferredWidth, fontScale])

  return <>
    <div ref={handle} className="project-sidebar-resize" role="separator" tabIndex={0}
      aria-label="Project sidebar width" aria-orientation="vertical" aria-controls="project-sidebar"
      aria-describedby="project-sidebar-resize-help" title="Drag to resize sidebar · Double-click to reset" />
    <span id="project-sidebar-resize-help" className="sr-only">Use Left and Right arrows to resize, Shift for larger steps, Home for minimum, End for maximum, and Enter to reset.
      Escape cancels resizing.</span>
  </>
}
