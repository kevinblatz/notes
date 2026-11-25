/**
 * Giving the keyboard back to the window that had it (Windows).
 *
 * Electron can take the keyboard for the notes (focus) and let go of it (blur), but letting go
 * hands it to the next visible window below the notes in the z-order. For an always-on-top
 * window that is the taskbar, not the chart. Hiding is worse: Chromium hides a window without
 * activating another, so the hidden notes keep the keyboard and typing goes nowhere visible.
 *
 * So the window in front is noted just before a hotkey or the show shortcut brings the notes
 * forward, and gets the keyboard straight back when they are done (Windows allows it because
 * the notes are in front at that moment). When nothing usable was noted (the notes were
 * clicked into, or brought forward from the tray, when the taskbar was in front), the keyboard
 * goes to the top ordinary app window instead, which is the app used last. user32 is reached
 * through koffi.
 */

/** A window handle (HWND) as a number; 0 means none. */
export type WindowHandle = number

/** What decides whether a window can be given the keyboard. */
export interface WindowInfo {
  visible: boolean
  minimized: boolean
  /** Hidden by the system although "visible" (a suspended app, another virtual desktop). */
  cloaked: boolean
  pid: number
  className: string
  exStyle: number
}

export interface ForegroundApi {
  /** The window that has the keyboard now (0 when none). */
  current(): WindowHandle
  /** Null when the window no longer exists. */
  describe(hwnd: WindowHandle): WindowInfo | null
  /** The top-level windows from the top of the z-order down. */
  topDown(): Iterable<WindowHandle>
  /** Give it the keyboard. True when Windows accepted the request. */
  activate(hwnd: WindowHandle): boolean
}

export interface ForegroundStatus {
  /** user32 could be reached, so the keyboard goes back to the exact window that had it. */
  available: boolean
  /** Why it could not be reached (a missing or blocked native module, say). */
  error: string | null
}

/** The taskbar, the tray and the shell's flyouts: never where typing is meant to go. */
export const SHELL_CLASSES: ReadonlySet<string> = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland',
  'XamlExplorerHostIslandWindow',
  'TaskListThumbnailWnd',
  'MultitaskingViewFrame',
  'ForegroundStaging',
  'Windows.UI.Core.CoreWindow'
])
/** The desktop itself: a fine place to go back to if it was in front, but not "the app used last". */
const DESKTOP_CLASSES: ReadonlySet<string> = new Set(['Progman', 'WorkerW'])

const WS_EX_TOPMOST = 0x8
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_APPWINDOW = 0x40000

/** A window the keyboard may go back to: one that can be seen, outside this app and the shell. */
export function isReturnTarget(info: WindowInfo | null, ownPid: number): info is WindowInfo {
  return !!info && info.visible && !info.minimized && !info.cloaked && info.pid !== 0 && info.pid !== ownPid && !SHELL_CLASSES.has(info.className)
}

/** An ordinary app window (not always-on-top, not a tool window, not the desktop): what Alt+Tab would offer. */
export function isOrdinaryAppWindow(info: WindowInfo | null, ownPid: number): info is WindowInfo {
  if (!isReturnTarget(info, ownPid)) return false
  const tool = (info.exStyle & WS_EX_TOOLWINDOW) !== 0 && (info.exStyle & WS_EX_APPWINDOW) === 0
  return (info.exStyle & WS_EX_TOPMOST) === 0 && !tool && !DESKTOP_CLASSES.has(info.className)
}

/** The app used last: the top ordinary app window in the z-order. 0 when there is none. */
export function appUsedLast(api: ForegroundApi, ownPid: number): WindowHandle {
  let seen = 0
  for (const hwnd of api.topDown()) {
    if (++seen > 4096) break
    if (isOrdinaryAppWindow(api.describe(hwnd), ownPid)) return hwnd
  }
  return 0
}

let loaded: ForegroundApi | null | undefined
let loadError: string | null = null

/** user32's window functions, loaded on first use. Null where they are not available (any other platform, or a failed load). */
export function foregroundApi(): ForegroundApi | null {
  if (loaded !== undefined) return loaded
  loaded = null
  if (process.platform !== 'win32') return loaded
  try {
    // Loaded at run time from the app's own node_modules (see electron.vite.config.mts).
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const getForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
    const setForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr_t hWnd)')
    const isWindow = user32.func('int __stdcall IsWindow(intptr_t hWnd)')
    const isWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hWnd)')
    const isIconic = user32.func('int __stdcall IsIconic(intptr_t hWnd)')
    const getTopWindow = user32.func('intptr_t __stdcall GetTopWindow(intptr_t hWnd)')
    const getWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)')
    const getWindowLongPtr = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)')
    const getWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *lpdwProcessId)')
    const getClassName = user32.func('int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint8_t *lpClassName, int nMaxCount)')
    // Cloaking is optional information: without dwmapi every window counts as not cloaked.
    let dwmCloaked: ((hwnd: WindowHandle) => boolean) | null = null
    try {
      const dwmapi = koffi.load('dwmapi.dll')
      const getAttribute = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)')
      const DWMWA_CLOAKED = 14
      dwmCloaked = (hwnd) => {
        const value: [number | null] = [null]
        return Number(getAttribute(hwnd, DWMWA_CLOAKED, value, 4)) === 0 && Number(value[0] ?? 0) !== 0
      }
    } catch {
      dwmCloaked = null
    }
    const GW_HWNDNEXT = 2
    const GWL_EXSTYLE = -20
    loaded = {
      current: () => Number(getForegroundWindow()),
      describe: (hwnd) => {
        if (hwnd === 0 || Number(isWindow(hwnd)) === 0) return null
        const pid: [number | null] = [null]
        getWindowThreadProcessId(hwnd, pid)
        const name = Buffer.alloc(512)
        const length = Number(getClassName(hwnd, name, 256))
        return {
          visible: Number(isWindowVisible(hwnd)) !== 0,
          minimized: Number(isIconic(hwnd)) !== 0,
          cloaked: dwmCloaked ? dwmCloaked(hwnd) : false,
          pid: Number(pid[0] ?? 0),
          className: length > 0 ? name.toString('utf16le', 0, length * 2) : '',
          exStyle: Number(getWindowLongPtr(hwnd, GWL_EXSTYLE))
        }
      },
      topDown: function* () {
        for (let hwnd = Number(getTopWindow(0)); hwnd !== 0; hwnd = Number(getWindow(hwnd, GW_HWNDNEXT))) yield hwnd
      },
      activate: (hwnd) => Number(setForegroundWindow(hwnd)) !== 0
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
  }
  return loaded
}

export function foregroundStatus(): ForegroundStatus {
  const api = foregroundApi()
  return { available: api !== null, error: loadError }
}

/** For the unit tests only. */
export function setForegroundApiForTests(api: ForegroundApi | null | undefined, error: string | null = null): void {
  loaded = api
  loadError = error
}

/** A native window handle as Electron gives it (a pointer-sized little-endian buffer) as a number. */
export function handleFromBuffer(buffer: Buffer): WindowHandle {
  if (buffer.length >= 8) return Number(buffer.readBigUInt64LE(0))
  if (buffer.length >= 4) return buffer.readUInt32LE(0)
  return 0
}
