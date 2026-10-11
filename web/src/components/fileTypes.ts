import { extension, fileName } from '../location'
import type { Entry } from '../types'

export type ReaderType = 'markdown' | 'latex' | 'pdf' | 'html' | 'image' | 'text' | 'code' | 'other'
export type FileCategory = 'documents' | 'multimedia' | 'code' | 'other'

export const fileTypeGroups: { id: FileCategory; label: string; types: ReaderType[] }[] = [
  { id: 'documents', label: 'Documents', types: ['markdown', 'latex', 'pdf', 'text'] },
  { id: 'multimedia', label: 'Multimedia', types: ['html', 'image'] },
  { id: 'code', label: 'Code', types: ['code'] },
  { id: 'other', label: 'Others', types: ['other'] },
]

export const readerTypeLabels: Record<ReaderType, string> = {
  markdown: 'Markdown', latex: 'LaTeX', pdf: 'PDF', html: 'HTML',
  image: 'Image', text: 'Text', code: 'Code', other: 'Others',
}

export const readerTypeDescriptions: Record<ReaderType, string> = {
  markdown: 'MD, Markdown', latex: 'TeX, LaTeX, BibTeX', pdf: 'PDF documents', html: 'HTML pages and reports',
  code: 'Source code, shell scripts, notebooks, JSON, YAML, TOML, and other configuration files',
  image: 'PNG, JPEG, SVG, GIF, WebP, and other images', text: 'Plain text, logs, and README files',
  other: 'Tables, datasets, archives, and other file formats',
}

export const allReaderTypes = fileTypeGroups.flatMap(group => group.types)

export function normalizeReaderTypes(selected: unknown[]): ReaderType[] {
  const types = new Set(selected)
  return allReaderTypes.filter(type => types.has(type))
}

const codeExtensions = new Set('py pyi pyw js jsx ts tsx mjs cjs cts mts css scss sass less c h cc cpp cxx hpp cu cuh rs go java kt kts swift rb php sql r jl lua pl pm ex exs erl hs scala clj cljs vue svelte dart m mm cmake dockerfile makefile diff patch'.split(' '))
const shellExtensions = new Set('sh bash zsh fish ksh csh tcsh ps1 psm1 psd1 bat cmd'.split(' '))
const binaryExtensions = new Set('zip gz tgz tar 7z rar xz bz2 zst pt pth safetensors ckpt npy npz parquet arrow bin exe so dll dylib woff woff2 ttf otf mp4 mov webm mp3 wav ogg flac sqlite db pickle pkl h5 hdf5 feather'.split(' '))

export function isBinaryFile(path: string) {
  return binaryExtensions.has(extension(path))
}

export function readerType(path: string): ReaderType {
  const ext = extension(path)
  const name = fileName(path).toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (['md', 'markdown', 'mdown'].includes(ext)) return 'markdown'
  if (['tex', 'latex', 'bib', 'sty', 'cls'].includes(ext)) return 'latex'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'avif', 'ico', 'tif', 'tiff'].includes(ext)) return 'image'
  if (shellExtensions.has(ext) || /^(\.(bashrc|bash_profile|bash_login|bash_logout|zshrc|zprofile|zshenv)|\.profile)$/.test(name)) return 'code'
  if (['yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'config', 'env', 'properties', 'json', 'jsonl', 'ndjson', 'ipynb'].includes(ext) || /^(\.env(\..*)?|\.gitconfig|\.editorconfig|\.npmrc|\.yarnrc)$/.test(name)) return 'code'
  if (codeExtensions.has(ext) || /^(makefile|dockerfile|justfile|gemfile)$/i.test(fileName(path))) return 'code'
  if (['txt', 'text', 'log', 'rst', 'adoc', 'out', 'err'].includes(ext) || /^(readme|license|licence|copying|authors|changelog|notice)(\..*)?$/i.test(fileName(path))) return 'text'
  return 'other'
}

export function entryTypeLabel(entry: Entry) {
  if (entry.type === 'directory') return 'Folder'
  if (entry.type === 'symlink') return 'Symlink'
  if (entry.type !== 'file') return 'Special'
  return readerTypeLabels[readerType(entry.resolvedPath ?? entry.path)]
}

export type SortColumn = 'name' | 'type' | 'size' | 'modified'
export interface FileSort { column: SortColumn; direction: 'asc' | 'desc' }

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const typeCollator = new Intl.Collator()

export function sortEntries(entries: Entry[], sort: FileSort, flat = false) {
  const modified = sort.column === 'modified' ? new Map(entries.map(entry => [entry, Date.parse(entry.modified) || 0])) : null
  const types = sort.column === 'type' ? new Map(entries.map(entry => [entry, entryTypeLabel(entry)])) : null
  const compareName = (a: Entry, b: Entry) => nameCollator.compare(flat ? a.path : a.name, flat ? b.path : b.name)
  return [...entries].sort((a, b) => {
    if ((a.type === 'directory') !== (b.type === 'directory')) return a.type === 'directory' ? -1 : 1
    let difference = 0
    if (sort.column === 'name') difference = compareName(a, b)
    if (sort.column === 'type') difference = typeCollator.compare(types!.get(a)!, types!.get(b)!)
    if (sort.column === 'size') difference = a.size - b.size
    if (sort.column === 'modified') difference = modified!.get(a)! - modified!.get(b)!
    return (difference || compareName(a, b)) * (sort.direction === 'asc' ? 1 : -1)
  })
}
