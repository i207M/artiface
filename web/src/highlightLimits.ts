export const sourceHighlightInputLimit = 160_000
export const sourceHighlightDeadline = 2000
const markupLimit = 1024 * 1024
const spanLimit = 10_000

export function boundedHighlight(markup: unknown): markup is string {
  if (typeof markup !== 'string' || markup.length > markupLimit) return false
  let spans = 0
  for (const _match of markup.matchAll(/<span(?:\s|>)/g)) {
    if (++spans > spanLimit) return false
  }
  return new TextEncoder().encode(markup).byteLength <= markupLimit
}
