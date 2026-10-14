import assert from 'node:assert/strict'
import { gitGraph } from '../web/src/gitGraph.ts'
import { parseGitDiff, splitDiffLines } from '../web/src/gitDiff.ts'

// Diverging lanes, an octopus merge, an unrelated root, and a common ancestor.
const commits = [
  { hash: 'merge', parents: ['main', 'feature', 'third'] },
  { hash: 'other', parents: [] },
  { hash: 'feature', parents: ['base'] },
  { hash: 'third', parents: ['base'] },
  { hash: 'main', parents: ['base'] },
  { hash: 'base', parents: [] },
]
const graph = gitGraph(commits)
for (let index = 0; index < commits.length; index++) {
  const row = graph.rows[index]
  const outgoing = row.edges.filter(edge => edge.start === 'node')
  assert.equal(outgoing.length, commits[index].parents.length)
  for (const [parentIndex, parent] of commits[index].parents.entries()) {
    let lane = outgoing[parentIndex].to
    const end = commits.findIndex(commit => commit.hash === parent)
    for (let next = index + 1; next <= end; next++) {
      const edge = graph.rows[next].edges.find(edge => edge.start === 'top' && edge.from === lane)
      assert(edge, `Broken graph line between ${commits[index].hash} and ${parent}`)
      if (next === end) {
        assert.equal(edge.end, 'node')
        assert.equal(edge.to, graph.rows[next].column)
      } else {
        assert.equal(edge.end, 'bottom')
        lane = edge.to
      }
    }
  }
}
assert.deepEqual(gitGraph(commits.slice(0, 3)).rows, graph.rows.slice(0, 3), 'Pagination changed existing graph lines')
assert(graph.rows.every(row => row.edges.every(edge => edge.from >= 0 && edge.to >= 0)))
console.log('PASS: Merge/branch/root graph lines reach their actual parents and remain stable across pagination')

const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -8,4 +12,3 @@ function\n same\n-old one\n-old two\n+new\n end\n@@ -20,0 +24,1 @@\n+last\n\\ No newline at end of file\n'
const diff = parseGitDiff(patch)
assert.deepEqual(diff.hunks[0].lines.map(line => [line.kind, line.oldNumber, line.newNumber]), [
  ['context', 8, 12], ['remove', 9, undefined], ['remove', 10, undefined], ['add', undefined, 13], ['context', 11, 14],
])
const split = splitDiffLines(diff.hunks[0].lines)
assert.deepEqual(split.map(row => [row.left?.text, row.right?.text]), [
  ['same', 'same'], ['old one', 'new'], ['old two', undefined], ['end', 'end'],
])
assert.equal(diff.hunks[1].lines[0].oldNumber, undefined)
assert.equal(diff.hunks[1].lines[0].newNumber, 24)
assert.equal(diff.hunks[1].lines[0].noNewline, true)
assert.deepEqual(parseGitDiff('Binary files a/image.png and b/image.png differ\n'), {
  hunks: [], metadata: ['Binary files a/image.png and b/image.png differ'],
})
assert.equal(parseGitDiff('@@ -1,0 +1,1 @@\n+<script>unsafe</script>\n').hunks[0].lines[0].text, '<script>unsafe</script>')
console.log('PASS: Diff numbers, unbalanced replacements, zero-length hunks, missing newline, binary changes and literal source text')
