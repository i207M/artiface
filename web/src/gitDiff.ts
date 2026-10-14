export interface DiffLine {
  kind: 'context' | 'add' | 'remove'
  text: string
  oldNumber?: number
  newNumber?: number
  noNewline?: boolean
}
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface SplitLine { left?: DiffLine; right?: DiffLine }

export function parseGitDiff(patch: string) {
  const hunks: DiffHunk[] = []
  const metadata: string[] = []
  let hunk: DiffHunk | undefined
  let oldNumber = 0
  let newNumber = 0
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      oldNumber = Number(header[1])
      newNumber = Number(header[2])
      hunk = { header: line, lines: [] }
      hunks.push(hunk)
    } else if (line.startsWith('diff --git ')) {
      hunk = undefined
    } else if (hunk && line.startsWith('\\ No newline at end of file')) {
      const previous = hunk.lines.at(-1)
      if (previous) previous.noNewline = true
    } else if (hunk && line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), newNumber: newNumber++ })
    } else if (hunk && line.startsWith('-')) {
      hunk.lines.push({ kind: 'remove', text: line.slice(1), oldNumber: oldNumber++ })
    } else if (hunk && line.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ })
    } else if (line && !/^(index |--- |\+\+\+ )/.test(line)) {
      metadata.push(line)
    }
  }
  return { hunks, metadata }
}

export function splitDiffLines(lines: DiffLine[]): SplitLine[] {
  const rows: SplitLine[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({ left: removed[index], right: added[index] })
    }
    removed = []
    added = []
  }
  for (const line of lines) {
    if (line.kind === 'remove') removed.push(line)
    else if (line.kind === 'add') added.push(line)
    else {
      flush()
      rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}
