/**
 * What the trading hotkeys do. Each press runs one of these, and so does the test trigger.
 *
 * Keyboard rule: the notes never take the keyboard on their own. Quick note and the risk
 * calculator need typing, so they take it for that moment, and give it back afterwards to
 * where it was: hidden notes are hidden again, a chart that had the keyboard gets it back,
 * and notes that had it keep it (the window puts the caret back where it was itself).
 * The snapshot, see-through and candle timer hotkeys never touch the keyboard.
 */
import type { HotkeyId } from '@shared/hotkeys'
import { seeThroughToggleTarget } from '@shared/preferences'
import { clockTime, localDateKey, snapshotCaption } from '@shared/sessionLog'
import type { Preferences } from '@shared/types'
import { encodeSnapshot, type CaptureResult } from './snapshot'
import type { Library } from './store/library'
import type { WindowManager } from './windowManager'

/** How the keyboard goes back when typing ends. */
export type HandBack = 'hide' | 'minimize' | 'blur' | 'none'
export type TypingAction = 'quickNote' | 'risk'

interface TypingSession {
  token: number
  action: TypingAction
  handBack: HandBack
}

export interface HotkeyControllerOptions {
  windows: WindowManager
  library: Library
  /** The app's clock (moved only by the automated tests). */
  now: () => number
  applyPreferences: (previous: Preferences, next: Preferences) => void
  capture: () => Promise<CaptureResult>
  /** A short state line for the tray icon's tooltip, after a snapshot. */
  onSnapshotState: (text: string) => void
}

export class HotkeyController {
  private typing: TypingSession | null = null
  private tokens = 0
  private capturing: Promise<void> | null = null
  /** For the automated desktop tests: what the last typing session did with the keyboard. */
  readonly record = { lastHandBack: null as HandBack | null, lastCapture: null as { from: 'window' | 'display'; title: string | null } | null, snapshots: 0 }

  constructor(private readonly options: HotkeyControllerOptions) {}

  /** The function behind each hotkey. */
  handlers(toggle: () => void): Record<HotkeyId, () => void> {
    return {
      toggle,
      quickNote: () => this.beginTyping('quickNote'),
      risk: () => this.beginTyping('risk'),
      snapshot: () => void this.snapshot(),
      candleTimer: () => this.toggleCandleTimer(),
      seeThrough: () => this.toggleSeeThrough(),
      openLog: () => this.openLog()
    }
  }

  /** Quick note or the risk calculator: the window takes the keyboard until it calls endTyping. */
  beginTyping(action: TypingAction): void {
    const { windows } = this.options
    const win = windows.window
    if (!win) return
    const visible = win.isVisible()
    const minimized = win.isMinimized()
    const focused = visible && !minimized && win.isFocused()
    if (this.typing && focused) {
      // Pressed again (or the other typing hotkey) while typing: same session, same way back.
      this.typing.action = action
    } else {
      // A first press; or a press after the keyboard went elsewhere while the panel stayed
      // open (the chart was clicked): then where the keyboard is now is where it goes back to.
      const handBack: HandBack = !visible ? 'hide' : minimized ? 'minimize' : focused ? 'none' : 'blur'
      this.typing = { token: this.typing?.token ?? ++this.tokens, action, handBack }
    }
    const { token } = this.typing
    // Told before it gets the keyboard, so the strip is ready for the very first key typed.
    windows.send('hotkey', { action, token, at: this.options.now() })
    if (!focused) windows.show(true)
  }

  /** The window finished typing (Enter or Esc): give the keyboard back to where it was. */
  endTyping(token: number): void {
    const session = this.typing
    if (!session || session.token !== token) return
    this.typing = null
    const { windows } = this.options
    let done: HandBack = session.handBack
    // hide() and minimize() hand the keyboard back first themselves (see WindowManager).
    if (session.handBack === 'hide') windows.hide()
    else if (session.handBack === 'minimize') windows.minimize()
    // Only while the notes still have the keyboard: if the user already took it elsewhere
    // themselves (clicked the chart while the strip was open), it stays where they put it.
    else if (session.handBack === 'blur') done = windows.releaseKeyboard() === 'none' ? 'none' : 'blur'
    this.record.lastHandBack = done
  }

  /**
   * The notes were hidden while typing (the show/hide shortcut, the close button): there is
   * nowhere to give the keyboard back to any more, so finishing the line later leaves it be.
   */
  windowHidden(): void {
    this.typing = null
  }

  /** The page was reloaded or replaced: it can no longer end the session. */
  pageReset(): void {
    this.typing = null
  }

  /** An explicit request to write in today's log: the notes show with the keyboard and keep it. */
  openLog(): void {
    const { windows } = this.options
    if (!windows.window) return
    this.typing = null
    windows.show(true)
    windows.send('hotkey', { action: 'openLog', at: this.options.now() })
  }

  /** Solid <-> the see-through value last chosen. Through the stored preference, like the tray menu. */
  toggleSeeThrough(): void {
    const { library, applyPreferences, windows } = this.options
    const previous = library.getPreferences()
    const target = seeThroughToggleTarget(previous.windowOpacity, previous.seeThroughOpacity)
    // Going solid remembers the see-through value it leaves, so the next press returns to it.
    const patch = target < 1 ? { windowOpacity: target } : { windowOpacity: target, seeThroughOpacity: previous.windowOpacity }
    applyPreferences(previous, library.setPreferences(patch))
    windows.send('hotkey', { action: 'seeThrough', opacity: target })
  }

  toggleCandleTimer(): void {
    const { library, applyPreferences } = this.options
    const previous = library.getPreferences()
    applyPreferences(previous, library.setPreferences({ candleTimer: !previous.candleTimer }))
  }

  /** Capture the chart into today's log without taking the keyboard. One capture at a time. */
  snapshot(): Promise<void> {
    this.capturing ??= this.captureOnce().finally(() => {
      this.capturing = null
    })
    return this.capturing
  }

  private async captureOnce(): Promise<void> {
    const { windows, library, now, capture, onSnapshotState } = this.options
    const at = now()
    const windowShown = windows.isShown()
    const failed = (message: string): void => {
      onSnapshotState(`Chart snapshot failed at ${clockTime(at)}`)
      windows.send('snapshot', { ok: false, at, message, windowShown })
    }
    const result = await capture()
    if (!result.ok) {
      failed(result.message)
      return
    }
    try {
      const encoded = encodeSnapshot(result.image)
      const attachment = library.importImage({
        bytes: encoded.bytes,
        name: `Chart ${localDateKey(at)} ${clockTime(at).replaceAll(':', '-')}.png`,
        width: encoded.width,
        height: encoded.height,
        preview: encoded.preview
      })
      this.record.snapshots++
      this.record.lastCapture = { from: result.from, title: result.title }
      onSnapshotState(`Last chart snapshot ${clockTime(at)}`)
      windows.send('snapshot', { ok: true, at, attachment, width: encoded.width, height: encoded.height, caption: snapshotCaption(at, result.title), windowShown })
    } catch (error) {
      failed(`The snapshot could not be stored: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
