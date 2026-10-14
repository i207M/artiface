import { useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { FileLocation, Host, Location, Project } from '../types'
import { fileKind } from './Common'
import { tabKey } from './workspaceTabs'

const maxReaders = 8

// Keep the actual DOM: recreating an iframe reloads its report and loses its controls.
export default function ReaderDeck({ location, tabs, hosts, revision = '', render }: {
  location: Location
  tabs: FileLocation[]
  hosts: Host[]
  revision?: string
  render: (location: Location, host: Host, project: Project, active: boolean) => ReactNode
}) {
  const [recent, setRecent] = useState<{ revision: string; items: FileLocation[] }>({ revision, items: [] })
  const active = location.kind === 'file' && (location.view || fileKind(location.path) !== 'pdf') ? location : null
  const next = (recent.revision === revision ? recent.items : []).filter(item => tabs.some(tab => tabKey(item) === tabKey(tab)) && (!active || tabKey(item) !== tabKey(active)))
  if (active) next.push(active)
  const retained = next.slice(-maxReaders)
  const signature = retained.map(tabKey).join('\n')
  useLayoutEffect(() => {
    setRecent(current => current.revision === revision && current.items.map(tabKey).join('\n') === signature ? current : { revision, items: retained })
  }, [revision, signature]) // The locations are represented by their complete tab keys.
  // LRU updates must not move existing DOM nodes: moving an iframe reloads it.
  return [...retained].sort((a, b) => tabKey(a).localeCompare(tabKey(b))).map(item => {
    const host = hosts.find(host => host.id === item.host && !host.hidden)
    const project = host?.roots.find(project => project.id === item.root && !project.hidden)
    if (!host || !project) return null
    const visible = active !== null && tabKey(item) === tabKey(active)
    const source = JSON.stringify([revision, tabKey(item), host.kind, host.target, project.path, Boolean(project.trustedScripts)])
    return <div key={source} id={visible ? 'reader-panel' : undefined} role={visible ? 'tabpanel' : undefined}
      aria-labelledby={visible ? `file-tab-${encodeURIComponent(tabKey(item))}` : undefined}
      className="reader-panel" hidden={!visible} inert={!visible}>
      {render({ ...item, kind: 'file' }, host, project, visible)}
    </div>
  })
}
