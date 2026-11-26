/**
 * Chart snapshots. The chart window is captured in the main process, without the notes taking
 * the keyboard or coming forward: the window whose title is a TradingView chart (or names
 * TradingView) when there is one, otherwise the display under the pointer with the notes
 * window cut away when it is docked to one side of that display.
 *
 * Of a browser window only the web page is kept: the browser's tabs, address bar, bookmarks
 * bar and side panels are cut away, using where Windows says the page sits in the window
 * (see windowGeometry.ts and @shared/pageCrop). When that cannot be told, the whole window is
 * kept, as before. The picture is asked for at the size of the part of the window that
 * Electron's window capture pictures, so that it is pixel for pixel what is on screen.
 */
import type { Display, NativeImage, SourcesOptions } from 'electron'
import { captureSize, keepsWholePicture, pageCrop, type Size, type WindowGeometry } from '@shared/pageCrop'
import { isTradingViewWindow, parseTradingViewTitle } from '@shared/sessionLog'
import type { Rect } from '@shared/windowBounds'

/** The parts of a desktopCapturer source this uses (a test can stand in for it). */
export interface CaptureSource {
  id: string
  name: string
  display_id: string
  thumbnail: NativeImage
}
export type GetSources = (options: SourcesOptions) => Promise<CaptureSource[]>
/** Where the page is in the window behind a window source id, or why that cannot be told. */
export type ReadGeometry = (sourceId: string) => { ok: true; geometry: WindowGeometry } | { ok: false; reason: string }

export interface CaptureContext {
  getSources: GetSources
  displays: Display[]
  /** The display under the pointer. */
  cursorDisplay: Display
  /** The notes window when it is visible and docked to a half of a display, else null. */
  docked: { bounds: Rect; displayId: number } | null
  /** Windows with this title are the app's own and never captured. */
  ownTitle: string
  readGeometry: ReadGeometry
}

/** What was kept of a window's picture, and why: for the diagnostics report and the tests. */
export interface CropReport {
  /** 'page': only the web page was kept. 'none': the whole window was kept. */
  method: 'page' | 'none'
  /** Why the whole window was kept. */
  reason: string | null
  /** The part of the picture kept, in the picture's pixels. */
  rect: Rect | null
  /** The window's picture as captured. */
  picture: Size
  /** The size it was asked for at. */
  requested: Size | null
  /** The part of the screen the picture was found to show, in physical pixels (null when not worked out). */
  pictured: Rect | null
  /** What Windows said about the window, in physical pixels (null when nothing could be read). */
  frame: Rect | null
  /** The part of the window webrtc's GDI window capturer pictures (null when nothing could be read). */
  gdiRegion: Rect | null
  pages: Rect[]
  /** The window's DPI, when known. */
  dpi: number | null
}

export type CaptureResult =
  | { ok: true; image: NativeImage; title: string | null; from: 'window' | 'display'; crop: CropReport | null }
  | { ok: false; message: string }

const NOTHING_CAPTURED = 'Nothing could be captured. Screen capture may not be allowed on this computer.'

/** Pick the chart window: a TradingView chart title first, then any window naming TradingView. */
export function chooseChartWindow(sources: Array<Pick<CaptureSource, 'id' | 'name'>>, ownTitle: string): Pick<CaptureSource, 'id' | 'name'> | null {
  const windows = sources.filter((source) => source.id.startsWith('window:') && source.name !== ownTitle && isTradingViewWindow(source.name))
  return windows.find((source) => parseTradingViewTitle(source.name) !== null) ?? windows[0] ?? null
}

/** Physical pixel size of the largest display: a window thumbnail this big is never scaled down. */
function largestDisplaySize(displays: Display[]): { width: number; height: number } {
  let width = 1
  let height = 1
  for (const display of displays) {
    width = Math.max(width, Math.round(display.bounds.width * display.scaleFactor))
    height = Math.max(height, Math.round(display.bounds.height * display.scaleFactor))
  }
  return { width, height }
}

/**
 * The part of a display's picture that is not the notes window: when the notes are docked to
 * the right half, the left part, and the other way round. Null when nothing is to be cut.
 */
export function cropAwayNotes(display: Pick<Display, 'id' | 'bounds'>, docked: CaptureContext['docked'], image: { width: number; height: number }): Rect | null {
  if (!docked || docked.displayId !== display.id) return null
  const { bounds } = display
  const scaleX = image.width / bounds.width
  const scaleY = image.height / bounds.height
  const notesLeft = docked.bounds.x - bounds.x
  const notesRight = notesLeft + docked.bounds.width
  // Docked right: keep what is left of the notes. Docked left: keep what is right of them.
  const keep = notesLeft > bounds.width / 4 ? { from: 0, to: notesLeft } : { from: notesRight, to: bounds.width }
  const x = Math.round(Math.max(0, keep.from) * scaleX)
  const width = Math.round(Math.min(bounds.width, keep.to) * scaleX) - x
  if (width < 32) return null
  return { x, y: 0, width, height: Math.round(bounds.height * scaleY) }
}

/** Keep only the web page of a window's picture, asked for at `requested`, when Windows says where it is; otherwise all of it. */
export function cropToPage(picture: NativeImage, lookup: ReturnType<ReadGeometry>, requested: Size | null): { image: NativeImage; crop: CropReport } {
  const size = picture.getSize()
  const none = { method: 'none' as const, rect: null, picture: size, requested, pictured: null }
  if (!lookup.ok) return { image: picture, crop: { ...none, reason: lookup.reason, frame: null, gdiRegion: null, pages: [], dpi: null } }
  const { frame, pages } = lookup.geometry
  const known = { frame, gdiRegion: lookup.geometry.gdiRegion ?? null, pages, dpi: lookup.geometry.dpi ?? null }
  if (!requested) return { image: picture, crop: { ...none, ...known, reason: 'the picture was not asked for at the browser window’s size' } }
  const crop = pageCrop(lookup.geometry, size, requested)
  if (crop.method === 'none') return { image: picture, crop: { ...none, ...known, reason: crop.reason } }
  const image = keepsWholePicture(crop.rect, size) ? picture : picture.crop(crop.rect)
  return { image, crop: { method: 'page', reason: null, rect: crop.rect, picture: size, requested, pictured: crop.pictured, ...known } }
}

export async function captureChart(context: CaptureContext): Promise<CaptureResult> {
  try {
    // Names only first (no pictures), to find the chart cheaply.
    const listed = await context.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    const chart = chooseChartWindow(listed, context.ownTitle)
    if (chart) {
      // Read just before the picture is taken. With the window known, the picture is asked for
      // at the size of the part of it that is pictured, so that it is pixel for pixel the screen.
      const lookup = context.readGeometry(chart.id)
      const fits = lookup.ok ? captureSize(lookup.geometry) : null
      const requested = fits && fits.width > 0 && fits.height > 0 ? fits : null
      const sources = await context.getSources({ types: ['window'], thumbnailSize: requested ?? largestDisplaySize(context.displays), fetchWindowIcons: false })
      const source = sources.find((candidate) => candidate.id === chart.id)
      if (source && !source.thumbnail.isEmpty()) {
        const { image, crop } = cropToPage(source.thumbnail, lookup, requested)
        return { ok: true, image, title: source.name, from: 'window', crop }
      }
    }
    const display = context.cursorDisplay
    const size = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) }
    const screens = await context.getSources({ types: ['screen'], thumbnailSize: size, fetchWindowIcons: false })
    const screen = screens.find((candidate) => candidate.display_id === String(display.id)) ?? (screens.length === 1 ? screens[0] : undefined)
    if (!screen || screen.thumbnail.isEmpty()) return { ok: false, message: NOTHING_CAPTURED }
    const picture = screen.thumbnail.getSize()
    const crop = cropAwayNotes(display, context.docked, picture)
    return { ok: true, image: crop ? screen.thumbnail.crop(crop) : screen.thumbnail, title: chart?.name ?? null, from: 'display', crop: null }
  } catch (error) {
    return { ok: false, message: `The chart could not be captured: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Above this size (or file size) a smaller preview is kept beside the original, as for a pasted screenshot. */
const PREVIEW_MAX_EDGE = 1800
const PREVIEW_MIN_BYTES = 350 * 1024

/** The original as PNG, and a smaller JPEG preview when that is worth having. */
export function encodeSnapshot(image: NativeImage): { bytes: Buffer; width: number; height: number; preview: { bytes: Buffer; width: number; height: number } | null } {
  const { width, height } = image.getSize()
  const bytes = image.toPNG()
  let preview: { bytes: Buffer; width: number; height: number } | null = null
  const longest = Math.max(width, height)
  if (longest > PREVIEW_MAX_EDGE || bytes.byteLength > PREVIEW_MIN_BYTES) {
    const scale = Math.min(1, PREVIEW_MAX_EDGE / longest)
    const small = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }) : image
    const jpeg = small.toJPEG(86)
    const size = small.getSize()
    // Only kept when it is actually smaller than the original.
    if (jpeg.byteLength < bytes.byteLength * 0.9) preview = { bytes: jpeg, width: size.width, height: size.height }
  }
  return { bytes, width, height, preview }
}
