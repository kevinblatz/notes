/**
 * Giving the keyboard back to the window that had it (Windows).
 *
 * Electron can take the keyboard for the notes (focus) and let go of it (blur), but letting go
 * hands it to the next visible window below the notes in the z-order. For an always-on-top
 * window that is the taskbar, not the chart. Hiding is worse: Chromium hides a window without
 * activating another, so the hidden notes keep the keyboard and typing goes nowhere visible.
 *
 * So the window that had the keyboard is noted when the notes take it: by asking Windows which
 * window is in front just before a hotkey or the show shortcut brings the notes forward, and
 * from the WM_ACTIVATE message, which names the window that was active before (a click into the
 * notes, Alt+Tab). Giving the keyboard back then means activating that window directly, which
 * Windows allows because the notes are in front at that moment. user32 is reached through koffi.
 */

/** A window handle (HWND) as a number; 0 means none. */
export type WindowHandle = number

export interface ForegroundApi {
  /** The window that has the keyboard now (0 when none). */
  current(): WindowHandle
  /** The window still exists, is shown and is not minimized. */
  usable(hwnd: WindowHandle): boolean
  /** Give it the keyboard. True when Windows accepted the request. */
  activate(hwnd: WindowHandle): boolean
}

export interface ForegroundStatus {
  /** user32 could be reached, so the keyboard goes back to the exact window that had it. */
  available: boolean
  /** Why it could not be reached (a missing or blocked native module, say). */
  error: string | null
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
    loaded = {
      current: () => Number(getForegroundWindow()),
      usable: (hwnd) => hwnd !== 0 && Number(isWindow(hwnd)) !== 0 && Number(isWindowVisible(hwnd)) !== 0 && Number(isIconic(hwnd)) === 0,
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

export const WM_ACTIVATE = 0x0006
const WA_INACTIVE = 0

/**
 * The window that was active before the notes, from a WM_ACTIVATE message: when the notes are
 * being activated, lParam is the window being deactivated (it can be none). Null when the
 * message is the notes being deactivated, or names no other window.
 */
export function previousWindowFromActivate(wParam: Buffer, lParam: Buffer, own: WindowHandle): WindowHandle | null {
  if (wParam.length < 2) return null
  if (wParam.readUInt16LE(0) === WA_INACTIVE) return null
  const previous = handleFromBuffer(lParam)
  return previous !== 0 && previous !== own ? previous : null
}
