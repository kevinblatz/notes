/**
 * Board layout operations.
 *
 * The board is an ordered list of rows. A row holds one note (full width) or two notes
 * (a side-by-side pair, left to right). Every function here is pure and returns a new
 * layout. The invariant they all preserve: a note that was on the board before the call is
 * on the board after it, exactly once, unless the call was explicitly asked to remove it.
 * Nothing is ever merged, replaced or overwritten.
 */
import type { BoardLayout, BoardRow, Placement, TrashOrigin } from './types'

export const MAX_ROW_NOTES = 2

export type RowIdFactory = () => string

export interface NotePosition {
  rowIndex: number
  slot: number
  row: BoardRow
}

export type MoveDirection = 'up' | 'down' | 'left' | 'right'

export function emptyLayout(): BoardLayout {
  return { rows: [] }
}

export function cloneLayout(layout: BoardLayout): BoardLayout {
  return { rows: layout.rows.map((r) => ({ id: r.id, notes: [...r.notes] })) }
}

/** Reading order: top to bottom, left to right. */
export function flattenOrder(layout: BoardLayout): string[] {
  return layout.rows.flatMap((r) => r.notes)
}

export function findNote(layout: BoardLayout, noteId: string): NotePosition | null {
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex++) {
    const row = layout.rows[rowIndex]!
    const slot = row.notes.indexOf(noteId)
    if (slot !== -1) return { rowIndex, slot, row }
  }
  return null
}

export function layoutsEqual(a: BoardLayout, b: BoardLayout): boolean {
  if (a.rows.length !== b.rows.length) return false
  for (let i = 0; i < a.rows.length; i++) {
    const ra = a.rows[i]!
    const rb = b.rows[i]!
    if (ra.notes.length !== rb.notes.length) return false
    for (let j = 0; j < ra.notes.length; j++) if (ra.notes[j] !== rb.notes[j]) return false
  }
  return true
}

/**
 * Repair an arbitrary (possibly untrusted or stale) layout against the set of notes that
 * must be on the board:
 *  - unknown and duplicate note IDs are dropped,
 *  - rows with more than two notes are split, keeping order,
 *  - empty rows are removed, duplicate/missing row IDs are regenerated,
 *  - any live note the layout forgot is appended as its own row at the bottom.
 * The last rule is what guarantees a layout save can never make a note vanish.
 */
export function normalizeLayout(input: unknown, liveIds: Iterable<string>, makeRowId: RowIdFactory): BoardLayout {
  const live = new Set(liveIds)
  const seenNotes = new Set<string>()
  const seenRows = new Set<string>()
  const rows: BoardRow[] = []

  const takeRowId = (candidate: unknown): string => {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 64 && !seenRows.has(candidate)) {
      seenRows.add(candidate)
      return candidate
    }
    let id = makeRowId()
    while (seenRows.has(id)) id = makeRowId()
    seenRows.add(id)
    return id
  }

  const rawRows = isRecord(input) && Array.isArray(input.rows) ? input.rows : []
  for (const raw of rawRows) {
    if (!isRecord(raw) || !Array.isArray(raw.notes)) continue
    const ids: string[] = []
    for (const id of raw.notes) {
      if (typeof id !== 'string' || !live.has(id) || seenNotes.has(id)) continue
      seenNotes.add(id)
      ids.push(id)
    }
    for (let i = 0; i < ids.length; i += MAX_ROW_NOTES) {
      rows.push({ id: takeRowId(i === 0 ? raw.id : undefined), notes: ids.slice(i, i + MAX_ROW_NOTES) })
    }
  }
  for (const id of live) {
    if (!seenNotes.has(id)) rows.push({ id: takeRowId(undefined), notes: [id] })
  }
  return { rows }
}

/** Remove a note. If it was half of a pair, its partner stays where it was as a full-width row. */
export function removeNote(layout: BoardLayout, noteId: string): BoardLayout {
  const rows: BoardRow[] = []
  for (const row of layout.rows) {
    if (!row.notes.includes(noteId)) {
      rows.push({ id: row.id, notes: [...row.notes] })
      continue
    }
    const rest = row.notes.filter((id) => id !== noteId)
    if (rest.length > 0) rows.push({ id: row.id, notes: rest })
  }
  return { rows }
}

/**
 * Insert a note that is not currently on the board.
 *
 * Row placement: the note becomes a new full-width row at `index` (clamped).
 *
 * Slot placement into a row holding one note [A]:
 *   index 0 -> [X, A]        index >= 1 -> [A, X]
 *
 * Slot placement into a full row [A, B] (a row never holds more than two). The note that no
 * longer fits moves into its own row directly next to the pair, on the side that keeps the
 * reading order A before B intact:
 *   index 0  -> [X, A] then [B]     (B is pushed down)
 *   index 1  -> [A, X] then [B]     (B is pushed down)
 *   index 2+ -> [A] then [B, X]     (A is pushed up)
 *
 * If the row no longer exists the note is appended at the bottom rather than lost.
 */
export function insertNote(layout: BoardLayout, noteId: string, placement: Placement, makeRowId: RowIdFactory): BoardLayout {
  const base = findNote(layout, noteId) ? removeNote(layout, noteId) : cloneLayout(layout)
  const rows = base.rows

  if (placement.kind === 'row') {
    const index = clampInt(placement.index, 0, rows.length)
    rows.splice(index, 0, { id: makeRowId(), notes: [noteId] })
    return { rows }
  }

  const rowIndex = rows.findIndex((r) => r.id === placement.rowId)
  if (rowIndex === -1) {
    rows.push({ id: makeRowId(), notes: [noteId] })
    return { rows }
  }
  const row = rows[rowIndex]!
  const index = clampInt(placement.index, 0, row.notes.length)

  if (row.notes.length < MAX_ROW_NOTES) {
    const notes = [...row.notes]
    notes.splice(index, 0, noteId)
    rows[rowIndex] = { id: row.id, notes }
    return { rows }
  }

  const [a, b] = row.notes as [string, string]
  if (index <= 0) {
    rows.splice(rowIndex, 1, { id: row.id, notes: [noteId, a] }, { id: makeRowId(), notes: [b] })
  } else if (index === 1) {
    rows.splice(rowIndex, 1, { id: row.id, notes: [a, noteId] }, { id: makeRowId(), notes: [b] })
  } else {
    rows.splice(rowIndex, 1, { id: makeRowId(), notes: [a] }, { id: row.id, notes: [b, noteId] })
  }
  return { rows }
}

/**
 * Move a note already on the board. `placement` is interpreted against the layout *after*
 * the note has been lifted out (see `liftNote`), which is also the layout drop targets are
 * computed from while dragging.
 */
export function moveNote(layout: BoardLayout, noteId: string, placement: Placement, makeRowId: RowIdFactory): BoardLayout {
  if (!findNote(layout, noteId)) return cloneLayout(layout)
  return insertNote(removeNote(layout, noteId), noteId, placement, makeRowId)
}

/** The layout with `noteId` lifted out: what the rest of the board looks like during a drag. */
export function liftNote(layout: BoardLayout, noteId: string): BoardLayout {
  return removeNote(layout, noteId)
}

/** The placement that would put a note back exactly where it currently is (after lifting it). */
export function placementOf(layout: BoardLayout, noteId: string): Placement | null {
  const pos = findNote(layout, noteId)
  if (!pos) return null
  if (pos.row.notes.length === 1) return { kind: 'row', index: pos.rowIndex }
  return { kind: 'slot', rowId: pos.row.id, index: pos.slot }
}

/**
 * Keyboard rearranging. Returns null when the move would change nothing.
 *
 *  up / down
 *    - a note in a pair leaves the pair and becomes its own row directly above / below it
 *    - a full-width note swaps places with the row above / below
 *  left / right
 *    - inside a pair: swap sides (no-op if already on that side)
 *    - a full-width note joins the row above on that side (the row below if it is the top
 *      row). If that row is already a pair, the full-row rule of `insertNote` applies.
 */
export function keyboardMove(layout: BoardLayout, noteId: string, direction: MoveDirection, makeRowId: RowIdFactory): BoardLayout | null {
  const pos = findNote(layout, noteId)
  if (!pos) return null
  const { rowIndex, slot, row } = pos
  const paired = row.notes.length > 1

  if (direction === 'up' || direction === 'down') {
    if (paired) {
      const lifted = removeNote(layout, noteId)
      const index = direction === 'up' ? rowIndex : rowIndex + 1
      return insertNote(lifted, noteId, { kind: 'row', index }, makeRowId)
    }
    const target = direction === 'up' ? rowIndex - 1 : rowIndex + 1
    if (target < 0 || target >= layout.rows.length) return null
    const next = cloneLayout(layout)
    const moving = next.rows[rowIndex]!
    next.rows[rowIndex] = next.rows[target]!
    next.rows[target] = moving
    return next
  }

  if (paired) {
    const wanted = direction === 'left' ? 0 : row.notes.length - 1
    if (slot === wanted) return null
    const next = cloneLayout(layout)
    next.rows[rowIndex] = { id: row.id, notes: [...row.notes].reverse() }
    return next
  }

  const neighbourIndex = rowIndex > 0 ? rowIndex - 1 : rowIndex + 1
  const neighbour = layout.rows[neighbourIndex]
  if (!neighbour) return null
  const lifted = removeNote(layout, noteId)
  const index = direction === 'left' ? 0 : neighbour.notes.length
  return insertNote(lifted, noteId, { kind: 'slot', rowId: neighbour.id, index }, makeRowId)
}

/** Record where a note sits so a later restore can put it back. */
export function trashOriginOf(layout: BoardLayout, noteId: string): TrashOrigin | null {
  const pos = findNote(layout, noteId)
  if (!pos) return null
  const partnerId = pos.row.notes.find((id) => id !== noteId) ?? null
  return { rowIndex: pos.rowIndex, slot: pos.slot, partnerId }
}

/**
 * Put a restored note back near where it was: beside its former partner if that note is
 * still alone in its row, otherwise as its own row at the original index.
 */
export function restoreAt(layout: BoardLayout, noteId: string, origin: TrashOrigin | null, makeRowId: RowIdFactory): BoardLayout {
  if (findNote(layout, noteId)) return cloneLayout(layout)
  if (!origin) return insertNote(layout, noteId, { kind: 'row', index: layout.rows.length }, makeRowId)
  if (origin.partnerId) {
    const partner = findNote(layout, origin.partnerId)
    if (partner && partner.row.notes.length === 1) {
      return insertNote(layout, noteId, { kind: 'slot', rowId: partner.row.id, index: origin.slot <= 0 ? 0 : 1 }, makeRowId)
    }
  }
  return insertNote(layout, noteId, { kind: 'row', index: origin.rowIndex }, makeRowId)
}

/** Plain-language position, used for screen-reader announcements after a move. */
export function describePosition(layout: BoardLayout, noteId: string): string {
  const pos = findNote(layout, noteId)
  if (!pos) return 'not on the board'
  const rowText = `row ${pos.rowIndex + 1} of ${layout.rows.length}`
  if (pos.row.notes.length === 1) return `${rowText}, full width`
  return `${rowText}, ${pos.slot === 0 ? 'left' : 'right'} side of a pair`
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
