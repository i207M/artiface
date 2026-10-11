import assert from 'node:assert/strict'
import { parseDelimited } from '../web/src/csv.ts'
import { columnSortKeys, sortedRowIndices } from '../web/src/csvSort.ts'

assert.deepEqual(parseDelimited('\uFEFFname,value,note\r\n"alpha, beta","007","He said ""hello"""\r\nmulti,,"one\r\ntwo"\r\n', ',').rows,
  [['name', 'value', 'note'], ['alpha, beta', '007', 'He said "hello"'], ['multi', '', 'one\r\ntwo']])
assert.deepEqual(parseDelimited('a\tb\n"one\ttwo"\t"line\nbreak"\n', '\t').rows,
  [['a', 'b'], ['one\ttwo', 'line\nbreak']])
assert.deepEqual(parseDelimited('\n\r\n"",,\rshort\rtrailing,', ',').rows, [['', '', ''], ['short'], ['trailing', '']])
assert.deepEqual(parseDelimited('', ',').rows, [])
assert.match(parseDelimited('a,b\nok,yes\n"broken', ',').error, /Unclosed/)
assert.match(parseDelimited('"a"x,b', ',').error, /Unexpected text/)
assert.match(parseDelimited('ab"c,d', ',').error, /Unexpected quote/)
assert.deepEqual(parseDelimited('a,b\nok,yes\n"partial\nrecord', ',', true),
  { rows: [['a', 'b'], ['ok', 'yes']], limited: false, error: '' })
assert.deepEqual(parseDelimited('a,b\npartial,record', ',', true).rows, [['a', 'b']])
assert.deepEqual(parseDelimited('a,b\nok,yes\n', ',', true).rows, [['a', 'b'], ['ok', 'yes']])

// Round-trip varied records through standard doubled-quote serialization.
let seed = 731
const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n }
const alphabet = ['a', 'é', ' ', '\n', '\r', ',', '\t', '"', '<script>', '0']
for (const delimiter of [',', '\t']) {
  for (let sample = 0; sample < 60; sample++) {
    const rows = Array.from({ length: 1 + random(12) }, () =>
      Array.from({ length: 1 + random(8) }, () =>
        Array.from({ length: random(15) }, () => alphabet[random(alphabet.length)]).join('')))
    const text = rows.map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(delimiter)).join('\r\n')
    const parsed = parseDelimited(text, delimiter)
    assert.equal(parsed.error, '')
    assert.deepEqual(parsed.rows, rows)
  }
}
for (const text of ['x\n'.repeat(20_000), ','.repeat(200_000), ('x,'.repeat(90) + 'x\n').repeat(2000)]) {
  const parsed = parseDelimited(text, ',')
  assert(parsed.limited)
  assert(parsed.rows.length <= 10_000)
  assert(parsed.rows.every(row => row.length <= 100))
  assert(parsed.rows.reduce((count, row) => count + row.length, 0) <= 50_000)
}
// Compare exact values, retaining original indices for equal numbers in either direction.
const values = ['9007199254740993', '9007199254740992', '2e400', '1e400', '2e-400', '1e-400',
  '-2e400', '-1e400', '0', '-0', '+0', '1', '1.0', '1e0', '1.20', '1.2', '-1.2', '-1.20']
const exactKeys = columnSortKeys(values.map(value => [value]), 0)
const ascending = [6, 7, 16, 17, 8, 9, 10, 5, 4, 11, 12, 13, 14, 15, 1, 0, 3, 2]
const descending = [2, 3, 0, 1, 14, 15, 11, 12, 13, 4, 5, 8, 9, 10, 16, 17, 7, 6]
assert.deepEqual(sortedRowIndices(exactKeys, false), ascending)
assert.deepEqual(sortedRowIndices(exactKeys, true), descending)
for (const descending of [false, true]) {
  const rows = [['2'], [''], ['1'], [], ['1']]
  assert.deepEqual(sortedRowIndices(columnSortKeys(rows, 0), descending), descending ? [0, 2, 4, 1, 3] : [2, 4, 0, 1, 3])
}
for (const value of ['001', '-01', '+01', ' 3 ', '3\n', ' ', 'NA', '.5', '1.', '0x10', '1,000']) {
  assert.equal(columnSortKeys([['2'], [value]], 0).numeric, false, `Coerced literal text: ${JSON.stringify(value)}`)
}
assert.deepEqual(sortedRowIndices(columnSortKeys([['002'], ['10'], ['001']], 0), false), [2, 0, 1])
assert.deepEqual(sortedRowIndices(columnSortKeys([['10'], ['2'], ['NA'], ['']], 0), false), [0, 1, 2, 3])
assert.deepEqual(sortedRowIndices(columnSortKeys([[''], []], 0), true), [0, 1])
// Equivalent spellings cross exponent carry/borrow and the small-integer fast path.
for (const exponent of [999999999999999n, 9999999999999999n, -10000000000000000n,
  BigInt('9'.repeat(200)), -BigInt('1' + '0'.repeat(200))]) {
  const keys = columnSortKeys([
    [`2e${exponent}`], [`1e${exponent}`], [`10e${exponent - 1n}`], [`0.001e${exponent + 3n}`], [`9e${exponent - 1n}`],
  ], 0)
  assert.deepEqual(sortedRowIndices(keys, false), [4, 1, 2, 3, 0])
  assert.deepEqual(sortedRowIndices(keys, true), [0, 1, 2, 3, 4])
}
// Large exponents must never be expanded into powers or exponent-sized zero padding.
const exponent = '9'.repeat(10_000)
const coefficient = '1' + '0'.repeat(100_000)
assert.deepEqual(sortedRowIndices(columnSortKeys([[coefficient + '2'], [coefficient + '1']], 0), false), [1, 0])
assert.deepEqual(sortedRowIndices(columnSortKeys([
  [`2e${exponent}`], [`1e${exponent}`], [`1e-${exponent}`], [coefficient], ['9'.repeat(100_000)],
], 0), false), [2, 4, 3, 1, 0])
console.log('PASS: CSV/TSV parsing and allocation bounds; exact decimal/scientific sorting, stable original ties, empty-last, literal IDs/mixed values, and long numeric keys')
