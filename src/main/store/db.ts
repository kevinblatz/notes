/**
 * SQLite persistence for notes, board layout, pins, attachment records and settings.
 *
 * Uses the SQLite engine built into Electron's Node runtime (`node:sqlite`), so there is no
 * native module to compile. Deliberately free of any `electron` import: the same class is
 * exercised directly by the unit tests.
 *
 * All calls are synchronous and run on the main process, which makes writes naturally
 * serialised: two saves can never interleave.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  collectAttachmentIds,
  extractCaptions,
  extractPlainText,
  isContentEmpty,
  isValidId,
  sanitizeDoc,
  sanitizeTags,
  sanitizeTitle
} from '@shared/content'
import { insertNote, normalizeLayout, removeNote, restoreAt, trashOriginOf } from '@shared/layout'
import type {
  AttachmentMeta,
  BoardLayout,
  CreateNoteInput,
  CreateNoteResult,
  Note,
  RichDoc,
  SaveNoteInput,
  SaveNoteResult,
  TrashOrigin
} from '@shared/types'

/** Bump when the schema changes and append a migration to MIGRATIONS. */
export const SCHEMA_VERSION = 1

type Migration = (db: DatabaseSync) => void

/**
 * MIGRATIONS[n] upgrades a database from schema version n to n + 1. Each one runs inside a
 * transaction together with the version bump, so a failed upgrade leaves the file untouched.
 * To change the schema later: add a function here and raise SCHEMA_VERSION. Existing
 * databases are copied to backups/ before the first migration touches them.
 */
const MIGRATIONS: Migration[] = [
  (db) => {
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'note',
        title TEXT,
        content_json TEXT NOT NULL,
        plain_text TEXT NOT NULL DEFAULT '',
        captions_text TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        trash_origin_json TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        extra_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX notes_deleted_at ON notes(deleted_at);

      CREATE TABLE board_rows (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL
      );
      CREATE TABLE board_slots (
        note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        row_id TEXT NOT NULL REFERENCES board_rows(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL
      );

      CREATE TABLE pins (
        note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        position INTEGER NOT NULL
      );

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        preview_name TEXT,
        original_name TEXT,
        mime TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE note_attachments (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL,
        PRIMARY KEY (note_id, attachment_id)
      );
      CREATE INDEX note_attachments_attachment ON note_attachments(attachment_id);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `)
  }
]

export class SchemaTooNewError extends Error {
  constructor(public readonly found: number) {
    super(
      `This notes database was written by a newer version of Trading Notes (schema ${found}, this version understands ${SCHEMA_VERSION}). ` +
        'Update the app to open it. Your notes have not been changed.'
    )
  }
}

export interface AttachmentRow {
  id: string
  fileName: string
  previewName: string | null
  originalName: string | null
  mime: string
  byteSize: number
  width: number | null
  height: number | null
  sha256: string
  createdAt: number
}

export interface NoteRecord extends Note {
  trashOrigin: TrashOrigin | null
}

interface NoteRow {
  id: string
  kind: string
  title: string | null
  content_json: string
  plain_text: string
  captions_text: string
  tags_json: string
  collapsed: number
  created_at: number
  updated_at: number
  deleted_at: number | null
  trash_origin_json: string | null
  revision: number
  extra_json: string
}

export interface DbOptions {
  now?: () => number
  /** Directory for the pre-migration safety copy. Defaults to "backups" beside the database. */
  backupDir?: string
}

export const newRowId = (): string => randomUUID()

export class NotesDb {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly statements = new Map<string, StatementSync>()
  private txDepth = 0
  private closed = false

  constructor(
    public readonly file: string,
    options: DbOptions = {}
  ) {
    this.now = options.now ?? Date.now
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    const existed = file !== ':memory:' && existsSync(file)
    this.db = new DatabaseSync(file)
    // WAL keeps readers and the single writer from blocking each other and survives an app
    // crash; synchronous=FULL additionally asks the OS to flush each commit to disk.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;')
    this.migrate(existed, options.backupDir ?? (file === ':memory:' ? null : join(dirname(file), 'backups')))
  }

  private migrate(existed: boolean, backupDir: string | null): void {
    const current = this.userVersion()
    if (current > SCHEMA_VERSION) {
      this.db.close()
      this.closed = true
      throw new SchemaTooNewError(current)
    }
    if (current === SCHEMA_VERSION) return
    if (existed && current > 0 && backupDir) {
      mkdirSync(backupDir, { recursive: true })
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      copyFileSync(this.file, join(backupDir, `notes-schema-v${current}-${this.now()}.db`))
    }
    for (let version = current; version < SCHEMA_VERSION; version++) {
      const migration = MIGRATIONS[version]
      if (!migration) throw new Error(`Missing migration from schema ${version}.`)
      this.transaction(() => {
        migration(this.db)
        this.db.exec(`PRAGMA user_version = ${version + 1}`)
      })
    }
  }

  private userVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    return Number(row?.user_version ?? 0)
  }

  schemaVersion(): number {
    return this.userVersion()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.statements.clear()
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // Checkpointing is best effort; the WAL is replayed on next open either way.
    }
    this.db.close()
  }

  /** Force everything committed so far into the main database file. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /** Run `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++
      try {
        return fn()
      } finally {
        this.txDepth--
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.txDepth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The original error is the one worth reporting.
      }
      throw error
    } finally {
      this.txDepth = 0
    }
  }

  // ---------------------------------------------------------------- notes

  private toNote(row: NoteRow): NoteRecord {
    let content: RichDoc
    try {
      content = sanitizeDoc(JSON.parse(row.content_json))
    } catch {
      // Never fail to load a note: fall back to its stored plain text.
      content = {
        type: 'doc',
        content: row.plain_text.split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }))
      }
    }
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      content,
      plainText: row.plain_text,
      captions: row.captions_text,
      tags: safeJson<string[]>(row.tags_json, []),
      collapsed: row.collapsed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      revision: row.revision,
      extra: safeJson<Record<string, unknown>>(row.extra_json, {}),
      trashOrigin: row.trash_origin_json ? safeJson<TrashOrigin | null>(row.trash_origin_json, null) : null
    }
  }

  getNote(id: string): NoteRecord | null {
    const row = this.stmt('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
    return row ? this.toNote(row) : null
  }

  listLive(): Note[] {
    const rows = this.stmt('SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at').all() as unknown as NoteRow[]
    return rows.map((r) => stripInternal(this.toNote(r)))
  }

  /** The live note whose extra field `key` holds `value` (the oldest, should there be several). */
  findLiveByExtra(key: string, value: string): Note | null {
    const row = this.stmt(`SELECT * FROM notes WHERE deleted_at IS NULL AND json_valid(extra_json) AND json_extract(extra_json, '$.' || ?) = ? ORDER BY created_at LIMIT 1`).get(key, value) as NoteRow | undefined
    return row ? stripInternal(this.toNote(row)) : null
  }

  listTrash(): NoteRecord[] {
    const rows = this.stmt('SELECT * FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all() as unknown as NoteRow[]
    return rows.map((r) => this.toNote(r))
  }

  listAll(): NoteRecord[] {
    const rows = this.stmt('SELECT * FROM notes ORDER BY created_at').all() as unknown as NoteRow[]
    return rows.map((r) => this.toNote(r))
  }

  liveIds(): string[] {
    return (this.stmt('SELECT id FROM notes WHERE deleted_at IS NULL ORDER BY created_at').all() as Array<{ id: string }>).map((r) => r.id)
  }

  countLive(): number {
    return Number((this.stmt('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL').get() as { n: number }).n)
  }

  countTrash(): number {
    return Number((this.stmt('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NOT NULL').get() as { n: number }).n)
  }

  private linkAttachments(noteId: string, doc: RichDoc): void {
    this.stmt('DELETE FROM note_attachments WHERE note_id = ?').run(noteId)
    const insert = this.stmt('INSERT OR IGNORE INTO note_attachments (note_id, attachment_id) VALUES (?, ?)')
    for (const attachmentId of collectAttachmentIds(doc)) insert.run(noteId, attachmentId)
  }

  /**
   * Insert a new note and place it on the board in one transaction. `extra` is set only by the
   * main process itself (the session log marks its date there); the window cannot set it.
   */
  createNote(input: CreateNoteInput, extra: Record<string, unknown> = {}): CreateNoteResult {
    if (!isValidId(input.id)) throw new Error('Invalid note ID.')
    const content = sanitizeDoc(input.content)
    const title = sanitizeTitle(input.title)
    const tags = sanitizeTags(input.tags)
    return this.transaction(() => {
      if (this.getNote(input.id)) throw new Error('A note with this ID already exists.')
      const now = this.now()
      this.stmt(
        `INSERT INTO notes (id, kind, title, content_json, plain_text, captions_text, tags_json, created_at, updated_at, revision, extra_json)
         VALUES (?, 'note', ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(input.id, title, JSON.stringify(content), extractPlainText(content), extractCaptions(content), JSON.stringify(tags), now, now, JSON.stringify(extra))
      this.linkAttachments(input.id, content)
      const layout = this.writeLayout(insertNote(this.getLayout([input.id]), input.id, input.placement, newRowId))
      return { note: stripInternal(this.getNote(input.id)!), layout }
    })
  }

  /**
   * Save an edit. The caller names the revision its edit was based on; if the stored note
   * has moved on since, the save is stale and is rejected instead of overwriting newer text.
   */
  saveNote(input: SaveNoteInput): SaveNoteResult {
    return this.transaction((): SaveNoteResult => {
      const current = this.getNote(input.id)
      if (!current || current.deletedAt !== null) return { ok: false, reason: 'missing' }
      if (current.revision !== input.expectedRevision) return { ok: false, reason: 'stale', current: stripInternal(current) }

      const content = input.content !== undefined ? sanitizeDoc(input.content) : current.content
      const title = input.title !== undefined ? sanitizeTitle(input.title) : current.title
      const tags = input.tags !== undefined ? sanitizeTags(input.tags) : current.tags
      const collapsed = input.collapsed !== undefined ? input.collapsed : current.collapsed
      const contentChanged = input.content !== undefined || input.title !== undefined || input.tags !== undefined
      // Collapsing a note is a view preference, not an edit, so it does not count as "recently edited".
      const updatedAt = contentChanged ? this.now() : current.updatedAt

      this.stmt(
        `UPDATE notes SET title = ?, content_json = ?, plain_text = ?, captions_text = ?, tags_json = ?, collapsed = ?,
           updated_at = ?, revision = revision + 1 WHERE id = ?`
      ).run(title, JSON.stringify(content), extractPlainText(content), extractCaptions(content), JSON.stringify(tags), collapsed ? 1 : 0, updatedAt, input.id)
      if (input.content !== undefined) this.linkAttachments(input.id, content)
      return { ok: true, note: stripInternal(this.getNote(input.id)!) }
    })
  }

  /**
   * Permanently remove a note that has no content. Refuses to touch a note that still has a
   * title, text or an image, so this path can never destroy writing.
   */
  discardEmptyNote(id: string): boolean {
    return this.transaction(() => {
      const note = this.getNote(id)
      if (!note) return true
      if (!isContentEmpty(note.title, note.content)) return false
      this.stmt('DELETE FROM notes WHERE id = ?').run(id)
      this.writeLayout(removeNote(this.getLayout(), id))
      return true
    })
  }

  /** Move a note to Trash, remembering its board position. */
  trashNote(id: string): boolean {
    return this.transaction(() => {
      const note = this.getNote(id)
      if (!note || note.deletedAt !== null) return false
      const layout = this.getLayout()
      const origin = trashOriginOf(layout, id)
      this.stmt('UPDATE notes SET deleted_at = ?, trash_origin_json = ? WHERE id = ?').run(this.now(), origin ? JSON.stringify(origin) : null, id)
      this.writeLayout(removeNote(layout, id))
      return true
    })
  }

  /** Bring a note back from Trash to (as near as possible) its old board position. */
  restoreNote(id: string): Note | null {
    return this.transaction(() => {
      const note = this.getNote(id)
      if (!note || note.deletedAt === null) return null
      this.stmt('UPDATE notes SET deleted_at = NULL, trash_origin_json = NULL WHERE id = ?').run(id)
      const liveBefore = this.liveIds().filter((liveId) => liveId !== id)
      const current = normalizeLayout(this.readLayoutRows(), liveBefore, newRowId)
      this.writeLayout(restoreAt(current, id, note.trashOrigin, newRowId))
      return stripInternal(this.getNote(id)!)
    })
  }

  /** Permanently delete trashed notes. Returns attachment rows that nothing references any more. */
  purgeNotes(ids: string[] | 'all'): AttachmentRow[] {
    return this.transaction(() => {
      const targets = ids === 'all' ? this.listTrash().map((n) => n.id) : ids.filter((id) => this.getNote(id)?.deletedAt != null)
      if (targets.length === 0) return []
      const candidates = new Set<string>()
      const linked = this.stmt('SELECT attachment_id FROM note_attachments WHERE note_id = ?')
      const remove = this.stmt('DELETE FROM notes WHERE id = ?')
      for (const id of targets) {
        for (const row of linked.all(id) as Array<{ attachment_id: string }>) candidates.add(row.attachment_id)
        remove.run(id)
      }
      const stillUsed = this.stmt('SELECT 1 FROM note_attachments WHERE attachment_id = ? LIMIT 1')
      const orphans: AttachmentRow[] = []
      for (const attachmentId of candidates) {
        if (stillUsed.get(attachmentId)) continue
        const row = this.getAttachment(attachmentId)
        if (row) {
          orphans.push(row)
          this.deleteAttachment(attachmentId)
        }
      }
      return orphans
    })
  }

  // ---------------------------------------------------------------- layout

  private readLayoutRows(): BoardLayout {
    const rows = this.stmt('SELECT id FROM board_rows ORDER BY position').all() as Array<{ id: string }>
    const slots = this.stmt('SELECT note_id, row_id FROM board_slots ORDER BY slot').all() as Array<{ note_id: string; row_id: string }>
    const byRow = new Map<string, string[]>()
    for (const slot of slots) {
      const list = byRow.get(slot.row_id)
      if (list) list.push(slot.note_id)
      else byRow.set(slot.row_id, [slot.note_id])
    }
    return { rows: rows.map((r) => ({ id: r.id, notes: byRow.get(r.id) ?? [] })) }
  }

  /**
   * Current board layout, repaired against the live notes so every live note appears exactly
   * once. `exclude` lists notes that are about to be placed explicitly.
   */
  getLayout(exclude: string[] = []): BoardLayout {
    const skip = new Set(exclude)
    return normalizeLayout(
      this.readLayoutRows(),
      this.liveIds().filter((id) => !skip.has(id)),
      newRowId
    )
  }

  private writeLayout(layout: BoardLayout): BoardLayout {
    const normalized = normalizeLayout(layout, this.liveIds(), newRowId)
    this.transaction(() => {
      this.db.exec('DELETE FROM board_slots; DELETE FROM board_rows;')
      const insertRow = this.stmt('INSERT INTO board_rows (id, position) VALUES (?, ?)')
      const insertSlot = this.stmt('INSERT INTO board_slots (note_id, row_id, slot) VALUES (?, ?, ?)')
      normalized.rows.forEach((row, position) => {
        insertRow.run(row.id, position)
        row.notes.forEach((noteId, slot) => insertSlot.run(noteId, row.id, slot))
      })
    })
    return normalized
  }

  /** Persist a layout sent by the window. It is normalised first, so no live note can be dropped. */
  saveLayout(layout: unknown): BoardLayout {
    return this.writeLayout(normalizeLayout(layout, this.liveIds(), newRowId))
  }

  // ---------------------------------------------------------------- pins

  getPins(): string[] {
    const rows = this.stmt(
      `SELECT p.note_id FROM pins p JOIN notes n ON n.id = p.note_id WHERE n.deleted_at IS NULL ORDER BY p.position`
    ).all() as Array<{ note_id: string }>
    return rows.map((r) => r.note_id)
  }

  /** Every pin in order, including pins of notes that are in Trash (used by backup). */
  getAllPins(): string[] {
    return (this.stmt('SELECT note_id FROM pins ORDER BY position').all() as Array<{ note_id: string }>).map((r) => r.note_id)
  }

  /** Replace the whole pin table with the given order, keeping only IDs of notes that exist (live or trashed). */
  importPins(ids: unknown): string[] {
    const known = new Set((this.stmt('SELECT id FROM notes').all() as Array<{ id: string }>).map((r) => r.id))
    const wanted: string[] = []
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && known.has(id) && !wanted.includes(id)) wanted.push(id)
    return this.transaction(() => {
      this.db.exec('DELETE FROM pins')
      const insert = this.stmt('INSERT INTO pins (note_id, position) VALUES (?, ?)')
      wanted.forEach((id, position) => insert.run(id, position))
      return this.getPins()
    })
  }

  /** Replace the pinned index (order matters). Pins of trashed notes are kept for a later restore. */
  setPins(ids: unknown): string[] {
    const live = new Set(this.liveIds())
    const wanted: string[] = []
    if (Array.isArray(ids)) {
      for (const id of ids) if (typeof id === 'string' && live.has(id) && !wanted.includes(id)) wanted.push(id)
    }
    return this.transaction(() => {
      const trashedPins = (
        this.stmt('SELECT p.note_id FROM pins p JOIN notes n ON n.id = p.note_id WHERE n.deleted_at IS NOT NULL ORDER BY p.position').all() as Array<{
          note_id: string
        }>
      ).map((r) => r.note_id)
      this.db.exec('DELETE FROM pins')
      const insert = this.stmt('INSERT INTO pins (note_id, position) VALUES (?, ?)')
      ;[...wanted, ...trashedPins].forEach((id, position) => insert.run(id, position))
      return this.getPins()
    })
  }

  // ---------------------------------------------------------------- attachments

  insertAttachment(row: AttachmentRow): void {
    this.stmt(
      `INSERT INTO attachments (id, file_name, preview_name, original_name, mime, byte_size, width, height, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.fileName, row.previewName, row.originalName, row.mime, row.byteSize, row.width, row.height, row.sha256, row.createdAt)
  }

  getAttachment(id: string): AttachmentRow | null {
    const row = this.stmt('SELECT * FROM attachments WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toAttachmentRow(row) : null
  }

  listAttachments(): AttachmentRow[] {
    return (this.stmt('SELECT * FROM attachments ORDER BY created_at').all() as Array<Record<string, unknown>>).map(toAttachmentRow)
  }

  /** Attachment records that no note (live or trashed) refers to. */
  unreferencedAttachments(): AttachmentRow[] {
    return (
      this.stmt('SELECT * FROM attachments WHERE id NOT IN (SELECT attachment_id FROM note_attachments)').all() as Array<Record<string, unknown>>
    ).map(toAttachmentRow)
  }

  deleteAttachment(id: string): void {
    this.stmt('DELETE FROM attachments WHERE id = ?').run(id)
  }

  // ---------------------------------------------------------------- settings

  getSetting<T>(key: string): T | undefined {
    const row = this.stmt('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined
    if (!row) return undefined
    return safeJson<T | undefined>(row.value_json, undefined)
  }

  setSetting(key: string, value: unknown): void {
    this.stmt('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(
      key,
      JSON.stringify(value)
    )
  }

  // ---------------------------------------------------------------- bulk (backup / restore)

  /** Insert a fully formed note record as-is (used by import). Content is sanitised again here. */
  insertImportedNote(note: NoteRecord): void {
    const content = sanitizeDoc(note.content)
    this.stmt(
      `INSERT INTO notes (id, kind, title, content_json, plain_text, captions_text, tags_json, collapsed, created_at, updated_at,
         deleted_at, trash_origin_json, revision, extra_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      note.id,
      typeof note.kind === 'string' && note.kind ? note.kind.slice(0, 40) : 'note',
      sanitizeTitle(note.title),
      JSON.stringify(content),
      extractPlainText(content),
      extractCaptions(content),
      JSON.stringify(sanitizeTags(note.tags)),
      note.collapsed ? 1 : 0,
      note.createdAt,
      note.updatedAt,
      note.deletedAt,
      note.trashOrigin ? JSON.stringify(note.trashOrigin) : null,
      Math.max(1, Math.trunc(note.revision) || 1),
      JSON.stringify(note.extra ?? {})
    )
    this.linkAttachments(note.id, content)
  }

  /** Remove every note, pin, layout row and attachment record. Settings are left alone. */
  clearCollection(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM pins; DELETE FROM board_slots; DELETE FROM board_rows; DELETE FROM note_attachments; DELETE FROM notes; DELETE FROM attachments;')
    })
  }

  replaceLayout(layout: unknown): BoardLayout {
    return this.saveLayout(layout)
  }
}

export function toAttachmentMeta(row: AttachmentRow): AttachmentMeta {
  return {
    id: row.id,
    mime: row.mime,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    originalName: row.originalName,
    hasPreview: row.previewName !== null,
    createdAt: row.createdAt
  }
}

function toAttachmentRow(row: Record<string, unknown>): AttachmentRow {
  return {
    id: String(row.id),
    fileName: String(row.file_name),
    previewName: row.preview_name === null ? null : String(row.preview_name),
    originalName: row.original_name === null ? null : String(row.original_name),
    mime: String(row.mime),
    byteSize: Number(row.byte_size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    sha256: String(row.sha256),
    createdAt: Number(row.created_at)
  }
}

function stripInternal(record: NoteRecord): Note {
  const { trashOrigin: _trashOrigin, ...note } = record
  return note
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
