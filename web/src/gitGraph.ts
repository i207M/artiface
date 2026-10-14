export interface GitCommit {
  hash: string
  parents: string[]
  author: string
  email: string
  date: string
  message: string
  refs: string[]
}

export interface GitHistory {
  commits: GitCommit[]
  revision: string
  hasMore: boolean
  scoped: boolean
  head: string
}

export interface GraphEdge { from: number; to: number; color: number; start: 'top' | 'node'; end: 'bottom' | 'node' }
export interface GraphRow { column: number; color: number; edges: GraphEdge[] }

// Each lane names the ancestor it is waiting for.
// Keeping that identity across rows handles merges, disconnected branches and
// parents that will arrive on the next page without relying on commit dates.
export function gitGraph(commits: Pick<GitCommit, 'hash' | 'parents'>[]) {
  let lanes: { hash: string; color: number }[] = []
  let nextColor = 0
  let columns = 1
  const rows: GraphRow[] = []
  for (const commit of commits) {
    let column = lanes.findIndex(lane => lane.hash === commit.hash)
    const incoming = column >= 0
    if (!incoming) {
      column = lanes.length
      lanes.push({ hash: commit.hash, color: nextColor++ % 6 })
    }
    const color = lanes[column].color
    const next = lanes.filter((_, index) => index !== column)
    const parents = [...new Set(commit.parents)]
    for (const [index, hash] of parents.entries()) {
      if (next.some(lane => lane.hash === hash)) continue
      const lane = { hash, color: index === 0 ? color : nextColor++ % 6 }
      if (index === 0) next.splice(column, 0, lane)
      else next.push(lane)
    }
    const edges = lanes.flatMap<GraphEdge>((lane, from) => from === column
      ? incoming ? [{ from, to: column, color, start: 'top' as const, end: 'node' as const }] : []
      : [{ from, to: next.findIndex(item => item.hash === lane.hash), color: lane.color, start: 'top' as const, end: 'bottom' as const }])
    for (const hash of parents) {
      const to = next.findIndex(lane => lane.hash === hash)
      edges.push({ from: column, to, color: next[to].color, start: 'node', end: 'bottom' })
    }
    columns = Math.max(columns, lanes.length, next.length)
    rows.push({ column, color, edges })
    lanes = next
  }
  return { rows, columns }
}
