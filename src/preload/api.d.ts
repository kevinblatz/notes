import type { WindowAction } from '@shared/ipc'
import type {
  AttachmentMeta,
  BoardLayout,
  CreateNoteInput,
  CreateNoteResult,
  EditCommand,
  ExportResult,
  ImportImageInput,
  ImportMode,
  ImportPreview,
  ImportResult,
  LayoutResult,
  MainEvents,
  Preferences,
  RestoreResult,
  SaveNoteInput,
  SaveNoteResult,
  ShortcutStatus,
  Snapshot,
  TrashEntry,
  WindowStatus
} from '@shared/types'

/** The complete surface the window can use. Everything else stays in the main process. */
export interface TnApi {
  loadSnapshot(): Promise<Snapshot>
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>
  saveNote(input: SaveNoteInput): Promise<SaveNoteResult>
  discardNote(id: string): Promise<LayoutResult & { discarded: boolean }>
  trashNote(id: string): Promise<LayoutResult>
  restoreNote(id: string): Promise<RestoreResult | null>
  listTrash(): Promise<TrashEntry[]>
  purge(ids: string[] | 'all'): Promise<LayoutResult>
  saveLayout(layout: BoardLayout): Promise<BoardLayout>
  setPins(ids: string[]): Promise<string[]>
  importImage(input: ImportImageInput): Promise<AttachmentMeta>
  setPreferences(patch: Partial<Preferences>): Promise<Preferences>
  setShortcut(accelerator: string): Promise<{ status: ShortcutStatus; accepted: boolean }>
  suspendShortcut(flag: boolean): Promise<ShortcutStatus>
  windowAction(action: WindowAction): Promise<WindowStatus>
  setSession(openNoteId: string | null): Promise<void>
  exportBackup(): Promise<ExportResult>
  inspectBackup(): Promise<ImportPreview | { error: string } | null>
  runImport(token: string, mode: ImportMode): Promise<ImportResult>
  openExternal(url: string): Promise<boolean>
  openDataFolder(): Promise<boolean>
  showInFolder(path: string): Promise<void>
  edit(command: EditCommand): Promise<void>
  /** Answer a flush request: `saved` is false when the pending edit could not be written. */
  flushDone(token: string, saved: boolean): void
  /** Tell the main process whether the open note holds writing that is not stored yet. */
  reportUnsaved(unsaved: boolean): void
  /** Tell the main process the pointer came onto the page or left it ("solid while I use it"). */
  reportPointer(inside: boolean): void
  /**
   * Show this window opacity right away, without storing it, because the user is adjusting it
   * (it wins over "solid while I use it" so they can see what they pick). Null ends the preview.
   */
  previewOpacity(value: number | null): void
  on<K extends keyof MainEvents>(name: K, listener: (payload: MainEvents[K]) => void): () => void
}

declare global {
  interface Window {
    tn: TnApi
  }
}
