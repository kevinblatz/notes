/**
 * Keeping only the web page of a browser window's picture.
 *
 * On Windows, Chromium browsers (Chrome, Edge and the others) show the web page in a child
 * window of class Chrome_RenderWidgetHostHWND (the "Chrome Legacy Window"); the browser's
 * tabs, address bar, bookmarks bar and side panels are drawn around it. Where that window
 * sits inside the browser window's visible frame says which part of the window's picture is
 * the page. Nothing is guessed from the picture's pixels, and nothing is ever sent to the
 * browser: the geometry is only read.
 *
 * The frame and page rectangles are in physical screen pixels; the result is in the
 * picture's own pixels (a window capture can be scaled to fit the size asked for).
 */
import type { Rect } from './windowBounds'

/** The class Chromium gives the child window that holds a web page. */
export const PAGE_WINDOW_CLASS = 'Chrome_RenderWidgetHostHWND'

/** What is read from Windows about a captured window. */
export interface WindowGeometry {
  /** The window's visible frame (DWMWA_EXTENDED_FRAME_BOUNDS): what a window capture pictures. */
  frame: Rect
  /** Every visible page window inside it (GetWindowRect of each Chrome_RenderWidgetHostHWND). */
  pages: Rect[]
}

export interface Size {
  width: number
  height: number
}

/** The part of the picture to keep, or why the whole picture is kept. */
export type PageCrop = { method: 'page'; rect: Rect } | { method: 'none'; reason: string }

/** A page edge may stick out of the frame by this much (rounding between the two readings). */
export const FRAME_TOLERANCE = 2
/** A page narrower or lower than this is not the chart. */
export const MIN_PAGE_EDGE = 100
/** Nor is one that fills less than this share of the window. */
export const MIN_PAGE_SHARE = 0.3

const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height)

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

function insideFrame(page: Rect, frame: Rect): boolean {
  return (
    page.x >= frame.x - FRAME_TOLERANCE &&
    page.y >= frame.y - FRAME_TOLERANCE &&
    page.x + page.width <= frame.x + frame.width + FRAME_TOLERANCE &&
    page.y + page.height <= frame.y + frame.height + FRAME_TOLERANCE
  )
}

/**
 * The Windows handle in a desktopCapturer window source id ("window:<HWND>:<n>"), or null
 * when the id carries none.
 */
export function hwndFromSourceId(id: string): number | null {
  const match = /^window:(-?\d{1,20}):\d+$/.exec(id)
  if (!match) return null
  const hwnd = Number(match[1])
  return Number.isSafeInteger(hwnd) && hwnd !== 0 ? hwnd : null
}

/**
 * The page to keep: the largest page window, when it is plausibly the whole chart page. A
 * side panel or docked developer tools beside it are smaller and simply left out. Two
 * substantial pages side by side (split view) cannot be told apart, so nothing is cut then.
 */
export function choosePage(geometry: WindowGeometry): { page: Rect } | { reason: string } {
  const { frame } = geometry
  if (!(frame.width > 0 && frame.height > 0)) return { reason: 'the window has no visible frame' }
  const pages = geometry.pages.filter((page) => page.width > 0 && page.height > 0)
  if (pages.length === 0) return { reason: 'no page window was found in the browser window' }
  const largest = pages.reduce((best, page) => (area(page) > area(best) ? page : best))
  if (!insideFrame(largest, frame)) return { reason: 'the page window is outside the browser window' }
  const page = intersect(largest, frame)
  if (page.width < MIN_PAGE_EDGE || page.height < MIN_PAGE_EDGE || area(page) < MIN_PAGE_SHARE * area(frame)) {
    return { reason: 'the page window is too small to be the chart' }
  }
  for (const other of pages) {
    if (other === largest) continue
    const shown = intersect(other, frame)
    // Another page of its own size that is not on top of the chosen one: which is the chart?
    if (area(shown) >= MIN_PAGE_SHARE * area(frame) && area(intersect(shown, page)) < 0.9 * area(shown)) {
      return { reason: 'two pages are side by side in the browser window' }
    }
  }
  return { page }
}

/**
 * The page's place in the window's picture: (page - frame) scaled by picture size / frame
 * size. Edges are rounded inwards, so no row of the browser's own bar is ever kept.
 */
export function mapPageToPicture(frame: Rect, page: Rect, picture: Size): PageCrop {
  if (!(frame.width > 0 && frame.height > 0 && picture.width > 0 && picture.height > 0)) return { method: 'none', reason: 'the picture or the window is empty' }
  // The picture is the frame, scaled the same both ways. Anything else is not this window as read.
  const expectedHeight = (frame.height * picture.width) / frame.width
  if (Math.abs(expectedHeight - picture.height) > Math.max(3, picture.height * 0.02)) return { method: 'none', reason: 'the picture does not match the browser window' }
  const scaleX = picture.width / frame.width
  const scaleY = picture.height / frame.height
  const kept = intersect(page, frame)
  const EPSILON = 1e-6
  const left = Math.max(0, Math.ceil((kept.x - frame.x) * scaleX - EPSILON))
  const top = Math.max(0, Math.ceil((kept.y - frame.y) * scaleY - EPSILON))
  const right = Math.min(picture.width, Math.floor((kept.x + kept.width - frame.x) * scaleX + EPSILON))
  const bottom = Math.min(picture.height, Math.floor((kept.y + kept.height - frame.y) * scaleY + EPSILON))
  if (right - left < 1 || bottom - top < 1) return { method: 'none', reason: 'the page is not in the picture' }
  return { method: 'page', rect: { x: left, y: top, width: right - left, height: bottom - top } }
}

/** What to keep of a browser window's picture, given what Windows says about the window. */
export function pageCrop(geometry: WindowGeometry, picture: Size): PageCrop {
  const chosen = choosePage(geometry)
  if ('reason' in chosen) return { method: 'none', reason: chosen.reason }
  return mapPageToPicture(geometry.frame, chosen.page, picture)
}

/** True when a crop keeps the whole picture (a full-screen page): nothing to cut. */
export function keepsWholePicture(rect: Rect, picture: Size): boolean {
  return rect.x === 0 && rect.y === 0 && rect.width === picture.width && rect.height === picture.height
}
