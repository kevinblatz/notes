/** Larger image view with zoom and pan. An overlay inside the notes window, closed with Esc. */
import { Minus, Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'
import { attachmentUrl } from '@shared/types'
import { useEscape } from '../lib/escape'
import { closeImagePreview } from '../state/actions'
import { useStore } from '../state/store'
import { IconButton, useFocusTrap } from './ui'

const MIN_ZOOM = 1
const MAX_ZOOM = 8

export function ImagePreview() {
  const preview = useStore((s) => s.preview)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const panel = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEscape(preview !== null, closeImagePreview)
  useFocusTrap(panel, preview !== null)
  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    if (preview) panel.current?.querySelector<HTMLElement>('button')?.focus()
  }, [preview])

  if (!preview) return null

  const applyZoom = (next: number): void => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    setZoom(clamped)
    if (clamped === 1) setOffset({ x: 0, y: 0 })
  }
  const onWheel = (event: WheelEvent): void => applyZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15))
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (zoom === 1 || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragging.current
    if (start) setOffset({ x: start.ox + event.clientX - start.x, y: start.oy + event.clientY - start.y })
  }
  const endDrag = (): void => {
    dragging.current = null
  }

  return (
    <div className="preview-layer" ref={panel} role="dialog" aria-modal="true" aria-label="Image preview" data-overlay data-testid="image-preview">
      <div className="preview-bar">
        <span className="preview-caption" title={preview.caption || undefined}>
          {preview.caption}
        </span>
        <IconButton label="Zoom out" hint="-" disabled={zoom <= MIN_ZOOM} onClick={() => applyZoom(zoom / 1.4)}><Minus size={16} /></IconButton>
        <span className="preview-zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" hint="+" disabled={zoom >= MAX_ZOOM} onClick={() => applyZoom(zoom * 1.4)}><Plus size={16} /></IconButton>
        <IconButton label="Fit to window" disabled={zoom === 1} onClick={() => applyZoom(1)}><RotateCcw size={15} /></IconButton>
        <IconButton label="Close preview" hint="Esc" onClick={closeImagePreview}><X size={16} /></IconButton>
      </div>
      <div
        className={`preview-stage${zoom > 1 ? ' is-zoomed' : ''}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(event) => {
          if (event.target === event.currentTarget && zoom === 1) closeImagePreview()
        }}
        onKeyDown={(event) => {
          if (event.key === '+' || event.key === '=') applyZoom(zoom * 1.4)
          else if (event.key === '-') applyZoom(zoom / 1.4)
          else if (event.key === '0') applyZoom(1)
        }}
        tabIndex={0}
      >
        <img
          src={attachmentUrl(preview.attachmentId, 'full')}
          alt={preview.caption}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          onDoubleClick={() => applyZoom(zoom === 1 ? 2.5 : 1)}
        />
      </div>
    </div>
  )
}
