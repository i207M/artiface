import type { GitCommit } from './gitGraph'

export interface GitCommitFile { path: string; status: 'A' | 'D' | 'M' | 'T' }
export interface GitCommitDetails extends Omit<GitCommit, 'refs'> {
  committer: string
  committerEmail: string
  commitDate: string
  files: GitCommitFile[]
  truncated: boolean
}
export interface GitFileNode {
  name: string
  path: string
  status?: GitCommitFile['status']
  children: GitFileNode[]
}

export function gitFileTree(files: GitCommitFile[]): GitFileNode[] {
  interface Node extends Omit<GitFileNode, 'children'> { children: Map<string, Node> }
  const root = new Map<string, Node>()
  for (const file of files) {
    const parts = file.path.split('/')
    let children = root
    // Deep paths retain their full suffix without creating unbounded nested DOM.
    const depth = Math.min(parts.length - 1, 32)
    for (let index = 0; index < depth; index++) {
      const name = parts[index], key = `directory:${name}`
      let node = children.get(key)
      if (!node) {
        node = { name, path: parts.slice(0, index + 1).join('/'), children: new Map() }
        children.set(key, node)
      }
      children = node.children
    }
    const name = parts.slice(depth).join('/')
    children.set(`file:${name}`, { name, path: file.path, status: file.status, children: new Map() })
  }
  const sorted = (nodes: Map<string, Node>): GitFileNode[] => [...nodes.values()]
    .sort((a, b) => Number(Boolean(a.status)) - Number(Boolean(b.status)) || a.name.localeCompare(b.name))
    .map(node => ({ ...node, children: sorted(node.children) }))
  return sorted(root)
}
