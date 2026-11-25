/**
 * Every request the window can make of the main process. Each handler checks that the
 * request really comes from the app's own page and validates its arguments before use.
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { isValidAccelerator } from '@shared/accelerator'
import { isOpenableExternalUrl } from '@shared/content'
import { bindingsFromPreferences, HOTKEY_IDS, preferencesFromBindings } from '@shared/hotkeys'
import { IPC } from '@shared/ipc'
import { MAX_USER_WORD_LENGTH, MAX_USER_WORDS } from '@shared/preferences'
import { MAX_CONTRACTS } from '@shared/risk'
import type {
  AppInfo,
  ExportResult,
  ImportPreview,
  ImportResult,
  HotkeyStatus,
  HotkeyStatuses,
  Preferences,
  RichDoc,
  SessionInfo,
  SessionLogResult,
  ShortcutStatus,
  Snapshot
} from '@shared/types'
import { autostartSupported } from './autostart'
import type { HotkeyController } from './hotkeys'
import type { ShortcutManager } from './shortcut'
import { MAX_IMAGE_BYTES, MAX_PREVIEW_BYTES } from './store/attachments'
import { BACKUP_EXTENSION, BackupReader, exportBackup, importBackup, summarize, timestampForFile } from './store/backup'
import { SCHEMA_VERSION } from './store/db'
import type { Library } from './store/library'
import type { WindowManager } from './windowManager'

const zId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const zDoc = z.custom<RichDoc>((value) => typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc')
const zTitle = z.string().max(2000).nullable()
const zTags = z.array(z.string().max(200)).max(100)
const zPlacement = z.union([
  z.object({ kind: z.literal('row'), index: z.number().int() }),
  z.object({ kind: z.literal('slot'), rowId: z.string().min(1).max(64), index: z.number().int() })
])
const zCreate = z.object({ id: zId, title: zTitle, content: zDoc, tags: zTags, placement: zPlacement })
const zSave = z.object({
  id: zId,
  expectedRevision: z.number().int().nonnegative(),
  title: zTitle.optional(),
  content: zDoc.optional(),
  tags: zTags.optional(),
  collapsed: z.boolean().optional()
})
const zBinary = z.custom<ArrayBuffer | ArrayBufferView>((value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value))
const zImage = z.object({
  bytes: zBinary,
  name: z.string().max(400).nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  preview: z.object({ bytes: zBinary, width: z.number(), height: z.number() }).nullable()
})
const zWindowAction = z.enum(['hide', 'minimize', 'toggle-maximize', 'quit', 'dock-left', 'dock-right'])
const zEdit = z.enum(['cut', 'copy', 'paste', 'pastePlain', 'selectAll', 'undo', 'redo'])
const zImport = z.object({ token: z.string().max(100), mode: z.enum(['merge', 'replace']) })
const zPointer = z.boolean()
// Any finite number is accepted and then held to the allowed range by the window manager.
const zOpacityPreview = z.number().nullable()
const zHotkeyId = z.enum(HOTKEY_IDS)
const zSetHotkey = z.object({ id: zHotkeyId, accelerator: z.string().max(64) })
const zSetHotkeyEnabled = z.object({ id: zHotkeyId, enabled: z.boolean() })
const zMoment = z.number().int().nonnegative().max(8.64e15)
const zContracts = z.number().int().nonnegative().max(MAX_CONTRACTS)
const zToken = z.number().int().positive()
// The spelling dictionary: a list of short strings. Each word is then checked again (and the
// list capped) by mergePreferences, as every other preference is.
const zSpellingWords = z.array(z.string().max(MAX_USER_WORD_LENGTH * 4)).max(MAX_USER_WORDS * 2)

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

export interface IpcContext {
  library: Library
  windows: WindowManager
  shortcuts: ShortcutManager
  hotkeys: HotkeyController
  session: SessionInfo
  /** Apply preference side effects (topmost flag, startup entry, shortcut). */
  applyPreferences: (previous: Preferences, next: Preferences) => void
  quit: () => void
  /** The window reports whether the open note holds writing that is not stored yet. */
  setUnsaved: (unsaved: boolean) => void
  /** Test-only switches; all false in normal use. */
  testHooks: { failSaves: boolean; quitChoice: 'ask' | 'keep' | 'quit'; clockOffsetMs: number }
}

export function registerIpc(context: IpcContext): void {
  const { library, windows, shortcuts, hotkeys } = context
  // Only the path is remembered between the preview and the import. The archive itself is
  // closed in between, so the file is never held open while the user decides (on Windows an
  // open file cannot be moved, renamed or deleted).
  let pendingImport: { token: string; filePath: string } | null = null
  /** Backup files written by this run; the only paths "Show file" may reveal. */
  const revealable = new Set<string>()

  const appInfo = (): AppInfo => ({
    version: app.getVersion(),
    dataDir: library.dataDir,
    platform: process.platform,
    schemaVersion: SCHEMA_VERSION
  })

  /** True only for the app's own top-level page in the notes window. */
  const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame
    return !!frame && frame === event.sender.mainFrame && event.sender === windows.window?.webContents && windows.isTrustedFrameUrl(frame.url)
  }

  /** Register a handler that refuses calls from anything but the app's own top-level page. */
  const handle = <T>(channel: string, fn: (payload: unknown, event: IpcMainInvokeEvent) => T | Promise<T>): void => {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!fromApp(event)) throw new Error('Request refused.')
      return fn(payload, event)
    })
  }

  const assertWritable = (): void => {
    if (context.testHooks.failSaves) throw new Error('The notes file could not be written (simulated disk failure).')
  }

  handle(IPC.snapshot, (): Snapshot => {
    const state = library.layoutState()
    return {
      notes: library.listLive(),
      layout: state.layout,
      pins: state.pins,
      trashCount: state.trashCount,
      preferences: library.getPreferences(),
      session: context.session,
      shortcut: shortcuts.status(),
      hotkeys: shortcuts.statuses(),
      window: windows.status(),
      app: appInfo(),
      clockOffsetMs: context.testHooks.clockOffsetMs
    }
  })

  handle(IPC.createNote, (payload) => {
    assertWritable()
    return library.createNote(zCreate.parse(payload))
  })

  handle(IPC.saveNote, (payload) => {
    assertWritable()
    return library.saveNote(zSave.parse(payload))
  })

  handle(IPC.discardNote, (payload) => library.discardEmptyNote(zId.parse(payload)))
  handle(IPC.trashNote, (payload) => library.trashNote(zId.parse(payload)))
  handle(IPC.restoreNote, (payload) => library.restoreNote(zId.parse(payload)))
  handle(IPC.listTrash, () => library.listTrash())
  handle(IPC.purge, (payload) => library.purge(z.union([z.literal('all'), z.array(zId).max(100000)]).parse(payload)))
  handle(IPC.saveLayout, (payload) => {
    assertWritable()
    return library.saveLayout(payload)
  })
  handle(IPC.setPins, (payload) => library.setPins(z.array(z.string().max(64)).max(100000).parse(payload)))

  handle(IPC.importImage, (payload) => {
    assertWritable()
    const input = zImage.parse(payload)
    const bytes = toBytes(input.bytes)
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`The image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`)
    const preview = input.preview ? toBytes(input.preview.bytes) : null
    return library.importImage({
      bytes,
      name: input.name,
      width: input.width,
      height: input.height,
      preview: preview && preview.byteLength <= MAX_PREVIEW_BYTES && input.preview ? { bytes: preview, width: input.preview.width, height: input.preview.height } : null
    })
  })

  handle(IPC.setPreferences, (payload): Preferences => {
    const previous = library.getPreferences()
    const patch = z.record(z.string(), z.unknown()).parse(payload)
    // Hotkeys have their own channels because changing them can fail.
    delete patch.shortcut
    delete patch.shortcutEnabled
    delete patch.hotkeys
    if ('spellingWords' in patch && !zSpellingWords.safeParse(patch.spellingWords).success) delete patch.spellingWords
    if (patch.launchAtStartup === true && !autostartSupported()) delete patch.launchAtStartup
    const next = library.setPreferences(patch)
    context.applyPreferences(previous, next)
    return next
  })

  /** Store what the hotkeys now are, and let the window know. */
  const storeBindings = (): void => {
    const previous = library.getPreferences()
    context.applyPreferences(previous, library.setPreferences(preferencesFromBindings(shortcuts.bindings())))
  }

  // The show/hide shortcut alone, as before there were several.
  handle(IPC.setShortcut, (payload): { status: ShortcutStatus; accepted: boolean } => {
    const accelerator = z.string().max(64).parse(payload)
    if (!isValidAccelerator(accelerator)) {
      return { status: { accelerator, enabled: true, registered: false, error: 'That key combination cannot be used as a global shortcut.' }, accepted: false }
    }
    const result = shortcuts.change('toggle', accelerator)
    if (result.accepted) storeBindings()
    const { id: _id, ...status } = result.status
    return { status, accepted: result.accepted }
  })

  handle(IPC.setHotkey, (payload) => {
    const { id, accelerator } = zSetHotkey.parse(payload)
    const result = shortcuts.change(id, accelerator)
    if (result.accepted) storeBindings()
    return { ...result, statuses: shortcuts.statuses() }
  })

  handle(IPC.setHotkeyEnabled, (payload): { status: HotkeyStatus; accepted: boolean; statuses: HotkeyStatuses } => {
    const { id, enabled } = zSetHotkeyEnabled.parse(payload)
    const result = shortcuts.setEnabled(id, enabled)
    if (result.accepted) storeBindings()
    return { ...result, statuses: shortcuts.statuses() }
  })

  handle(IPC.suspendShortcut, (payload) => {
    shortcuts.suspend(z.boolean().parse(payload))
    return shortcuts.status()
  })

  handle(IPC.ensureSessionLog, (payload): SessionLogResult => {
    assertWritable()
    return library.ensureSessionLog(zMoment.parse(payload))
  })

  // Only a whole number of contracts, never anything else: the calculator does arithmetic only.
  handle(IPC.copyContracts, (payload) => {
    clipboard.writeText(String(zContracts.parse(payload)))
  })

  handle(IPC.windowAction, (payload) => {
    const action = zWindowAction.parse(payload)
    if (action === 'hide') windows.hide()
    else if (action === 'minimize') windows.minimize()
    else if (action === 'toggle-maximize') windows.toggleMaximize()
    else if (action === 'dock-left' || action === 'dock-right') {
      const side = action === 'dock-left' ? 'left' : 'right'
      library.setPreferences({ dockSide: side })
      windows.dockTo(side)
    } else if (action === 'quit') context.quit()
    return windows.status()
  })

  handle(IPC.setSession, (payload) => {
    const openNoteId = zId.nullable().parse(payload)
    library.setSession({ openNoteId })
  })

  handle(IPC.exportBackup, async (): Promise<ExportResult> => {
    const win = windows.window
    if (!win) return { ok: false, error: 'The notes window is not available.' }
    const chosen = await dialog.showSaveDialog(win, {
      title: 'Export backup',
      defaultPath: join(app.getPath('documents'), `Trading Notes ${timestampForFile(Date.now()).slice(0, 10)}.${BACKUP_EXTENSION}`),
      filters: [{ name: 'Trading Notes backup', extensions: [BACKUP_EXTENSION] }]
    })
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true }
    try {
      await windows.requestFlush(1500)
      const summary = await exportBackup(library, chosen.filePath, app.getVersion())
      revealable.add(summary.path)
      return {
        ok: true,
        path: summary.path,
        noteCount: summary.noteCount,
        attachmentCount: summary.attachmentCount,
        byteSize: summary.byteSize,
        missingFiles: summary.missingFiles
      }
    } catch (error) {
      return { ok: false, error: `The backup could not be written: ${messageOf(error)}` }
    }
  })

  handle(IPC.inspectBackup, async (): Promise<ImportPreview | { error: string } | null> => {
    const win = windows.window
    if (!win) return null
    const chosen = await dialog.showOpenDialog(win, {
      title: 'Import backup',
      properties: ['openFile'],
      filters: [{ name: 'Trading Notes backup', extensions: [BACKUP_EXTENSION, 'zip'] }]
    })
    const filePath = chosen.filePaths[0]
    if (chosen.canceled || !filePath) return null
    pendingImport = null
    try {
      const reader = await BackupReader.open(filePath)
      try {
        const token = randomUUID()
        pendingImport = { token, filePath }
        return { token, ...summarize(library, reader) }
      } finally {
        reader.close()
      }
    } catch (error) {
      return { error: messageOf(error) }
    }
  })

  handle(IPC.runImport, async (payload): Promise<ImportResult> => {
    const { token, mode } = zImport.parse(payload)
    const failed = (error: string): ImportResult => ({
      ok: false, mode, added: 0, skipped: 0, copied: 0, attachmentsImported: 0, missingAttachments: 0, safetyBackupPath: null, error
    })
    if (!pendingImport || pendingImport.token !== token) return failed('Choose the backup file again.')
    const { filePath } = pendingImport
    pendingImport = null
    const previous = library.getPreferences()
    let reader: BackupReader
    try {
      // Opened again here, which also re-validates the file in case it changed since the preview.
      reader = await BackupReader.open(filePath)
    } catch (error) {
      return failed(`Nothing was changed. ${messageOf(error)}`)
    }
    try {
      await windows.requestFlush(1500)
      const result = await importBackup(library, reader, mode, { appVersion: app.getVersion() })
      if (result.safetyBackupPath) revealable.add(result.safetyBackupPath)
      if (mode === 'replace') {
        // A restored hotkey may be taken on this machine; the working one is kept in that case.
        shortcuts.apply(bindingsFromPreferences(library.getPreferences()))
        library.setPreferences(preferencesFromBindings(shortcuts.bindings()))
        context.applyPreferences(previous, library.getPreferences())
        library.setSession({ openNoteId: null })
      }
      windows.send('data-replaced', null)
      return result
    } catch (error) {
      return failed(`Nothing was changed. ${messageOf(error)}`)
    } finally {
      reader.close()
    }
  })

  handle(IPC.openExternal, async (payload) => {
    if (!isOpenableExternalUrl(payload)) return false
    await shell.openExternal(payload)
    return true
  })

  handle(IPC.openDataFolder, async () => (await shell.openPath(library.dataDir)) === '')

  handle(IPC.showInFolder, (payload) => {
    const target = z.string().max(4000).parse(payload)
    // Only files this app itself wrote during this run can be revealed: the exported backup
    // and the automatic safety copies. The window cannot make Explorer open any other path.
    if (revealable.has(target)) shell.showItemInFolder(target)
  })

  handle(IPC.edit, (payload, event) => {
    const command = zEdit.parse(payload)
    const contents = event.sender
    if (command === 'cut') contents.cut()
    else if (command === 'copy') contents.copy()
    else if (command === 'paste') contents.paste()
    else if (command === 'pastePlain') contents.pasteAndMatchStyle()
    else if (command === 'selectAll') contents.selectAll()
    else if (command === 'undo') contents.undo()
    else contents.redo()
  })

  ipcMain.on(IPC.flushDone, (event, token: unknown, saved: unknown) => {
    if (event.sender !== windows.window?.webContents || typeof token !== 'string') return
    // Anything other than an explicit "false" counts as saved (nothing was pending).
    windows.confirmFlush(token, saved !== false)
  })

  ipcMain.on(IPC.endTyping, (event, token: unknown) => {
    if (!fromApp(event)) return
    const parsed = zToken.safeParse(token)
    if (parsed.success) hotkeys.endTyping(parsed.data)
  })

  ipcMain.on(IPC.unsaved, (event, unsaved: unknown) => {
    if (event.sender !== windows.window?.webContents || typeof unsaved !== 'boolean') return
    context.setUnsaved(unsaved)
  })

  // "Solid while I use it": the page says when the pointer comes onto it and leaves it.
  ipcMain.on(IPC.pointer, (event, inside: unknown) => {
    if (!fromApp(event)) return
    const parsed = zPointer.safeParse(inside)
    if (parsed.success) windows.reportPointer('page', parsed.data)
  })

  // The value being adjusted, at most once a frame while a slider moves; null when done.
  ipcMain.on(IPC.opacityPreview, (event, value: unknown) => {
    if (!fromApp(event)) return
    const parsed = zOpacityPreview.safeParse(value)
    if (parsed.success) windows.previewOpacity(parsed.data)
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
