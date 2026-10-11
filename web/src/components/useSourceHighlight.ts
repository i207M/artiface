import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { boundedHighlight, sourceHighlightDeadline, sourceHighlightInputLimit } from '../highlightLimits'

export function useSourceHighlight(text: string, language: string, code: RefObject<HTMLElement | null>) {
  const [result, setResult] = useState<{ text: string; language: string; markup: string } | null>(null)

  useEffect(() => {
    setResult(null)
    if (!text || text.length > sourceHighlightInputLimit || language === 'plaintext' || typeof Worker === 'undefined') return
    let worker: Worker | undefined
    let timer: number | undefined
    let stopped = false
    let selecting = false
    const element = code.current
    const startSelection = () => { selecting = true }
    const endSelection = () => { selecting = false }
    const stop = () => {
      if (stopped) return
      stopped = true
      window.clearTimeout(timer)
      element?.removeEventListener('pointerdown', startSelection)
      window.removeEventListener('pointerup', endSelection)
      window.removeEventListener('pointercancel', endSelection)
      if (worker) {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate()
      }
    }
    try {
      worker = new Worker(new URL('../highlight.worker.ts', import.meta.url), { type: 'module' })
      element?.addEventListener('pointerdown', startSelection)
      window.addEventListener('pointerup', endSelection)
      window.addEventListener('pointercancel', endSelection)
      worker.onmessage = event => {
        if (stopped) return
        const selection = window.getSelection()
        let selected = selecting
        if (element && selection && !selection.isCollapsed) {
          for (let index = 0; index < selection.rangeCount; index++) {
            if (selection.getRangeAt(index).intersectsNode(element)) selected = true
          }
        }
        stop()
        // Decorating replaces text nodes, so leave this version plain during selection.
        if (!selected && boundedHighlight(event.data)) setResult({ text, language, markup: event.data })
      }
      worker.onerror = event => { event.preventDefault(); stop() }
      worker.onmessageerror = stop
      timer = window.setTimeout(stop, sourceHighlightDeadline)
      worker.postMessage({ text, language })
    } catch {
      stop()
    }
    return stop
  }, [text, language, code])

  return result?.text === text && result.language === language ? result.markup : null
}
