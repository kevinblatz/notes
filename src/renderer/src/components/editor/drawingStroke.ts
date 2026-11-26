/**
 * The shape of a pen stroke in the drawing space: sampled points in, a smooth, slightly
 * tapered outline out (perfect-freehand). No DOM, so it is unit-tested.
 */
import { getStroke, type StrokeOptions } from 'perfect-freehand'
import { pathLength, taperShare, type InkPoint } from '@shared/drawing'

/** Pen diameters at normal pressure, in CSS pixels. */
export const BRUSH_SIZES = [2.5, 5, 10] as const

export interface PenSettings {
  /** Diameter in CSS pixels. */
  size: number
  /** True when the pressure came from a pen; a mouse's pressure is simulated from its speed. */
  pressure: boolean
}

/** How much pressure (or, with a mouse, speed) changes the width of a line. */
const PEN_THINNING = 0.62
const MOUSE_THINNING = 0.42
/** A pointer that moved less than this (CSS px) between press and release made a dot. */
const DOT_LENGTH = 0.5
/** Points around the edge of a dot. */
const DOT_STEPS = 24

/**
 * Brush feel: a little smoothing and a short taper at both ends, which grows in as the line
 * gets long enough to carry it; speed thins a mouse line slightly.
 */
function strokeOptions(pen: PenSettings, length: number): StrokeOptions {
  const startTaper = Math.max(4, pen.size * 1.4)
  const endTaper = Math.max(6, pen.size * 2)
  const share = taperShare(length, startTaper + endTaper)
  return {
    size: pen.size,
    thinning: pen.pressure ? PEN_THINNING : MOUSE_THINNING,
    smoothing: 0.6,
    // Little streamlining: the line stays where the pointer went, corners included.
    streamline: 0.2,
    simulatePressure: !pen.pressure,
    start: { taper: startTaper * share, cap: true },
    end: { taper: endTaper * share, cap: true },
    // The outline always ends exactly at the pointer, so the line never trails behind it.
    last: true
  }
}

/**
 * Closed outline of a pen stroke, as polygon points. A tap is a round dot exactly the size
 * the pointer showed (smaller under light pen pressure).
 */
export function penOutline(points: readonly InkPoint[], pen: PenSettings): Array<[x: number, y: number]> {
  const last = points[points.length - 1]
  if (!last) return []
  const length = pathLength(points)
  if (length < DOT_LENGTH) {
    const radius = pen.pressure ? Math.max(0.5, pen.size * (0.5 - PEN_THINNING * (0.5 - last[2]))) : pen.size / 2
    return Array.from({ length: DOT_STEPS }, (_, i): [number, number] => {
      const angle = (i / DOT_STEPS) * Math.PI * 2
      return [last[0] + radius * Math.cos(angle), last[1] + radius * Math.sin(angle)]
    })
  }
  return getStroke(points as unknown as number[][], strokeOptions(pen, length))
}
