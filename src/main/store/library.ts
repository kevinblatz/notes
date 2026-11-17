/**
 * The note library: one object that owns the database and the attachment folder and exposes
 * the operations the app performs. No Electron imports, so it runs unchanged under the
 * unit tests and could later back a different shell.
 */
import { join } from 'node:path'
import { countImages, noteLabel, truncate } from '@shared/content'
import { loadPreferences, mergePreferences } from '@shared/preferences'
import type {
  AttachmentMeta,
  BoardLayout,
  CreateNoteInput,
  CreateNoteResult,
  LayoutResult,
  Note,
  Preferences,
  RestoreResult,
  SaveNoteInput,
  SaveNoteResult,
  TrashEntry
} from '@shared/types'
import type { SavedWindowState } from '@shared/windowBounds'
import { AttachmentStore, type StoreImageInput } from './attachments'
import { NotesDb, toAttachmentMeta, type AttachmentRow, type DbOptions } from './db'

export interface StoredSession {
  openNoteId: string | null
  cleanExit: boolean
}

export class Library {
  readonly db: NotesDb
  readonly attachments: AttachmentStore

  constructor(
    public readonly dataDir: string,
    options: DbOptions = {}
  ) {
    this.db = new NotesDb(join(dataDir, 'notes.db'), { backupDir: join(dataDir, 'backups'), ...options })
    this.attachments = new AttachmentStore(join(dataDir, 'attachments'))
  }

  get backupDir(): string {
    return join(this.dataDir, 'backups')
  }

  close(): void {
    this.db.close()
  }

  // ---- notes

  listLive(): Note[] {
    return this.db.listLive()
  }

  layoutState(): LayoutResult {
    return { layout: this.db.getLayout(), pins: this.db.getPins(), trashCount: this.db.countTrash() }
  }

  createNote(input: CreateNoteInput): CreateNoteResult {
    return this.db.createNote(input)
  }

  saveNote(input: SaveNoteInput): SaveNoteResult {
    return this.db.saveNote(input)
  }

  discardEmptyNote(id: string): LayoutResult & { discarded: boolean } {
    const discarded = this.db.discardEmptyNote(id)
    return { discarded, ...this.layoutState() }
  }

  trashNote(id: string): LayoutResult {
    this.db.trashNote(id)
    return this.layoutState()
  }

  restoreNote(id: string): RestoreResult | null {
    const note = this.db.restoreNote(id)
    return note ? { note, ...this.layoutState() } : null
  }

  listTrash(): TrashEntry[] {
    return this.db.listTrash().map((note) => ({
      id: note.id,
      label: noteLabel(note),
      snippet: truncate(note.plainText.replace(/\s+/g, ' ').trim(), 160),
      imageCount: countImages(note.content),
      deletedAt: note.deletedAt ?? 0
    }))
  }

  /** Delete trashed notes for good, together with image files nothing else uses. */
  purge(ids: string[] | 'all'): LayoutResult {
    for (const orphan of this.db.purgeNotes(ids)) this.attachments.remove(orphan)
    return this.layoutState()
  }

  saveLayout(layout: unknown): BoardLayout {
    return this.db.saveLayout(layout)
  }

  setPins(ids: unknown): string[] {
    return this.db.setPins(ids)
  }

  // ---- attachments

  importImage(input: StoreImageInput): AttachmentMeta {
    const row = this.attachments.store(input)
    try {
      this.db.insertAttachment(row)
    } catch (error) {
      this.attachments.remove(row)
      throw error
    }
    return toAttachmentMeta(row)
  }

  getAttachment(id: string): AttachmentRow | null {
    return this.db.getAttachment(id)
  }

  /**
   * Startup housekeeping: remove half-written temp files and images that no note refers to.
   * Runs only at startup, when there is no editor undo history that could bring an image back.
   */
  collectGarbage(): { removed: number } {
    this.attachments.sweepTempFiles()
    const orphans = this.db.unreferencedAttachments()
    for (const orphan of orphans) {
      this.db.deleteAttachment(orphan.id)
      this.attachments.remove(orphan)
    }
    return { removed: orphans.length }
  }

  // ---- settings

  getPreferences(): Preferences {
    return loadPreferences(this.db.getSetting('preferences'))
  }

  setPreferences(patch: unknown): Preferences {
    const next = mergePreferences(this.getPreferences(), patch)
    this.db.setSetting('preferences', next)
    return next
  }

  getWindowState(): SavedWindowState | null {
    const value = this.db.getSetting<SavedWindowState>('window')
    if (!value || typeof value !== 'object') return null
    if (value.dock !== 'left' && value.dock !== 'right' && value.dock !== 'custom') return null
    return {
      dock: value.dock,
      bounds: isRect(value.bounds) ? value.bounds : null,
      displayId: typeof value.displayId === 'number' ? value.displayId : null,
      displayBounds: isRect(value.displayBounds) ? value.displayBounds : null
    }
  }

  setWindowState(state: SavedWindowState): void {
    this.db.setSetting('window', state)
  }

  getSession(): StoredSession {
    const value = this.db.getSetting<Partial<StoredSession>>('session')
    return {
      openNoteId: typeof value?.openNoteId === 'string' ? value.openNoteId : null,
      // A missing record means first launch, which is not an unclean exit.
      cleanExit: value?.cleanExit !== false
    }
  }

  setSession(patch: Partial<StoredSession>): void {
    this.db.setSetting('session', { ...this.getSession(), ...patch })
  }
}

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}
