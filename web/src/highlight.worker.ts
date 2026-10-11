import { highlight } from './highlight'
import { boundedHighlight, sourceHighlightInputLimit } from './highlightLimits'

self.onmessage = (event: MessageEvent<{ text?: unknown; language?: unknown }>) => {
  const { text, language } = event.data ?? {}
  const markup = typeof text === 'string' && text.length <= sourceHighlightInputLimit && typeof language === 'string'
    ? highlight(text, language) : null
  self.postMessage(boundedHighlight(markup) ? markup : null)
}
