/**
 * Main process entry point: wires the note library, the window, the tray icon, the global
 * shortcut and the IPC bridge together, and owns startup and shutdown.
 */
import { join } from 'node:path'
import { app, dialog, session } from 'electron'
import type { Preferences, SessionInfo } from '@shared/types'
import appIcon from '../../resources/icon.png?asset'
import trayIco from '../../resources/tray.ico?asset'
import trayPng from '../../resources/tray.png?asset'
import { applyAutostart, AUTOSTART_ARG, readAutostart } from './autostart'
import { registerIpc } from './ipc'
import { handleAttachmentRequests, registerAttachmentScheme } from './protocol'
import { ShortcutManager } from './shortcut'
import { Library } from './store/library'
import { TrayController } from './tray'
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
  handleAttachmentRequests(lib)

  const quit = async (): Promise<void> => {
    if (quitInProgress) return
    quitInProgress = true
    // Give the window a moment to write the edit in progress before the database closes.
    await windows?.requestFlush(2500)
    try {
      lib.setSession({ cleanExit: true })
    } catch {
      // If this write fails the next start simply reports an unclean exit.
    }
    windows?.prepareToQuit()
    shortcuts.dispose()
    tray?.destroy()
    lib.close()
    quitConfirmed = true
    app.quit()
  }

  const blocked = isTest ? new Set((process.env.TRADING_NOTES_TEST_BLOCKED_SHORTCUTS ?? '').split(',').filter(Boolean)) : new Set<string>()
  const shortcuts = new ShortcutManager(() => windows?.toggle(), blocked)

  const onStatusChange = (): void => {
    if (!windows) return
    windows.send('window-status', windows.status())
    tray?.refresh()
  }

  const manager = new WindowManager({
    library: lib,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null,
    rendererFile: join(__dirname, '../renderer/index.html'),
    iconPath: appIcon,
    getPreferences: () => lib.getPreferences(),
    onStatusChange,
    allowDevTools: !app.isPackaged || isTest
  })
  windows = manager

  const applyPreferences = (previous: Preferences, next: Preferences): void => {
    if (previous.alwaysOnTop !== next.alwaysOnTop) manager.setAlwaysOnTop(next.alwaysOnTop)
    if (previous.launchAtStartup !== next.launchAtStartup) applyAutostart(next.launchAtStartup)
    if (previous.dockSide !== next.dockSide) manager.dockTo(next.dockSide)
    manager.send('preferences-changed', next)
    tray?.refresh()
  }

  const testHooks = { failSaves: false }
  registerIpc({ library: lib, windows: manager, shortcuts, session: sessionInfo, applyPreferences, quit: () => void quit(), testHooks })

  // Keep the stored preference honest if the startup entry was removed outside the app.
  const prefs = lib.getPreferences()
  if (prefs.launchAtStartup && !readAutostart()) applyAutostart(true)

  shortcuts.start(prefs.shortcut)

  const startMode: ShowMode = process.argv.includes('--hidden') ? 'hidden' : process.argv.includes(AUTOSTART_ARG) ? 'inactive' : 'focus'
  const win = manager.create(startMode)

  // Windows is logging off or shutting down: there is no time to wait, so write what we can.
  win.on('query-session-end' as 'close', () => void manager.requestFlush(1000))
  win.on('session-end' as 'close', () => {
    try {
      lib.setSession({ cleanExit: true })
      lib.db.checkpoint()
    } catch {
      // Nothing more can be done this late.
    }
  })

  tray = new TrayController(process.platform === 'win32' ? trayIco : trayPng, {
    toggle: () => manager.toggle(),
    isShown: () => manager.isShown(),
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
    quit: () => void quit()
  })
  try {
    tray.create()
  } catch {
    // Some Linux desktops have no tray; the window and shortcut still work.
    tray = null
  }

  app.on('before-quit', (event) => {
    if (quitConfirmed) return
    event.preventDefault()
    void quit()
  })

  if (isTest) {
    // Handles for the automated desktop tests. Never present in a normal run.
    ;(globalThis as Record<string, unknown>).__tnTest = { library: lib, windows: manager, shortcuts, testHooks, quit }
  }
}
