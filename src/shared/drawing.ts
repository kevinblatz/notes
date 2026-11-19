/**
 * Pure helpers for the drawing space: stroke points, bounds and cropping, export sizing, the
 * size a finished drawing is shown at in the note, and turning a saved drawing back into ink
 * so it can be edited again. No DOM, so it is unit-tested.
 */

/** One sampled pointer position, in CSS pixels from the drawing space's top-left corner. */
export type InkPoint = readonly [x: number, y: number, pressure: number]

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Empty sheet kept around a finished drawing, in CSS pixels, so it never touches its frame. */
export const DRAWING_MARGIN = 14
/** Points closer than this to the previous one add nothing visible and are dropped. */
export const MIN_POINT_DISTANCE = 0.6
/** Same limit as the main process applies to every imported image (attachments.ts). */
export const MAX_DRAWING_BYTES = 40 * 1024 * 1024
/** Chromium canvases stay reliable below these. */
export const MAX_EXPORT_EDGE = 8192
export const MAX_EXPORT_PIXELS = 32_000_000
/** Smallest width an image can have in a note (the resize handle's own minimum). */
export const MIN_IMAGE_WIDTH_PERCENT = 10
/** Pixel densities a drawing can be saved at (pixels per CSS pixel). */
export const MIN_DRAWING_SCALE = 0.25
export const MAX_DRAWING_SCALE = 8

/**
 * The value kept in a drawing's `drawing` attribute: the pixel density it was saved at, so it
 * reopens for editing at exactly the size it was drawn. `true` (a drawing of unknown density)
 * is accepted too. Anything else is not a drawing.
 */
export function drawingScaleAttr(value: unknown): number | true | null {
  if (value === true) return true
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < MIN_DRAWING_SCALE || value > MAX_DRAWING_SCALE) return null
  return Math.round(value * 100) / 100
}

/**
 * Add a point to a stroke that is being drawn, unless it is too close to the previous one to
 * make a visible difference (a pen reports hundreds of samples a second). Returns true when
 * the point was kept.
 */
export function pushPoint(points: InkPoint[], point: InkPoint, minDistance = MIN_POINT_DISTANCE): boolean {
  const last = points[points.length - 1]
  if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < minDistance) return false
  points.push(point)
  return true
}

/** Length of the line through the points, in CSS pixels. */
export function pathLength(points: readonly InkPoint[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1])
  return length
}

/**
 * How much of its full taper a stroke of this length gets (0 to 1). A taper thins a line's
 * ends to a point, so a tap or a short tick that is all taper would not show at all: short
 * marks get round ends, and the taper grows in as the line gets longer than its two tapers.
 */
export function taperShare(length: number, fullTaper: number): number {
  if (!(fullTaper > 0)) return 0
  return Math.min(1, Math.max(0, (length - fullTaper) / fullTaper))
}

/** Bounding box of a list of points, grown by `pad` on every side (the stroke's own radius). */
export function pointsBounds(points: readonly InkPoint[], pad: number): Rect | null {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 }
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

export function expandRect(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 }
}

/** Smallest rectangle on whole pixels that contains `rect`. */
export function snapRectOut(rect: Rect): Rect {
  const x = Math.floor(rect.x)
  const y = Math.floor(rect.y)
  return { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y }
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/**
 * The pixels that actually hold ink (alpha above `threshold`) in RGBA data. Ink that was
 * erased again does not count, so a drawing is cropped to what can be seen.
 */
export function alphaBounds(data: ArrayLike<number>, width: number, height: number, threshold = 3): Rect | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    let rowMin = -1
    let rowMax = -1
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3]! > threshold) {
        rowMin = x
        break
      }
    }
    if (rowMin === -1) continue
    for (let x = width - 1; x >= rowMin; x--) {
      if (data[row + x * 4 + 3]! > threshold) {
        rowMax = x
        break
      }
    }
    if (rowMin < minX) minX = rowMin
    if (rowMax > maxX) maxX = rowMax
    if (y < minY) minY = y
    maxY = y
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * Pixels per CSS pixel for the exported picture: the screen's own density when the result
 * stays inside the canvas limits, otherwise as much as fits.
 */
export function exportScale(cssWidth: number, cssHeight: number, preferred: number): number {
  let scale = Math.max(0.25, Math.min(4, preferred || 1))
  const edge = Math.max(cssWidth, cssHeight) * scale
  if (edge > MAX_EXPORT_EDGE) scale *= MAX_EXPORT_EDGE / edge
  const pixels = cssWidth * scale * cssHeight * scale
  if (pixels > MAX_EXPORT_PIXELS) scale *= Math.sqrt(MAX_EXPORT_PIXELS / pixels)
  return scale
}

/**
 * Width a new drawing gets in the note, as a percentage of the note's width. The whole
 * drawing space maps onto the note's width, the way a screenshot of the whole screen fills
 * it: a drawing that used the full space fills the note, and a smaller sketch keeps its size
 * relative to it instead of being blown up.
 */
export function displayWidthPercent(drawingCssWidth: number, spaceCssWidth: number): number {
  if (!(drawingCssWidth > 0) || !(spaceCssWidth > 0)) return 100
  const percent = Math.round((drawingCssWidth / spaceCssWidth) * 100)
  return Math.min(100, Math.max(MIN_IMAGE_WIDTH_PERCENT, percent))
}

/** Where a picture of the given size goes in an area: centred, but never starting off its top-left. */
export function placeCentered(width: number, height: number, areaWidth: number, areaHeight: number): { x: number; y: number } {
  return { x: Math.max(0, (areaWidth - width) / 2), y: Math.max(0, (areaHeight - height) / 2) }
}

/** The colour shared by most of the four corners of RGBA data: a finished drawing's background. */
export function cornerColor(data: ArrayLike<number>, width: number, height: number): [number, number, number] {
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4
    return [data[i]!, data[i + 1]!, data[i + 2]!]
  }
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
  let best = corners[0]!
  let bestCount = 0
  for (const candidate of corners) {
    const count = corners.filter((c) => c[0] === candidate[0] && c[1] === candidate[1] && c[2] === candidate[2]).length
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/** A #rgb or #rrggbb colour as [red, green, blue] (0-255); null for anything else. */
export function parseHexColor(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, '')
  const full = /^[0-9a-f]{3}$/i.test(hex) ? hex.replace(/./g, (digit) => digit + digit) : hex
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)]
}

/**
 * Which of the named colours `rgb` is (within `tolerance` per channel): used to tell which
 * theme's sheet a saved drawing was painted on. Null when it is none of them.
 */
export function matchColor<K extends string>(rgb: readonly [number, number, number], candidates: ReadonlyArray<readonly [K, string]>, tolerance = 2): K | null {
  for (const [name, value] of candidates) {
    const color = parseHexColor(value)
    if (color && color.every((channel, i) => Math.abs(channel - rgb[i]!) <= tolerance)) return name
  }
  return null
}

/** Pixels at least this far from the sheet colour towards their own are solid ink. */
const SOLID_INK_ALPHA = 0.7

/**
 * Turn an opaque picture painted on `background` back into ink on a transparent layer
 * ("colour to alpha"): the sheet becomes transparent, solid ink stays solid, and the soft
 * edges in between get the smallest opacity that, painted over the background, gives exactly
 * the colour they had. Painting the result on the same background reproduces the original.
 */
export function removeBackground(data: Uint8ClampedArray | number[], background: readonly [number, number, number]): void {
  for (let i = 0; i < data.length; i += 4) {
    let alpha = 0
    for (let c = 0; c < 3; c++) {
      const p = data[i + c]!
      const b = background[c]!
      const a = p > b ? (p - b) / (255 - b) : p < b ? (b - p) / b : 0
      if (a > alpha) alpha = a
    }
    const sourceAlpha = data[i + 3]! / 255
    if (alpha <= 0) {
      data[i + 3] = 0
      continue
    }
    // Clearly ink: keep it solid and exactly its colour, so it stays true on another sheet too.
    if (alpha >= SOLID_INK_ALPHA) continue
    for (let c = 0; c < 3; c++) {
      const b = background[c]!
      data[i + c] = Math.round(Math.min(255, Math.max(0, (data[i + c]! - b) / alpha + b)))
    }
    data[i + 3] = Math.round(Math.min(1, alpha) * sourceAlpha * 255)
  }
}

// ---------------------------------------------------------------- history

export type DrawOp<S> = { kind: 'stroke'; stroke: S } | { kind: 'clear' }

/** What is on the sheet: the strokes since the last Clear, and whether the starting picture survived. */
export function visibleOps<S>(ops: readonly DrawOp<S>[]): { strokes: S[]; baseVisible: boolean } {
  let from = 0
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i]!.kind === 'clear') {
      from = i + 1
      break
    }
  }
  const strokes: S[] = []
  for (let i = from; i < ops.length; i++) {
    const op = ops[i]!
    if (op.kind === 'stroke') strokes.push(op.stroke)
  }
  return { strokes, baseVisible: from === 0 }
}
