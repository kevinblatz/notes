import { describe, expect, it } from 'vitest'
import { dockBounds, fitInside, isUsablyVisible, resolveWindow, type DisplayInfo } from '@shared/windowBounds'

const primary: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
// A 4K monitor at 150 % to the right: 3840x2160 physical = 2560x1440 DIP.
const right: DisplayInfo = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1392 }, scaleFactor: 1.5 }
// A monitor above-left with negative coordinates and a taskbar on the left edge.
const upperLeft: DisplayInfo = { id: 3, bounds: { x: -1280, y: -1024, width: 1280, height: 1024 }, workArea: { x: -1218, y: -1024, width: 1218, height: 1024 }, scaleFactor: 1.25 }

describe('dockBounds', () => {
  it('uses half of the work area and never covers the taskbar', () => {
    expect(dockBounds(primary.workArea, 'right')).toEqual({ x: 960, y: 0, width: 960, height: 1040 })
    expect(dockBounds(primary.workArea, 'left')).toEqual({ x: 0, y: 0, width: 960, height: 1040 })
    expect(dockBounds(upperLeft.workArea, 'right')).toEqual({ x: -609, y: -1024, width: 609, height: 1024 })
  })

  it('keeps the minimum width and stays on screen on a narrow or portrait monitor', () => {
    // 1080x1920 portrait at 150 % = 720 px wide: half would be 360, below the 420 minimum.
    const portrait = { x: 1920, y: 0, width: 720, height: 1240 }
    expect(dockBounds(portrait, 'right')).toEqual({ x: 1920 + 720 - 420, y: 0, width: 420, height: 1240 })
    expect(dockBounds(portrait, 'left')).toEqual({ x: 1920, y: 0, width: 420, height: 1240 })
    // Narrower than the minimum itself: use what there is.
    expect(dockBounds({ x: 0, y: 0, width: 300, height: 600 }, 'right')).toEqual({ x: 0, y: 0, width: 300, height: 600 })
  })

  it('splits odd widths without a gap or overlap', () => {
    const wa = { x: 0, y: 0, width: 1367, height: 700 }
    const l = dockBounds(wa, 'left')
    const r = dockBounds(wa, 'right')
    expect(l.width + r.width).toBe(1367)
    expect(r.x).toBe(l.x + l.width)
  })
})

describe('resolveWindow', () => {
  const base = { displays: [primary, right, upperLeft], primaryDisplayId: 1, preferredSide: 'right' as const }

  it('first launch docks on the monitor under the cursor', () => {
    expect(resolveWindow({ ...base, saved: null, cursorDisplayId: 2 })).toEqual({
      bounds: { x: 3200, y: 0, width: 1280, height: 1392 },
      displayId: 2,
      dock: 'right',
      recovered: false
    })
    expect(resolveWindow({ ...base, saved: null, cursorDisplayId: null }).displayId).toBe(1)
  })

  it('re-docks on the remembered monitor using its current work area', () => {
    const saved = { dock: 'left' as const, bounds: { x: 1920, y: 0, width: 1000, height: 900 }, displayId: 2, displayBounds: right.bounds }
    expect(resolveWindow({ ...base, saved, cursorDisplayId: 1 })).toMatchObject({ bounds: { x: 1920, y: 0, width: 1280, height: 1392 }, displayId: 2, dock: 'left', recovered: false })
  })

  it('recognises a monitor whose id changed by its bounds', () => {
    const saved = { dock: 'right' as const, bounds: null, displayId: 777, displayBounds: right.bounds }
    expect(resolveWindow({ ...base, saved, cursorDisplayId: 1 })).toMatchObject({ displayId: 2, recovered: false })
  })

  it('recovers onto the primary monitor when the remembered one is gone', () => {
    const docked = { dock: 'left' as const, bounds: { x: 1920, y: 0, width: 1280, height: 1392 }, displayId: 2, displayBounds: right.bounds }
    expect(resolveWindow({ ...base, displays: [primary], saved: docked, cursorDisplayId: 1 })).toEqual({
      bounds: { x: 0, y: 0, width: 960, height: 1040 },
      displayId: 1,
      dock: 'left',
      recovered: true
    })
    const floating = { dock: 'custom' as const, bounds: { x: 2500, y: 200, width: 700, height: 800 }, displayId: 2, displayBounds: right.bounds }
    expect(resolveWindow({ ...base, displays: [primary], saved: floating, cursorDisplayId: 1 })).toEqual({
      bounds: { x: 960, y: 0, width: 960, height: 1040 },
      displayId: 1,
      dock: 'right',
      recovered: true
    })
  })

  it('keeps a free-floating window that is still visible, shrinking it to fit', () => {
    const saved = { dock: 'custom' as const, bounds: { x: 100, y: 50, width: 700, height: 800 }, displayId: 1, displayBounds: primary.bounds }
    expect(resolveWindow({ ...base, saved, cursorDisplayId: 2 })).toEqual({ bounds: saved.bounds, displayId: 1, dock: 'custom', recovered: false })
    const tall = { ...saved, bounds: { x: 100, y: 0, width: 700, height: 5000 } }
    expect(resolveWindow({ ...base, saved: tall, cursorDisplayId: 2 }).bounds).toEqual({ x: 100, y: 0, width: 700, height: 1040 })
  })

  it('rejects positions whose title region cannot be reached', () => {
    expect(isUsablyVisible({ x: 100, y: -900, width: 700, height: 950 }, [primary])).toBe(false)
    expect(isUsablyVisible({ x: 1900, y: 100, width: 700, height: 800 }, [primary])).toBe(false)
    expect(isUsablyVisible({ x: 1700, y: 100, width: 700, height: 800 }, [primary])).toBe(true)
    expect(fitInside({ x: 1700, y: 900, width: 700, height: 800 }, primary.workArea)).toEqual({ x: 1220, y: 240, width: 700, height: 800 })
  })
})
