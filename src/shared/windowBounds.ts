/**
 * Window placement maths, kept free of Electron so it can be unit tested with made-up
 * monitor arrangements. All rectangles are in Electron's device-independent pixels, which
 * already account for per-monitor Windows display scaling.
 */
import type { DockSide } from './types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  /** Full monitor rectangle. */
  bounds: Rect
  /** Monitor rectangle minus the taskbar and other reserved areas. */
  workArea: Rect
  scaleFactor: number
}

export interface SavedWindowState {
  dock: DockSide | 'custom'
  bounds: Rect | null
  displayId: number | null
  /** Bounds of the display at save time; used to recognise it again if its ID changed. */
  displayBounds: Rect | null
}

export interface ResolvedWindow {
  bounds: Rect
  displayId: number
  dock: DockSide | 'custom'
  /** True when the saved position could not be used and the window was moved somewhere visible. */
  recovered: boolean
}

export const MIN_WIDTH = 420
export const MIN_HEIGHT = 360
/** How much of the window must be on screen for a saved position to count as usable. */
const MIN_VISIBLE_WIDTH = 160
const MIN_VISIBLE_HEIGHT = 120
/** Height of the draggable title region; part of it must be reachable. */
const TITLE_REGION = 32

/**
 * Half of the usable work area, never covering the taskbar. Odd widths give the extra pixel
 * to the left half. On a monitor too narrow for two readable halves (a portrait or heavily
 * scaled display) the window keeps its minimum width and stays flush with its own edge of the
 * screen instead of hanging off it.
 */
export function dockBounds(workArea: Rect, side: DockSide): Rect {
  const leftHalf = Math.ceil(workArea.width / 2)
  const half = side === 'left' ? leftHalf : workArea.width - leftHalf
  const width = Math.max(half, Math.min(MIN_WIDTH, workArea.width))
  const height = Math.max(workArea.height, Math.min(MIN_HEIGHT, workArea.height))
  const x = side === 'left' ? workArea.x : workArea.x + workArea.width - width
  return { x, y: workArea.y, width, height }
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

export function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** The display showing the largest part of `bounds`, or null if it is entirely off screen. */
export function displayForBounds(bounds: Rect, displays: DisplayInfo[]): DisplayInfo | null {
  let best: DisplayInfo | null = null
  let bestArea = 0
  for (const display of displays) {
    const overlap = intersection(bounds, display.workArea)
    const area = overlap ? overlap.width * overlap.height : 0
    if (area > bestArea) {
      best = display
      bestArea = area
    }
  }
  return best
}

/**
 * A saved position is usable when enough of the window, including part of its title region,
 * is inside one display's work area. Otherwise the user could not see or grab it.
 */
export function isUsablyVisible(bounds: Rect, displays: DisplayInfo[]): boolean {
  const titleRegion: Rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: TITLE_REGION }
  return displays.some((display) => {
    const body = intersection(bounds, display.workArea)
    const title = intersection(titleRegion, display.workArea)
    if (!body || !title) return false
    const needWidth = Math.min(MIN_VISIBLE_WIDTH, bounds.width)
    const needHeight = Math.min(MIN_VISIBLE_HEIGHT, bounds.height)
    return body.width >= needWidth && body.height >= needHeight && title.width >= needWidth && title.height >= TITLE_REGION / 2
  })
}

/** Keep a free-floating window no larger than the work area and fully inside it. */
export function fitInside(bounds: Rect, workArea: Rect): Rect {
  const width = Math.max(Math.min(bounds.width, workArea.width), Math.min(MIN_WIDTH, workArea.width))
  const height = Math.max(Math.min(bounds.height, workArea.height), Math.min(MIN_HEIGHT, workArea.height))
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

function findSavedDisplay(saved: SavedWindowState, displays: DisplayInfo[]): DisplayInfo | null {
  if (saved.displayId !== null) {
    const byId = displays.find((d) => d.id === saved.displayId)
    if (byId) return byId
  }
  if (saved.displayBounds) {
    const byBounds = displays.find((d) => rectsEqual(d.bounds, saved.displayBounds))
    if (byBounds) return byBounds
  }
  return null
}

export interface ResolveInput {
  saved: SavedWindowState | null
  displays: DisplayInfo[]
  /** Display under the mouse cursor; used on first launch. */
  cursorDisplayId: number | null
  primaryDisplayId: number
  preferredSide: DockSide
}

/**
 * Decide where the window opens.
 *  - First launch: docked to the preferred half of the monitor under the cursor.
 *  - Docked before: docked again on the same monitor, recomputed from its current work area
 *    (so a moved taskbar or a changed scale factor is handled).
 *  - Free-floating before: the saved rectangle, if it is still usably visible.
 *  - Monitor gone or rectangle off screen: docked on the primary monitor, flagged `recovered`.
 */
export function resolveWindow(input: ResolveInput): ResolvedWindow {
  const { saved, displays, preferredSide } = input
  if (displays.length === 0) throw new Error('No displays available.')
  const primary = displays.find((d) => d.id === input.primaryDisplayId) ?? displays[0]!
  const cursor = displays.find((d) => d.id === input.cursorDisplayId) ?? primary

  if (!saved) {
    return { bounds: dockBounds(cursor.workArea, preferredSide), displayId: cursor.id, dock: preferredSide, recovered: false }
  }

  const display = findSavedDisplay(saved, displays)

  if (saved.dock !== 'custom') {
    const target = display ?? primary
    return { bounds: dockBounds(target.workArea, saved.dock), displayId: target.id, dock: saved.dock, recovered: display === null }
  }

  if (saved.bounds && isUsablyVisible(saved.bounds, displays)) {
    const host = displayForBounds(saved.bounds, displays) ?? display ?? primary
    return { bounds: fitInside(saved.bounds, host.workArea), displayId: host.id, dock: 'custom', recovered: false }
  }

  return { bounds: dockBounds(primary.workArea, preferredSide), displayId: primary.id, dock: preferredSide, recovered: true }
}
