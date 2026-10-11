import { Component } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { Entry } from '../types'

interface Props {
  entries: Entry[] | null
  settled: boolean
  signature: string
  page: number
  view: 'list' | 'icons'
  contentRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}
interface Snapshot { origin: HTMLAnchorElement; neighbors: string[] }
const filenameLinks = '.table-name > a[href], a.file-tile[href]'
const pathOf = (link: HTMLAnchorElement) => link.closest<HTMLElement>('[data-browse-entry]')?.dataset.browseEntry

// Capture actual focus before React removes a refreshed filename, without a pending focus request.
export default class BrowseResults extends Component<Props, object, Snapshot | null> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { entries, settled, signature, page, view, contentRef } = this.props
    if (!settled || !entries || !previous.entries || entries === previous.entries ||
      signature !== previous.signature || page !== previous.page || view !== previous.view || !document.hasFocus()) return null
    const origin = document.activeElement
    if (!(origin instanceof HTMLAnchorElement)) return null
    const links = Array.from(contentRef.current?.querySelectorAll<HTMLAnchorElement>(filenameLinks) ?? [])
    const index = links.indexOf(origin)
    const path = pathOf(origin)
    if (index < 0 || path === undefined || entries.some(entry => entry.path === path)) return null
    return { origin, neighbors: [...links.slice(index + 1), ...links.slice(0, index).reverse()]
      .flatMap(link => { const path = pathOf(link); return path === undefined ? [] : [path] }) }
  }

  componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null) {
    if (!snapshot || snapshot.origin.isConnected || !document.hasFocus() || document.activeElement !== document.body) return
    const content = this.props.contentRef.current
    const links = Array.from(content?.querySelectorAll<HTMLAnchorElement>(filenameLinks) ?? [])
    const byPath = new Map(links.map(link => [pathOf(link), link]))
    const neighbor = snapshot.neighbors.find(path => byPath.has(path))
    const target = (neighbor === undefined ? undefined : byPath.get(neighbor)) ?? links[0] ??
      content?.querySelector<HTMLElement>('[aria-label="Directory results"]') ?? document.getElementById('main-content')
    target?.focus({ preventScroll: true })
  }

  render() {
    return <div ref={this.props.contentRef} className="browse-files">{this.props.children}</div>
  }
}
