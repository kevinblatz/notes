import { describe, expect, it } from 'vitest'
import { appUsedLast, foregroundApi, foregroundStatus, handleFromBuffer, isOrdinaryAppWindow, isReturnTarget, type ForegroundApi, type WindowInfo } from '../../src/main/foreground'

const OWN = 4242

function info(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return { visible: true, minimized: false, cloaked: false, pid: 9000, className: 'Chrome_WidgetWin_1', exStyle: 0x100, ...overrides }
}

describe('window handles from Electron buffers', () => {
  it('reads 64-bit and 32-bit handles', () => {
    const wide = Buffer.alloc(8)
    wide.writeBigUInt64LE(0x1a2b3cn)
    expect(handleFromBuffer(wide)).toBe(0x1a2b3c)
    const small = Buffer.alloc(4)
    small.writeUInt32LE(0x00450a2e)
    expect(handleFromBuffer(small)).toBe(0x00450a2e)
    expect(handleFromBuffer(Buffer.alloc(0))).toBe(0)
  })
})

describe('where the keyboard may go back to', () => {
  it('accepts an app window the user can see', () => {
    expect(isReturnTarget(info())).toBe(true)
    // The desktop, if that is where the user was.
    expect(isReturnTarget(info({ className: 'Progman', pid: 7000 }))).toBe(true)
  })
  it('never the taskbar, the tray or its flyouts', () => {
    for (const className of ['Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland', 'XamlExplorerHostIslandWindow']) {
      expect(isReturnTarget(info({ className, pid: 7000 }))).toBe(false)
    }
  })
  it('never a window that cannot be seen or is gone', () => {
    expect(isReturnTarget(null)).toBe(false)
    expect(isReturnTarget(info({ visible: false }))).toBe(false)
    expect(isReturnTarget(info({ minimized: true }))).toBe(false)
    expect(isReturnTarget(info({ cloaked: true }))).toBe(false)
    expect(isReturnTarget(info({ pid: 0 }))).toBe(false)
  })
})

describe('the app used last', () => {
  it('is an ordinary app window: not always-on-top, not a tool window, not the desktop', () => {
    expect(isOrdinaryAppWindow(info())).toBe(true)
    expect(isOrdinaryAppWindow(info({ exStyle: 0x8 }))).toBe(false)
    expect(isOrdinaryAppWindow(info({ exStyle: 0x80 }))).toBe(false)
    // A tool window that asks to be on the taskbar counts.
    expect(isOrdinaryAppWindow(info({ exStyle: 0x80 | 0x40000 }))).toBe(true)
    expect(isOrdinaryAppWindow(info({ className: 'Progman' }))).toBe(false)
    expect(isOrdinaryAppWindow(info({ className: 'Shell_TrayWnd' }))).toBe(false)
  })
  it('is the first one from the top of the z-order, past the notes, the taskbar and hidden windows', () => {
    const windows = new Map<number, WindowInfo>([
      [1, info({ pid: OWN, exStyle: 0x8 })], // the notes, always on top
      [2, info({ className: 'Shell_TrayWnd', pid: 7000, exStyle: 0x8 | 0x80 })],
      [3, info({ visible: false })],
      [4, info({ cloaked: true, pid: 7100 })],
      [5, info({ pid: 9000 })], // the chart
      [6, info({ pid: 9100 })]
    ])
    const api: ForegroundApi = {
      current: () => 1,
      describe: (hwnd) => windows.get(hwnd) ?? null,
      topDown: () => windows.keys(),
      activate: () => true
    }
    expect(appUsedLast(api, 1)).toBe(5)
    // With always-on-top switched off the notes are an ordinary window, and still skipped.
    windows.set(1, info({ pid: OWN }))
    expect(appUsedLast(api, 1)).toBe(5)
    windows.delete(5)
    windows.delete(6)
    expect(appUsedLast(api, 1)).toBe(0)
  })
})

describe('user32 access', () => {
  it('is only loaded on Windows', () => {
    if (process.platform === 'win32') {
      expect(foregroundStatus()).toEqual({ available: true, error: null })
      const api = foregroundApi()!
      const current = api.current()
      expect(typeof current).toBe('number')
      expect(api.describe(0)).toBeNull()
      if (current !== 0) expect(typeof api.describe(current)?.className).toBe('string')
      expect(typeof appUsedLast(api, 0)).toBe('number')
    } else {
      expect(foregroundApi()).toBeNull()
      expect(foregroundStatus()).toEqual({ available: false, error: null })
    }
  })
})
