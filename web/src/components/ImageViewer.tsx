import { RotateCw, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultImageView, imageCenter, imageLayout, imageScroll, imageViewGeneration, imageZooms, readImageView, retainImageView } from '../imageView'
import type { ImageLayout, ImageView } from '../imageView'
import { ErrorState, Loading } from './Common'
import './imageViewer.css'

export function useImageView(key?: string) {
  const [view, setView] = useState(() => (key && readImageView(key)) || defaultImageView())
  const [scale, setScale] = useState(0)
  const current = useRef(view)
  const generation = useRef(imageViewGeneration())
  const capture = useRef<(() => void) | null>(null)
  useEffect(() => () => {
    if (key) retainImageView(key, current.current, generation.current)
  }, [key])

  function change(patch: Partial<ImageView>) {
    capture.current?.()
    current.current = { ...current.current, ...patch }
    setView(current.current)
  }
  function zoom(direction: 1 | -1) {
    const value = direction === 1 ? imageZooms.find(value => value > scale + 0.001)
      : [...imageZooms].reverse().find(value => value < scale - 0.001)
    if (value !== undefined) change({ zoom: value })
  }
  return { view, current, capture, change, zoom, scale, setScale }
}

type Controller = ReturnType<typeof useImageView>

export function ImageViewActions({ image, menu = false }: { image: Controller; menu?: boolean }) {
  const out = <button className="icon-button" data-keep-menu-open disabled={!image.scale || image.scale <= 0.25} aria-label="Zoom image out" title="Zoom image out" onClick={() => image.zoom(-1)}><ZoomOut size={17} />{menu && 'Zoom out'}</button>
  const into = <button className="icon-button" data-keep-menu-open disabled={!image.scale || image.scale >= 4} aria-label="Zoom image in" title="Zoom image in" onClick={() => image.zoom(1)}><ZoomIn size={17} />{menu && 'Zoom in'}</button>
  if (menu) return <div className="image-view-options">{out}{into}
    <button data-keep-menu-open disabled={!image.scale} onClick={() => image.change({ rotation: (image.view.rotation + 90) % 360 })}><RotateCw size={17} />Rotate clockwise <span>{image.view.rotation}°</span></button>
    <label>Image background<select value={image.view.background} onChange={event => image.change({ background: event.target.value as ImageView['background'] })}>
      <option value="theme">Match theme</option><option value="light">Light</option><option value="dark">Dark</option>
    </select></label>
  </div>
  return <div className="image-view-controls">
    {out}
    <select aria-label="Image zoom" value={image.view.zoom} disabled={!image.scale} onChange={event => image.change({ zoom: event.target.value === 'fit' ? 'fit' : Number(event.target.value) })}>
      <option value="fit">Fit</option>
      {imageZooms.map(value => <option key={value} value={value}>{value * 100}%</option>)}
    </select>
    {into}
  </div>
}

export default function ImageViewer({ url, name, image, onError, onReady, retry }: {
  url: string; name: string; image: Controller; onError: () => void; onReady: () => void; retry: () => void
}) {
  const [visible, setVisible] = useState<{ url: string; width: number; height: number } | null>(null)
  const [failedURL, setFailedURL] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const area = useRef<HTMLDivElement>(null)
  const deferredLoad = useRef<(() => void) | null>(null)
  const cancelPan = useRef<(() => void) | null>(null)
  const previousLayout = useRef<ImageLayout | null>(null)
  const currentURL = useRef(url)
  currentURL.current = url
  const { current, capture, setScale } = image
  const layout = useMemo(() => visible && viewport.width && viewport.height ? imageLayout(visible, viewport, image.view) : null,
    [visible, viewport, image.view.zoom, image.view.rotation])
  const urls = Array.from(new Set([visible?.url, failedURL === url ? null : url].filter((source): source is string => Boolean(source))))

  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    let pointer: { id: number; x: number; y: number; left: number; top: number } | null = null
    const stopPanning = () => {
      if (!pointer) return
      const id = pointer.id
      pointer = null
      element.classList.remove('is-panning')
      if (element.hasPointerCapture(id)) element.releasePointerCapture(id)
    }
    cancelPan.current = stopPanning
    const startPanning = (event: PointerEvent) => {
      if (pointer || event.pointerType !== 'mouse' || !event.isPrimary || event.button !== 0 ||
        !element.querySelector('.image-stage > img:not(.pending-preview)') ||
        (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)) return
      const bounds = element.getBoundingClientRect()
      if (event.clientX >= bounds.left + element.clientLeft + element.clientWidth ||
        event.clientY >= bounds.top + element.clientTop + element.clientHeight) return
      event.preventDefault()
      element.focus({ preventScroll: true })
      element.setPointerCapture(event.pointerId)
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
      element.classList.add('is-panning')
    }
    const pan = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return
      element.scrollLeft = pointer.left + pointer.x - event.clientX
      element.scrollTop = pointer.top + pointer.y - event.clientY
    }
    const finishPanning = (event: PointerEvent) => {
      if (pointer?.id === event.pointerId) stopPanning()
    }
    const remember = () => {
      if (previousLayout.current && element.clientWidth && element.clientHeight) current.current = { ...current.current, ...imageCenter(previousLayout.current, element.scrollLeft, element.scrollTop) }
    }
    capture.current = remember
    const measure = () => {
      stopPanning()
      // Hidden retained readers report zero geometry, not a new image center.
      if (!element.clientWidth || !element.clientHeight) previousLayout.current = null
      remember()
      setViewport(previous => previous.width === element.clientWidth && previous.height === element.clientHeight
        ? previous : { width: element.clientWidth, height: element.clientHeight })
      if (element.clientWidth && element.clientHeight) {
        const complete = deferredLoad.current
        deferredLoad.current = null
        complete?.()
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element.addEventListener('pointerdown', startPanning)
    element.addEventListener('pointermove', pan)
    element.addEventListener('pointerup', finishPanning)
    element.addEventListener('pointercancel', finishPanning)
    element.addEventListener('lostpointercapture', finishPanning)
    element.addEventListener('blur', stopPanning)
    window.addEventListener('blur', stopPanning)
    return () => {
      stopPanning()
      cancelPan.current = null
      remember()
      capture.current = null
      observer.disconnect()
      element.removeEventListener('pointerdown', startPanning)
      element.removeEventListener('pointermove', pan)
      element.removeEventListener('pointerup', finishPanning)
      element.removeEventListener('pointercancel', finishPanning)
      element.removeEventListener('lostpointercapture', finishPanning)
      element.removeEventListener('blur', stopPanning)
      window.removeEventListener('blur', stopPanning)
    }
  }, [capture, current])

  useLayoutEffect(() => {
    if (!layout || !area.current) return
    cancelPan.current?.()
    const position = imageScroll(layout, current.current)
    area.current.scrollLeft = position.left
    area.current.scrollTop = position.top
    previousLayout.current = layout
    current.current = { ...current.current, ...imageCenter(layout, area.current.scrollLeft, area.current.scrollTop) }
    setScale(layout.scale)
  }, [layout, current, setScale])

  const canPan = layout && (Math.round(layout.width) > viewport.width || Math.round(layout.height) > viewport.height)
  return <div ref={area} className={`image-viewer image-reader${canPan ? ' can-pan' : ''}`} data-background={image.view.background} role="region" aria-label={`${name} image`} tabIndex={0}
    onScroll={() => capture.current?.()}>
    {!visible && failedURL === url ? <ErrorState title="Couldn’t display this image" message="The image may be unsupported, unavailable, or its preview may have expired." retry={retry} />
      : <>
        {!visible && <Loading message="Opening image…" />}
        <div className="image-stage" style={{ width: layout?.width ?? '100%', height: layout?.height ?? '100%' }}>
          {urls.map(source => <img key={source} className={source === visible?.url ? '' : 'pending-preview'} src={source} alt={name}
            aria-hidden={source !== visible?.url} referrerPolicy="no-referrer" draggable={false}
            style={source === visible?.url && layout ? { width: visible.width * layout.scale, height: visible.height * layout.scale, transform: `translate(-50%, -50%) rotate(${image.view.rotation}deg)` } : undefined}
            onLoad={event => {
              const element = event.currentTarget
              const complete = () => {
                if (source !== currentURL.current || !element.isConnected) return
                let { naturalWidth: width, naturalHeight: height } = element
                // A loaded SVG can have an aspect ratio without intrinsic dimensions.
                // The pending image's fixed-width probe keeps this independent of zoom.
                if (!width || !height) {
                  const bounds = element.getBoundingClientRect()
                  width = bounds.width
                  height = bounds.height
                }
                if ((!width || !height) && (!area.current?.clientWidth || !area.current?.clientHeight)) {
                  // A hidden reader has no probe geometry; retry when it is measurable.
                  deferredLoad.current = complete
                  return
                }
                deferredLoad.current = null
                if (!width || !height) { setFailedURL(source); onError(); return }
                capture.current?.()
                setVisible({ url: source, width, height })
                onReady()
              }
              complete()
            }}
            onError={() => { if (source === currentURL.current) { deferredLoad.current = null; setFailedURL(source); onError() } }} />)}
        </div>
      </>}
  </div>
}
