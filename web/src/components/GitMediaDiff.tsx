import { ArrowDownToLine } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { errorMessage } from '../api'
import { fileName } from '../location'
import { ErrorState, Loading } from './Common'
import ImageViewer, { ImageViewActions, useImageView } from './ImageViewer'
import './gitDiff.css'

const GitPDFPreview = lazy(() => import('./GitPDFPreview'))

interface Version { data?: string; unsupported?: boolean }
export interface GitMedia { type: string; before: Version | null; after: Version | null }

function MediaVersion({ version, type, name, label, missing, active }: {
  version: Version | null; type: string; name: string; label: string; missing: string; active: boolean
}) {
  const image = useImageView()
  const [resource, setResource] = useState<{ bytes: Uint8Array<ArrayBuffer>; url: string } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const pdf = type === 'application/pdf'
  useEffect(() => {
    if (!version || version.unsupported) return
    let url = ''
    try {
      const decoded = atob(version.data ?? '')
      const bytes = new Uint8Array(decoded.length)
      for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index)
      url = URL.createObjectURL(new Blob([bytes], { type }))
      setResource({ bytes, url })
    } catch (failure) { setError(errorMessage(failure)) }
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [version, type])
  return <section className="git-media-version" aria-label={label}>
    <header className="git-media-heading"><strong>{label}</strong>
      {resource && <a className="icon-button" href={resource.url} download={fileName(name)} aria-label={`Download ${label}`} title={`Download ${label}`}><ArrowDownToLine size={16} /></a>}
    </header>
    {!version ? <p className="git-media-empty">{missing}</p>
      : version.unsupported ? <p className="git-media-empty">This version is not a regular file and cannot be previewed.</p>
        : error ? <ErrorState title="Couldn’t open this version" message={error} />
          : !resource ? <Loading message="Opening preview…" />
            : pdf ? <Suspense fallback={<Loading message="Opening PDF…" />}>
              {active && <GitPDFPreview bytes={resource.bytes} />}
            </Suspense>
              : <><div className="git-media-controls"><ImageViewActions image={image} /></div>
                <ImageViewer key={attempt} url={resource.url} name={`${label}: ${name}`} image={image}
                  onReady={() => {}} onError={() => {}} retry={() => setAttempt(value => value + 1)} /></>}
  </section>
}

export default function GitMediaDiff({ media, name, layout, commit, active }: {
  media: GitMedia; name: string; layout: 'inline' | 'split'; commit?: string; active: boolean
}) {
  return <div className={`git-media-diff git-media-${layout}`} aria-label="Visual file diff" data-layout={layout}>
    {layout === 'split' && <MediaVersion key="before" version={media.before} type={media.type} name={name} label="Before"
      missing="This file did not exist before this change." active={active} />}
    <MediaVersion key="after" version={media.after} type={media.type} name={name} label={commit ? `After · ${commit.slice(0, 8)}` : 'After · Working tree'}
      missing={media.before ? 'File deleted. Use Side by side to view the previous version.' : 'No file exists in this version.'} active={active} />
  </div>
}
