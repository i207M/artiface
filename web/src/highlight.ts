import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import latex from 'highlight.js/lib/languages/latex'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { boundedHighlight } from './highlightLimits'

for (const [name, language] of Object.entries({ bash, cpp, css, diff, go, ini, javascript, json, latex, markdown, python, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language)
}

export function highlight(text: string, language: string): string | null {
  // Bound synchronous highlighting work on large remote files.
  if (text.length > 160_000 || !hljs.getLanguage(language)) return null
  try {
    const markup = hljs.highlight(text, { language, ignoreIllegals: true }).value
    return boundedHighlight(markup) ? markup : null
  } catch {
    return null
  }
}
