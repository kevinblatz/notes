/**
 * Managed image files. Every screenshot a note uses is copied into the app's own
 * attachments folder, so notes keep their images when the original file moves or is deleted.
 * The full-resolution original is always kept; a smaller preview sits beside it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachmentRow } from './db'

export const MAX_IMAGE_BYTES = 40 * 1024 * 1024
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024

export interface ImageKind {
  mime: string
  ext: string
}

/** Identify an image by its leading bytes. The file name and any declared type are ignored. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mime: 'image/png', ext: '.png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return { mime: 'image/gif', ext: '.gif' }
  return null
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]!)
  return out
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class AttachmentError extends Error {}

export interface StoreImageInput {
  bytes: Uint8Array
  name: string | null
  width: number | null
  height: number | null
  preview: { bytes: Uint8Array; width: number; height: number } | null
  /** Reuse a specific ID (backup import). */
  id?: string
  createdAt?: number
}

export class AttachmentStore {
  constructor(public readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  /** Write the original (and preview, if given) and return the record to insert. */
  store(input: StoreImageInput): AttachmentRow {
    if (input.bytes.byteLength === 0) throw new AttachmentError('The image is empty.')
    if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new AttachmentError(`The image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`)
    }
    const kind = sniffImage(input.bytes)
    if (!kind) throw new AttachmentError('Only PNG, JPEG, WebP and GIF images can be added.')

    const id = input.id ?? randomUUID()
    const fileName = `${id}${kind.ext}`
    this.writeAtomic(fileName, input.bytes)

    let previewName: string | null = null
    if (input.preview && input.preview.bytes.byteLength > 0 && input.preview.bytes.byteLength <= MAX_PREVIEW_BYTES) {
      const previewKind = sniffImage(input.preview.bytes)
      if (previewKind) {
        previewName = `${id}.preview${previewKind.ext}`
        this.writeAtomic(previewName, input.preview.bytes)
      }
    }

    return {
      id,
      fileName,
      previewName,
      originalName: cleanName(input.name),
      mime: kind.mime,
      byteSize: input.bytes.byteLength,
      width: positiveInt(input.width),
      height: positiveInt(input.height),
      sha256: sha256Hex(input.bytes),
      createdAt: input.createdAt ?? Date.now()
    }
  }

  private writeAtomic(fileName: string, bytes: Uint8Array): void {
    const target = join(this.dir, fileName)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, bytes)
    renameSync(temp, target)
  }

  /** Absolute path of a stored file. `fileName` always comes from a database row, never from user input. */
  pathOf(fileName: string): string {
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) throw new AttachmentError('Invalid attachment file name.')
    return join(this.dir, fileName)
  }

  originalPath(row: AttachmentRow): string {
    return this.pathOf(row.fileName)
  }

  /** The preview if one exists on disk, otherwise the original. */
  previewPath(row: AttachmentRow): string {
    if (row.previewName) {
      const preview = this.pathOf(row.previewName)
      if (existsSync(preview)) return preview
    }
    return this.pathOf(row.fileName)
  }

  hasOriginal(row: AttachmentRow): boolean {
    return existsSync(this.pathOf(row.fileName))
  }

  remove(row: AttachmentRow): void {
    rmSync(this.pathOf(row.fileName), { force: true })
    if (row.previewName) rmSync(this.pathOf(row.previewName), { force: true })
  }

  /** Delete leftovers of writes that were interrupted (crash or power loss mid-copy). */
  sweepTempFiles(): number {
    let removed = 0
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.tmp')) continue
      try {
        // Leave very fresh temp files alone in case another write is in progress.
        if (Date.now() - statSync(join(this.dir, name)).mtimeMs < 60_000) continue
        rmSync(join(this.dir, name), { force: true })
        removed++
      } catch {
        // Ignore: a file we cannot remove now will be retried next start.
      }
    }
    return removed
  }
}

function cleanName(name: string | null): string | null {
  if (typeof name !== 'string') return null
  const base = name.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200)
  return base.length > 0 ? base : null
}

function positiveInt(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100000 ? Math.round(value) : null
}
