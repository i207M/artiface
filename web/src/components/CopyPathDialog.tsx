import { useEffect, useRef } from 'react'

export default function CopyPathDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return <dialog ref={dialog} className="report-link-dialog" aria-labelledby="copy-path-title" aria-describedby="copy-path-help" onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id="copy-path-title">Copy file path</h2>
    <p id="copy-path-help">Your browser blocked automatic copying. Copy the selected path below.</p>
    <textarea className="copy-path-field" aria-label="File path" value={path} readOnly rows={3} autoFocus onFocus={event => event.currentTarget.select()} />
    <div className="report-link-actions"><button className="button secondary" onClick={onClose}>Close</button></div>
  </dialog>
}
