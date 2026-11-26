/**
 * Main process entry point: wires the note library, the window, the tray icon, the global
 * shortcut and the IPC bridge together, and owns startup and shutdown.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, desktopCapturer, dialog, nativeImage, powerMonitor, screen, session } from 'electron'
import { bindingsFromPreferences, HOTKEY_IDS, type HotkeyId } from '@shared/hotkeys'
import type { WindowGeometry } from '@shared/pageCrop'
import type { Preferences, SessionInfo } from '@shared/types'
import appIcon from '../../resources/icon.png?asset'
import trayIco from '../../resources/tray.ico?asset'
import trayPng from '../../resources/tray.png?asset'
import { applyAutostart, AUTOSTART_ARG, readAutostart } from './autostart'
import { CandleClock } from './candleClock'
import { HotkeyController } from './hotkeys'
import { foregroundStatus } from './foreground'
import { registerIpc } from './ipc'
import { handleAttachmentRequests, registerAttachmentScheme } from './protocol'
import { ShortcutManager } from './shortcut'
import { captureChart, type CaptureResult, type GetSources, type ReadGeometry } from './snapshot'
import { Library } from './store/library'
import { TrayController } from './tray'
import { lookUpWindowGeometry, windowGeometryStatus } from './windowGeometry'
import { WindowManager, type ShowMode } from './windowManager'

const isTest = process.env.TRADING_NOTES_TEST === '1'

// Notes live under the per-user app data folder. A development run uses its own folder so it
// can never touch real notes; tests point at a throwaway directory.
const dataOverride = process.env.TRADING_NOTES_DATA_DIR
if (dataOverride) app.setPath('userData', dataOverride)
else if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')} (dev)`)

if (process.platform === 'win32') app.setAppUserModelId('com.tradingnotes.app')

registerAttachmentScheme()

// One app, one window: launching the shortcut again brings the existing notes forward.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  let windows: WindowManager | null = null
  let tray: TrayController | null = null
  let library: Library | null = null
  let quitConfirmed = false
  let quitInProgress = false

  app.on('second-instance', () => windows?.show(true))
  // Staying in the tray with no visible window is the normal resting state.
  app.on('window-all-closed', () => undefined)

  await app.whenReady()

  try {
    library = new Library(join(app.getPath('userData'), 'library'))
  } catch (error) {
    dialog.showErrorBox(
      'Trading Notes could not open your notes',
      `${error instanceof Error ? error.message : String(error)}\n\nNotes folder: ${join(app.getPath('userData'), 'library')}`
    )
    app.exit(1)
    return
  }
  const lib = library

  // Work out whether the last run ended cleanly, then mark this run as in progress.
  const stored = lib.getSession()
  const openNote = stored.openNoteId ? lib.db.getNote(stored.openNoteId) : null
  const sessionInfo: SessionInfo = {
    openNoteId: openNote && openNote.deletedAt === null ? openNote.id : null,
    recoveredFromUncleanExit: !stored.cleanExit
  }
  lib.setSession({ cleanExit: false, openNoteId: sessionInfo.openNoteId })
  try {
    lib.collectGarbage()
  } catch {
    // Housekeeping only; never block startup on it.
  }

  // Nothing in this app needs camera, microphone, location, notifications and so on.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  // The app has its own spelling checker (src/shared/spelling.ts). Chromium's is switched off
  // for the whole session, not only in the page (webPreferences.spellcheck), and given no
  // languages, so it never downloads a dictionary: the app makes no network requests.
  session.defaultSession.setSpellCheckerEnabled(false)
  if (process.platform !== 'darwin') session.defaultSession.setSpellCheckerLanguages([])
  handleAttachmentRequests(lib)

  /** A desktopCapturer source as a test describes it: a known picture under a known title. */
  interface TestSource {
    id: string
    name: string
    display_id?: string
    png: string
  }
  const testHooks: {
    failSaves: boolean
    quitChoice: 'ask' | 'keep' | 'quit'
    /** Added to the clock the hotkeys, the session log and the candle timer go by. */
    clockOffsetMs: number
    /** Stand-ins for desktopCapturer's sources; null uses the real thing. */
    desktopSources: TestSource[] | null
    /** Makes capturing fail with this message. */
    captureError: string | null
    /** What Windows would say about the stand-in windows, by source id (frame, GDI region and pages, physical pixels). */
    windowGeometry: Record<string, WindowGeometry> | null
    /** The size the last window pictures were asked for at (set by the stand-in sources). */
    lastWindowThumbnailSize: { width: number; height: number } | null
  } = { failSaves: false, quitChoice: 'ask', clockOffsetMs: 0, desktopSources: null, captureError: null, windowGeometry: null, lastWindowThumbnailSize: null }
  const now = (): number => Date.now() + testHooks.clockOffsetMs

  const quit = async (): Promise<void> => {
    if (quitInProgress) return
    quitInProgress = true
    // Give the window a moment to write the edit in progress before the database closes.
    const outcome = (await windows?.requestFlush(2500)) ?? 'unavailable'
    if (outcome === 'failed') {
      // The note could not be written. Never drop it silently: bring the notes forward and ask.
      windows?.show(true)
      let choice = testHooks.quitChoice
      if (choice === 'ask') {
        const win = windows?.window
        const options = {
          type: 'warning' as const,
          buttons: ['Keep editing', 'Quit anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Trading Notes',
          message: 'The note you are writing could not be saved.',
          detail: 'If you quit now, what you typed since the last successful save will be lost. Keep editing to try again or to copy the text somewhere safe.'
        }
        const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
        choice = answer.response === 1 ? 'quit' : 'keep'
      }
      if (choice === 'keep') {
        quitInProgress = false
        return
      }
    }
    try {
      // Only a confirmed write counts as a clean exit; otherwise the next start says so.
      if (outcome === 'saved' || outcome === 'unavailable') lib.setSession({ cleanExit: true })
    } catch {
      // If this write fails the next start simply reports an unclean exit.
    }
    windows?.prepareToQuit()
    shortcuts.dispose()
    candles.dispose()
    tray?.destroy()
    lib.close()
    quitConfirmed = true
    app.quit()
  }

  const blocked = isTest ? new Set((process.env.TRADING_NOTES_TEST_BLOCKED_SHORTCUTS ?? '').split(',').filter(Boolean)) : new Set<string>()
  // Filled in once the window manager and the hotkey actions exist (they need each other).
  const hotkeyHandlers: Partial<Record<HotkeyId, () => void>> = {}
  const shortcuts = new ShortcutManager(
    Object.fromEntries(HOTKEY_IDS.map((id) => [id, () => hotkeyHandlers[id]?.()])) as Record<HotkeyId, () => void>,
    blocked,
    () => {
      windows?.send('hotkey-status', shortcuts.statuses())
      windows?.send('shortcut-status', shortcuts.status())
    }
  )
  // The candle timer keeps time here, because the window's timers slow down while it is hidden.
  const candles = new CandleClock(now, (at, minutes) => windows?.send('candle-close', { at, minutes }))

  const onStatusChange = (): void => {
    if (!windows) return
    windows.send('window-status', windows.status())
    tray?.refresh()
  }

  // Optional start-up report and keyboard event log, used by scripts/windows-native-check.ps1
  // to confirm on real Windows what the packaged app did.
  const diagnosticsFile = process.env.TRADING_NOTES_DIAGNOSTICS
  const keyboardLog = (how: string): void => {
    if (!diagnosticsFile) return
    try {
      appendFileSync(`${diagnosticsFile}.keyboard.log`, `${JSON.stringify({ at: Date.now(), how })}\n`)
    } catch {
      // Diagnostics are best effort.
    }
  }
  // One line per snapshot: what was captured and what was kept of it (never the picture or its title).
  const snapshotLog = (result: CaptureResult): void => {
    if (!diagnosticsFile) return
    try {
      const line = result.ok ? { at: Date.now(), ok: true, from: result.from, crop: result.crop } : { at: Date.now(), ok: false, message: result.message }
      appendFileSync(`${diagnosticsFile}.snapshot.log`, `${JSON.stringify(line)}\n`)
    } catch {
      // Diagnostics are best effort.
    }
  }

  const manager = new WindowManager({
    library: lib,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null,
    rendererFile: join(__dirname, '../renderer/index.html'),
    iconPath: appIcon,
    getPreferences: () => lib.getPreferences(),
    onStatusChange,
    onKeyboardReleased: keyboardLog,
    allowDevTools: !app.isPackaged || isTest
  })
  windows = manager
  // Load user32 now rather than at the first hotkey, which must act at once.
  const keyboardReturn = foregroundStatus()
  const snapshotPage = windowGeometryStatus()

  const applyPreferences = (previous: Preferences, next: Preferences): void => {
    if (previous.alwaysOnTop !== next.alwaysOnTop) manager.setAlwaysOnTop(next.alwaysOnTop)
    candles.update(next.candleTimer, next.candleMinutes)
    if (previous.launchAtStartup !== next.launchAtStartup) applyAutostart(next.launchAtStartup)
    if (previous.dockSide !== next.dockSide) manager.dockTo(next.dockSide)
    if (previous.windowOpacity !== next.windowOpacity || previous.opacitySolidOnHover !== next.opacitySolidOnHover) manager.updateOpacity()
    manager.send('preferences-changed', next)
    tray?.refresh()
  }

  // Stand-in sources for the automated tests. Zero-size requests get no picture, as for real.
  const testSources: GetSources = async (options) => {
    if (testHooks.captureError) throw new Error(testHooks.captureError)
    const wanted = options.types
    if (wanted.includes('window') && options.thumbnailSize && options.thumbnailSize.width > 0) testHooks.lastWindowThumbnailSize = { ...options.thumbnailSize }
    return (testHooks.desktopSources ?? [])
      .filter((source) => wanted.includes(source.id.startsWith('screen:') ? 'screen' : 'window'))
      .map((source) => ({
        id: source.id,
        name: source.name,
        display_id: source.display_id ?? '',
        thumbnail: options.thumbnailSize?.width === 0 ? nativeImage.createEmpty() : nativeImage.createFromBuffer(Buffer.from(source.png, 'base64'))
      }))
  }
  // Stand-in geometry for the stand-in windows: never the real windows of the test machine.
  const testGeometry: ReadGeometry = (sourceId) => {
    const geometry = testHooks.windowGeometry?.[sourceId]
    return geometry ? { ok: true, geometry } : { ok: false, reason: 'no window geometry was given for this stand-in window' }
  }

  const hotkeys = new HotkeyController({
    windows: manager,
    library: lib,
    now,
    applyPreferences,
    capture: async () => {
      const standIn = isTest && (testHooks.desktopSources || testHooks.captureError)
      const result = await captureChart({
        getSources: standIn ? testSources : (options) => desktopCapturer.getSources(options),
        displays: screen.getAllDisplays(),
        cursorDisplay: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
        docked: manager.dockedRect(),
        ownTitle: 'Trading Notes',
        readGeometry: standIn ? testGeometry : lookUpWindowGeometry
      })
      snapshotLog(result)
      return result
    },
    onSnapshotState: (text) => tray?.setStatus(text)
  })
  Object.assign(hotkeyHandlers, hotkeys.handlers(() => manager.toggle()))

  // Kept up to date by the window, so that it can be read at a moment when there is no time to ask.
  let unsavedInWindow = false
  registerIpc({
    library: lib,
    windows: manager,
    shortcuts,
    hotkeys,
    session: sessionInfo,
    applyPreferences,
    quit: () => void quit(),
    setUnsaved: (unsaved) => {
      unsavedInWindow = unsaved
    },
    testHooks
  })

  // Keep the stored preference honest if the startup entry was removed outside the app.
  const prefs = lib.getPreferences()
  if (prefs.launchAtStartup && !readAutostart()) applyAutostart(true)

  shortcuts.start(bindingsFromPreferences(prefs))
  candles.update(prefs.candleTimer, prefs.candleMinutes)
  // After sleep the next close is worked out afresh (timers do not count time asleep reliably).
  powerMonitor.on('resume', () => candles.reschedule())

  const startMode: ShowMode = process.argv.includes('--hidden') ? 'hidden' : process.argv.includes(AUTOSTART_ARG) ? 'inactive' : 'focus'
  const win = manager.create(startMode)
  win.webContents.on('did-start-loading', () => hotkeys.pageReset())
  win.on('hide', () => {
    hotkeys.windowHidden()
    // A shortcut being recorded in Settings has every hotkey released; hidden, the window
    // cannot record anything, and show/hide must work to bring it back.
    shortcuts.suspend(false)
  })

  // Windows is logging off or shutting down: there is no time to ask anything. Have the window
  // write what is pending, and record a clean exit unless the window last reported writing
  // that is not stored. (The answer to the request may not arrive before Windows ends the
  // session, so the decision rests on what the window has already reported.)
  win.on('query-session-end', () => {
    void manager.requestFlush(1000)
  })
  win.on('session-end', () => {
    try {
      if (!unsavedInWindow) lib.setSession({ cleanExit: true })
      lib.db.checkpoint()
    } catch {
      // Nothing more can be done this late.
    }
  })

  tray = new TrayController(process.platform === 'win32' ? trayIco : trayPng, {
    toggle: () => manager.toggle(),
    isShown: () => manager.isShown(),
    quickNote: () => hotkeys.beginTyping('quickNote'),
    snapshot: () => void hotkeys.snapshot(),
    dock: (side) => {
      lib.setPreferences({ dockSide: side })
      manager.dockTo(side)
      manager.send('preferences-changed', lib.getPreferences())
    },
    isAlwaysOnTop: () => lib.getPreferences().alwaysOnTop,
    setAlwaysOnTop: (flag) => {
      const previous = lib.getPreferences()
      applyPreferences(previous, lib.setPreferences({ alwaysOnTop: flag }))
    },
    opacity: () => lib.getPreferences().windowOpacity,
    setOpacity: (value) => {
      const previous = lib.getPreferences()
      applyPreferences(previous, lib.setPreferences({ windowOpacity: value }))
    },
    quit: () => void quit()
  })
  try {
    tray.create()
  } catch {
    // Some Linux desktops have no tray; the window and shortcut still work.
    tray = null
  }

  if (diagnosticsFile) {
    try {
      writeFileSync(
        diagnosticsFile,
        JSON.stringify({
          version: app.getVersion(),
          packaged: app.isPackaged,
          electron: process.versions.electron,
          tray: tray ? tray.state() : { created: false, iconLoaded: false },
          shortcut: shortcuts.status(),
          hotkeys: shortcuts.statuses(),
          keyboardReturn,
          snapshotPage,
          alwaysOnTop: win.isAlwaysOnTop(),
          bounds: win.getBounds(),
          dataDir: lib.dataDir
        })
      )
    } catch {
      // Diagnostics are best effort.
    }
  }

  app.on('before-quit', (event) => {
    if (quitConfirmed) return
    event.preventDefault()
    void quit()
  })

  if (isTest) {
    // Handles for the automated desktop tests. Never present in a normal run.
    ;(globalThis as Record<string, unknown>).__tnTest = {
      library: lib,
      windows: manager,
      shortcuts,
      hotkeys,
      candles,
      tray,
      testHooks,
      quit,
      /** Move the app's clock to `ms` (the hotkeys, the session log and the candle timer follow). */
      setNow: (ms: number) => {
        testHooks.clockOffsetMs = ms - Date.now()
        manager.send('clock', { offsetMs: testHooks.clockOffsetMs })
        candles.reschedule()
      },
      now
    }
  }
}
