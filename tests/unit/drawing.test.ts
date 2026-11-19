import { describe, expect, it } from 'vitest'
import { sanitizeDoc } from '@shared/content'
import {
  alphaBounds,
  cornerColor,
  displayWidthPercent,
  drawingScaleAttr,
  expandRect,
  exportScale,
  intersectRect,
  MAX_EXPORT_EDGE,
  MAX_EXPORT_PIXELS,
  placeCentered,
  pointsBounds,
  pushPoint,
  removeBackground,
  snapRectOut,
  unionRect,
  visibleOps,
  type DrawOp,
  type InkPoint
} from '@shared/drawing'

const IMG = 'aaaaaaaa-1111-2222-3333-444444444444'

describe('stroke points', () => {
  it('drops samples too close to the previous one while drawing', () => {
    const points: InkPoint[] = []
    expect(pushPoint(points, [10, 10, 0.5])).toBe(true)
    expect(pushPoint(points, [10.2, 10.1, 0.5])).toBe(false)
    expect(pushPoint(points, [11, 10, 0.5])).toBe(true)
    expect(points).toEqual([
      [10, 10, 0.5],
      [11, 10, 0.5]
    ])
  })
})

describe('bounds and cropping', () => {
  it('measures points with the stroke radius around them', () => {
    expect(pointsBounds([], 3)).toBeNull()
    expect(pointsBounds([[10, 20, 0.5], [30, 5, 0.5]], 2)).toEqual({ x: 8, y: 3, width: 24, height: 19 })
  })

  it('combines, grows, snaps and intersects rectangles', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    const b = { x: 20, y: -5, width: 5, height: 5 }
    expect(unionRect(null, null)).toBeNull()
    expect(unionRect(a, null)).toBe(a)
    expect(unionRect(a, b)).toEqual({ x: 0, y: -5, width: 25, height: 15 })
    expect(expandRect(a, 4)).toEqual({ x: -4, y: -4, width: 18, height: 18 })
    expect(snapRectOut({ x: 1.4, y: -2.6, width: 3.2, height: 1 })).toEqual({ x: 1, y: -3, width: 4, height: 2 })
    expect(intersectRect(a, { x: 5, y: 5, width: 20, height: 20 })).toEqual({ x: 5, y: 5, width: 5, height: 5 })
    expect(intersectRect(a, b)).toBeNull()
  })

  it('finds the pixels that hold ink, ignoring erased (transparent) ones', () => {
    const width = 8
    const height = 6
    const data = new Uint8ClampedArray(width * height * 4)
    const ink = (x: number, y: number, alpha = 255): void => {
      data[(y * width + x) * 4 + 3] = alpha
    }
    expect(alphaBounds(data, width, height)).toBeNull()
    ink(2, 1)
    ink(5, 4)
    ink(7, 0, 2) // an almost invisible fringe does not count
    expect(alphaBounds(data, width, height)).toEqual({ x: 2, y: 1, width: 4, height: 4 })
    ink(0, 5, 200)
    expect(alphaBounds(data, width, height)).toEqual({ x: 0, y: 1, width: 6, height: 5 })
  })
})

describe('export size', () => {
  it('uses the screen density when it fits and less when it would not', () => {
    expect(exportScale(800, 600, 1.5)).toBe(1.5)
    expect(exportScale(800, 600, 0)).toBe(1)
    const wide = exportScale(6000, 200, 2)
    expect(6000 * wide).toBeLessThanOrEqual(MAX_EXPORT_EDGE + 0.001)
    const huge = exportScale(5000, 5000, 2)
    expect(5000 * huge * 5000 * huge).toBeLessThanOrEqual(MAX_EXPORT_PIXELS + 1)
  })

  it('shows a drawing in the note the way a screenshot of the whole sheet would be shown', () => {
    // The whole sheet fills the note, like a full-screen screenshot.
    expect(displayWidthPercent(960, 960)).toBe(100)
    expect(displayWidthPercent(1200, 960)).toBe(100)
    // A smaller sketch keeps its size relative to the sheet instead of being blown up.
    expect(displayWidthPercent(480, 960)).toBe(50)
    expect(displayWidthPercent(20, 960)).toBe(10)
    expect(displayWidthPercent(0, 960)).toBe(100)
  })

  it('centres a reopened drawing, never starting above or left of the sheet', () => {
    expect(placeCentered(200, 100, 1000, 500)).toEqual({ x: 400, y: 200 })
    expect(placeCentered(1200, 900, 1000, 500)).toEqual({ x: 0, y: 0 })
  })
})

describe('reopening a saved drawing', () => {
  const sheet: [number, number, number] = [37, 38, 42]

  /** One pixel of `ink` at `alpha`, painted over the sheet, as the saved PNG has it. */
  const over = (ink: [number, number, number], alpha: number): number[] => [...ink.map((c, i) => Math.round(c * alpha + sheet[i]! * (1 - alpha))), 255]

  it('takes the sheet colour out again and keeps the ink as drawn', () => {
    const ink: [number, number, number] = [235, 229, 217]
    const data = new Uint8ClampedArray([...over(ink, 0), ...over(ink, 1), ...over(ink, 0.5), ...over([240, 137, 122], 1)])
    removeBackground(data, sheet)
    // Background: fully transparent.
    expect(data[3]).toBe(0)
    // Solid ink: opaque and its own colour.
    expect([...data.slice(4, 8)]).toEqual([235, 229, 217, 255])
    // An antialiased edge: half transparent, and painted on the same sheet it gives the same pixel.
    const alpha = data[11]! / 255
    expect(alpha).toBeGreaterThan(0.4)
    expect(alpha).toBeLessThan(0.6)
    const repainted = [0, 1, 2].map((c) => Math.round(data[8 + c]! * alpha + sheet[c]! * (1 - alpha)))
    repainted.forEach((value, c) => expect(Math.abs(value - over(ink, 0.5)[c]!)).toBeLessThanOrEqual(2))
    expect([...data.slice(12, 16)]).toEqual([240, 137, 122, 255])
  })

  it('reads the sheet colour from the corners', () => {
    const width = 3
    const height = 3
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) data.set([37, 38, 42, 255], i * 4)
    data.set([200, 0, 0, 255], 0) // ink touching one corner does not fool it
    expect(cornerColor(data, width, height)).toEqual([37, 38, 42])
  })
})

describe('drawing history', () => {
  it('shows only what came after the last Clear, and the starting picture only before one', () => {
    const ops: DrawOp<string>[] = [{ kind: 'stroke', stroke: 'a' }]
    expect(visibleOps(ops)).toEqual({ strokes: ['a'], baseVisible: true })
    ops.push({ kind: 'clear' }, { kind: 'stroke', stroke: 'b' }, { kind: 'stroke', stroke: 'c' })
    expect(visibleOps(ops)).toEqual({ strokes: ['b', 'c'], baseVisible: false })
    // Undoing the Clear brings everything back.
    expect(visibleOps(ops.slice(0, 1))).toEqual({ strokes: ['a'], baseVisible: true })
    expect(visibleOps([])).toEqual({ strokes: [], baseVisible: true })
  })
})

describe('the drawing attribute on images', () => {
  it('keeps only a sensible pixel density (or true)', () => {
    expect(drawingScaleAttr(2)).toBe(2)
    expect(drawingScaleAttr(1.254)).toBe(1.25)
    expect(drawingScaleAttr(true)).toBe(true)
    for (const bad of [0, -1, 0.1, 9, Number.NaN, Infinity, '2', 'true', false, null, undefined, {}, [2]]) expect(drawingScaleAttr(bad)).toBeNull()
  })

  it('survives sanitising on a drawing and never appears on other images', () => {
    const doc = (attrs: Record<string, unknown>) => ({ type: 'doc', content: [{ type: 'noteImage', attrs: { attachmentId: IMG, width: 40, caption: 'Plan', naturalWidth: 960, naturalHeight: 540, ...attrs } }] })
    expect(sanitizeDoc(doc({ drawing: 1.5 })).content![0]!.attrs).toEqual({ attachmentId: IMG, width: 40, caption: 'Plan', naturalWidth: 960, naturalHeight: 540, drawing: 1.5 })
    expect(sanitizeDoc(doc({ drawing: true })).content![0]!.attrs!.drawing).toBe(true)
    // A plain image carries no key at all, so stored notes and backups are unchanged.
    for (const value of [null, false, 'yes', '<script>', 1000, { scale: 2 }]) {
      expect(sanitizeDoc(doc({ drawing: value })).content![0]!.attrs).not.toHaveProperty('drawing')
    }
    expect(sanitizeDoc(doc({})).content![0]!.attrs).not.toHaveProperty('drawing')
  })
})
