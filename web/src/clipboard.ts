export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Plain HTTP deployments may not expose the Clipboard API.
  }
  const previous = document.activeElement
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.tabIndex = -1
  field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;font-size:16px;pointer-events:none'
  document.body.append(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    if (!document.execCommand('copy')) throw new Error('Clipboard access unavailable')
  } finally {
    field.remove()
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}
