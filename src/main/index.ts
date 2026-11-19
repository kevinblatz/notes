/**
 * Main process entry point: wires the note library, the window, the tray icon, the global
 * shortcut and the IPC bridge together, and owns startup and shutdown.
 */
import { writeFileSync } from 'node:fs'
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

  const testHooks: { failSaves: boolean; quitChoice: 'ask' | 'keep' | 'quit' } = { failSaves: false, quitChoice: 'ask' }

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
    if (previous.windowOpacity !== next.windowOpacity || previous.opacitySolidOnHover !== next.opacitySolidOnHover) manager.updateOpacity()
    manager.send('preferences-changed', next)
    tray?.refresh()
  }

  // Kept up to date by the window, so that it can be read at a moment when there is no time to ask.
  let unsavedInWindow = false
  registerIpc({
    library: lib,
    windows: manager,
    shortcuts,
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

  shortcuts.start(prefs.shortcut)

  const startMode: ShowMode = process.argv.includes('--hidden') ? 'hidden' : process.argv.includes(AUTOSTART_ARG) ? 'inactive' : 'focus'
  const win = manager.create(startMode)

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

  // Optional start-up report, used by scripts/windows-native-check.ps1 to confirm that the
  // packaged app really created its tray icon and registered its shortcut.
  const diagnosticsFile = process.env.TRADING_NOTES_DIAGNOSTICS
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
    ;(globalThis as Record<string, unknown>).__tnTest = { library: lib, windows: manager, shortcuts, tray, testHooks, quit }
  }
}
