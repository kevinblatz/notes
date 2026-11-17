/** An image inside the editor: resizable from its corner (aspect ratio kept), with an optional caption. */
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Maximize2 } from 'lucide-react'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { attachmentUrl } from '@shared/types'
import { openImagePreview } from '../../state/actions'

const MIN_WIDTH = 10

export function ImageNodeView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const attachmentId = String(node.attrs.attachmentId ?? '')
  const caption = String(node.attrs.caption ?? '')
  const storedWidth = Number(node.attrs.width ?? 100)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [missing, setMissing] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const width = dragWidth ?? storedWidth

  const startResize = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const frame = wrapper.current
    const container = frame?.parentElement
    if (!frame || !container) return
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startPx = frame.getBoundingClientRect().width
    const containerPx = container.getBoundingClientRect().width || 1
    let latest = storedWidth
    const onMove = (move: PointerEvent): void => {
      latest = Math.round(Math.min(100, Math.max(MIN_WIDTH, ((startPx + move.clientX - startX) / containerPx) * 100)))
      setDragWidth(latest)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      setDragWidth(null)
      if (latest !== storedWidth) updateAttributes({ width: latest })
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const resizeByKey = (delta: number): void => updateAttributes({ width: Math.min(100, Math.max(MIN_WIDTH, storedWidth + delta)) })

  return (
    <NodeViewWrapper className={`image-node${selected ? ' is-selected' : ''}${missing ? ' is-missing' : ''}`} style={{ width: `${width}%` }} ref={wrapper} data-drag-handle>
      <div className="image-frame">
        {missing ? (
          <div className="image-missing">Image file missing</div>
        ) : (
          <img
            src={attachmentUrl(attachmentId, 'preview')}
            alt={caption}
            width={Number(node.attrs.naturalWidth) || undefined}
            height={Number(node.attrs.naturalHeight) || undefined}
            draggable={false}
            onError={() => setMissing(true)}
            onDoubleClick={() => openImagePreview(attachmentId, caption)}
          />
        )}
        <button type="button" className="image-zoom" aria-label="Open larger preview" title="Open larger preview" onClick={() => openImagePreview(attachmentId, caption)} contentEditable={false}>
          <Maximize2 size={15} />
        </button>
        {editor.isEditable ? (
          <span
            className="image-resize"
            role="slider"
            tabIndex={0}
            aria-label="Image width"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={100}
            aria-valuenow={width}
            aria-valuetext={`${width}% of the note width`}
            title="Drag to resize. Arrow keys also work."
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                event.preventDefault()
                event.stopPropagation()
                resizeByKey(-5)
              } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopPropagation()
                resizeByKey(5)
              }
            }}
          />
        ) : null}
        {dragWidth !== null ? <span className="image-size-badge">{dragWidth}%</span> : null}
      </div>
      <input
        className="image-caption"
        type="text"
        value={caption}
        placeholder="Add a caption"
        aria-label="Image caption"
        maxLength={2000}
        onChange={(event) => updateAttributes({ caption: event.target.value })}
        onKeyDown={(event) => {
          // Keep typing keys in the caption field instead of handing them to the editor.
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
            editor.commands.focus()
          }
        }}
      />
    </NodeViewWrapper>
  )
}
