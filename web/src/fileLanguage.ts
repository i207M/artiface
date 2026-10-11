const extensions: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', pyw: 'python',
  json: 'json', jsonl: 'json', ipynb: 'json', yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  tex: 'latex', latex: 'latex', bib: 'latex', sty: 'latex', cls: 'latex',
  go: 'go', rs: 'rust', c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cu: 'cpp',
  sql: 'sql', diff: 'diff', patch: 'diff', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
  md: 'markdown', markdown: 'markdown',
}

export function fileLanguage(path: string) {
  const name = path.split('/').pop() || ''
  if (name === '.bashrc' || name === '.zshrc' || name === '.bash_profile') return 'bash'
  if (name === '.gitconfig' || name === '.env' || name.startsWith('.env.')) return 'ini'
  return extensions[name.split('.').pop()?.toLowerCase() ?? ''] || 'plaintext'
}
