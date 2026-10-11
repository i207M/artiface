interface DecimalKey { sign: number; order: string; digits: string }

// Adjust the exponent by the coefficient's decimal position, never by expanding a power.
// Large exponent strings can exceed WebKit's BigInt limit even within a text preview.
function decimalOrder(exponent: string, offset: number) {
  const negative = exponent.startsWith('-')
  const digits = exponent.replace(/^[+-]?0*/, '') || '0'
  if (digits.length <= 15) return String(Number((negative ? '-' : '') + digits) + offset)
  // The magnitude exceeds any preview-length offset, so its sign cannot change.
  let carry = negative ? -offset : offset
  let index = digits.length
  const tail: string[] = []
  while (carry && index) {
    const digit = Number(digits[--index]) + carry
    tail.push(String((digit % 10 + 10) % 10))
    carry = Math.floor(digit / 10)
  }
  const adjusted = ((carry ? String(carry) : '') + digits.slice(0, index) + tail.reverse().join('')).replace(/^0+/, '')
  return (negative ? '-' : '') + adjusted
}

function compareOrders(a: string, b: string) {
  const aSign = a.startsWith('-') ? -1 : 1, bSign = b.startsWith('-') ? -1 : 1
  if (aSign !== bSign) return aSign - bSign
  return aSign * (a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
}

// Keep the source spelling; compare normalized decimal keys without floating-point rounding.
export function decimalSortKey(value: string): DecimalKey | null {
  const match = /^([+-]?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value)
  if (!match || match[0] !== value) return null
  const fraction = match[3] ?? ''
  const coefficient = (match[2] + fraction).replace(/^0+/, '')
  if (!coefficient) return { sign: 0, order: '0', digits: '' }
  let end = coefficient.length
  while (coefficient[end - 1] === '0') end--
  return { sign: match[1] === '-' ? -1 : 1,
    order: decimalOrder(match[4] ?? '0', coefficient.length - fraction.length),
    digits: coefficient.slice(0, end) }
}

export function compareDecimals(a: DecimalKey, b: DecimalKey) {
  if (a.sign !== b.sign) return a.sign - b.sign
  if (!a.sign) return 0
  const magnitude = compareOrders(a.order, b.order) || (a.digits < b.digits ? -1 : a.digits > b.digits ? 1 : 0)
  return magnitude * a.sign
}

const textOrder = new Intl.Collator(undefined, { numeric: false, sensitivity: 'variant' })

export function columnSortKeys(rows: string[][], column: number) {
  const values = rows.map(row => row[column] ?? '')
  const numbers = values.map(value => value === '' ? null : decimalSortKey(value))
  const numeric = values.some(value => value !== '') && values.every((value, index) => value === '' || numbers[index] !== null)
  return { values, numbers, numeric }
}

export function sortedRowIndices(keys: ReturnType<typeof columnSortKeys>, descending: boolean) {
  return Array.from({ length: keys.values.length }, (_, index) => index).sort((a, b) => {
    const left = keys.values[a], right = keys.values[b]
    if ((left === '') !== (right === '')) return left === '' ? 1 : -1
    const comparison = left === '' ? 0 : keys.numeric
      ? compareDecimals(keys.numbers[a]!, keys.numbers[b]!) : textOrder.compare(left, right)
    return comparison * (descending ? -1 : 1) || a - b
  })
}
