/**
 * The one notes window: creation, half-screen docking, always-on-top, show/hide and
 * recovery when monitors change.
 *
 * Focus policy (a core requirement): the window stays visible while the user works in
 * another app, and it never takes keyboard focus on its own. Focus is requested only in
 * direct response to the user asking for the notes (tray click, global shortcut, launching
 * the app again). There is no blur handler that re-focuses, no fullscreen overlay and no
 * click-through surface: this is an ordinary top-level window with the topmost flag set.
 */
import { pathToFileURL } from 'node:url'
import { BrowserWindow, screen, type Display, type Rectangle } from 'electron'
import { IPC } from '@shared/ipc'
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
import type { Library } from './store/library'

export type ShowMode = 'focus' | 'inactive' | 'hidden'
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
  allowDevTools: boolean
}

/** How long after a monitor change window moves are attributed to Windows rather than to the user. */
const DISPLAY_SETTLE_MS = 1500

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
  private saveTimer: NodeJS.Timeout | null = null
  private displayTimer: NodeJS.Timeout | null = null
  private flushWaiters = new Map<string, (saved: boolean) => void>()
  private flushCounter = 0

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

    // The window only ever shows the app itself. Links are opened through a validated IPC call.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('will-attach-webview', (event) => event.preventDefault())

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
    // Work-area changes are skipped while maximized; catch up once the user restores the window.
    win.on('unmaximize', () => {
      if (this.dock !== 'custom') this.scheduleDisplayCheck()
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

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.detectDock()
      this.persistState()
      this.options.onStatusChange()
    }, 350)
  }

  /** After the user moves or resizes the window, work out whether it still sits exactly on a half. */
  private detectDock(): void {
    const win = this.window
    if (!win || win.isMinimized()) return
    // While monitors are changing, Windows moves and resizes windows itself. That is not the
    // user un-docking the notes; reconcileDisplays() decides where the window belongs.
    if (this.displayTimer || Date.now() - this.displaysChangedAt < DISPLAY_SETTLE_MS) return
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
    this.displaysChangedAt = Date.now()
    // A move caused by this display change must not be classified before the check below runs.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
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
    if (!win || win.isMinimized() || win.isMaximized()) return
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
    if (win.isMinimized()) win.restore()
    if (!isUsablyVisible(win.getNormalBounds(), this.displays())) this.reconcileDisplays()
    if (focus) {
      win.show()
      win.focus()
    } else {
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
    this.window?.minimize()
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
