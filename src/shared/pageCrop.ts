/**
 * Keeping only the web page of a browser window's picture.
 *
 * On Windows, Chromium browsers (Chrome, Edge and the others) show the web page in a child
 * window of class Chrome_RenderWidgetHostHWND (the "Chrome Legacy Window"); the browser's
 * tabs, address bar, bookmarks bar and side panels are drawn around it. Where that window
 * sits inside the part of the browser window that the picture shows says which part of the
 * picture is the page. Nothing is guessed from the picture's pixels, and nothing is ever sent
 * to the browser: the geometry is only read.
 *
 * Which part of the window a picture shows depends on how Electron took it. Its window
 * capture (desktopCapturer) uses webrtc's GDI window capturer, which pictures the window
 * rectangle less the resize borders as it reckons them (gdiCaptureRegion); on Windows 11 it
 * falls back to Windows Graphics Capture when that gives a blank picture, and that pictures
 * the window's visible frame (DWMWA_EXTENDED_FRAME_BOUNDS). Either picture is scaled to fit
 * the size asked for, keeping its shape, so its size tells the two apart (picturedRegion).
 *
 * All rectangles here are in physical screen pixels; crops are in the picture's own pixels.
 */
import type { Rect } from './windowBounds'

/** The class Chromium gives the child window that holds a web page. */
export const PAGE_WINDOW_CLASS = 'Chrome_RenderWidgetHostHWND'

/** What is read from Windows about a captured window. */
export interface WindowGeometry {
  /** The window's visible frame (DWMWA_EXTENDED_FRAME_BOUNDS): what Windows Graphics Capture pictures. */
  frame: Rect
  /** What webrtc's GDI window capturer pictures (see gdiCaptureRegion). Missing: the frame. */
  gdiRegion?: Rect
  /** Every visible page window inside it (GetWindowRect of each Chrome_RenderWidgetHostHWND). */
  pages: Rect[]
  /** The window's DPI (GetDpiForWindow; 96 is 100 %), when known. */
  dpi?: number | null
}

export interface Size {
  width: number
  height: number
}

/** The part of the picture to keep, or why the whole picture is kept. */
export type PageCrop = { method: 'page'; rect: Rect } | { method: 'none'; reason: string }

/** A crop, with the part of the screen the picture was found to show (null when that was not worked out). */
export type PageCropResult = PageCrop & { pictured: Rect | null }

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

/** The system metrics webrtc's GDI window capturer crops a window's resize borders by. */
export interface BorderMetrics {
  /** GetSystemMetrics(SM_CXSIZEFRAME): cut from the left and the right. */
  sizeFrameX: number
  /** GetSystemMetrics(SM_CYSIZEFRAME): cut from the bottom. */
  sizeFrameY: number
  /** GetSystemMetrics(SM_CYBORDER): cut from the top. */
  borderY: number
}

const WS_THICKFRAME = 0x00040000
const DS_MODALFRAME = 0x80

/**
 * The part of a top-level window that webrtc's GDI window capturer pictures, worked out as it
 * does (GetCroppedWindowRect, Windows 8 and later, the window itself rather than one it owns):
 * the window rectangle (GetWindowRect), less SM_CXSIZEFRAME on the left and right,
 * SM_CYSIZEFRAME at the bottom and SM_CYBORDER at the top, when the window has a resize border
 * (WS_THICKFRAME or DS_MODALFRAME) and its visible frame does not start at its left edge;
 * otherwise the whole window rectangle. The metrics are read in this process, which is the
 * one that captures, so they are the ones the capturer uses.
 */
export function gdiCaptureRegion(window: Rect, frame: Rect, style: number, metrics: BorderMetrics): Rect {
  if (frame.x === window.x || (style & (WS_THICKFRAME | DS_MODALFRAME)) === 0) return { ...window }
  return {
    x: window.x + metrics.sizeFrameX,
    y: window.y + metrics.borderY,
    width: window.width - 2 * metrics.sizeFrameX,
    height: window.height - metrics.borderY - metrics.sizeFrameY
  }
}

/**
 * The size of the picture desktopCapturer gives for `content` asked for at `target`: scaled to
 * fit inside it, its shape kept, rounded as Chromium rounds (media::ComputeLetterboxRegion).
 */
export function letterboxSize(target: Size, content: Size): Size {
  if (!(content.width > 0 && content.height > 0 && target.width > 0 && target.height > 0)) return { width: 0, height: 0 }
  const x = content.width * target.height
  const y = content.height * target.width
  const rounded = (a: number, b: number): number => Math.floor((a + Math.floor(b / 2)) / b)
  return y < x ? { width: target.width, height: rounded(y, content.width) } : { width: rounded(x, content.height), height: target.height }
}

/** The size to ask desktopCapturer for: that of the part of the window it pictures, so that the picture is pixel for pixel the screen. */
export function captureSize(geometry: WindowGeometry): Size {
  const region = geometry.gdiRegion ?? geometry.frame
  return { width: region.width, height: region.height }
}

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/**
 * Which part of the screen a window's picture shows, told by its size: the GDI region or the
 * visible frame, whichever, scaled to fit the size asked for, has the picture's size (to a
 * pixel). When neither does, or both do, nothing can be placed in the picture.
 */
export function picturedRegion(geometry: WindowGeometry, requested: Size, picture: Size): { region: Rect } | { reason: string } {
  const candidates: Rect[] = []
  for (const region of [geometry.gdiRegion, geometry.frame]) {
    if (region && region.width > 0 && region.height > 0 && !candidates.some((known) => sameRect(known, region))) candidates.push(region)
  }
  const matching = candidates.filter((region) => {
    const expected = letterboxSize(requested, { width: region.width, height: region.height })
    return Math.abs(expected.width - picture.width) <= 1 && Math.abs(expected.height - picture.height) <= 1
  })
  if (matching.length === 0) return { reason: 'the picture is not of the browser window as Windows reports it' }
  if (matching.length > 1) return { reason: 'it cannot be told which part of the browser window the picture shows' }
  return { region: matching[0]! }
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
 * The page's place in the picture of `region` (the part of the screen the picture shows):
 * (page - region) scaled by picture size / region size. Edges are rounded inwards, so no row
 * of the browser's own bar is ever kept, and then moved `inset` more pixels inwards (for a
 * scaled picture, whose edge rows blend in their neighbours, and for a display scale that is
 * not a whole multiple of 100 %, where Chromium rounds the page window outwards by up to a
 * pixel).
 */
export function mapPageToPicture(region: Rect, page: Rect, picture: Size, inset = 0): PageCrop {
  if (!(region.width > 0 && region.height > 0 && picture.width > 0 && picture.height > 0)) return { method: 'none', reason: 'the picture or the window is empty' }
  // The picture is the region, scaled the same both ways. Anything else is not this window as read.
  const expectedHeight = (region.height * picture.width) / region.width
  if (Math.abs(expectedHeight - picture.height) > Math.max(3, picture.height * 0.02)) return { method: 'none', reason: 'the picture does not match the browser window' }
  const scaleX = picture.width / region.width
  const scaleY = picture.height / region.height
  const kept = intersect(page, region)
  const EPSILON = 1e-6
  const left = Math.max(0, Math.ceil((kept.x - region.x) * scaleX - EPSILON)) + inset
  const top = Math.max(0, Math.ceil((kept.y - region.y) * scaleY - EPSILON)) + inset
  const right = Math.min(picture.width, Math.floor((kept.x + kept.width - region.x) * scaleX + EPSILON)) - inset
  const bottom = Math.min(picture.height, Math.floor((kept.y + kept.height - region.y) * scaleY + EPSILON)) - inset
  if (right - left < 1 || bottom - top < 1) return { method: 'none', reason: 'the page is not in the picture' }
  return { method: 'page', rect: { x: left, y: top, width: right - left, height: bottom - top } }
}

/**
 * What to keep of a browser window's picture, given what Windows says about the window and the
 * size the picture was asked for at (by default captureSize, as captureChart asks).
 */
export function pageCrop(geometry: WindowGeometry, picture: Size, requested: Size = captureSize(geometry)): PageCropResult {
  const chosen = choosePage(geometry)
  if ('reason' in chosen) return { method: 'none', reason: chosen.reason, pictured: null }
  const pictured = picturedRegion(geometry, requested, picture)
  if ('reason' in pictured) return { method: 'none', reason: pictured.reason, pictured: null }
  const { region } = pictured
  const scaled = picture.width !== region.width || picture.height !== region.height
  const fractionalScale = typeof geometry.dpi === 'number' && geometry.dpi > 0 && geometry.dpi % 96 !== 0
  return { ...mapPageToPicture(region, chosen.page, picture, scaled || fractionalScale ? 1 : 0), pictured: region }
}

/** True when a crop keeps the whole picture (a full-screen page): nothing to cut. */
export function keepsWholePicture(rect: Rect, picture: Size): boolean {
  return rect.x === 0 && rect.y === 0 && rect.width === picture.width && rect.height === picture.height
}
