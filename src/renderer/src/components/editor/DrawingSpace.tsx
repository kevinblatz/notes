/**
 * The drawing space: a blank sheet over the whole window below the title bar (an overlay in
 * this same window, never a new one). Draw anything at any size; Done crops the drawing to
 * what was drawn and puts it in the note the way a pasted screenshot goes in.
 *
 * Pointer input never goes through React: samples are collected from coalesced pointer
 * events and painted in one animation frame per screen refresh, only while a stroke is being
 * drawn. Everything drawn is kept as a list of strokes in CSS pixels, so undo, redo, a window
 * resize and the export redraw it exactly.
 */
import type { Editor } from '@tiptap/core'
import { Eraser, Redo2, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { displayWidthPercent, placeCentered, pushPoint, type DrawOp, type InkPoint } from '@shared/drawing'
import { useEscape } from '../../lib/escape'
import { importImageFile } from '../../lib/images'
import { toast } from '../../state/actions'
import { useStore } from '../../state/store'
import { IconButton } from '../ui'
import {
  BRUSH_SIZES,
  brushCursor,
  colorLabel,
  colorVar,
  DRAW_COLORS,
  ERASER_SIZES,
  eraseSegment,
  exportDrawing,
  hasVisibleInk,
  lightness,
  loadDrawing,
  paintScene,
  paintStroke,
  penPath,
  resolvePalette,
  sheetColor,
  SIZE_LABELS,
  type BaseLayer,
  type DrawColor,
  type DrawTool,
  type Palette,
  type Stroke
} from './drawingInk'
import { closeDrawing, type DrawingTarget } from './drawingSession'
import { insertDrawingNode, removeDrawingNode, replaceDrawingNode } from './extensions'

/** Kept clear for the toolbar when an edited drawing is placed on the sheet. */
const TOOLBAR_RESERVE = 64
/** How close (CSS px) ink may come to the toolbar before it fades out of the way. */
const TOOLBAR_CLEARANCE = 32

/** The last colour and size used, for the next drawing in this session. */
const remembered: { color: DrawColor; sizeIndex: number } = { color: 'ink', sizeIndex: 1 }

interface Scene {
  ops: DrawOp<Stroke>[]
  redo: DrawOp<Stroke>[]
  base: BaseLayer | null
  /** The stroke being drawn right now. */
  active: Stroke | null
}

interface Surface {
  ink: CanvasRenderingContext2D
  live: CanvasRenderingContext2D
  cssWidth: number
  cssHeight: number
  scale: number
}

interface Status {
  canUndo: boolean
  canRedo: boolean
  hasInk: boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : String(error)
}

export function DrawingSpace({ editor, target }: { editor: Editor; target: DrawingTarget }) {
  const layerRef = useRef<HTMLDivElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<HTMLCanvasElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const [scene] = useState<Scene>(() => ({ ops: [], redo: [], base: null, active: null }))
  const surface = useRef<Surface | null>(null)
  const palette = useRef<Palette | null>(null)
  const pointer = useRef<{ id: number | null; frame: number; erased: number; predicted: InkPoint[] }>({ id: null, frame: 0, erased: 0, predicted: [] })

  const theme = useStore((s) => s.prefs.theme)
  const [tool, setTool] = useState<DrawTool>('pen')
  const [color, setColor] = useState<DrawColor>(remembered.color)
  const [sizeIndex, setSizeIndex] = useState(remembered.sizeIndex)
  const [status, setStatus] = useState<Status>({ canUndo: false, canRedo: false, hasInk: false })
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(target.kind === 'edit')
  // The sheet starts just under the title bar, which stays usable (move, minimize, hide).
  const [top] = useState(() => Math.max(0, Math.round(document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0)))

  const settings = useRef({ tool, color, sizeIndex })
  settings.current = { tool, color, sizeIndex }
  const blocked = useRef(false)
  blocked.current = busy || confirming || loading
  remembered.color = color
  remembered.sizeIndex = sizeIndex

  const sync = useCallback((): void => {
    setStatus({ canUndo: scene.ops.length > 0, canRedo: scene.redo.length > 0, hasInk: hasVisibleInk(scene.base, scene.ops) })
  }, [scene])

  /** Something would be lost by closing: new ink on a new sheet, or any change to an edited drawing. */
  const changed = useCallback((): boolean => (target.kind === 'edit' ? scene.ops.length > 0 : hasVisibleInk(scene.base, scene.ops)), [scene, target.kind])

  const clearLive = (s: Surface): void => {
    s.live.setTransform(1, 0, 0, 1, 0, 0)
    s.live.clearRect(0, 0, s.live.canvas.width, s.live.canvas.height)
    s.live.setTransform(s.scale, 0, 0, s.scale, 0, 0)
  }

  /** Repaint everything kept so far (after undo, redo, clear, a resize or the starting picture loading). */
  const redrawInk = useCallback((): void => {
    const s = surface.current
    if (!s) return
    s.ink.setTransform(1, 0, 0, 1, 0, 0)
    s.ink.clearRect(0, 0, s.ink.canvas.width, s.ink.canvas.height)
    s.ink.setTransform(s.scale, 0, 0, s.scale, 0, 0)
    const colors = resolvePalette()
    paintScene(s.ink, scene.base, scene.ops, colors)
    // An eraser stroke in progress has already taken its bite out of the old picture.
    if (scene.active?.tool === 'eraser') paintStroke(s.ink, scene.active, colors)
  }, [scene])

  /** One frame of the stroke being drawn. */
  const paintActive = useCallback((): void => {
    const state = pointer.current
    state.frame = 0
    const stroke = scene.active
    const s = surface.current
    if (!stroke || !s) return
    if (stroke.tool === 'pen') {
      clearLive(s)
      s.live.fillStyle = palette.current?.[stroke.color] ?? '#888'
      s.live.fill(penPath(state.predicted.length > 0 ? [...stroke.points, ...state.predicted] : stroke.points, stroke))
    } else {
      const points = stroke.points
      for (; state.erased < points.length; state.erased++) eraseSegment(s.ink, points[Math.max(0, state.erased - 1)]!, points[state.erased]!, stroke.size)
    }
  }, [scene])

  const finishStroke = useCallback((): void => {
    const stroke = scene.active
    if (!stroke) return
    const state = pointer.current
    if (state.frame) cancelAnimationFrame(state.frame)
    state.frame = 0
    const id = state.id
    state.id = null
    state.predicted = []
    scene.active = null
    const canvas = liveRef.current
    if (canvas && id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id)
    layerRef.current?.classList.remove('is-inking', 'is-near-tools')
    const s = surface.current
    if (s) {
      if (stroke.tool === 'pen') {
        clearLive(s)
        paintStroke(s.ink, stroke, palette.current ?? resolvePalette())
      } else {
        const points = stroke.points
        for (; state.erased < points.length; state.erased++) eraseSegment(s.ink, points[Math.max(0, state.erased - 1)]!, points[state.erased]!, stroke.size)
      }
    }
    scene.ops.push({ kind: 'stroke', stroke })
    scene.redo = []
    sync()
  }, [scene, sync])

  // ------------------------------------------------------------ canvas size

  useLayoutEffect(() => {
    const ink = inkRef.current
    const live = liveRef.current
    const inkContext = ink?.getContext('2d')
    const liveContext = live?.getContext('2d')
    if (!ink || !live || !inkContext || !liveContext) return
    const apply = (cssWidth: number, cssHeight: number, deviceWidth: number, deviceHeight: number): void => {
      if (cssWidth <= 0 || cssHeight <= 0) return
      const current = surface.current
      if (current && ink.width === deviceWidth && ink.height === deviceHeight && current.cssWidth === cssWidth) return
      for (const canvas of [ink, live]) {
        canvas.width = deviceWidth
        canvas.height = deviceHeight
      }
      surface.current = { ink: inkContext, live: liveContext, cssWidth, cssHeight, scale: deviceWidth / cssWidth }
      // Nothing is stretched or lost: strokes are kept in CSS pixels from the top-left corner
      // and simply painted again at the new size (ink beyond the edge comes back when it grows).
      redrawInk()
      if (scene.active?.tool === 'pen') paintActive()
    }
    const box = ink.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    apply(box.width, box.height, Math.round(box.width * ratio), Math.round(box.height * ratio))
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      const device = entry.devicePixelContentBoxSize?.[0]
      const scale = window.devicePixelRatio || 1
      apply(width, height, device ? device.inlineSize : Math.round(width * scale), device ? device.blockSize : Math.round(height * scale))
    })
    try {
      observer.observe(ink, { box: 'device-pixel-content-box' })
    } catch {
      observer.observe(ink)
    }
    return () => observer.disconnect()
  }, [scene, redrawInk, paintActive])

  // ------------------------------------------------------------ the picture an edit starts from

  useEffect(() => {
    if (target.kind !== 'edit') return
    let cancelled = false
    loadDrawing(target.attachmentId, target.scale ?? surface.current?.scale ?? window.devicePixelRatio ?? 1).then(
      (loaded) => {
        if (cancelled) return
        const s = surface.current
        const width = s?.cssWidth ?? window.innerWidth
        const height = s?.cssHeight ?? window.innerHeight
        const scale = s?.scale ?? window.devicePixelRatio ?? 1
        const at = placeCentered(loaded.width, loaded.height, width, height - TOOLBAR_RESERVE)
        // On whole device pixels, so the picture is shown and saved again without any blur.
        scene.base = { image: loaded.image, x: Math.round(at.x * scale) / scale, y: Math.round(at.y * scale) / scale, width: loaded.width, height: loaded.height }
        redrawInk()
        sync()
        setLoading(false)
      },
      () => {
        if (cancelled) return
        toast('This drawing could not be opened for editing.', { kind: 'error', duration: 8000 })
        editor.view.focus()
        closeDrawing()
      }
    )
    return () => {
      cancelled = true
    }
    // The target never changes while the space is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------ pointer input

  useEffect(() => {
    const canvas = liveRef.current
    const layer = layerRef.current
    if (!canvas || !layer) return
    let origin = { x: 0, y: 0 }
    let tools: DOMRect | null = null
    const state = pointer.current
    const toPoint = (event: PointerEvent): InkPoint => [event.clientX - origin.x, event.clientY - origin.y, event.pointerType === 'pen' ? Math.max(0.05, event.pressure) : 0.5]

    const frame = (): void => {
      paintActive()
      // Ink coming close to the toolbar: the toolbar steps out of the way until the stroke ends.
      const stroke = scene.active
      const last = stroke?.points[stroke.points.length - 1]
      if (last && tools && !layer.classList.contains('is-near-tools')) {
        const x = last[0] + origin.x
        const y = last[1] + origin.y
        if (y > tools.top - TOOLBAR_CLEARANCE && x > tools.left - TOOLBAR_CLEARANCE && x < tools.right + TOOLBAR_CLEARANCE) layer.classList.add('is-near-tools')
      }
    }
    const schedule = (): void => {
      if (!state.frame) state.frame = requestAnimationFrame(frame)
    }

    const down = (event: PointerEvent): void => {
      if (state.id !== null || blocked.current) return
      const eraserEnd = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) === 32)
      if (event.button !== 0 && !eraserEnd) return
      event.preventDefault()
      const box = layer.getBoundingClientRect()
      origin = { x: box.left, y: box.top }
      tools = toolbarRef.current?.getBoundingClientRect() ?? null
      const current = settings.current
      const erasing = eraserEnd || current.tool === 'eraser'
      try {
        canvas.setPointerCapture(event.pointerId)
      } catch {
        // A pointer that is already gone: the stroke still starts and ends normally.
      }
      state.id = event.pointerId
      state.erased = 0
      state.predicted = []
      palette.current = resolvePalette()
      scene.active = {
        tool: erasing ? 'eraser' : 'pen',
        color: current.color,
        size: erasing ? ERASER_SIZES[current.sizeIndex]! : BRUSH_SIZES[current.sizeIndex]!,
        pressure: event.pointerType === 'pen',
        points: [toPoint(event)]
      }
      layer.classList.add('is-inking')
      schedule()
    }
    const move = (event: PointerEvent): void => {
      const stroke = scene.active
      if (event.pointerId !== state.id || !stroke) return
      // Every position the pointer reported since the last event, not just the latest one.
      const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
      for (const sample of samples.length > 0 ? samples : [event]) pushPoint(stroke.points, toPoint(sample))
      // Where the pointer is about to be, drawn for this frame only, so the line keeps up with it.
      const ahead = stroke.tool === 'pen' && typeof event.getPredictedEvents === 'function' ? event.getPredictedEvents() : []
      state.predicted = ahead.length > 0 ? [toPoint(ahead[0]!)] : []
      schedule()
    }
    const up = (event: PointerEvent): void => {
      if (event.pointerId === state.id) finishStroke()
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('lostpointercapture', up)
    return () => {
      if (state.frame) cancelAnimationFrame(state.frame)
      state.frame = 0
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      canvas.removeEventListener('lostpointercapture', up)
    }
  }, [scene, paintActive, finishStroke])

  // ------------------------------------------------------------ actions

  const undo = (): void => {
    if (blocked.current || scene.active) return
    const op = scene.ops.pop()
    if (!op) return
    scene.redo.push(op)
    redrawInk()
    sync()
  }
  const redo = (): void => {
    if (blocked.current || scene.active) return
    const op = scene.redo.pop()
    if (!op) return
    scene.ops.push(op)
    redrawInk()
    sync()
  }
  const clear = (): void => {
    if (blocked.current || scene.active || !hasVisibleInk(scene.base, scene.ops)) return
    // Clearing is one more step in the history, so Undo brings everything back.
    scene.ops.push({ kind: 'clear' })
    scene.redo = []
    redrawInk()
    sync()
  }

  /** Leave the drawing space, handing the keyboard back to the text. */
  const leave = useCallback((): void => {
    if (!editor.isDestroyed) editor.view.focus()
    closeDrawing()
  }, [editor])

  const requestCancel = (): void => {
    if (busy || loading) return
    finishStroke()
    if (changed()) setConfirming(true)
    else leave()
  }

  const done = async (): Promise<void> => {
    if (blocked.current) return
    finishStroke()
    if (target.kind === 'edit' && scene.ops.length === 0) {
      leave()
      return
    }
    setBusy(true)
    blocked.current = true
    try {
      const exported = await exportDrawing(scene.base, scene.ops, surface.current?.scale ?? window.devicePixelRatio ?? 1)
      if (!exported) {
        // Nothing left on the sheet. An edited drawing that was wiped leaves the note (Ctrl+Z there brings it back).
        if (target.kind === 'edit') removeDrawingNode(editor, target.attachmentId, target.getPos())
        leave()
        return
      }
      // Exactly the path a pasted screenshot takes: a managed attachment with its own preview.
      const file = new File([exported.bytes], 'Drawing.png', { type: 'image/png' })
      const { attachment, width, height } = await importImageFile(file)
      if (editor.isDestroyed) return
      const attrs = { attachmentId: attachment.id, naturalWidth: width, naturalHeight: height, drawing: Math.round(exported.scale * 100) / 100 }
      const replaced = target.kind === 'edit' && replaceDrawingNode(editor, target.attachmentId, target.getPos(), attrs)
      if (!replaced) {
        const spaceWidth = surface.current?.cssWidth ?? window.innerWidth
        insertDrawingNode(editor, { ...attrs, width: displayWidthPercent(exported.cssWidth, spaceWidth) })
      }
      leave()
    } catch (error) {
      toast(`The drawing could not be added. ${errorText(error)}`, { kind: 'error', duration: 9000 })
      setBusy(false)
    }
  }

  // Esc: the question if one is showing, otherwise cancel (asking first when something was drawn).
  useEscape(true, requestCancel)
  useEscape(confirming, () => setConfirming(false))

  // The question takes the keyboard while it shows; afterwards the sheet has it again.
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    else if (layerRef.current && !layerRef.current.contains(document.activeElement)) layerRef.current.focus({ preventScroll: true })
  }, [confirming])

  useLayoutEffect(() => {
    layerRef.current?.focus({ preventScroll: true })
  }, [])

  // Keys while the sheet is open. Registered ahead of everything else in the window, so
  // Ctrl+Enter finishes the drawing and never also logs the note, and nothing else opens on top.
  const keys = useRef({ undo, redo, done, setTool, setSizeIndex })
  keys.current = { undo, redo, done, setTool, setSizeIndex }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.key === 'Escape') return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      const stop = (): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      if (mod && !event.altKey) {
        if (key === 'enter') {
          stop()
          void keys.current.done()
        } else if (key === 'z' && !event.shiftKey) {
          stop()
          keys.current.undo()
        } else if ((key === 'y' && !event.shiftKey) || (key === 'z' && event.shiftKey)) {
          stop()
          keys.current.redo()
        } else if (key === 'k' || key === ',' || key === 'n' || key === 'd' || key === 'a') {
          // Find, Settings, a new note: not on top of a drawing in progress.
          stop()
        }
        return
      }
      if (event.altKey || blocked.current) return
      if (key === 'e') {
        stop()
        keys.current.setTool((current) => (current === 'eraser' ? 'pen' : 'eraser'))
      } else if (key === '1' || key === '2' || key === '3') {
        stop()
        keys.current.setSizeIndex(Number(key) - 1)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Tab stays inside the sheet (or inside the question while it shows).
  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const scope = confirmRef.current ?? layerRef.current
    const items = Array.from(scope?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : index === -1 || index === items.length - 1 ? 0 : index + 1
    items[next]!.focus()
  }

  const cursor = useMemo(() => {
    const colors = resolvePalette()
    const dark = lightness(sheetColor()) < 0.5
    return tool === 'eraser' ? brushCursor('eraser', ERASER_SIZES[sizeIndex]!, readSoftInk(), dark) : brushCursor('pen', BRUSH_SIZES[sizeIndex]!, colors[color], dark)
    // The theme changes the colours behind the variables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, color, sizeIndex, theme])

  const pickColor = (next: DrawColor): void => {
    setColor(next)
    setTool('pen')
  }
  const empty = !status.hasInk && !loading

  return createPortal(
    <div
      ref={layerRef}
      className={`draw-layer${busy ? ' is-busy' : ''}`}
      style={{ top }}
      role="dialog"
      aria-modal="true"
      aria-label="Drawing space"
      tabIndex={-1}
      data-overlay
      data-testid="drawing-space"
      data-mode={target.kind}
      onKeyDown={trapTab}
    >
      <canvas ref={inkRef} className="draw-canvas" data-testid="drawing-ink" aria-hidden="true" />
      <canvas ref={liveRef} className="draw-canvas draw-input" style={{ cursor }} role="img" aria-label="Drawing sheet. Draw with the mouse or a pen." data-testid="drawing-canvas" />
      {empty ? (
        <p className="draw-hint" aria-hidden="true">
          Draw anywhere
          <span>Done, or Ctrl + Enter, puts it in your note</span>
        </p>
      ) : null}

      <div ref={toolbarRef} className="draw-toolbar" role="toolbar" aria-label="Drawing tools">
        <div className={`draw-swatches${tool === 'eraser' ? ' is-idle' : ''}`} role="radiogroup" aria-label="Ink color">
          {DRAW_COLORS.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={color === name}
              aria-label={colorLabel(name)}
              title={colorLabel(name)}
              className="draw-swatch"
              style={{ ['--swatch' as string]: `var(${colorVar(name)})` }}
              onClick={() => pickColor(name)}
            />
          ))}
        </div>
        <span className="draw-divider" />
        <div className="draw-sizes" role="radiogroup" aria-label="Brush size">
          {SIZE_LABELS.map((label, index) => (
            <button key={label} type="button" role="radio" aria-checked={sizeIndex === index} aria-label={label} title={`${label} (${index + 1})`} className="draw-size" onClick={() => setSizeIndex(index)}>
              <span style={{ width: 3 + index * 3.5, height: 3 + index * 3.5 }} />
            </button>
          ))}
        </div>
        <IconButton label="Eraser" hint="E" active={tool === 'eraser'} onClick={() => setTool(tool === 'eraser' ? 'pen' : 'eraser')}>
          <Eraser size={16} />
        </IconButton>
        <span className="draw-divider" />
        <IconButton label="Undo" hint="Ctrl+Z" disabled={!status.canUndo} onClick={undo}>
          <Undo2 size={16} />
        </IconButton>
        <IconButton label="Redo" hint="Ctrl+Y" disabled={!status.canRedo} onClick={redo}>
          <Redo2 size={16} />
        </IconButton>
        <IconButton label="Clear" hint="Undo brings it back" disabled={!status.hasInk} onClick={clear}>
          <Trash2 size={16} />
        </IconButton>
        <span className="draw-divider" />
        <button type="button" className="ghost-button draw-cancel" title="Cancel (Esc)" onClick={requestCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary-button draw-done" title="Put the drawing in the note (Ctrl+Enter)" onClick={() => void done()} disabled={busy || loading}>
          {busy ? 'Adding…' : 'Done'}
          <kbd>Ctrl ↵</kbd>
        </button>
      </div>

      {confirming ? (
        <div className="draw-confirm-layer" onPointerDown={(event) => event.target === event.currentTarget && setConfirming(false)}>
          <div ref={confirmRef} className="draw-confirm" role="alertdialog" aria-modal="true" aria-labelledby="draw-confirm-title" aria-describedby="draw-confirm-text">
            <h2 id="draw-confirm-title">Discard this drawing?</h2>
            <p id="draw-confirm-text">{target.kind === 'edit' ? 'Your changes will be lost. The note keeps the drawing as it was.' : 'It will not be added to the note.'}</p>
            <div className="button-row">
              <button type="button" className="small-button" data-autofocus onClick={() => setConfirming(false)}>
                Keep drawing
              </button>
              <button type="button" className="danger-button" onClick={leave}>
                Discard
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body
  )
}

function readSoftInk(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--ink-soft').trim() || '#b9b3a8'
}
