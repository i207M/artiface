import { useMemo, useRef } from 'react'
import { fileLanguage } from '../fileLanguage'
import { useSourceHighlight } from './useSourceHighlight'

export default function SourceViewer({ text, path, lines, wrap }: {
  text: string; path: string; lines: number; wrap: boolean
}) {
  const code = useRef<HTMLElement>(null)
  const language = fileLanguage(path)
  const highlighted = useSourceHighlight(text, language, code)
  const lineNumbers = useMemo(() => Array.from({ length: lines }, (_, index) => index + 1).join('\n'), [lines])

  return (
    <div className={`source-viewer${wrap ? ' source-wrap' : ''}${text.length === 0 ? ' source-is-empty' : ''}`}>
      <div className="source-scroll" tabIndex={0} role="region" aria-label="File source">
        {!wrap && <pre className="line-numbers" aria-hidden="true">{lineNumbers}</pre>}
        <pre className="source-code">{highlighted !== null ? <code ref={code} dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code ref={code}>{text}</code>}</pre>
        {text.length === 0 && <p className="reader-empty" role="status">This file is empty.</p>}
      </div>
    </div>
  )
}
