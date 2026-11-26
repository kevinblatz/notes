/**
 * Where the web page is inside a captured browser window (Windows), so that the snapshot can
 * keep the page and leave out the browser's tabs, address bar, bookmarks bar and side panels.
 *
 * Only window geometry is read: the window's visible frame from the desktop window manager
 * (DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS), its rectangle, style, DPI and the
 * system's resize border sizes (from which the part of it that Electron's window capture
 * pictures is worked out, see gdiCaptureRegion), and the rectangles of its visible
 * Chrome_RenderWidgetHostHWND child windows (GetWindowRect), found by walking the child
 * windows with GetWindow (no callbacks). Nothing is sent to the browser: no keys, no clicks,
 * no window messages, and no accessibility or UI Automation, which would switch on the
 * browser's accessibility support and slow it down. The readings are in physical pixels (the
 * desktop window manager always gives those; GetWindowRect does to a per-monitor DPI aware
 * process, which the Electron main process is, and that is checked). user32 and dwmapi are
 * reached through koffi, as in foreground.ts.
 */
import { gdiCaptureRegion, hwndFromSourceId, PAGE_WINDOW_CLASS, type WindowGeometry } from '@shared/pageCrop'
import type { Rect } from '@shared/windowBounds'

/** A window handle (HWND) as a number; 0 means none. */
type WindowHandle = number

/** The few questions the walk asks of each window (a test can stand in for Windows). */
export interface WindowTree {
  /** Its first child window, 0 when it has none (GetWindow GW_CHILD). */
  firstChild(hwnd: WindowHandle): WindowHandle
  /** The next window at the same level, 0 after the last (GetWindow GW_HWNDNEXT). */
  next(hwnd: WindowHandle): WindowHandle
  className(hwnd: WindowHandle): string
  /** Shown, and so are all the windows it is inside (IsWindowVisible). */
  visible(hwnd: WindowHandle): boolean
  /** Its rectangle on screen, null when it cannot be read (GetWindowRect). */
  rect(hwnd: WindowHandle): Rect | null
}

/** Never walk more windows than this (a browser window has a handful). */
const WALK_LIMIT = 4096

/**
 * The rectangles of the visible page windows anywhere under `root`, depth first, without
 * callbacks. Hidden windows are skipped with everything inside them. (Chromium creates a page
 * window for every page view, sized to the page, and hides it, or moves it out of the browser
 * window, while that page is not shown: a background tab, or a minimized or completely
 * covered browser window.)
 */
export function findPageWindows(tree: WindowTree, root: WindowHandle): { pages: Rect[]; walked: number } {
  const pages: Rect[] = []
  const pending: WindowHandle[] = []
  let walked = 0
  const addChildren = (parent: WindowHandle): void => {
    for (let child = tree.firstChild(parent); child !== 0 && walked + pending.length < WALK_LIMIT; child = tree.next(child)) pending.push(child)
  }
  addChildren(root)
  while (pending.length > 0 && walked < WALK_LIMIT) {
    const hwnd = pending.pop()!
    walked++
    if (!tree.visible(hwnd)) continue
    if (tree.className(hwnd) === PAGE_WINDOW_CLASS) {
      const rect = tree.rect(hwnd)
      if (rect && rect.width > 0 && rect.height > 0) pages.push(rect)
    }
    addChildren(hwnd)
  }
  return { pages, walked }
}

/** What is read for one window, with what the snapshot report says about the reading. */
export interface GeometryReading extends WindowGeometry {
  /** The window's rectangle (GetWindowRect), resize borders included. */
  window: Rect
  /** How many child windows were looked at. */
  walked: number
}

export interface WindowGeometryApi {
  /** Null when the window is gone, minimized, or its frame cannot be read. */
  read(hwnd: WindowHandle): GeometryReading | null
  /** False when this process gets scaled (not physical) window rectangles: then nothing is cut. */
  physicalPixels(): boolean
}

export type GeometryLookup = { ok: true; geometry: GeometryReading } | { ok: false; reason: string }

export interface WindowGeometryStatus {
  available: boolean
  error: string | null
}

let loaded: WindowGeometryApi | null | undefined
let loadError: string | null = null

const rectFrom = (buffer: Buffer): Rect => {
  const left = buffer.readInt32LE(0)
  const top = buffer.readInt32LE(4)
  return { x: left, y: top, width: buffer.readInt32LE(8) - left, height: buffer.readInt32LE(12) - top }
}

/** user32's and dwmapi's window geometry, loaded on first use. Null on any other platform, or when they cannot be loaded. */
export function windowGeometryApi(): WindowGeometryApi | null {
  if (loaded !== undefined) return loaded
  loaded = null
  if (process.platform !== 'win32') return loaded
  try {
    // Loaded at run time from the app's own node_modules (see electron.vite.config.mts).
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    const isWindow = user32.func('int __stdcall IsWindow(intptr_t hWnd)')
    const isIconic = user32.func('int __stdcall IsIconic(intptr_t hWnd)')
    const isWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hWnd)')
    const getWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)')
    const getClassName = user32.func('int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint8_t *lpClassName, int nMaxCount)')
    const getWindowRect = user32.func('int __stdcall GetWindowRect(intptr_t hWnd, _Out_ uint8_t *lpRect)')
    const getAttribute = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ uint8_t *pvAttribute, uint32_t cbAttribute)')
    const getWindowLong = user32.func('int32_t __stdcall GetWindowLongW(intptr_t hWnd, int nIndex)')
    const getSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)')
    // Windows 10 1607 and later: the window's DPI. Without it the display scale is not known.
    let dpiOf: ((hwnd: WindowHandle) => number | null) | null = null
    try {
      const getDpiForWindow = user32.func('uint32_t __stdcall GetDpiForWindow(intptr_t hwnd)')
      dpiOf = (hwnd) => Number(getDpiForWindow(hwnd)) || null
    } catch {
      dpiOf = null
    }
    // Windows 10 1607 and later: how this thread is DPI aware. Without it, rectangles are taken as physical.
    let awareness: (() => number) | null = null
    try {
      const getContext = user32.func('intptr_t __stdcall GetThreadDpiAwarenessContext()')
      const awarenessOf = user32.func('int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t value)')
      awareness = () => Number(awarenessOf(getContext()))
    } catch {
      awareness = null
    }
    const GW_HWNDNEXT = 2
    const GW_CHILD = 5
    const DWMWA_EXTENDED_FRAME_BOUNDS = 9
    const GWL_STYLE = -16
    const SM_CYBORDER = 6
    const SM_CXSIZEFRAME = 32
    const SM_CYSIZEFRAME = 33
    const DPI_AWARENESS_PER_MONITOR_AWARE = 2
    const tree: WindowTree = {
      firstChild: (hwnd) => Number(getWindow(hwnd, GW_CHILD)),
      next: (hwnd) => Number(getWindow(hwnd, GW_HWNDNEXT)),
      className: (hwnd) => {
        const name = Buffer.alloc(512)
        const length = Number(getClassName(hwnd, name, 256))
        return length > 0 ? name.toString('utf16le', 0, length * 2) : ''
      },
      visible: (hwnd) => Number(isWindowVisible(hwnd)) !== 0,
      rect: (hwnd) => {
        const buffer = Buffer.alloc(16)
        return Number(getWindowRect(hwnd, buffer)) !== 0 ? rectFrom(buffer) : null
      }
    }
    loaded = {
      read: (hwnd) => {
        if (Number(isWindow(hwnd)) === 0 || Number(isIconic(hwnd)) !== 0) return null
        const buffer = Buffer.alloc(16)
        if (Number(getAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buffer, 16)) !== 0) return null
        const frame = rectFrom(buffer)
        const window = tree.rect(hwnd)
        if (frame.width <= 0 || frame.height <= 0 || !window || window.width <= 0 || window.height <= 0) return null
        const metrics = { sizeFrameX: Number(getSystemMetrics(SM_CXSIZEFRAME)), sizeFrameY: Number(getSystemMetrics(SM_CYSIZEFRAME)), borderY: Number(getSystemMetrics(SM_CYBORDER)) }
        const gdiRegion = gdiCaptureRegion(window, frame, Number(getWindowLong(hwnd, GWL_STYLE)), metrics)
        return { frame, window, gdiRegion, dpi: dpiOf ? dpiOf(hwnd) : null, ...findPageWindows(tree, hwnd) }
      },
      physicalPixels: () => (awareness ? awareness() === DPI_AWARENESS_PER_MONITOR_AWARE : true)
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
  }
  return loaded
}

export function windowGeometryStatus(): WindowGeometryStatus {
  const api = windowGeometryApi()
  return { available: api !== null, error: loadError }
}

/** For the unit tests only. */
export function setWindowGeometryApiForTests(api: WindowGeometryApi | null | undefined, error: string | null = null): void {
  loaded = api
  loadError = error
}

/** Where the page is in the window behind a desktopCapturer source id, or why that cannot be told. */
export function lookUpWindowGeometry(sourceId: string): GeometryLookup {
  const api = windowGeometryApi()
  if (!api) return { ok: false, reason: process.platform === 'win32' ? `window geometry could not be read (${loadError ?? 'user32 not loaded'})` : 'the page is only found on Windows' }
  const hwnd = hwndFromSourceId(sourceId)
  if (hwnd === null) return { ok: false, reason: 'the window source has no window handle' }
  try {
    if (!api.physicalPixels()) return { ok: false, reason: 'window rectangles are scaled for this app, so they cannot be matched to the picture' }
    const geometry = api.read(hwnd)
    return geometry ? { ok: true, geometry } : { ok: false, reason: 'the browser window could not be read (closed or minimized)' }
  } catch (error) {
    return { ok: false, reason: `the browser window could not be read (${error instanceof Error ? error.message : String(error)})` }
  }
}
