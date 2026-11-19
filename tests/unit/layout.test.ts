import { describe, expect, it } from 'vitest'
import {
  anchorOf,
  describePosition,
  findNote,
  flattenOrder,
  insertNote,
  keyboardMove,
  liftNote,
  moveNote,
  normalizeLayout,
  placeByAnchor,
  placementOf,
  removeNote,
  restoreAt,
  trashOriginOf
} from '@shared/layout'
import type { BoardLayout, Placement } from '@shared/types'

let counter = 0
const rid = (): string => `r${++counter}`
const L = (...rows: string[][]): BoardLayout => ({ rows: rows.map((notes, i) => ({ id: `row${i}`, notes })) })
const shape = (layout: BoardLayout): string[][] => layout.rows.map((r) => r.notes)
const sorted = (layout: BoardLayout): string[] => [...flattenOrder(layout)].sort()

function assertValid(layout: BoardLayout): void {
  const ids = flattenOrder(layout)
  expect(new Set(ids).size, 'no note appears twice').toBe(ids.length)
  expect(new Set(layout.rows.map((r) => r.id)).size, 'row ids are unique').toBe(layout.rows.length)
  for (const row of layout.rows) {
    expect(row.notes.length).toBeGreaterThanOrEqual(1)
    expect(row.notes.length).toBeLessThanOrEqual(2)
  }
}

describe('insertNote', () => {
  it('adds a full-width row at the requested index, clamped', () => {
    expect(shape(insertNote(L(['a'], ['b']), 'x', { kind: 'row', index: 1 }, rid))).toEqual([['a'], ['x'], ['b']])
    expect(shape(insertNote(L(['a'], ['b']), 'x', { kind: 'row', index: 99 }, rid))).toEqual([['a'], ['b'], ['x']])
    expect(shape(insertNote(L(['a'], ['b']), 'x', { kind: 'row', index: -5 }, rid))).toEqual([['x'], ['a'], ['b']])
    expect(shape(insertNote(L(), 'x', { kind: 'row', index: 0 }, rid))).toEqual([['x']])
  })

  it('pairs with a single note on either side', () => {
    expect(shape(insertNote(L(['a']), 'x', { kind: 'slot', rowId: 'row0', index: 0 }, rid))).toEqual([['x', 'a']])
    expect(shape(insertNote(L(['a']), 'x', { kind: 'slot', rowId: 'row0', index: 1 }, rid))).toEqual([['a', 'x']])
  })

  it('displaces one note into an adjacent row when the row is already a pair', () => {
    const full = L(['p'], ['a', 'b'], ['q'])
    expect(shape(insertNote(full, 'x', { kind: 'slot', rowId: 'row1', index: 0 }, rid))).toEqual([['p'], ['x', 'a'], ['b'], ['q']])
    expect(shape(insertNote(full, 'x', { kind: 'slot', rowId: 'row1', index: 1 }, rid))).toEqual([['p'], ['a', 'x'], ['b'], ['q']])
    expect(shape(insertNote(full, 'x', { kind: 'slot', rowId: 'row1', index: 2 }, rid))).toEqual([['p'], ['a'], ['b', 'x'], ['q']])
  })

  it('keeps the reading order of the notes that were already there', () => {
    const full = L(['p'], ['a', 'b'], ['q'])
    for (const index of [0, 1, 2]) {
      const next = insertNote(full, 'x', { kind: 'slot', rowId: 'row1', index }, rid)
      expect(flattenOrder(next).filter((id) => id !== 'x')).toEqual(['p', 'a', 'b', 'q'])
      assertValid(next)
    }
  })

  it('appends instead of losing the note when the target row is gone', () => {
    expect(shape(insertNote(L(['a']), 'x', { kind: 'slot', rowId: 'missing', index: 0 }, rid))).toEqual([['a'], ['x']])
  })

  it('does not mutate its input', () => {
    const before = L(['a', 'b'])
    const snapshot = JSON.stringify(before)
    insertNote(before, 'x', { kind: 'slot', rowId: 'row0', index: 0 }, rid)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('removeNote / moveNote', () => {
  it('leaves the partner in place as a full-width row', () => {
    expect(shape(removeNote(L(['a', 'b'], ['c']), 'a'))).toEqual([['b'], ['c']])
    expect(shape(removeNote(L(['a'], ['c']), 'a'))).toEqual([['c']])
  })

  it('moves above, below, left and right', () => {
    const base = L(['a'], ['b'], ['c'])
    expect(shape(moveNote(base, 'c', { kind: 'row', index: 0 }, rid))).toEqual([['c'], ['a'], ['b']])
    expect(shape(moveNote(base, 'a', { kind: 'row', index: 2 }, rid))).toEqual([['b'], ['c'], ['a']])
    expect(shape(moveNote(base, 'c', { kind: 'slot', rowId: 'row0', index: 0 }, rid))).toEqual([['c', 'a'], ['b']])
    expect(shape(moveNote(base, 'c', { kind: 'slot', rowId: 'row0', index: 1 }, rid))).toEqual([['a', 'c'], ['b']])
  })

  it('swaps sides inside a pair', () => {
    expect(shape(moveNote(L(['a', 'b']), 'a', { kind: 'slot', rowId: 'row0', index: 1 }, rid))).toEqual([['b', 'a']])
  })

  it('moves around a full two-note row without losing anything', () => {
    const base = L(['a', 'b'], ['c'])
    expect(shape(moveNote(base, 'c', { kind: 'slot', rowId: 'row0', index: 0 }, rid))).toEqual([['c', 'a'], ['b']])
    expect(shape(moveNote(base, 'c', { kind: 'slot', rowId: 'row0', index: 2 }, rid))).toEqual([['a'], ['b', 'c']])
    expect(shape(moveNote(base, 'c', { kind: 'row', index: 0 }, rid))).toEqual([['c'], ['a', 'b']])
  })

  it('is a no-op for a note that is not on the board', () => {
    expect(shape(moveNote(L(['a']), 'zzz', { kind: 'row', index: 0 }, rid))).toEqual([['a']])
  })

  it('placementOf round-trips through lift + insert', () => {
    const base = L(['a'], ['b', 'c'], ['d'])
    for (const id of ['a', 'b', 'c', 'd']) {
      const placement = placementOf(base, id)!
      expect(shape(insertNote(liftNote(base, id), id, placement, rid))).toEqual(shape(base))
    }
  })
})

describe('no note is ever lost (randomised)', () => {
  it('survives thousands of arbitrary moves', () => {
    let seed = 1234567
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const ids = Array.from({ length: 14 }, (_, i) => `n${i}`)
    let layout = normalizeLayout({ rows: [] }, ids, rid)
    const expected = [...ids].sort()

    for (let step = 0; step < 4000; step++) {
      const id = ids[rand(ids.length)]!
      const lifted = liftNote(layout, id)
      const others = flattenOrder(lifted)
      let placement: Placement
      if (rand(2) === 0 || lifted.rows.length === 0) {
        placement = { kind: 'row', index: rand(lifted.rows.length + 2) - 1 }
      } else {
        const row = lifted.rows[rand(lifted.rows.length)]!
        placement = { kind: 'slot', rowId: rand(20) === 0 ? 'gone' : row.id, index: rand(4) - 1 }
      }
      const next = step % 3 === 0 ? (keyboardMove(layout, id, (['up', 'down', 'left', 'right'] as const)[rand(4)]!, rid) ?? layout) : moveNote(layout, id, placement, rid)
      assertValid(next)
      expect(sorted(next)).toEqual(expected)
      // Everything except the moved note keeps its relative reading order.
      if (step % 3 !== 0) expect(flattenOrder(next).filter((n) => n !== id)).toEqual(others)
      layout = next
    }
  })
})

describe('normalizeLayout', () => {
  it('repairs duplicates, unknown ids, oversized rows and forgotten notes', () => {
    const repaired = normalizeLayout(
      { rows: [{ id: 'r', notes: ['a', 'ghost', 'a', 'b', 'c'] }, { id: 'r', notes: [] }, { notes: ['d'] }, 'junk', { id: 5, notes: 'no' }] },
      ['a', 'b', 'c', 'd', 'forgotten'],
      rid
    )
    assertValid(repaired)
    expect(shape(repaired)).toEqual([['a', 'b'], ['c'], ['d'], ['forgotten']])
  })

  it('returns an empty board for garbage input but still places every live note', () => {
    expect(shape(normalizeLayout(null, [], rid))).toEqual([])
    expect(shape(normalizeLayout('nope', ['a', 'b'], rid))).toEqual([['a'], ['b']])
  })
})

describe('keyboardMove', () => {
  it('moves a full-width note up and down past rows', () => {
    const base = L(['a'], ['b', 'c'], ['d'])
    expect(shape(keyboardMove(base, 'd', 'up', rid)!)).toEqual([['a'], ['d'], ['b', 'c']])
    expect(shape(keyboardMove(base, 'a', 'down', rid)!)).toEqual([['b', 'c'], ['a'], ['d']])
    expect(keyboardMove(base, 'a', 'up', rid)).toBeNull()
    expect(keyboardMove(base, 'd', 'down', rid)).toBeNull()
  })

  it('takes a note out of a pair with up / down', () => {
    const base = L(['a'], ['b', 'c'], ['d'])
    expect(shape(keyboardMove(base, 'c', 'up', rid)!)).toEqual([['a'], ['c'], ['b'], ['d']])
    expect(shape(keyboardMove(base, 'b', 'down', rid)!)).toEqual([['a'], ['c'], ['b'], ['d']])
  })

  it('swaps sides inside a pair and pairs a full-width note with its neighbour', () => {
    const base = L(['a'], ['b', 'c'], ['d'])
    expect(shape(keyboardMove(base, 'c', 'left', rid)!)).toEqual([['a'], ['c', 'b'], ['d']])
    expect(keyboardMove(base, 'b', 'left', rid)).toBeNull()
    expect(shape(keyboardMove(L(['a'], ['b']), 'b', 'right', rid)!)).toEqual([['a', 'b']])
    expect(shape(keyboardMove(L(['a'], ['b']), 'b', 'left', rid)!)).toEqual([['b', 'a']])
    expect(shape(keyboardMove(L(['a'], ['b']), 'a', 'right', rid)!)).toEqual([['b', 'a']])
    // Joining a full pair displaces one note into its own row.
    expect(shape(keyboardMove(base, 'd', 'left', rid)!)).toEqual([['a'], ['d', 'b'], ['c']])
    expect(shape(keyboardMove(base, 'd', 'right', rid)!)).toEqual([['a'], ['b'], ['c', 'd']])
    expect(keyboardMove(L(['only']), 'only', 'left', rid)).toBeNull()
  })
})

describe('trash origin', () => {
  it('restores a note beside its former partner or at its old row', () => {
    const base = L(['a'], ['b', 'c'], ['d'])
    const originC = trashOriginOf(base, 'c')!
    expect(shape(restoreAt(removeNote(base, 'c'), 'c', originC, rid))).toEqual(shape(base))
    const originB = trashOriginOf(base, 'b')!
    expect(shape(restoreAt(removeNote(base, 'b'), 'b', originB, rid))).toEqual(shape(base))
    const originA = trashOriginOf(base, 'a')!
    expect(shape(restoreAt(removeNote(base, 'a'), 'a', originA, rid))).toEqual(shape(base))
    // Partner has since been paired with someone else: fall back to the old row index.
    const changed = L(['a'], ['b', 'z'], ['d'])
    expect(shape(restoreAt(changed, 'c', originC, rid))).toEqual([['a'], ['c'], ['b', 'z'], ['d']])
    expect(shape(restoreAt(L(['a']), 'c', null, rid))).toEqual([['a'], ['c']])
  })

  it('puts one note back by its neighbours without disturbing notes added since', () => {
    // D was moved up from the bottom of [a],[c],[d]; meanwhile b was restored under a.
    const anchor = anchorOf(L(['a'], ['c'], ['d']), 'd')!
    expect(anchor).toEqual({ partnerId: null, slot: 0, previousNoteId: 'c', rowIndex: 2 })
    expect(shape(placeByAnchor(L(['a'], ['b'], ['d'], ['c']), 'd', anchor, rid))).toEqual([['a'], ['b'], ['c'], ['d']])
    // A note that was at the top goes back to the top even if rows were inserted since.
    const top = anchorOf(L(['a'], ['b']), 'a')!
    expect(shape(placeByAnchor(L(['b'], ['new'], ['a'], ['c']), 'a', top, rid))).toEqual([['a'], ['b'], ['new'], ['c']])
    // A former pair is re-formed on the same side when the partner is still alone.
    const paired = anchorOf(L(['x'], ['a', 'b']), 'b')!
    expect(shape(placeByAnchor(L(['b'], ['x'], ['new'], ['a']), 'b', paired, rid))).toEqual([['x'], ['new'], ['a', 'b']])
    // The neighbour above is gone: fall back to the old row number, and never lose anything.
    const orphan = { partnerId: null, slot: 0, previousNoteId: 'gone', rowIndex: 1 }
    expect(shape(placeByAnchor(L(['a'], ['b'], ['c']), 'c', orphan, rid))).toEqual([['a'], ['c'], ['b']])
  })

  it('describes positions for announcements', () => {
    const base = L(['a'], ['b', 'c'])
    expect(describePosition(base, 'a')).toBe('row 1 of 2, full width')
    expect(describePosition(base, 'c')).toBe('row 2 of 2, right side of a pair')
    expect(findNote(base, 'nope')).toBeNull()
  })
})
