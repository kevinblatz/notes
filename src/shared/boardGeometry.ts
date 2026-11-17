/**
 * Turns a pointer position on the board into a logical placement.
 *
 * Two questions are answered here, both as pure functions of measured note rectangles so
 * they can be unit tested without a browser:
 *   1. The user clicked (or is hovering) genuinely empty space: where would a new note go?
 *   2. The user is dragging a note: where would it land if dropped now?
 *
 * All coordinates are in the board's own coordinate space (origin at the board's top-left
 * corner), using layout positions rather than animated ones.
 */
import { findNote } from './layout'
import type { BoardLayout, Placement } from './types'

export interface NoteBox {
  id: string
  rowId: string
  left: number
  top: number
  width: number
  height: number
}

export interface BoardGeometry {
  /** Left and right edge of the area notes occupy (inside the board's side padding). */
  contentLeft: number
  contentRight: number
  /** Top edge of the first row (the board's top padding). */
  contentTop: number
  /** True when pairs are shown side by side; false when they are stacked. */
  wide: boolean
  /** Space between neighbouring notes. */
  gap: number
  boxes: NoteBox[]
}

export interface Indicator {
  orientation: 'horizontal' | 'vertical'
  x: number
  y: number
  length: number
}

export interface EmptyHit {
  placement: Placement
  indicator: Indicator
}

interface Band {
  rowId: string
  index: number
  top: number
  bottom: number
  boxes: NoteBox[]
}

/** Share of the board width at each side that means "put it beside" while dragging. */
export const SIDE_ZONE = 0.22

const right = (box: NoteBox): number => box.left + box.width
const bottom = (box: NoteBox): number => box.top + box.height

function bands(geometry: BoardGeometry, layout: BoardLayout): Band[] {
  const byRow = new Map<string, NoteBox[]>()
  for (const box of geometry.boxes) {
    const list = byRow.get(box.rowId)
    if (list) list.push(box)
    else byRow.set(box.rowId, [box])
  }
  const out: Band[] = []
  layout.rows.forEach((row, index) => {
    const boxes = byRow.get(row.id)
    if (!boxes || boxes.length === 0) return
    // Keep the layout's left-to-right order regardless of how the boxes were measured.
    boxes.sort((a, b) => row.notes.indexOf(a.id) - row.notes.indexOf(b.id))
    out.push({ rowId: row.id, index, top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map(bottom)), boxes })
  })
  return out
}

function horizontal(geometry: BoardGeometry, y: number, left = geometry.contentLeft, rightEdge = geometry.contentRight): Indicator {
  return { orientation: 'horizontal', x: left, y, length: Math.max(0, rightEdge - left) }
}

/**
 * Placement for a click on empty board space at (x, y).
 *
 *  - Between two rows, above the first or anywhere below the last: a new full-width row there.
 *  - Beside a row (in the side margin, or in the gutter between a pair) when pairs are shown
 *    side by side: join that row on that side.
 *  - Under the shorter note of a pair: a new row directly below the pair.
 *  - When pairs are stacked: between the two stacked notes joins the pair; the side margins
 *    resolve to the nearer row boundary.
 */
export function hitEmptySpace(geometry: BoardGeometry, layout: BoardLayout, x: number, y: number): EmptyHit {
  const rows = bands(geometry, layout)
  const half = geometry.gap / 2
  if (rows.length === 0) {
    // The first note always starts at the top of the board, wherever the click was.
    return { placement: { kind: 'row', index: 0 }, indicator: horizontal(geometry, geometry.contentTop + half) }
  }

  for (const band of rows) {
    if (y < band.top || y > band.bottom) continue
    const first = band.boxes[0]!
    const last = band.boxes[band.boxes.length - 1]!

    if (geometry.wide) {
      const height = band.bottom - band.top
      if (x < first.left) {
        return {
          placement: { kind: 'slot', rowId: band.rowId, index: 0 },
          indicator: { orientation: 'vertical', x: Math.max(2, first.left - half), y: band.top, length: height }
        }
      }
      if (x > right(last)) {
        return {
          placement: { kind: 'slot', rowId: band.rowId, index: band.boxes.length },
          indicator: { orientation: 'vertical', x: right(last) + half, y: band.top, length: height }
        }
      }
      if (band.boxes.length === 2 && x > right(first) && x < last.left) {
        return {
          placement: { kind: 'slot', rowId: band.rowId, index: 1 },
          indicator: { orientation: 'vertical', x: (right(first) + last.left) / 2, y: band.top, length: height }
        }
      }
      // Inside the row's band but not on a note: the space under the shorter note of a pair.
      return { placement: { kind: 'row', index: band.index + 1 }, indicator: horizontal(geometry, band.bottom + half) }
    }

    if (band.boxes.length === 2 && y > bottom(first) && y < last.top) {
      return {
        placement: { kind: 'slot', rowId: band.rowId, index: 1 },
        indicator: horizontal(geometry, (bottom(first) + last.top) / 2)
      }
    }
    const above = y < (band.top + band.bottom) / 2
    return {
      placement: { kind: 'row', index: above ? band.index : band.index + 1 },
      indicator: horizontal(geometry, above ? band.top - half : band.bottom + half)
    }
  }

  const next = rows.find((band) => band.top > y)
  if (next) return { placement: { kind: 'row', index: next.index }, indicator: horizontal(geometry, Math.max(2, next.top - half)) }
  const lastBand = rows[rows.length - 1]!
  // Anywhere in the open space below the notes appends directly after the last one.
  return { placement: { kind: 'row', index: layout.rows.length }, indicator: horizontal(geometry, lastBand.bottom + half) }
}

export function placementsEqual(a: Placement | null, b: Placement | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'row' && b.kind === 'row') return a.index === b.index
  if (a.kind === 'slot' && b.kind === 'slot') return a.rowId === b.rowId && a.index === b.index
  return false
}

/**
 * Placement for a note being dragged, given the board as currently drawn (which already
 * shows the dragged note as a placeholder at `current`) and `base`, the layout without it.
 *
 *  - Over the placeholder itself: nothing changes (this is what keeps the preview steady).
 *  - Level with another note, in the left or right side zone: join that note's row on that side.
 *  - Level with another note, in the middle: above or below that note's row, by which half of
 *    the row is nearer.
 *  - In the space above, below or between rows: a full-width row at that boundary.
 */
export function hitDrag(geometry: BoardGeometry, base: BoardLayout, x: number, y: number, draggedId: string, current: Placement): Placement {
  const half = geometry.gap / 2
  const placeholder = geometry.boxes.find((box) => box.id === draggedId)
  if (placeholder && x >= placeholder.left - half && x <= right(placeholder) + half && y >= placeholder.top - half && y <= bottom(placeholder) + half) {
    return current
  }
  const others = geometry.boxes.filter((box) => box.id !== draggedId && findNote(base, box.id))
  if (others.length === 0) return { kind: 'row', index: 0 }

  const level = others.filter((box) => y >= box.top - half && y <= bottom(box) + half)
  if (level.length > 0) {
    const distance = (box: NoteBox): number => (x < box.left ? box.left - x : x > right(box) ? x - right(box) : 0)
    const hovered = level.reduce((best, box) => (distance(box) < distance(best) ? box : best))
    const position = findNote(base, hovered.id)!
    const width = Math.max(1, geometry.contentRight - geometry.contentLeft)
    const relative = (x - geometry.contentLeft) / width
    if (relative < SIDE_ZONE) return { kind: 'slot', rowId: position.row.id, index: 0 }
    if (relative > 1 - SIDE_ZONE) return { kind: 'slot', rowId: position.row.id, index: position.row.notes.length }
    // Above or below is decided against the whole row the hovered note belongs to. A pair
    // (side by side or stacked) therefore has one midpoint, which keeps the preview from
    // flipping back and forth between its two notes.
    const rowBoxes = others.filter((box) => position.row.notes.includes(box.id))
    const top = Math.min(...rowBoxes.map((box) => box.top))
    const bottomEdge = Math.max(...rowBoxes.map(bottom))
    const above = y < (top + bottomEdge) / 2
    return { kind: 'row', index: above ? position.rowIndex : position.rowIndex + 1 }
  }

  // Not level with any note: find the nearest one vertically and go before or after its row.
  const verticalDistance = (box: NoteBox): number => (y < box.top ? box.top - y : y - bottom(box))
  const nearest = others.reduce((best, box) => (verticalDistance(box) < verticalDistance(best) ? box : best))
  const position = findNote(base, nearest.id)!
  return { kind: 'row', index: y < nearest.top ? position.rowIndex : position.rowIndex + 1 }
}
