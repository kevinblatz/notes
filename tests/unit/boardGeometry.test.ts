import { describe, expect, it } from 'vitest'
import { hitDrag, hitEmptySpace, placementsEqual, type BoardGeometry, type NoteBox } from '@shared/boardGeometry'
import { insertNote, liftNote } from '@shared/layout'
import type { BoardLayout, Placement } from '@shared/types'

const GAP = 16
const PAD = 30
const WIDTH = 900 // content width; content spans x 30..930
const COL = (WIDTH - GAP) / 2

/** Lay notes out the way the board's CSS grid does and return their boxes. */
function measure(layout: BoardLayout, wide: boolean, heights: Record<string, number> = {}): BoardGeometry {
  const boxes: NoteBox[] = []
  let y = 20
  for (const row of layout.rows) {
    const h = (id: string): number => heights[id] ?? 100
    if (row.notes.length === 1) {
      boxes.push({ id: row.notes[0]!, rowId: row.id, left: PAD, top: y, width: WIDTH, height: h(row.notes[0]!) })
      y += h(row.notes[0]!) + GAP
    } else if (wide) {
      row.notes.forEach((id, i) => boxes.push({ id, rowId: row.id, left: PAD + i * (COL + GAP), top: y, width: COL, height: h(id) }))
      y += Math.max(...row.notes.map(h)) + GAP
    } else {
      for (const id of row.notes) {
        boxes.push({ id, rowId: row.id, left: PAD, top: y, width: WIDTH, height: h(id) })
        y += h(id) + GAP
      }
    }
  }
  return { contentLeft: PAD, contentRight: PAD + WIDTH, contentTop: 20, wide, gap: GAP, boxes }
}

const L = (...rows: string[][]): BoardLayout => ({ rows: rows.map((notes, i) => ({ id: `row${i}`, notes })) })
let n = 0
const rid = (): string => `new${++n}`

describe('hitEmptySpace', () => {
  it('uses the whole empty board', () => {
    expect(hitEmptySpace(measure(L(), true), L(), 400, 300).placement).toEqual({ kind: 'row', index: 0 })
  })

  it('maps gaps between rows, the top margin and the open space below', () => {
    const layout = L(['a'], ['b'], ['c'])
    const geo = measure(layout, true)
    expect(hitEmptySpace(geo, layout, 400, 5).placement).toEqual({ kind: 'row', index: 0 })
    expect(hitEmptySpace(geo, layout, 400, 128).placement).toEqual({ kind: 'row', index: 1 })
    expect(hitEmptySpace(geo, layout, 400, 244).placement).toEqual({ kind: 'row', index: 2 })
    const below = hitEmptySpace(geo, layout, 400, 2000)
    expect(below.placement).toEqual({ kind: 'row', index: 3 })
    // The indicator sits right under the last note, not where the pointer happens to be.
    expect(below.indicator).toMatchObject({ orientation: 'horizontal', y: 20 + 3 * 100 + 2 * GAP + GAP / 2 })
  })

  it('maps the side margins and the gutter of a side-by-side row', () => {
    const layout = L(['a'], ['b', 'c'])
    const geo = measure(layout, true, { b: 60, c: 200 })
    expect(hitEmptySpace(geo, layout, 10, 60).placement).toEqual({ kind: 'slot', rowId: 'row0', index: 0 })
    expect(hitEmptySpace(geo, layout, 945, 60).placement).toEqual({ kind: 'slot', rowId: 'row0', index: 1 })
    expect(hitEmptySpace(geo, layout, 10, 200).placement).toEqual({ kind: 'slot', rowId: 'row1', index: 0 })
    expect(hitEmptySpace(geo, layout, 945, 200).placement).toEqual({ kind: 'slot', rowId: 'row1', index: 2 })
    expect(hitEmptySpace(geo, layout, PAD + COL + GAP / 2, 200).placement).toEqual({ kind: 'slot', rowId: 'row1', index: 1 })
    expect(hitEmptySpace(geo, layout, 10, 200).indicator.orientation).toBe('vertical')
    // Empty space under the shorter note of the pair.
    expect(hitEmptySpace(geo, layout, 200, 300).placement).toEqual({ kind: 'row', index: 2 })
  })

  it('handles stacked pairs at narrow widths', () => {
    const layout = L(['a'], ['b', 'c'])
    const geo = measure(layout, false)
    // Between the two stacked notes of the pair: join the pair in the middle.
    expect(hitEmptySpace(geo, layout, 400, 20 + 100 + GAP + 100 + GAP / 2).placement).toEqual({ kind: 'slot', rowId: 'row1', index: 1 })
    // Side margin beside the pair: nearest row boundary, never a hidden side-by-side slot.
    expect(hitEmptySpace(geo, layout, 10, 150).placement).toEqual({ kind: 'row', index: 1 })
    expect(hitEmptySpace(geo, layout, 10, 330).placement).toEqual({ kind: 'row', index: 2 })
  })
})

describe('hitDrag', () => {
  const start = (layout: BoardLayout, id: string, wide = true): { base: BoardLayout; geo: BoardGeometry } => ({ base: liftNote(layout, id), geo: measure(layout, wide) })

  it('keeps the target while the pointer is over the placeholder', () => {
    const layout = L(['a'], ['x'], ['b'])
    const { base, geo } = start(layout, 'x')
    const current: Placement = { kind: 'row', index: 1 }
    expect(hitDrag(geo, base, 400, 180, 'x', current)).toBe(current)
  })

  it('targets above / below in the middle and beside at the edges', () => {
    const layout = L(['a'], ['b'], ['x'])
    const { base, geo } = start(layout, 'x')
    const current: Placement = { kind: 'row', index: 2 }
    expect(hitDrag(geo, base, 480, 40, 'x', current)).toEqual({ kind: 'row', index: 0 })
    expect(hitDrag(geo, base, 480, 100, 'x', current)).toEqual({ kind: 'row', index: 1 })
    expect(hitDrag(geo, base, 480, 150, 'x', current)).toEqual({ kind: 'row', index: 1 })
    expect(hitDrag(geo, base, 480, 220, 'x', current)).toEqual({ kind: 'row', index: 2 })
    expect(hitDrag(geo, base, 60, 60, 'x', current)).toEqual({ kind: 'slot', rowId: 'row0', index: 0 })
    expect(hitDrag(geo, base, 900, 60, 'x', current)).toEqual({ kind: 'slot', rowId: 'row0', index: 1 })
    expect(hitDrag(geo, base, 480, -500, 'x', current)).toEqual({ kind: 'row', index: 0 })
    expect(hitDrag(geo, base, 480, 5000, 'x', current)).toEqual({ kind: 'row', index: 2 })
  })

  it('targets the outer sides of a full pair', () => {
    const layout = L(['a', 'b'], ['x'])
    const { base, geo } = start(layout, 'x')
    const current: Placement = { kind: 'row', index: 1 }
    expect(hitDrag(geo, base, 60, 60, 'x', current)).toEqual({ kind: 'slot', rowId: 'row0', index: 0 })
    expect(hitDrag(geo, base, 900, 60, 'x', current)).toEqual({ kind: 'slot', rowId: 'row0', index: 2 })
  })

  it('settles: once the preview is drawn, the same pointer position gives the same target', () => {
    // Simulates the live preview loop for many pointer positions, layouts and both widths.
    const layouts = [L(['a'], ['b'], ['x'], ['c']), L(['a', 'b'], ['x'], ['c', 'd']), L(['x', 'a'], ['b'], ['c', 'd']), L(['a'], ['b', 'x'])]
    for (const wide of [true, false]) {
      for (const layout of layouts) {
        const base = liftNote(layout, 'x')
        for (let px = 40; px <= 920; px += 110) {
          for (let py = 0; py <= 620; py += 23) {
            let target: Placement = { kind: 'row', index: 0 }
            let stableFor = 0
            for (let step = 0; step < 8 && stableFor < 2; step++) {
              const preview = insertNote(base, 'x', target, rid)
              // During a drag the placeholder is drawn short.
              const next = hitDrag(measure(preview, wide, { x: 80 }), base, px, py, 'x', target)
              stableFor = placementsEqual(next, target) ? stableFor + 1 : 0
              target = next
            }
            expect(stableFor, `wide=${wide} layout=${JSON.stringify(layout.rows.map((r) => r.notes))} at ${px},${py}`).toBeGreaterThanOrEqual(2)
          }
        }
      }
    }
  })
})
