/**
 * The one notes window: creation, half-screen docking, always-on-top, show/hide and
 * recovery when monitors change.
 *
 * Focus policy (a core requirement): the window stays visible while the user works in
 * another app, and it never takes keyboard focus on its own. Focus is requested only in
 * direct response to the user asking for the notes (tray click, global shortcut, launching
 * the app again). There is no blur handler that re-focuses, no fullscreen overlay and no
 * click-through surface: this is an ordinary top-level window with the topmost flag set.
 *
 * Opacity: the window can be made see-through (BrowserWindow.setOpacity) so whatever it covers
 * shows through. With "solid while I use it" it turns solid while the pointer is over it or it
 * has the keyboard. Changing opacity never touches focus, position or z-order.
 */
import { pathToFileURL } from 'node:url'
import { BrowserWindow, screen, systemPreferences, type Display, type Rectangle } from 'electron'
import { IPC } from '@shared/ipc'
import { clampOpacity, opacityFadeSteps, windowOpacityTarget } from '@shared/preferences'
import type { DockSide, MainEvents, Preferences, WindowStatus } from '@shared/types'
import {
  dockBounds,
  displayForBounds,
  isUsablyVisible,
  MIN_HEIGHT,
  MIN_WIDTH,
  rectsEqual,
  resolveWindow,
  type DisplayInfo,
  type Rect,
  type SavedWindowState
} from '@shared/windowBounds'
import { appUsedLast, foregroundApi, handleFromBuffer, isReturnTarget, SHELL_CLASSES, type WindowHandle } from './foreground'
import type { Library } from './store/library'

export type ShowMode = 'focus' | 'inactive' | 'hidden'

/**
 * How the notes gave the keyboard back: to the window noted when they took it ('returned'),
 * to the app used last when none was noted ('returned-below'), by letting go below the
 * always-on-top band ('blur-below', Windows without user32), or by letting go ('blur').
 * 'none': they did not have it.
 */
export type KeyboardRelease = 'returned' | 'returned-below' | 'blur-below' | 'blur' | 'none'
export type FlushOutcome = 'saved' | 'failed' | 'timeout' | 'unavailable'

export interface WindowManagerOptions {
  library: Library
  preloadPath: string
  /** Dev server URL, or null to load the built file. */
  rendererUrl: string | null
  rendererFile: string
  iconPath: string
  getPreferences: () => Preferences
  onStatusChange: () => void
  /** The notes gave the keyboard back (for the start-up diagnostics' event log). */
  onKeyboardReleased?: (how: KeyboardRelease) => void
  allowDevTools: boolean
}

/** How long after a monitor change window moves are attributed to Windows rather than to the user. */
const DISPLAY_SETTLE_MS = 1500

/** The pointer counts as gone only after this long, so brushing past the edge does not flicker. */
const POINTER_LEAVE_MS = 250
/** A change of opacity fades in this many steps, this far apart: about 150 ms in all. */
const FADE_STEPS = 6
const FADE_STEP_MS = 30
// Over the title bar's drag strip and the resize border, Windows sends "non-client" mouse
// messages instead of page mouse events, so the page sees the pointer as gone. These two say
// that the pointer is over that part of the window, and that it has left it.
const WM_NCMOUSEMOVE = 0x00a0
const WM_NCMOUSELEAVE = 0x02a2

/** Where a pointer report comes from: the page itself, or the window frame (Windows only). */
export type PointerSource = 'page' | 'frame'

/** Everything that decides the window's opacity, for the automated desktop tests. */
export interface OpacityState {
  chosen: number
  solidOnHover: boolean
  preview: number | null
  pointerInside: boolean
  focused: boolean
  /** The opacity the app last asked for: where the current fade ends. */
  requested: number
  /** The value last given to the window (during a fade, a step on the way). */
  applied: number
  /** What the window reports. Windows and macOS (and some Linux desktops) apply it; elsewhere it stays 1. */
  native: number
  /** The opacity the window was given when it was created, before it was first shown. */
  initial: number
  fading: boolean
  leavePending: boolean
  /** The values applied for the latest change: one for an instant change, several for a fade. */
  lastChange: number[]
  /** How many times the opacity has been applied to the window (setOpacity calls, fade steps included). */
  applyCount: number
}

/** Equal within a couple of pixels, to absorb rounding at fractional display scale factors. */
const rectsNear = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2

const toInfo = (display: Display): DisplayInfo => ({
  id: display.id,
  bounds: display.bounds,
  workArea: display.workArea,
  scaleFactor: display.scaleFactor
})

export class WindowManager {
  private win: BrowserWindow | null = null
  private dock: DockSide | 'custom' = 'right'
  private quitting = false
  /** The bounds the app itself last gave the window; while the window still has them it has not been moved by hand. */
  private lastApplied: Rect | null = null
  /** When monitors last changed. Moves that Windows makes in response are not the user's. */
  private displaysChangedAt = 0
  /** A monitor change arrived while the window was maximized; it is dealt with once the window is restored. */
  private displayCheckOwed = false
  private saveTimer: NodeJS.Timeout | null = null
  private displayTimer: NodeJS.Timeout | null = null
  private flushWaiters = new Map<string, (saved: boolean) => void>()
  private flushCounter = 0

  // Opacity. The pointer is over the notes when it is over the page or over the window frame.
  private pointerOnPage = false
  private pointerOnFrame = false
  /** The pointer state opacity follows: becomes false only POINTER_LEAVE_MS after the pointer left. */
  private pointerInside = false
  private hasKeyboard = false
  /**
   * Windows: the window that had the keyboard when the notes took it, to give it back to
   * (see foreground.ts). Forgotten as soon as the notes lose the keyboard.
   */
  private returnTo: WindowHandle | null = null
  /** What the last hand-back of the keyboard did, for the tests and the diagnostics. */
  readonly keyboardRecord = { last: null as KeyboardRelease | null, count: 0 }
  private opacityPreview: number | null = null
  private requestedOpacity = 1
  private appliedOpacity = 1
  private initialOpacity = 1
  /** Windows turns a window into a layered window the first time its opacity is set. */
  private layered = false
  private leaveTimer: NodeJS.Timeout | null = null
  private fadeTimer: NodeJS.Timeout | null = null
  private lastChange: number[] = []
  private applyCount = 0

  constructor(private readonly options: WindowManagerOptions) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  private displays(): DisplayInfo[] {
    return screen.getAllDisplays().map(toInfo)
  }

  create(mode: ShowMode): BrowserWindow {
    if (this.window) return this.window
    const prefs = this.options.getPreferences()
    const saved = this.options.library.getWindowState()
    const resolved = resolveWindow({
      saved,
      displays: this.displays(),
      cursorDisplayId: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id,
      primaryDisplayId: screen.getPrimaryDisplay().id,
      preferredSide: prefs.dockSide
    })
    this.dock = resolved.dock

    const win = new BrowserWindow({
      ...resolved.bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: false,
      title: 'Trading Notes',
      icon: this.options.iconPath,
      backgroundColor: '#1c1d1f',
      alwaysOnTop: prefs.alwaysOnTop,
      fullscreenable: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: true,
        devTools: this.options.allowDevTools
      }
    })
    this.win = win
    win.setMenu(null)
    this.applyBounds(resolved.bounds)
    this.initOpacity(win, mode)

    // The window only ever shows the app itself. Links are opened through a validated IPC call.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('will-attach-webview', (event) => event.preventDefault())

    // Once the keyboard has gone elsewhere, the window that had it before is no longer the one to go back to.
    win.on('blur', () => {
      this.returnTo = null
    })

    // Closing the window hides it to the tray; only an explicit Quit ends the app.
    win.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      this.hide()
    })
    win.on('closed', () => {
      this.win = null
    })

    const boundsChanged = (): void => this.scheduleSave()
    win.on('move', boundsChanged)
    win.on('resize', boundsChanged)
    const statusChanged = (): void => this.options.onStatusChange()
    for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize'] as const) {
      win.on(event as 'focus', statusChanged)
    }
    // Some window-state changes on Windows drop the topmost flag; put it back without touching focus.
    const reassertTopmost = (): void => {
      const wanted = this.options.getPreferences().alwaysOnTop
      if (this.window && this.window.isAlwaysOnTop() !== wanted) this.window.setAlwaysOnTop(wanted)
    }
    win.on('show', reassertTopmost)
    win.on('restore', reassertTopmost)
    // The same for opacity: whatever Windows did to the window while it was away, it comes back
    // with the opacity the app last gave it.
    win.on('show', () => this.reassertOpacity())
    win.on('restore', () => this.reassertOpacity())
    // Monitor changes are skipped while maximized; catch up once the window is restored.
    win.on('unmaximize', () => {
      if (!this.displayCheckOwed) return
      this.displayCheckOwed = false
      setTimeout(() => this.afterRestore(), 150)
    })

    const displaysChanged = (): void => this.scheduleDisplayCheck()
    screen.on('display-added', displaysChanged)
    screen.on('display-removed', displaysChanged)
    screen.on('display-metrics-changed', displaysChanged)
    win.once('closed', () => {
      screen.off('display-added', displaysChanged)
      screen.off('display-removed', displaysChanged)
      screen.off('display-metrics-changed', displaysChanged)
    })

    win.once('ready-to-show', () => {
      if (mode === 'focus') this.show(true)
      else if (mode === 'inactive') this.show(false)
    })

    if (this.options.rendererUrl) void win.loadURL(this.options.rendererUrl)
    else void win.loadFile(this.options.rendererFile)

    if (resolved.recovered || !saved) this.persistState()
    return win
  }

  /** URL prefix of the app's own page; IPC from anywhere else is refused. */
  isTrustedFrameUrl(url: string): boolean {
    if (this.options.rendererUrl) return url.startsWith(this.options.rendererUrl)
    try {
      const parsed = new URL(url)
      const expected = pathToFileURL(this.options.rendererFile)
      return parsed.protocol === 'file:' && decodeURIComponent(parsed.pathname).toLowerCase() === decodeURIComponent(expected.pathname).toLowerCase()
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------ bounds

  /**
   * Set bounds and verify. When the target monitor has a different scale factor than the
   * one the window is on, Windows can apply the size with the old factor on the first call;
   * a second call lands correctly.
   */
  private applyBounds(bounds: Rect): void {
    const win = this.window
    if (!win) return
    win.setBounds(bounds as Rectangle)
    if (!rectsEqual(win.getBounds(), bounds)) win.setBounds(bounds as Rectangle)
    this.lastApplied = win.getNormalBounds()
  }

  private currentDisplay(): DisplayInfo {
    const win = this.window
    const displays = this.displays()
    const primary = toInfo(screen.getPrimaryDisplay())
    if (!win) return primary
    return displayForBounds(win.getNormalBounds(), displays) ?? toInfo(screen.getDisplayMatching(win.getBounds())) ?? primary
  }

  /** True while Windows may still be rearranging windows after a monitor change. */
  private displaysSettling(): boolean {
    return this.displayTimer !== null || Date.now() - this.displaysChangedAt < DISPLAY_SETTLE_MS
  }

  private scheduleSave(delay = 350): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.displaysSettling()) {
        // Too early to tell whose move this was. Look again once things have settled, so the
        // remembered dock side always ends up matching where the window really is.
        this.scheduleSave(Math.max(350, DISPLAY_SETTLE_MS - (Date.now() - this.displaysChangedAt) + 50))
        return
      }
      this.detectDock()
      this.persistState()
      this.options.onStatusChange()
    }, delay)
  }

  /**
   * The window left the maximized state after a monitor change it sat out. Restored with its
   * button it is back exactly where the app last put it, so it can follow the changed work
   * area. Dragged out of the maximized state it is being moved by hand and is left alone.
   */
  private afterRestore(): void {
    const win = this.window
    if (!win || win.isMinimized()) return
    if (win.isMaximized()) {
      this.displayCheckOwed = true
      return
    }
    const bounds = win.getNormalBounds()
    const movedByHand = !rectsEqual(bounds, this.lastApplied)
    if (movedByHand && isUsablyVisible(bounds, this.displays())) return
    this.reconcileDisplays()
  }

  /** After the user moves or resizes the window, work out whether it still sits exactly on a half. */
  private detectDock(): void {
    const win = this.window
    if (!win || win.isMinimized()) return
    // While monitors are changing, Windows moves and resizes windows itself. That is not the
    // user un-docking the notes; reconcileDisplays() decides where the window belongs.
    if (this.displaysSettling()) return
    const bounds = win.getNormalBounds()
    // Still exactly where the app put it: nothing was moved by hand, whatever Windows rounded.
    if (rectsEqual(bounds, this.lastApplied)) return
    const display = this.currentDisplay()
    if (rectsNear(bounds, dockBounds(display.workArea, 'right'))) this.dock = 'right'
    else if (rectsNear(bounds, dockBounds(display.workArea, 'left'))) this.dock = 'left'
    else this.dock = 'custom'
  }

  private persistState(): void {
    const win = this.window
    if (!win) return
    const display = this.currentDisplay()
    const state: SavedWindowState = {
      dock: this.dock,
      bounds: win.getNormalBounds(),
      displayId: display.id,
      displayBounds: display.bounds
    }
    try {
      this.options.library.setWindowState(state)
    } catch {
      // Window position is a convenience; never let a failed write disturb the app.
    }
  }

  /** Dock to the left or right half of the monitor the window is currently on. */
  dockTo(side: DockSide): void {
    const win = this.window
    if (!win) return
    this.dock = side
    // Only an explicit request to dock takes the window out of the maximized state.
    if (win.isMaximized()) win.unmaximize()
    this.applyBounds(dockBounds(this.currentDisplay().workArea, side))
    this.persistState()
    this.options.onStatusChange()
  }

  private scheduleDisplayCheck(): void {
    // From here until things settle, moves are not classified (see scheduleSave): a move that
    // Windows makes because of this change must not be mistaken for the user un-docking.
    this.displaysChangedAt = Date.now()
    if (this.displayTimer) clearTimeout(this.displayTimer)
    this.displayTimer = setTimeout(() => {
      this.displayTimer = null
      this.reconcileDisplays()
    }, 400)
  }

  /**
   * Called when monitors are added, removed, rescaled or their work area changes.
   * A docked window is re-docked to the (possibly changed) work area; a free-floating one is
   * left alone unless it can no longer be seen, in which case it is brought back.
   */
  reconcileDisplays(): void {
    const win = this.window
    // A maximized window already fills its work area, and Windows keeps it that way. It is
    // left alone: un-maximizing it here would change (and on Windows could show or activate)
    // the window without anyone asking.
    if (!win || win.isMinimized()) return
    if (win.isMaximized()) {
      this.displayCheckOwed = true
      return
    }
    this.displayCheckOwed = false
    const displays = this.displays()
    if (displays.length === 0) return
    const bounds = win.getNormalBounds()
    const saved = this.options.library.getWindowState()

    if (this.dock !== 'custom') {
      const host = displays.find((d) => d.id === saved?.displayId) ?? displayForBounds(bounds, displays) ?? toInfo(screen.getPrimaryDisplay())
      const wanted = dockBounds(host.workArea, this.dock)
      if (!rectsEqual(bounds, wanted)) this.applyBounds(wanted)
    } else if (!isUsablyVisible(bounds, displays)) {
      const resolved = resolveWindow({
        saved: { dock: 'custom', bounds, displayId: saved?.displayId ?? null, displayBounds: saved?.displayBounds ?? null },
        displays,
        cursorDisplayId: null,
        primaryDisplayId: screen.getPrimaryDisplay().id,
        preferredSide: this.options.getPreferences().dockSide
      })
      this.dock = resolved.dock
      this.applyBounds(resolved.bounds)
    }
    this.persistState()
    this.options.onStatusChange()
  }

  // ------------------------------------------------------------ visibility

  isShown(): boolean {
    const win = this.window
    return !!win && win.isVisible() && !win.isMinimized()
  }

  /** Show the window. `focus` is true only when the user explicitly asked for the notes. */
  show(focus: boolean): void {
    const win = this.window
    if (!win) return
    // The window that has the keyboard now gets it back when the notes are done with it.
    // Noted before restore(), which activates a minimized window.
    if (focus) this.noteForegroundWindow(win)
    if (win.isMinimized()) win.restore()
    if (!isUsablyVisible(win.getNormalBounds(), this.displays())) this.reconcileDisplays()
    if (focus) {
      // Asked for in order to type in them: the notes appear as they will be once they have
      // the keyboard, rather than see-through for a moment first.
      this.hasKeyboard = true
      this.updateOpacity()
      win.show()
      win.focus()
      // Windows can refuse to hand over the keyboard. Then there will be no focus or blur
      // event to correct the guess, so correct it here.
      if (process.platform === 'win32' && !win.isFocused()) {
        this.returnTo = null
        this.hasKeyboard = false
        this.updateOpacity()
      }
    } else {
      this.updateOpacity()
      win.showInactive()
    }
    this.options.onStatusChange()
  }

  hide(): void {
    const win = this.window
    if (!win) return
    // Ask the window to write any pending edit. The renderer keeps running while hidden, so
    // this is belt and braces rather than the only thing standing between typing and disk.
    void this.requestFlush(1500)
    // On Windows a hidden window keeps the keyboard (Chromium hides without activating another
    // window), so typing would go into notes that cannot be seen. Hand it back first.
    if (process.platform === 'win32') {
      if (win.isFocused()) this.releaseKeyboard()
      else this.passKeyboardOnFromShell()
    }
    win.hide()
    this.options.onStatusChange()
  }

  /** Tray click and global shortcut: one existing window, shown or hidden. */
  toggle(): void {
    if (!this.window) {
      this.create('focus')
      return
    }
    if (this.isShown()) this.hide()
    else this.show(true)
  }

  minimize(): void {
    // The keyboard goes to the window that had it before, rather than wherever Windows picks.
    if (process.platform === 'win32') this.releaseKeyboard()
    this.window?.minimize()
  }

  isFocused(): boolean {
    return this.window?.isFocused() ?? false
  }

  /**
   * Give the keyboard back to the app that had it before the notes took it (the chart,
   * usually), leaving the notes where they are. Does nothing unless the notes have it.
   *
   * - On Windows, the window noted when the notes took the keyboard is activated directly;
   *   when none was noted (or it has gone), the app used last is (see foreground.ts).
   * - Without user32 the notes let go with blur(), which on Windows activates the next visible
   *   window below them. An always-on-top window steps out of the always-on-top band for that
   *   moment, so that the next window is the app used last rather than the taskbar.
   */
  releaseKeyboard(): KeyboardRelease {
    const win = this.window
    if (!win || !win.isVisible() || !win.isFocused()) return 'none'
    const target = this.returnTo
    this.returnTo = null
    let how: KeyboardRelease | null = null
    const api = foregroundApi()
    if (api) {
      const own = handleFromBuffer(win.getNativeWindowHandle())
      // Counted only once Windows has really moved the keyboard away from the notes.
      const handTo = (hwnd: WindowHandle): boolean => api.activate(hwnd) && api.current() !== own
      if (target !== null && target !== own && isReturnTarget(api.describe(target)) && handTo(target)) how = 'returned'
      else {
        const below = appUsedLast(api, own)
        if (below !== 0 && handTo(below)) how = 'returned-below'
      }
    }
    if (how === null) {
      if (process.platform === 'win32' && win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(false)
        win.blur()
        win.setAlwaysOnTop(true)
        how = 'blur-below'
      } else {
        win.blur()
        how = 'blur'
      }
    }
    this.record(how)
    return how
  }

  /**
   * Hiding while the taskbar, the tray or one of this app's own hidden windows (the tray menu)
   * has the keyboard: pass it on to the app used last, where Windows allows it, rather than
   * leave it with the taskbar or with a window that is about to disappear.
   */
  private passKeyboardOnFromShell(): void {
    const api = foregroundApi()
    const win = this.window
    if (!api || !win) return
    const current = api.current()
    const info = api.describe(current)
    if (!info) return
    const own = handleFromBuffer(win.getNativeWindowHandle())
    const ownHidden = info.pid === process.pid && !info.visible
    if (current === own || !(ownHidden || SHELL_CLASSES.has(info.className))) return
    const below = appUsedLast(api, own)
    if (below !== 0 && api.activate(below)) this.record('returned-below')
  }

  private record(how: KeyboardRelease): void {
    this.keyboardRecord.last = how
    this.keyboardRecord.count++
    this.options.onKeyboardReleased?.(how)
  }

  /** Windows: note the window in front now, as the one to give the keyboard back to. */
  private noteForegroundWindow(win: BrowserWindow): void {
    if (win.isVisible() && !win.isMinimized() && win.isFocused()) return
    const api = foregroundApi()
    if (!api) return
    const current = api.current()
    const own = handleFromBuffer(win.getNativeWindowHandle())
    // The taskbar (a tray click, a pinned-icon launch) is not where typing goes back to; the
    // app used last is found when the time comes.
    this.returnTo = current !== 0 && current !== own && isReturnTarget(api.describe(current)) ? current : null
  }

  /** The notes window when it is visible and docked to a half of a display (snapshots cut it away). */
  dockedRect(): { bounds: Rect; displayId: number } | null {
    const win = this.window
    if (!win || !this.isShown() || win.isMaximized() || this.dock === 'custom') return null
    return { bounds: win.getBounds(), displayId: this.currentDisplay().id }
  }

  toggleMaximize(): void {
    const win = this.window
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  }

  setAlwaysOnTop(flag: boolean): void {
    this.window?.setAlwaysOnTop(flag)
    this.options.onStatusChange()
  }

  status(): WindowStatus {
    const win = this.window
    return {
      dock: this.dock,
      alwaysOnTop: win ? win.isAlwaysOnTop() : this.options.getPreferences().alwaysOnTop,
      focused: win ? win.isFocused() : false,
      maximized: win ? win.isMaximized() : false
    }
  }

  // ------------------------------------------------------------ opacity

  /**
   * Set the opacity before the window is first shown, so a see-through window never flashes
   * solid at start-up, and listen for everything that decides it from then on.
   */
  private initOpacity(win: BrowserWindow, mode: ShowMode): void {
    const prefs = this.options.getPreferences()
    this.pointerOnPage = false
    this.pointerOnFrame = false
    this.pointerInside = false
    this.hasKeyboard = false
    this.opacityPreview = null
    this.layered = false
    this.appliedOpacity = 1
    // Shown with the keyboard (an ordinary start), the window will be in use straight away.
    const initial = windowOpacityTarget({
      chosen: prefs.windowOpacity,
      solidOnHover: prefs.opacitySolidOnHover,
      pointerInside: false,
      focused: mode === 'focus',
      preview: null
    })
    this.initialOpacity = initial
    this.requestedOpacity = initial
    this.lastChange = [initial]
    this.setNativeOpacity(initial)

    // Having the keyboard is one half of "in use"; the pointer being over the window is the other.
    win.on('focus', () => {
      this.hasKeyboard = true
      this.updateOpacity()
    })
    win.on('blur', () => {
      this.hasKeyboard = false
      this.updateOpacity()
    })
    // A hidden or minimized window has no pointer over it, and nothing is animated while away.
    const gone = (): void => {
      this.clearLeaveTimer()
      this.pointerOnPage = false
      this.pointerOnFrame = false
      this.pointerInside = false
      this.updateOpacity({ instant: true })
    }
    win.on('hide', gone)
    win.on('minimize', gone)
    // A page that is reloaded or replaced can no longer end its preview or report the pointer.
    const pageReset = (): void => {
      this.opacityPreview = null
      this.reportPointer('page', false)
      this.updateOpacity()
    }
    win.webContents.on('render-process-gone', pageReset)
    win.webContents.on('did-start-loading', pageReset)

    if (process.platform === 'win32') {
      // Called for every mouse move over the frame, so it does nothing unless the state changes.
      win.hookWindowMessage(WM_NCMOUSEMOVE, () => {
        if (!this.pointerOnFrame) this.reportPointer('frame', true)
      })
      win.hookWindowMessage(WM_NCMOUSELEAVE, () => {
        // Leaving the window through its frame (over the top edge from the drag strip, say)
        // may not reach the page as a leave of its own, so where the pointer really is decides.
        if (!this.cursorOverWindow()) this.pointerOnPage = false
        this.reportPointer('frame', false)
      })
    }
  }

  /** What decides the window's opacity right now, for the automated desktop tests. */
  opacityState(): OpacityState {
    const prefs = this.options.getPreferences()
    const win = this.window
    return {
      chosen: prefs.windowOpacity,
      solidOnHover: prefs.opacitySolidOnHover,
      preview: this.opacityPreview,
      pointerInside: this.pointerInside,
      focused: this.hasKeyboard,
      requested: this.requestedOpacity,
      applied: this.appliedOpacity,
      native: win ? win.getOpacity() : 1,
      initial: this.initialOpacity,
      fading: this.fadeTimer !== null,
      leavePending: this.leaveTimer !== null,
      lastChange: [...this.lastChange],
      applyCount: this.applyCount
    }
  }

  /** The opacity the window should have, given everything known right now. */
  private opacityTarget(pointerInside = this.pointerInside): number {
    // A preview is shown as it is; no need to look anything else up for it (it arrives once a frame).
    if (this.opacityPreview !== null) return clampOpacity(this.opacityPreview)
    const prefs = this.options.getPreferences()
    return windowOpacityTarget({
      chosen: prefs.windowOpacity,
      solidOnHover: prefs.opacitySolidOnHover,
      pointerInside,
      focused: this.hasKeyboard,
      preview: null
    })
  }

  /**
   * Bring the opacity in line with the preference, the pointer, the keyboard and any preview.
   * Called after any of them changes; does nothing when the window already has (or is fading
   * to) the right value. Never touches focus, position or z-order.
   */
  updateOpacity(options: { instant?: boolean } = {}): void {
    const win = this.window
    if (!win) return
    const target = this.opacityTarget()
    if (target === this.requestedOpacity && (this.fadeTimer !== null || this.appliedOpacity === target)) return
    const instant = options.instant === true || !win.isVisible() || win.isMinimized() || this.prefersReducedMotion()
    this.fadeTo(target, instant)
  }

  /**
   * The pointer came onto the notes or left them, as the page reports it or (on Windows) the
   * window frame: the title bar's drag strip and the resize border are not part of the page.
   */
  reportPointer(source: PointerSource, inside: boolean): void {
    if (source === 'page') {
      this.pointerOnPage = inside
      // On the page means off the frame, whatever the frame said last.
      if (inside) this.pointerOnFrame = false
    } else {
      this.pointerOnFrame = inside
    }
    if (this.pointerOnPage || this.pointerOnFrame) {
      this.clearLeaveTimer()
      if (this.pointerInside) return
      this.pointerInside = true
      this.updateOpacity()
      return
    }
    if (!this.pointerInside || this.leaveTimer) return
    // When leaving makes no visible difference (solid anyway, or kept solid by the keyboard),
    // there is nothing to wait for.
    if (this.opacityTarget(false) === this.opacityTarget(true)) {
      this.pointerInside = false
      return
    }
    // Otherwise the pointer counts as gone only once it has stayed away for a moment, so
    // brushing past the edge of the window does not make it flicker.
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null
      this.pointerInside = false
      this.updateOpacity()
    }, POINTER_LEAVE_MS)
  }

  /**
   * Show this opacity now, without storing it, because the user is adjusting it: it wins over
   * "solid while I use it" so they can see what they are choosing. Null ends the preview.
   */
  previewOpacity(value: number | null): void {
    const next = value === null ? null : clampOpacity(value)
    if (next === this.opacityPreview) return
    // Following a slider follows it exactly; only the start and the end of a preview fade.
    const continuing = this.opacityPreview !== null && next !== null
    this.opacityPreview = next
    this.updateOpacity({ instant: continuing })
  }

  private cursorOverWindow(): boolean {
    const win = this.window
    if (!win) return false
    const point = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
  }

  private clearLeaveTimer(): void {
    if (!this.leaveTimer) return
    clearTimeout(this.leaveTimer)
    this.leaveTimer = null
  }

  private prefersReducedMotion(): boolean {
    const setting = this.options.getPreferences().reducedMotion
    if (setting !== 'system') return setting === 'on'
    try {
      return systemPreferences.getAnimationSettings().prefersReducedMotion
    } catch {
      return false
    }
  }

  /** Go to `target` at once, or in a few short steps (about 150 ms) that run only while it changes. */
  private fadeTo(target: number, instant: boolean): void {
    this.requestedOpacity = target
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer)
      this.fadeTimer = null
    }
    const steps = instant ? [target] : opacityFadeSteps(this.appliedOpacity, target, FADE_STEPS)
    if (steps.length === 0) return
    this.lastChange = steps
    let index = 0
    const step = (): void => {
      this.fadeTimer = null
      const value = steps[index++]
      if (value === undefined) return
      this.setNativeOpacity(value)
      if (index < steps.length) this.fadeTimer = setTimeout(step, FADE_STEP_MS)
    }
    step()
  }

  private setNativeOpacity(value: number): void {
    const win = this.window
    if (!win) return
    this.appliedOpacity = value
    // Windows makes a window "layered" the first time its opacity is set. One that has never
    // been see-through is left an ordinary window.
    if (!this.layered && value >= 1) return
    win.setOpacity(value)
    this.layered = true
    this.applyCount++
  }

  private reassertOpacity(): void {
    const win = this.window
    if (!win || !this.layered) return
    win.setOpacity(this.appliedOpacity)
    this.applyCount++
  }

  // ------------------------------------------------------------ messaging

  send<K extends keyof MainEvents>(name: K, payload: MainEvents[K]): void {
    const win = this.window
    if (!win || win.webContents.isDestroyed()) return
    win.webContents.send(IPC.event, { name, payload })
  }

  /**
   * Ask the window to write pending edits and wait for its answer.
   *   saved        everything typed so far is on disk
   *   failed       the window tried and the write failed (the note still shows "Not saved")
   *   timeout      the window did not answer in time
   *   unavailable  there is no loaded window, so there is nothing to write
   */
  requestFlush(timeoutMs: number): Promise<FlushOutcome> {
    const win = this.window
    if (!win || win.webContents.isDestroyed() || win.webContents.isLoading()) return Promise.resolve('unavailable')
    const token = `flush-${++this.flushCounter}`
    return new Promise<FlushOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.flushWaiters.delete(token)
        resolve('timeout')
      }, timeoutMs)
      this.flushWaiters.set(token, (saved) => {
        clearTimeout(timer)
        this.flushWaiters.delete(token)
        resolve(saved ? 'saved' : 'failed')
      })
      this.send('flush-request', { token })
    })
  }

  confirmFlush(token: string, saved: boolean): void {
    this.flushWaiters.get(token)?.(saved)
  }

  /** Let the window actually close; used only on Quit. */
  prepareToQuit(): void {
    this.quitting = true
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // Always classify at quit, so a move made in the last moment is remembered.
    this.detectDock()
    this.persistState()
  }
}
