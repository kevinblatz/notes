/**
 * Backup export and import.
 *
 * A backup is a single zip archive (extension .tnbackup) holding:
 *   manifest.json   format name + version, counts, and one record per image with its SHA-256
 *   data.json       every note (including Trash), the board layout, pins and preferences
 *   attachments/    the full-resolution images and their previews
 *
 * Import never trusts the archive: the manifest and data are schema-checked, note content is
 * re-sanitised, archive paths are validated and never used as file names on disk, and every
 * image is checked against its recorded hash and its real file signature.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { z } from 'zod'
import { collectAttachmentIds, IMAGE_NODE, sanitizeDoc, sanitizeTags, sanitizeTitle } from '@shared/content'
import { normalizeLayout } from '@shared/layout'
import type { BoardLayout, ImportMode, ImportResult, RichDoc, RichNode } from '@shared/types'
import { MAX_IMAGE_BYTES, sha256Hex, sniffImage } from './attachments'
import { newRowId, SCHEMA_VERSION, type AttachmentRow, type NoteRecord } from './db'
import type { Library } from './library'

export const BACKUP_FORMAT = 'trading-notes-backup'
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_EXTENSION = 'tnbackup'

const MAX_JSON_BYTES = 256 * 1024 * 1024
const MAX_ENTRIES = 200_000

const zId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const zArchivePath = z
  .string()
  .max(200)
  .regex(/^attachments\/[A-Za-z0-9_.-]+$/)
  .refine((p) => !p.includes('..'), 'path must not contain ".."')

const zManifestAttachment = z.object({
  id: zId,
  file: zArchivePath,
  preview: zArchivePath.nullable().default(null),
  mime: z.string().max(100),
  byteSize: z.number().int().nonnegative(),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  originalName: z.string().max(300).nullable().default(null),
  createdAt: z.number()
})

const zManifest = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int().positive(),
  schemaVersion: z.number().int().nonnegative(),
  appVersion: z.string().max(40),
  createdAt: z.number(),
  counts: z.object({ notes: z.number(), trashed: z.number(), attachments: z.number(), pins: z.number() }).partial().default({}),
  attachments: z.array(zManifestAttachment).max(MAX_ENTRIES)
})

const zNote = z.object({
  id: zId,
  kind: z.string().max(40).default('note'),
  title: z.string().nullable().default(null),
  content: z.unknown(),
  tags: z.array(z.string()).default([]),
  collapsed: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable().default(null),
  trashOrigin: z.object({ rowIndex: z.number(), slot: z.number(), partnerId: z.string().nullable() }).nullable().default(null),
  revision: z.number().default(1),
  extra: z.record(z.string(), z.unknown()).default({})
})

const zData = z.object({
  notes: z.array(z.unknown()).max(MAX_ENTRIES),
  layout: z.unknown(),
  pins: z.array(z.string()).default([]),
  preferences: z.unknown().optional()
})

export type BackupManifest = z.infer<typeof zManifest>
type ManifestAttachment = z.infer<typeof zManifestAttachment>

export class BackupError extends Error {}

export interface ExportSummary {
  path: string
  noteCount: number
  attachmentCount: number
  byteSize: number
  /** Images whose files were missing on disk and therefore could not be included. */
  missingFiles: number
}

export async function exportBackup(library: Library, destPath: string, appVersion: string): Promise<ExportSummary> {
  const notes = library.db.listAll()
  const referenced = new Set<string>()
  for (const note of notes) for (const id of collectAttachmentIds(note.content)) referenced.add(id)

  const zip = new yazl.ZipFile()
  const manifestAttachments: ManifestAttachment[] = []
  let missingFiles = 0

  for (const row of library.db.listAttachments()) {
    if (!referenced.has(row.id)) continue
    if (!library.attachments.hasOriginal(row)) {
      missingFiles++
      continue
    }
    const file = `attachments/${row.fileName}`
    // Images are already compressed; storing them as-is keeps export fast.
    zip.addFile(library.attachments.originalPath(row), file, { compress: false })
    let preview: string | null = null
    if (row.previewName && existsSync(library.attachments.pathOf(row.previewName))) {
      preview = `attachments/${row.previewName}`
      zip.addFile(library.attachments.pathOf(row.previewName), preview, { compress: false })
    }
    manifestAttachments.push({
      id: row.id,
      file,
      preview,
      mime: row.mime,
      byteSize: row.byteSize,
      width: row.width,
      height: row.height,
      sha256: row.sha256,
      originalName: row.originalName,
      createdAt: row.createdAt
    })
  }

  const live = notes.filter((n) => n.deletedAt === null).length
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion,
    createdAt: Date.now(),
    counts: { notes: live, trashed: notes.length - live, attachments: manifestAttachments.length, pins: library.db.getPins().length },
    attachments: manifestAttachments
  }
  const data = {
    notes,
    layout: library.db.getLayout(),
    // Every pin, including those of notes in Trash, so restoring such a note later brings its pin back.
    pins: library.db.getAllPins(),
    preferences: library.getPreferences()
  }
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json', { compress: true })
  zip.addBuffer(Buffer.from(JSON.stringify(data), 'utf8'), 'data.json', { compress: true })

  // Write beside the destination and rename at the end, so an interrupted export never
  // leaves something that looks like a complete backup.
  mkdirSync(dirname(destPath), { recursive: true })
  const partial = `${destPath}.partial`
  try {
    zip.end()
    await pipeline(zip.outputStream, createWriteStream(partial))
    renameSync(partial, destPath)
  } catch (error) {
    rmSync(partial, { force: true })
    throw error
  }
  return { path: destPath, noteCount: live, attachmentCount: manifestAttachments.length, byteSize: statSync(destPath).size, missingFiles }
}

// ------------------------------------------------------------------ reading

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(new BackupError('This file is not a readable Trading Notes backup.'))
      else resolve(zip)
    })
  })
}

function listEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>()
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entries.size >= MAX_ENTRIES) {
        reject(new BackupError('The backup contains too many files.'))
        return
      }
      // yauzl has already rejected absolute paths, backslashes and ".." segments.
      if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry)
      zip.readEntry()
    })
    zip.once('end', () => resolve(entries))
    zip.once('error', () => reject(new BackupError('The backup archive is damaged or contains unsafe file paths.')))
    zip.readEntry()
  })
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > maxBytes) {
      reject(new BackupError(`"${entry.fileName}" is larger than allowed.`))
      return
    }
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new BackupError(`Could not read "${entry.fileName}" from the backup.`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          stream.destroy()
          reject(new BackupError(`"${entry.fileName}" is larger than allowed.`))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', () => reject(new BackupError(`"${entry.fileName}" in the backup is damaged.`)))
    })
  })
}

export interface BackupNote extends NoteRecord {}

export class BackupReader {
  private constructor(
    public readonly filePath: string,
    private readonly zip: yauzl.ZipFile,
    private readonly entries: Map<string, yauzl.Entry>,
    public readonly manifest: BackupManifest,
    public readonly notes: BackupNote[],
    public readonly layout: unknown,
    public readonly pins: string[],
    public readonly preferences: unknown,
    public readonly warnings: string[]
  ) {}

  static async open(filePath: string): Promise<BackupReader> {
    const zip = await openZip(filePath)
    try {
      const entries = await listEntries(zip)
      const manifestEntry = entries.get('manifest.json')
      const dataEntry = entries.get('data.json')
      if (!manifestEntry || !dataEntry) throw new BackupError('This file is not a Trading Notes backup (manifest.json or data.json is missing).')

      const manifestRaw = parseJson(await readEntry(zip, manifestEntry, MAX_JSON_BYTES), 'manifest.json')
      if (typeof manifestRaw === 'object' && manifestRaw !== null && (manifestRaw as { format?: unknown }).format !== BACKUP_FORMAT) {
        throw new BackupError('This file is not a Trading Notes backup.')
      }
      const manifestResult = zManifest.safeParse(manifestRaw)
      if (!manifestResult.success) throw new BackupError('The backup manifest is not valid.')
      const manifest = manifestResult.data
      if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
        throw new BackupError(
          `This backup uses format version ${manifest.formatVersion}, which is newer than this app understands (${BACKUP_FORMAT_VERSION}). Update Trading Notes to import it.`
        )
      }

      const dataResult = zData.safeParse(parseJson(await readEntry(zip, dataEntry, MAX_JSON_BYTES), 'data.json'))
      if (!dataResult.success) throw new BackupError('The backup data is not valid.')

      const warnings: string[] = []
      const notes: BackupNote[] = []
      const seen = new Set<string>()
      let unreadable = 0
      for (const raw of dataResult.data.notes) {
        const parsed = zNote.safeParse(raw)
        if (!parsed.success || seen.has(parsed.data.id)) {
          unreadable++
          continue
        }
        let content: RichDoc
        try {
          content = sanitizeDoc(parsed.data.content)
        } catch {
          unreadable++
          continue
        }
        seen.add(parsed.data.id)
        notes.push({
          id: parsed.data.id,
          kind: parsed.data.kind,
          title: sanitizeTitle(parsed.data.title),
          content,
          plainText: '',
          captions: '',
          tags: sanitizeTags(parsed.data.tags),
          collapsed: parsed.data.collapsed,
          createdAt: parsed.data.createdAt,
          updatedAt: parsed.data.updatedAt,
          deletedAt: parsed.data.deletedAt,
          revision: parsed.data.revision,
          extra: parsed.data.extra,
          trashOrigin: parsed.data.trashOrigin
        })
      }
      if (unreadable > 0) warnings.push(`${unreadable} ${unreadable === 1 ? 'note' : 'notes'} in the backup could not be read and will be skipped.`)

      return new BackupReader(filePath, zip, entries, manifest, notes, dataResult.data.layout, dataResult.data.pins, dataResult.data.preferences, warnings)
    } catch (error) {
      zip.close()
      throw error
    }
  }

  close(): void {
    this.zip.close()
  }

  private manifestIndex(): Map<string, ManifestAttachment> {
    return new Map(this.manifest.attachments.map((a) => [a.id, a]))
  }

  /** IDs of every image the notes refer to. */
  referencedAttachmentIds(notes: BackupNote[] = this.notes): string[] {
    const ids = new Set<string>()
    for (const note of notes) for (const id of collectAttachmentIds(note.content)) ids.add(id)
    return [...ids]
  }

  /** Referenced images that the archive cannot supply. */
  missingAttachmentIds(notes: BackupNote[] = this.notes): string[] {
    const index = this.manifestIndex()
    return this.referencedAttachmentIds(notes).filter((id) => {
      const record = index.get(id)
      return !record || !this.entries.has(record.file)
    })
  }

  /** Read and verify one image. Returns null when it is absent, damaged or not an image. */
  async readAttachment(id: string): Promise<{ record: ManifestAttachment; bytes: Buffer; preview: Buffer | null } | null> {
    const record = this.manifestIndex().get(id)
    if (!record) return null
    const entry = this.entries.get(record.file)
    if (!entry) return null
    let bytes: Buffer
    try {
      bytes = await readEntry(this.zip, entry, MAX_IMAGE_BYTES)
    } catch {
      return null
    }
    if (sha256Hex(bytes) !== record.sha256 || !sniffImage(bytes)) return null
    let preview: Buffer | null = null
    const previewEntry = record.preview ? this.entries.get(record.preview) : undefined
    if (previewEntry) {
      try {
        const candidate = await readEntry(this.zip, previewEntry, MAX_IMAGE_BYTES)
        if (sniffImage(candidate)) preview = candidate
      } catch {
        preview = null
      }
    }
    return { record, bytes, preview }
  }
}

function parseJson(buffer: Buffer, name: string): unknown {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new BackupError(`${name} in the backup is not valid JSON.`)
  }
}

// ------------------------------------------------------------------ importing

function remapAttachments(doc: RichDoc, map: Map<string, string>): RichDoc {
  if (map.size === 0) return doc
  const walk = (nodes: RichNode[] | undefined): RichNode[] | undefined =>
    nodes?.map((node) => {
      if (node.type === IMAGE_NODE && typeof node.attrs?.attachmentId === 'string' && map.has(node.attrs.attachmentId)) {
        return { ...node, attrs: { ...node.attrs, attachmentId: map.get(node.attrs.attachmentId)! } }
      }
      return node.content ? { ...node, content: walk(node.content) } : node
    })
  return { type: 'doc', content: walk(doc.content) }
}

function sameWriting(a: NoteRecord, b: NoteRecord): boolean {
  return (
    (a.title ?? '') === (b.title ?? '') &&
    JSON.stringify(a.content) === JSON.stringify(b.content) &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags)
  )
}

export function timestampForFile(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export interface ImportOptions {
  appVersion: string
}

/**
 * Apply an inspected backup.
 *
 * merge    Adds the backup's notes to the current collection. A note whose ID already exists
 *          is left exactly as it is; if the backup's version of it has different writing, that
 *          version is added as a separate copy. Nothing existing is changed or removed, and
 *          preferences are untouched. Added notes go to the bottom of the board in the
 *          backup's order, keeping their side-by-side pairs.
 *
 * replace  Restores the collection to exactly what the backup holds: notes, Trash, layout,
 *          pins and preferences. The current collection is first written to an automatic
 *          safety backup, and only then replaced.
 */
export async function importBackup(library: Library, reader: BackupReader, mode: ImportMode, options: ImportOptions): Promise<ImportResult> {
  const { db, attachments } = library
  const result: ImportResult = { ok: true, mode, added: 0, skipped: 0, copied: 0, attachmentsImported: 0, missingAttachments: 0, safetyBackupPath: null }

  // 1. Decide which notes come in, and under which IDs.
  const noteIdMap = new Map<string, string>()
  const incoming: BackupNote[] = []
  if (mode === 'replace') {
    incoming.push(...reader.notes)
  } else {
    for (const note of reader.notes) {
      const existing = db.getNote(note.id)
      if (!existing) {
        incoming.push(note)
      } else if (sameWriting(existing, note)) {
        result.skipped++
      } else {
        const copyId = randomUUID()
        noteIdMap.set(note.id, copyId)
        incoming.push({ ...note, id: copyId })
        result.copied++
      }
    }
  }

  // 2. Safety copy before anything destructive.
  if (mode === 'replace' && db.listAll().length > 0) {
    const safetyPath = join(library.backupDir, `before-restore-${timestampForFile(Date.now())}.${BACKUP_EXTENSION}`)
    await exportBackup(library, safetyPath, options.appVersion)
    result.safetyBackupPath = safetyPath
  }

  // 3. Bring image files in. Files are written first; database rows follow in one transaction.
  const attachmentIdMap = new Map<string, string>()
  const newRows: AttachmentRow[] = []
  const writtenRows: AttachmentRow[] = []
  const keepIds = new Set<string>()
  try {
    for (const id of reader.referencedAttachmentIds(incoming)) {
      const loaded = await reader.readAttachment(id)
      if (!loaded) {
        result.missingAttachments++
        continue
      }
      const existing = db.getAttachment(id)
      if (existing && existing.sha256 === loaded.record.sha256 && attachments.hasOriginal(existing)) {
        keepIds.add(id)
        if (mode === 'replace') newRows.push(existing)
        continue
      }
      // Same ID but different bytes can only happen with a hand-edited archive; keep both.
      const targetId = existing && mode === 'merge' ? randomUUID() : id
      if (targetId !== id) attachmentIdMap.set(id, targetId)
      const row = attachments.store({
        id: targetId,
        bytes: loaded.bytes,
        name: loaded.record.originalName,
        width: loaded.record.width,
        height: loaded.record.height,
        preview: loaded.preview ? { bytes: loaded.preview, width: 0, height: 0 } : null,
        createdAt: loaded.record.createdAt
      })
      newRows.push(row)
      writtenRows.push(row)
      keepIds.add(targetId)
      result.attachmentsImported++
    }

    // 4. One transaction for every database change.
    const oldAttachments = mode === 'replace' ? db.listAttachments() : []
    db.transaction(() => {
      if (mode === 'replace') db.clearCollection()
      for (const row of newRows) if (!db.getAttachment(row.id)) db.insertAttachment(row)
      for (const note of incoming) {
        db.insertImportedNote({ ...note, content: remapAttachments(note.content, attachmentIdMap) })
      }

      const addedLive = new Set(incoming.filter((n) => n.deletedAt === null).map((n) => n.id))
      const backupLayout = normalizeLayout(reader.layout, reader.notes.filter((n) => n.deletedAt === null).map((n) => n.id), newRowId)
      const mapped: BoardLayout = {
        rows: backupLayout.rows
          .map((row) => ({ id: newRowId(), notes: row.notes.map((id) => noteIdMap.get(id) ?? id).filter((id) => addedLive.has(id)) }))
          .filter((row) => row.notes.length > 0)
      }
      const incomingIds = new Set(incoming.map((n) => n.id))
      if (mode === 'replace') {
        db.replaceLayout(mapped)
        db.importPins(reader.pins)
        if (reader.preferences !== undefined) library.setPreferences(reader.preferences)
      } else {
        const current = db.getLayout([...addedLive])
        db.replaceLayout({ rows: [...current.rows, ...mapped.rows] })
        const addedPins = reader.pins.map((id) => noteIdMap.get(id) ?? id).filter((id) => incomingIds.has(id))
        db.importPins([...db.getAllPins(), ...addedPins])
      }
    })

    // 5. After a restore, drop image files the restored collection no longer uses.
    for (const old of oldAttachments) if (!keepIds.has(old.id)) attachments.remove(old)
    result.added = incoming.length - result.copied
    return result
  } catch (error) {
    // The transaction rolled back; remove image files written for it that nothing references.
    for (const row of writtenRows) if (!db.getAttachment(row.id)) attachments.remove(row)
    throw error
  }
}

export interface InspectSummary {
  fileName: string
  createdAt: number
  appVersion: string
  noteCount: number
  trashedCount: number
  attachmentCount: number
  pinCount: number
  missingAttachments: number
  overlappingNotes: number
  warnings: string[]
  currentNoteCount: number
}

export function summarize(library: Library, reader: BackupReader): InspectSummary {
  const live = reader.notes.filter((n) => n.deletedAt === null)
  const missing = reader.missingAttachmentIds().length
  const warnings = [...reader.warnings]
  if (missing > 0) warnings.push(`${missing} ${missing === 1 ? 'image is' : 'images are'} referenced by notes but missing from the backup. Those notes will import with an empty image placeholder.`)
  return {
    fileName: basename(reader.filePath),
    createdAt: reader.manifest.createdAt,
    appVersion: reader.manifest.appVersion,
    noteCount: live.length,
    trashedCount: reader.notes.length - live.length,
    attachmentCount: reader.manifest.attachments.length,
    pinCount: reader.pins.filter((id) => live.some((n) => n.id === id)).length,
    missingAttachments: missing,
    overlappingNotes: reader.notes.filter((n) => library.db.getNote(n.id) !== null).length,
    warnings,
    currentNoteCount: library.db.countLive()
  }
}
