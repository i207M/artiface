import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

export default function OverviewColumns({ children, hasFiles }: {
  children: [ReactElement, ReactElement]; hasFiles: boolean
}) {
  const columns = useRef<HTMLDivElement>(null)
  const [stacked, setStacked] = useState(false)
  const filesFirst = stacked && hasFiles

  useLayoutEffect(() => {
    const element = columns.current
    if (!element) return
    let previous = false
    const measure = () => {
      // CSS owns both the container breakpoint and the phone layout.
      const next = getComputedStyle(element).getPropertyValue('--overview-stacked').trim() === '1'
      if (next === previous) return
      previous = next
      setStacked(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    // React retains focus across keyed moves; keep that current choice readable.
    // No deferred focus request can override a newer choice or a background tab.
    const target = document.activeElement
    if (document.hasFocus() && target instanceof HTMLElement && columns.current?.contains(target)) {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    }
  }, [filesFirst])

  return <div className="overview-columns" ref={columns}>{filesFirst ? [children[1], children[0]] : children}</div>
}
