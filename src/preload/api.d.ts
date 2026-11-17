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
  flushDone(token: string): void
  on<K extends keyof MainEvents>(name: K, listener: (payload: MainEvents[K]) => void): () => void
}

declare global {
  interface Window {
    tn: TnApi
  }
}
