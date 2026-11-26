/**
 * The only bridge between the window and the main process. The page gets a small, fixed set
 * of functions on `window.tn`; it never sees ipcRenderer, Node, or the file system.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HotkeyId } from '@shared/hotkeys'
import { IPC, type WindowAction } from '@shared/ipc'
import type {
  CreateNoteInput,
  EditCommand,
  ImportImageInput,
  ImportMode,
  MainEvents,
  Preferences,
  SaveNoteInput
} from '@shared/types'
import type { TnApi } from './api'

type Listener = (payload: unknown) => void
const listeners = new Map<string, Set<Listener>>()

ipcRenderer.on(IPC.event, (_event: IpcRendererEvent, message: { name: string; payload: unknown }) => {
  if (!message || typeof message.name !== 'string') return
  for (const listener of listeners.get(message.name) ?? []) listener(message.payload)
})

const api: TnApi = {
  loadSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  createNote: (input: CreateNoteInput) => ipcRenderer.invoke(IPC.createNote, input),
  saveNote: (input: SaveNoteInput) => ipcRenderer.invoke(IPC.saveNote, input),
  discardNote: (id: string) => ipcRenderer.invoke(IPC.discardNote, id),
  trashNote: (id: string) => ipcRenderer.invoke(IPC.trashNote, id),
  restoreNote: (id: string) => ipcRenderer.invoke(IPC.restoreNote, id),
  listTrash: () => ipcRenderer.invoke(IPC.listTrash),
  purge: (ids: string[] | 'all') => ipcRenderer.invoke(IPC.purge, ids),
  saveLayout: (layout) => ipcRenderer.invoke(IPC.saveLayout, layout),
  setPins: (ids: string[]) => ipcRenderer.invoke(IPC.setPins, ids),
  importImage: (input: ImportImageInput) => ipcRenderer.invoke(IPC.importImage, input),
  setPreferences: (patch: Partial<Preferences>) => ipcRenderer.invoke(IPC.setPreferences, patch),
  setShortcut: (accelerator: string) => ipcRenderer.invoke(IPC.setShortcut, accelerator),
  suspendShortcut: (flag: boolean) => ipcRenderer.invoke(IPC.suspendShortcut, flag),
  setHotkey: (id: HotkeyId, accelerator: string) => ipcRenderer.invoke(IPC.setHotkey, { id, accelerator }),
  setHotkeyEnabled: (id: HotkeyId, enabled: boolean) => ipcRenderer.invoke(IPC.setHotkeyEnabled, { id, enabled }),
  endTyping: (token: number) => ipcRenderer.send(IPC.endTyping, token),
  ensureSessionLog: (at: number) => ipcRenderer.invoke(IPC.ensureSessionLog, at),
  copyContracts: (count: number) => ipcRenderer.invoke(IPC.copyContracts, count),
  windowAction: (action: WindowAction) => ipcRenderer.invoke(IPC.windowAction, action),
  setSession: (openNoteId: string | null) => ipcRenderer.invoke(IPC.setSession, openNoteId),
  exportBackup: () => ipcRenderer.invoke(IPC.exportBackup),
  inspectBackup: () => ipcRenderer.invoke(IPC.inspectBackup),
  runImport: (token: string, mode: ImportMode) => ipcRenderer.invoke(IPC.runImport, { token, mode }),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  openDataFolder: () => ipcRenderer.invoke(IPC.openDataFolder),
  showInFolder: (path: string) => ipcRenderer.invoke(IPC.showInFolder, path),
  edit: (command: EditCommand) => ipcRenderer.invoke(IPC.edit, command),
  flushDone: (token: string, saved: boolean) => ipcRenderer.send(IPC.flushDone, token, saved),
  reportUnsaved: (unsaved: boolean) => ipcRenderer.send(IPC.unsaved, unsaved),
  reportPointer: (inside: boolean) => ipcRenderer.send(IPC.pointer, inside),
  previewOpacity: (value: number | null) => ipcRenderer.send(IPC.opacityPreview, value),
  on: <K extends keyof MainEvents>(name: K, listener: (payload: MainEvents[K]) => void) => {
    let set = listeners.get(name)
    if (!set) {
      set = new Set()
      listeners.set(name, set)
    }
    const wrapped = listener as Listener
    set.add(wrapped)
    return () => {
      set.delete(wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('tn', api)
