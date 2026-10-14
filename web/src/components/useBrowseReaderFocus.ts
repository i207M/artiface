import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { FileLocation, Location } from '../types'
import { tabKey } from './workspaceTabs'

export interface BrowseReaderFocusRequest {
  key: string
  signal: AbortSignal
  cancel: () => void
  focus: (target: HTMLElement) => void
}

// One keyboard opening or chooser return, consumed when its reader becomes usable.
export function useBrowseReaderFocus(location: Location) {
  const pending = useRef<BrowseReaderFocusRequest | null>(null)
  const key = location.kind === 'file' ? tabKey(location) : null
  const cancel = useCallback(() => pending.current?.cancel(), [])
  useLayoutEffect(() => {
    if (pending.current?.key !== key) cancel()
  }, [key, cancel])
  useLayoutEffect(() => cancel, [cancel])

  const begin = useCallback((file: FileLocation, origin: HTMLElement | null) => {
    cancel()
    const controller = new AbortController()
    const request: BrowseReaderFocusRequest = {
      key: tabKey(file),
      signal: controller.signal,
      cancel() {
        if (controller.signal.aborted) return
        origin = null
        if (pending.current === request) pending.current = null
        controller.abort()
      },
      focus(target) {
        if (controller.signal.aborted || !target.isConnected) return
        const active = document.activeElement
        const removedOrigin = origin && (!origin.isConnected || origin.closest('[hidden],[inert]')) && active === document.body
        if (active !== origin && !removedOrigin) { request.cancel(); return }
        request.cancel()
        target.focus({ preventScroll: true })
      },
    }
    pending.current = request
    const options = { capture: true, signal: controller.signal }
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      document.addEventListener(event, request.cancel, options)
    }
    document.addEventListener('focusin', event => {
      // Removing the opener can leave native focus on BODY.
      // Explicit input still cancels, even if it does not focus a control.
      if (event.target === origin || (origin && (!origin.isConnected || origin.closest('[hidden],[inert]')) && event.target === document.body)) return
      request.cancel()
    }, options)
    for (const event of ['blur', 'hashchange', 'popstate', 'pagehide']) {
      window.addEventListener(event, request.cancel, { signal: controller.signal })
    }
  }, [cancel])

  // Child layout effects run before the parent's cancellation effect.
  return { begin, cancel, request: pending.current?.key === key ? pending.current : null }
}

export function useBrowseReaderFocusTarget(content: RefObject<HTMLDivElement | null>, request?: BrowseReaderFocusRequest | null) {
  useLayoutEffect(() => {
    const root = content.current
    if (!root || !request || request.signal.aborted) return
    const visible = (element: HTMLElement | null) => element?.getClientRects().length ? element : null
    const focusReady = () => {
      if (request.signal.aborted) return
      const error = visible(root.querySelector<HTMLElement>('.error-state'))
      const unsupported = visible(root.querySelector<HTMLElement>('.unsupported-viewer'))
      const target = error ? visible(error.querySelector<HTMLElement>('button:not(:disabled),a[href]')) ?? root
        : unsupported ? visible(unsupported.querySelector<HTMLElement>('a[href]')) ?? root
          : visible(root.querySelector<HTMLElement>('.source-scroll, .csv-scroll, .markdown-viewer, .git-diff-content[aria-busy="false"], .git-history-list[aria-busy="false"], .pdf-canvas-area[aria-busy="false"], iframe[aria-hidden="false"]'))
            ?? (root.querySelector('.image-reader img:not(.pending-preview)') ? visible(root.querySelector<HTMLElement>('.image-reader')) : null)
      if (target) request.focus(target)
    }
    // Observe only this pending reader, after lazy and saved-position layout work.
    const observer = new MutationObserver(focusReady)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy', 'aria-hidden', 'class', 'style'] })
    const stop = () => {
      observer.disconnect()
      request.signal.removeEventListener('abort', stop)
    }
    request.signal.addEventListener('abort', stop, { once: true })
    focusReady()
    return stop
  }, [content, request])
}
