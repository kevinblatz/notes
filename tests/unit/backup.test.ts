import { afterEach, describe, expect, it } from 'vitest'
import { createWriteStream, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import { flattenOrder } from '@shared/layout'
import { BACKUP_FORMAT, BackupError, BackupReader, exportBackup, importBackup, summarize } from '../../src/main/store/backup'
import { Library } from '../../src/main/store/library'
import { sha256Hex } from '../../src/main/store/attachments'
import { cleanupTempDirs, makePng, richDoc, tempDir, text } from './helpers'

afterEach(cleanupTempDirs)

const id = (n: number): string => `note-${String(n).padStart(8, '0')}`
const atEnd = { kind: 'row' as const, index: 9999 }
const APP = { appVersion: '0.0.0-test' }
const RED = makePng(8, 6, [200, 30, 30])
const GREEN = makePng(4, 4, [30, 200, 30])

/** A collection with formatting, two screenshots, a pair, pins, a trashed note and changed preferences. */
function seed(dir: string): { lib: Library; imageA: string; imageB: string } {
  const lib = new Library(dir)
  const a = lib.importImage({ bytes: RED, name: 'entry.png', width: 8, height: 6, preview: { bytes: makePng(4, 3, [200, 30, 30]), width: 4, height: 3 } })
  const b = lib.importImage({ bytes: GREEN, name: 'exit.png', width: 4, height: 4, preview: null })
  lib.createNote({ id: id(1), title: 'Session plan', content: richDoc(a.id, b.id), tags: ['Rules', 'Setups'], placement: atEnd })
  lib.createNote({ id: id(2), title: null, content: text('second note'), tags: [], placement: atEnd })
  lib.createNote({ id: id(3), title: null, content: text('third note'), tags: ['Journal'], placement: atEnd })
  lib.createNote({ id: id(4), title: null, content: text('in the trash'), tags: [], placement: atEnd })
  const rows = lib.db.getLayout().rows
  lib.saveLayout({ rows: [{ id: rows[2]!.id, notes: [id(3), id(2)] }, rows[0], rows[3]] })
  lib.setPins([id(3), id(1)])
  lib.trashNote(id(4))
  lib.setPreferences({ fontSize: 19, theme: 'midnight', dockSide: 'left' })
  return { lib, imageA: a.id, imageB: b.id }
}

async function writeZip(path: string, files: Record<string, Buffer | string>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [name, body] of Object.entries(files)) zip.addBuffer(Buffer.isBuffer(body) ? body : Buffer.from(body), name)
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(path))
}

describe('backup round trip', () => {
  it('restores notes, formatting, images, layout, pins, trash and preferences into an empty collection', async () => {
    const { lib: source, imageA, imageB } = seed(tempDir())
    const file = join(tempDir(), 'my.tnbackup')
    const summary = await exportBackup(source, file, APP.appVersion)
    expect(summary).toMatchObject({ noteCount: 3, attachmentCount: 2, missingFiles: 0 })
    expect(existsSync(`${file}.partial`)).toBe(false)

    const target = new Library(tempDir())
    const reader = await BackupReader.open(file)
    expect(summarize(target, reader)).toMatchObject({ noteCount: 3, trashedCount: 1, attachmentCount: 2, pinCount: 2, missingAttachments: 0, overlappingNotes: 0, warnings: [] })
    const result = await importBackup(target, reader, 'replace', APP)
    reader.close()
    expect(result).toMatchObject({ ok: true, added: 4, attachmentsImported: 2, missingAttachments: 0, safetyBackupPath: null })

    // Formatting survives byte for byte.
    const strip = (lib: Library): unknown => lib.listLive().map(({ updatedAt: _u, ...rest }) => rest).sort((x, y) => x.id.localeCompare(y.id))
    expect(strip(target)).toEqual(strip(source))
    expect(target.listLive().find((n) => n.id === id(1))!.content).toEqual(richDoc(imageA, imageB))

    // Layout, pins, trash, preferences.
    expect(target.db.getLayout().rows.map((r) => r.notes)).toEqual([[id(3), id(2)], [id(1)]])
    expect(target.db.getPins()).toEqual([id(3), id(1)])
    expect(target.listTrash().map((t) => t.id)).toEqual([id(4)])
    expect(target.getPreferences()).toMatchObject({ fontSize: 19, theme: 'midnight', dockSide: 'left' })

    // Images: full-resolution originals and previews are present and identical.
    for (const [attachmentId, bytes] of [[imageA, RED], [imageB, GREEN]] as const) {
      const row = target.getAttachment(attachmentId)!
      expect(readFileSync(target.attachments.originalPath(row)).equals(bytes)).toBe(true)
      expect(row.sha256).toBe(sha256Hex(bytes))
    }
    expect(target.getAttachment(imageA)!.previewName).not.toBeNull()
    expect(existsSync(target.attachments.previewPath(target.getAttachment(imageA)!))).toBe(true)

    // Restoring a trashed note from the backup puts it back on the board.
    expect(target.restoreNote(id(4))!.layout.rows.map((r) => r.notes)).toEqual([[id(3), id(2)], [id(1)], [id(4)]])
    source.close()
    target.close()
  })

  it('replace writes a safety backup first and removes images the restored collection does not use', async () => {
    const { lib: source } = seed(tempDir())
    const file = join(tempDir(), 'b.tnbackup')
    await exportBackup(source, file, APP.appVersion)

    const target = new Library(tempDir())
    const blue = makePng(5, 5, [30, 30, 200])
    const old = target.importImage({ bytes: blue, name: null, width: 5, height: 5, preview: null })
    target.createNote({ id: id(50), title: 'Existing note', content: { type: 'doc', content: [{ type: 'noteImage', attrs: { attachmentId: old.id } }] }, tags: [], placement: atEnd })
    const oldPath = target.attachments.originalPath(target.getAttachment(old.id)!)

    const reader = await BackupReader.open(file)
    const result = await importBackup(target, reader, 'replace', APP)
    reader.close()

    expect(target.listLive().map((n) => n.id).sort()).toEqual([id(1), id(2), id(3)])
    expect(existsSync(oldPath)).toBe(false)
    expect(result.safetyBackupPath).toBeTruthy()

    // The safety backup really contains what was replaced, image included.
    const safety = await BackupReader.open(result.safetyBackupPath!)
    expect(safety.notes.map((n) => n.title)).toEqual(['Existing note'])
    expect((await safety.readAttachment(old.id))!.bytes.equals(blue)).toBe(true)
    safety.close()
    source.close()
    target.close()
  })

  it('merge adds without changing or overwriting anything that exists', async () => {
    const { lib: source } = seed(tempDir())
    const file = join(tempDir(), 'b.tnbackup')
    await exportBackup(source, file, APP.appVersion)

    const target = new Library(tempDir())
    target.setPreferences({ fontSize: 15 })
    target.createNote({ id: id(60), title: null, content: text('mine, untouched'), tags: [], placement: atEnd })
    // Same ID as a backup note but different writing: both versions must survive.
    target.createNote({ id: id(2), title: null, content: text('my newer version of the second note'), tags: [], placement: atEnd })
    // Same ID and same writing: skipped.
    target.createNote({ id: id(3), title: null, content: text('third note'), tags: ['Journal'], placement: atEnd })
    target.setPins([id(60)])

    const reader = await BackupReader.open(file)
    expect(summarize(target, reader)).toMatchObject({ overlappingNotes: 2, currentNoteCount: 3 })
    const result = await importBackup(target, reader, 'merge', APP)
    reader.close()
    expect(result).toMatchObject({ added: 2, skipped: 1, copied: 1, attachmentsImported: 2, safetyBackupPath: null })

    const live = target.listLive()
    expect(live).toHaveLength(5)
    expect(live.find((n) => n.id === id(60))!.plainText).toBe('mine, untouched')
    expect(live.find((n) => n.id === id(2))!.plainText).toBe('my newer version of the second note')
    const copy = live.find((n) => n.plainText === 'second note')!
    expect(copy.id).not.toBe(id(2))

    // Existing rows first, in their order; imported notes appended in the backup's order.
    const order = flattenOrder(target.db.getLayout())
    expect(order.slice(0, 3)).toEqual([id(60), id(2), id(3)])
    expect(order.slice(3)).toEqual([copy.id, id(1)])
    expect(target.db.getPins()).toEqual([id(60), id(1)])
    expect(target.getPreferences().fontSize).toBe(15)
    expect(target.listTrash().map((t) => t.id)).toEqual([id(4)])

    // Importing the same backup again adds nothing new except another copy of the differing note.
    const again = await BackupReader.open(file)
    const second = await importBackup(target, again, 'merge', APP)
    again.close()
    expect(second).toMatchObject({ added: 0, skipped: 3, copied: 1, attachmentsImported: 0 })
    source.close()
    target.close()
  })

  it('reports images that are missing from the archive and still imports the words', async () => {
    const dir = tempDir()
    const { lib: source, imageB } = seed(dir)
    rmSync(source.attachments.originalPath(source.getAttachment(imageB)!))
    const file = join(tempDir(), 'b.tnbackup')
    expect((await exportBackup(source, file, APP.appVersion)).missingFiles).toBe(1)

    const target = new Library(tempDir())
    const reader = await BackupReader.open(file)
    const summary = summarize(target, reader)
    expect(summary.missingAttachments).toBe(1)
    expect(summary.warnings.join(' ')).toMatch(/1 image is referenced by notes but missing/)
    const result = await importBackup(target, reader, 'merge', APP)
    reader.close()
    expect(result).toMatchObject({ attachmentsImported: 1, missingAttachments: 1 })
    expect(target.listLive().find((n) => n.id === id(1))!.plainText).toContain('Text below the screenshots.')
    source.close()
    target.close()
  })
})

describe('import validation', () => {
  const manifest = (over: object = {}): string =>
    JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 1, schemaVersion: 1, appVersion: '0', createdAt: 1, counts: {}, attachments: [], ...over })
  const data = (over: object = {}): string => JSON.stringify({ notes: [], layout: { rows: [] }, pins: [], ...over })

  it('rejects files that are not backups', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.tnbackup'), 'definitely not a zip')
    await expect(BackupReader.open(join(dir, 'a.tnbackup'))).rejects.toThrow(BackupError)
    await writeZip(join(dir, 'b.tnbackup'), { 'readme.txt': 'hi' })
    await expect(BackupReader.open(join(dir, 'b.tnbackup'))).rejects.toThrow(/not a Trading Notes backup/)
    await writeZip(join(dir, 'c.tnbackup'), { 'manifest.json': '{nope', 'data.json': data() })
    await expect(BackupReader.open(join(dir, 'c.tnbackup'))).rejects.toThrow(/not valid JSON/)
    await writeZip(join(dir, 'd.tnbackup'), { 'manifest.json': JSON.stringify({ format: 'other' }), 'data.json': data() })
    await expect(BackupReader.open(join(dir, 'd.tnbackup'))).rejects.toThrow(/not a Trading Notes backup/)
    await writeZip(join(dir, 'e.tnbackup'), { 'manifest.json': manifest({ formatVersion: 99 }), 'data.json': data() })
    await expect(BackupReader.open(join(dir, 'e.tnbackup'))).rejects.toThrow(/newer than this app understands/)
  })

  it('rejects attachment paths that try to leave the archive', async () => {
    const dir = tempDir()
    for (const file of ['../../evil.png', '/etc/passwd', 'attachments/../../evil.png', 'C:\\evil.png', 'attachments/sub/dir.png']) {
      const attachment = { id: 'aaaaaaaa-0000', file, preview: null, mime: 'image/png', byteSize: 1, sha256: 'a'.repeat(64), createdAt: 1 }
      await writeZip(join(dir, 'x.tnbackup'), { 'manifest.json': manifest({ attachments: [attachment] }), 'data.json': data() })
      await expect(BackupReader.open(join(dir, 'x.tnbackup')), file).rejects.toThrow(/manifest is not valid/)
    }
  })

  it('skips damaged or disguised images, unreadable notes and unsafe content', async () => {
    const dir = tempDir()
    const good = makePng(3, 3, [9, 9, 9])
    const attachments = [
      { id: 'good-0000001', file: 'attachments/good.png', preview: null, mime: 'image/png', byteSize: good.length, sha256: sha256Hex(good), createdAt: 1 },
      { id: 'tampered-001', file: 'attachments/tampered.png', preview: null, mime: 'image/png', byteSize: good.length, sha256: 'b'.repeat(64), createdAt: 1 },
      { id: 'notimage-001', file: 'attachments/script.png', preview: null, mime: 'image/png', byteSize: 5, sha256: sha256Hex(Buffer.from('<svg>')), createdAt: 1 }
    ]
    const img = (attachmentId: string): object => ({ type: 'noteImage', attrs: { attachmentId } })
    const notes = [
      { id: 'note-ok-0001', createdAt: 1, updatedAt: 1, content: { type: 'doc', content: [img('good-0000001'), img('tampered-001'), img('notimage-001'), img('absent-00001')] } },
      { id: 'note-xss-001', createdAt: 1, updatedAt: 1, title: 'x', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] } },
      { id: 'bad id!', createdAt: 1, updatedAt: 1, content: { type: 'doc' } },
      { id: 'note-bad-0001', createdAt: 1, updatedAt: 1, content: 'not a doc' },
      'garbage'
    ]
    const file = join(dir, 'x.tnbackup')
    await writeZip(file, {
      'manifest.json': manifest({ attachments }),
      'data.json': data({ notes, layout: { rows: [{ id: 'r', notes: ['note-ok-0001', 'ghost', 'note-xss-001'] }] }, pins: ['ghost', 'note-xss-001'], preferences: { theme: 'neon', fontSize: 21 } }),
      'attachments/good.png': good,
      'attachments/tampered.png': good,
      'attachments/script.png': Buffer.from('<svg>')
    })

    const target = new Library(tempDir())
    const reader = await BackupReader.open(file)
    const summary = summarize(target, reader)
    expect(summary.noteCount).toBe(2)
    expect(summary.warnings.join(' ')).toMatch(/3 notes in the backup could not be read/)
    const result = await importBackup(target, reader, 'replace', APP)
    reader.close()
    expect(result).toMatchObject({ added: 2, attachmentsImported: 1, missingAttachments: 3 })
    expect(JSON.stringify(target.listLive())).not.toContain('javascript')
    expect(readdirSync(target.attachments.dir)).toEqual(['good-0000001.png'])
    expect(target.db.getLayout().rows.map((r) => r.notes)).toEqual([['note-ok-0001', 'note-xss-001']])
    expect(target.db.getPins()).toEqual(['note-xss-001'])
    expect(target.getPreferences()).toMatchObject({ theme: 'charcoal', fontSize: 21 })
    target.close()
  })
})
