/**
 * Ink for the drawing space: brush settings, the theme's colours, painting strokes (shaped
 * in drawingStroke.ts) and the eraser on a canvas, and exporting the finished drawing as a
 * PNG cropped to what was drawn.
 */
import { INK_COLORS } from '@shared/content'
import {
  alphaBounds,
  cornerColor,
  DRAWING_MARGIN,
  expandRect,
  exportScale,
  intersectRect,
  matchColor,
  MAX_DRAWING_BYTES,
  parseHexColor,
  pointsBounds,
  removeBackground,
  snapRectOut,
  unionRect,
  visibleOps,
  type DrawOp,
  type InkPoint,
  type Rect
} from '@shared/drawing'
import { THEMES } from '@shared/preferences'
import { attachmentUrl, type ThemeKey } from '@shared/types'
import { penOutline, type PenSettings } from './drawingStroke'

/** The note's own ink colours, led by the theme's text colour. */
export const DRAW_COLORS = ['ink', ...INK_COLORS] as const
export type DrawColor = (typeof DRAW_COLORS)[number]

export const SIZE_LABELS = ['Fine', 'Medium', 'Bold'] as const
/** Eraser diameters, in CSS pixels (its cursor ring stays within 32 px). */
export const ERASER_SIZES = [12, 20, 28] as const

export type DrawTool = 'pen' | 'eraser'

/** One stroke of the pen or the eraser (`size` is the eraser's diameter for the eraser). */
export interface Stroke extends PenSettings {
  tool: DrawTool
  color: DrawColor
  points: InkPoint[]
}

/** The picture an edited drawing starts from: ink on a transparent layer, placed in CSS pixels. */
export interface BaseLayer {
  image: CanvasImageSource
  x: number
  y: number
  width: number
  height: number
}

export type Palette = Record<DrawColor, string>

/**
 * A theme's colours as real values (the export is a picture, not a page that knows the
 * variables): the sheet a drawing is painted on, its ink colours, and the soft ink the
 * eraser's ring is drawn in.
 */
export interface Inks {
  sheet: string
  soft: string
  palette: Palette
}

const colorVar = (color: DrawColor): string => (color === 'ink' ? '--ink' : `--ink-${color}`)

export function colorLabel(color: DrawColor): string {
  return color === 'ink' ? 'Ink' : color[0]!.toUpperCase() + color.slice(1)
}

/**
 * The colours of a theme, read from a hidden element that carries it. Read by theme name
 * rather than from the window, so they are right even before the window has switched to a
 * newly chosen theme, and for a drawing that was made in another theme. A theme that only
 * changes a few tokens (midnight) is laid over the base theme, as it is on the window.
 */
export function themeInks(theme: ThemeKey): Inks {
  const base = document.createElement('div')
  base.dataset.theme = 'charcoal'
  base.hidden = true
  const probe = document.createElement('div')
  probe.dataset.theme = theme
  base.append(probe)
  document.body.append(base)
  try {
    const style = getComputedStyle(probe)
    const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
    return {
      sheet: read('--sheet', '#25262a'),
      soft: read('--ink-soft', '#b9b3a8'),
      palette: Object.fromEntries(DRAW_COLORS.map((color) => [color, read(colorVar(color), '#888888')])) as Palette
    }
  } finally {
    base.remove()
  }
}

/** The app theme whose sheet a saved drawing was painted on (its corner colour), if any. */
export function themeOfSheet(background: readonly [number, number, number]): ThemeKey | null {
  return matchColor(
    background,
    THEMES.map((theme) => [theme, themeInks(theme).sheet] as const)
  )
}

/** Closed outline of a pen stroke as a smooth path (quadratic curves through midpoints). */
export function penPath(points: readonly InkPoint[], stroke: Stroke): Path2D {
  const outline = penOutline(points, stroke)
  const path = new Path2D()
  const count = outline.length
  if (count < 2) return path
  path.moveTo(outline[0]![0], outline[0]![1])
  for (let i = 0; i < count; i++) {
    const [x0, y0] = outline[i]!
    const [x1, y1] = outline[(i + 1) % count]!
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  path.closePath()
  return path
}

const finishedPaths = new WeakMap<Stroke, Path2D>()

function finishedPath(stroke: Stroke): Path2D {
  let path = finishedPaths.get(stroke)
  if (!path) {
    path = penPath(stroke.points, stroke)
    finishedPaths.set(stroke, path)
  }
  return path
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Erase along one segment (or a dot), with round ends so consecutive segments join seamlessly. */
export function eraseSegment(ctx: Context2D, from: InkPoint, to: InkPoint, size: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = size
  ctx.strokeStyle = '#000'
  ctx.fillStyle = '#000'
  ctx.beginPath()
  if (from[0] === to[0] && from[1] === to[1]) {
    ctx.arc(to[0], to[1], size / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.moveTo(from[0], from[1])
    ctx.lineTo(to[0], to[1])
    ctx.stroke()
  }
  ctx.restore()
}

export function paintStroke(ctx: Context2D, stroke: Stroke, palette: Palette): void {
  if (stroke.tool === 'eraser') {
    const points = stroke.points
    for (let i = 0; i < points.length; i++) eraseSegment(ctx, points[Math.max(0, i - 1)]!, points[i]!, stroke.size)
    return
  }
  ctx.fillStyle = palette[stroke.color]
  ctx.fill(finishedPath(stroke))
}

function paintBase(ctx: Context2D, base: BaseLayer): void {
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(base.image, base.x, base.y, base.width, base.height)
}

/** Everything on the sheet, in order: the starting picture (unless cleared), then each stroke. */
export function paintScene(ctx: Context2D, base: BaseLayer | null, ops: readonly DrawOp<Stroke>[], palette: Palette): void {
  const { strokes, baseVisible } = visibleOps(ops)
  if (base && baseVisible) paintBase(ctx, base)
  for (const stroke of strokes) paintStroke(ctx, stroke, palette)
}

/** Upper bound of where ink can be: pen strokes and the starting picture (erasing only removes ink). */
function sceneBounds(base: BaseLayer | null, ops: readonly DrawOp<Stroke>[]): Rect | null {
  const { strokes, baseVisible } = visibleOps(ops)
  let bounds: Rect | null = base && baseVisible ? { x: base.x, y: base.y, width: base.width, height: base.height } : null
  for (const stroke of strokes) {
    if (stroke.tool === 'pen') bounds = unionRect(bounds, pointsBounds(stroke.points, stroke.size + 1))
  }
  return bounds
}

/** True when there is something that a Clear would remove. */
export function hasVisibleInk(base: BaseLayer | null, ops: readonly DrawOp<Stroke>[]): boolean {
  const { strokes, baseVisible } = visibleOps(ops)
  return (base !== null && baseVisible) || strokes.some((stroke) => stroke.tool === 'pen')
}

/**
 * Reopen a finished drawing for editing: its original file, turned back into ink on a
 * transparent layer (the sheet colour it was saved on is taken out again), with its size in
 * CSS pixels as it was drawn, and that sheet colour. Loaded as an image (the window may show
 * attachments but not fetch them); the attachment scheme allows the pixels to be read back.
 */
export async function loadDrawing(
  attachmentId: string,
  scale: number
): Promise<{ image: OffscreenCanvas; width: number; height: number; background: [number, number, number] }> {
  const picture = new Image()
  picture.crossOrigin = 'anonymous'
  picture.src = attachmentUrl(attachmentId, 'full')
  await picture.decode()
  const canvas = new OffscreenCanvas(picture.naturalWidth, picture.naturalHeight)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('The drawing could not be opened.')
  context.drawImage(picture, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const background = cornerColor(pixels.data, canvas.width, canvas.height)
  removeBackground(pixels.data, background)
  context.putImageData(pixels, 0, 0)
  return { image: canvas, width: canvas.width / scale, height: canvas.height / scale, background }
}

/**
 * The pointer in the drawing space: a crisp dot showing exactly the brush's size and colour,
 * or a ring the size of the eraser, each with a thin halo so it shows on any ink. An SVG at
 * 1x and 2x so it stays sharp at 125-200 % scaling; at most 32 CSS pixels; hotspot centred.
 */
export function brushCursor(tool: DrawTool, diameter: number, color: string, darkSheet: boolean): string {
  const halo = darkSheet ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.9)'
  const box = Math.min(32, Math.max(12, 2 * Math.ceil((diameter + 6) / 2)))
  const c = box / 2
  const r = Math.min(c - 1.5, Math.max(1.5, diameter / 2))
  const body =
    tool === 'pen'
      ? `<circle cx="${c}" cy="${c}" r="${r + 1}" fill="${halo}"/><circle cx="${c}" cy="${c}" r="${r}" fill="${color}"/>`
      : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${halo}" stroke-width="3"/><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="1.25"/>`
  const url = (pixels: number): string =>
    `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${box} ${box}">${body}</svg>`)}")`
  return `image-set(${url(box)} 1x, ${url(box * 2)} 2x) ${c} ${c}, crosshair`
}

/** Rough lightness of a #rrggbb colour, 0..1. */
export function lightness(hex: string): number {
  const rgb = parseHexColor(hex)
  if (!rgb) return 0
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
}

export interface ExportedDrawing {
  bytes: Uint8Array<ArrayBuffer>
  /** Size in CSS pixels, i.e. as it was drawn. */
  cssWidth: number
  cssHeight: number
  /** Pixels per CSS pixel in the file. */
  scale: number
}

/**
 * The finished drawing as an opaque PNG on the sheet colour (readable in every theme, like a
 * screenshot), cropped to the ink plus a small margin, at the screen's pixel density. Null
 * when no ink is left. Larger than the attachment limit: drawn again at a lower density.
 */
export async function exportDrawing(base: BaseLayer | null, ops: readonly DrawOp<Stroke>[], devicePixelRatio: number, inks: Inks): Promise<ExportedDrawing | null> {
  const upper = sceneBounds(base, ops)
  if (!upper) return null
  const area = snapRectOut(expandRect(upper, DRAWING_MARGIN))
  const { palette, sheet: background } = inks
  let scale = exportScale(area.width, area.height, devicePixelRatio)
  for (let attempt = 0; attempt < 6; attempt++) {
    // Device pixels are counted from the drawing space's own origin, so the starting picture
    // of an edited drawing lands on whole pixels and is copied without any blur.
    const left = Math.floor(area.x * scale)
    const top = Math.floor(area.y * scale)
    const width = Math.max(1, Math.ceil((area.x + area.width) * scale) - left)
    const height = Math.max(1, Math.ceil((area.y + area.height) * scale) - top)
    const ink = new OffscreenCanvas(width, height)
    const inkContext = ink.getContext('2d')
    if (!inkContext) throw new Error('The drawing could not be prepared.')
    inkContext.setTransform(scale, 0, 0, scale, -left, -top)
    paintScene(inkContext, base, ops, palette)
    const tight = alphaBounds(inkContext.getImageData(0, 0, width, height).data, width, height)
    if (!tight) return null
    const crop = intersectRect(expandRect(tight, Math.round(DRAWING_MARGIN * scale)), { x: 0, y: 0, width, height })!
    const out = new OffscreenCanvas(crop.width, crop.height)
    const outContext = out.getContext('2d')
    if (!outContext) throw new Error('The drawing could not be prepared.')
    outContext.fillStyle = background
    outContext.fillRect(0, 0, crop.width, crop.height)
    outContext.drawImage(ink, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
    const blob = await out.convertToBlob({ type: 'image/png' })
    if (blob.size <= MAX_DRAWING_BYTES - 1024) {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { bytes, cssWidth: crop.width / scale, cssHeight: crop.height / scale, scale }
    }
    scale *= 0.7
  }
  throw new Error('The drawing is too large to keep.')
}
