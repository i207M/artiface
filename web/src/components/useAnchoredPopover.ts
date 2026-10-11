import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

export function useAnchoredPopover(open: boolean, trigger: RefObject<HTMLElement | null>) {
  const panel = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const anchor = trigger.current
    const popup = panel.current
    if (!open || !anchor || !popup) return
    popup.style.left = '0px'
    popup.style.top = '0px'
    const content = anchor.closest<HTMLElement>('.project-content') ?? document.documentElement
    const toolbar = anchor.closest<HTMLElement>('.browse-toolbar')
    const viewport = window.visualViewport
    let frame = 0

    const position = () => {
      const bounds = content.getBoundingClientRect()
      const inset = 10
      const gap = 8
      const left = Math.max(bounds.left + content.clientLeft, viewport?.offsetLeft ?? 0) + inset
      const right = Math.min(bounds.left + content.clientLeft + content.clientWidth,
        (viewport?.offsetLeft ?? 0) + (viewport?.width ?? document.documentElement.clientWidth)) - inset
      const top = Math.max(bounds.top + content.clientTop, viewport?.offsetTop ?? 0) + inset
      const bottom = Math.min(bounds.top + content.clientTop + content.clientHeight,
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? document.documentElement.clientHeight)) - inset
      const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)))

      popup.style.maxWidth = `${Math.max(0, right - left)}px`
      const preferred = popup.getBoundingClientRect()
      // Read the content height without temporarily expanding the panel and resetting its scroll.
      const contentHeight = popup.scrollHeight + popup.offsetHeight - popup.clientHeight
      const button = anchor.getBoundingClientRect()
      const below = Math.max(0, bottom - Math.max(top, button.bottom + gap))
      const above = Math.max(0, Math.min(bottom, button.top - gap) - top)
      const placeAbove = contentHeight > below && above > below
      popup.style.setProperty('--popover-max-height', `${placeAbove ? above : below}px`)
      const height = popup.getBoundingClientRect().height
      // Resolve the fixed origin without moving the panel through CSS transitions.
      const current = popup.getBoundingClientRect()
      const style = getComputedStyle(popup)
      const originLeft = current.left - parseFloat(style.left)
      const originTop = current.top - parseFloat(style.top)
      popup.style.left = `${clamp(button.right - preferred.width, left, right - preferred.width) - originLeft}px`
      popup.style.top = `${clamp(placeAbove ? button.top - gap - height : button.bottom + gap, top, bottom - height) - originTop}px`
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(position)
    }
    position()
    const observer = new ResizeObserver(schedule)
    for (const element of [anchor, popup, content, toolbar]) if (element) observer.observe(element)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
    }
  }, [open, trigger])

  return panel
}
