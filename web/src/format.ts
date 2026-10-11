const bytesFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const modifiedFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const olderModifiedFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const recentDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const olderDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length)
  return `${bytesFormatter.format(bytes / 1024 ** exponent)} ${units[exponent - 1]}`
}

export function modifiedTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  return (date.getFullYear() === new Date().getFullYear() ? modifiedFormatter : olderModifiedFormatter).format(date)
}

export function relativeTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const seconds = (date.getTime() - Date.now()) / 1000
  if (Math.abs(seconds) < 60) return 'just now'
  if (Math.abs(seconds) < 3600) return relativeFormatter.format(Math.round(seconds / 60), 'minute')
  if (Math.abs(seconds) < 86400) return relativeFormatter.format(Math.round(seconds / 3600), 'hour')
  if (Math.abs(seconds) < 7 * 86400) return relativeFormatter.format(Math.round(seconds / 86400), 'day')
  return (date.getFullYear() === new Date().getFullYear() ? recentDateFormatter : olderDateFormatter).format(date)
}
