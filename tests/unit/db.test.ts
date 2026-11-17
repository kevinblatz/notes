import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { flattenOrder } from '@shared/layout'
import { NotesDb, SCHEMA_VERSION, SchemaTooNewError } from '../../src/main/store/db'
import { Library } from '../../src/main/store/library'
import { sniffImage } from '../../src/main/store/attachments'
import { cleanupTempDirs, makePng, richDoc, tempDir, text } from './helpers'

afterEach(cleanupTempDirs)

const id = (n: number): string => `note-${String(n).padStart(8, '0')}`
const atEnd = { kind: 'row' as const, index: 9999 }

describe('NotesDb', () => {
  it('creates, saves and reloads a note across a restart', () => {
    const dir = tempDir()
    let lib = new Library(dir)
    const created = lib.createNote({ id: id(1), title: null, content: text('first'), tags: [], placement: atEnd })
    expect(created.note.revision).toBe(1)
    expect(created.layout.rows.map((r) => r.notes)).toEqual([[id(1)]])

    const saved = lib.saveNote({ id: id(1), expectedRevision: 1, content: text('first\nsecond'), title: 'Plan', tags: ['Rules'] })
    expect(saved.ok && saved.note.revision).toBe(2)
    lib.close()

    lib = new Library(dir)
    const [note] = lib.listLive()
    expect(note).toMatchObject({ id: id(1), title: 'Plan', plainText: 'first\nsecond', tags: ['Rules'], revision: 2 })
    expect(lib.db.schemaVersion()).toBe(SCHEMA_VERSION)
    lib.close()
  })

  it('rejects a stale save so older typing cannot overwrite newer typing', () => {
    const lib = new Library(tempDir())
    lib.createNote({ id: id(1), title: null, content: text('v1'), tags: [], placement: atEnd })
    expect(lib.saveNote({ id: id(1), expectedRevision: 1, content: text('v2 newer') }).ok).toBe(true)
    const stale = lib.saveNote({ id: id(1), expectedRevision: 1, content: text('v1 older, arrived late') })
    expect(stale).toMatchObject({ ok: false, reason: 'stale' })
    expect(lib.listLive()[0]!.plainText).toBe('v2 newer')
    expect(lib.saveNote({ id: id(99), expectedRevision: 1, content: text('x') })).toEqual({ ok: false, reason: 'missing' })
    lib.close()
  })

  it('does not count collapsing as an edit', () => {
    let clock = 1000
    const db = new NotesDb(join(tempDir(), 'n.db'), { now: () => clock })
    db.createNote({ id: id(1), title: null, content: text('a'), tags: [], placement: atEnd })
    clock = 5000
    const result = db.saveNote({ id: id(1), expectedRevision: 1, collapsed: true })
    expect(result.ok && result.note).toMatchObject({ collapsed: true, updatedAt: 1000, revision: 2 })
    db.close()
  })

  it('sanitises content on the way in', () => {
    const lib = new Library(tempDir())
    lib.createNote({
      id: id(1),
      title: null,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
      tags: [],
      placement: atEnd
    })
    expect(JSON.stringify(lib.listLive()[0]!.content)).not.toContain('javascript')
    expect(() => lib.createNote({ id: '../bad', title: null, content: text('x'), tags: [], placement: atEnd })).toThrow()
    expect(() => lib.createNote({ id: id(1), title: null, content: text('dup'), tags: [], placement: atEnd })).toThrow()
    lib.close()
  })

  it('places new notes at the requested insertion point and keeps layout through saves', () => {
    const lib = new Library(tempDir())
    for (const n of [1, 2, 3]) lib.createNote({ id: id(n), title: null, content: text(`n${n}`), tags: [], placement: atEnd })
    const rows = lib.db.getLayout().rows
    lib.createNote({ id: id(4), title: null, content: text('beside 2'), tags: [], placement: { kind: 'slot', rowId: rows[1]!.id, index: 1 } })
    lib.createNote({ id: id(5), title: null, content: text('between'), tags: [], placement: { kind: 'row', index: 1 } })
    const shape = (): string[][] => lib.db.getLayout().rows.map((r) => r.notes)
    expect(shape()).toEqual([[id(1)], [id(5)], [id(2), id(4)], [id(3)]])
    lib.saveNote({ id: id(2), expectedRevision: 1, content: text('edited') })
    expect(shape()).toEqual([[id(1)], [id(5)], [id(2), id(4)], [id(3)]])
    lib.close()
  })

  it('never lets a layout save drop a live note', () => {
    const lib = new Library(tempDir())
    for (const n of [1, 2, 3]) lib.createNote({ id: id(n), title: null, content: text(`n${n}`), tags: [], placement: atEnd })
    const saved = lib.saveLayout({ rows: [{ id: 'x', notes: [id(3), 'ghost', id(3)] }] })
    expect(flattenOrder(saved).sort()).toEqual([id(1), id(2), id(3)])
    expect(lib.saveLayout('garbage').rows).toHaveLength(3)
    lib.close()
  })

  it('trashes and restores a note to its old position, keeping its pin', () => {
    const lib = new Library(tempDir())
    for (const n of [1, 2, 3]) lib.createNote({ id: id(n), title: null, content: text(`n${n}`), tags: [], placement: atEnd })
    const rows = lib.db.getLayout().rows
    lib.saveLayout({ rows: [rows[0], { id: rows[1]!.id, notes: [id(2), id(3)] }] })
    lib.setPins([id(3), id(1)])

    const afterTrash = lib.trashNote(id(3))
    expect(afterTrash.layout.rows.map((r) => r.notes)).toEqual([[id(1)], [id(2)]])
    expect(afterTrash.pins).toEqual([id(1)])
    expect(afterTrash.trashCount).toBe(1)
    expect(lib.listLive().map((n) => n.id)).toEqual([id(1), id(2)])
    expect(lib.listTrash()[0]).toMatchObject({ id: id(3), label: 'n3' })

    const restored = lib.restoreNote(id(3))!
    expect(restored.layout.rows.map((r) => r.notes)).toEqual([[id(1)], [id(2), id(3)]])
    expect(restored.pins).toEqual([id(3), id(1)])
    expect(restored.trashCount).toBe(0)
    expect(lib.restoreNote(id(3))).toBeNull()
    lib.close()
  })

  it('only discards a note that is genuinely empty', () => {
    const lib = new Library(tempDir())
    const png = lib.importImage({ bytes: makePng(4, 4, [10, 20, 30]), name: 'a.png', width: 4, height: 4, preview: null })
    lib.createNote({ id: id(1), title: null, content: text('words'), tags: [], placement: atEnd })
    lib.createNote({ id: id(2), title: null, content: text('   '), tags: [], placement: atEnd })
    lib.createNote({ id: id(3), title: null, content: { type: 'doc', content: [{ type: 'noteImage', attrs: { attachmentId: png.id } }] }, tags: [], placement: atEnd })
    expect(lib.discardEmptyNote(id(1)).discarded).toBe(false)
    expect(lib.discardEmptyNote(id(3)).discarded).toBe(false)
    expect(lib.discardEmptyNote(id(2)).discarded).toBe(true)
    expect(lib.listLive().map((n) => n.id)).toEqual([id(1), id(3)])
    expect(lib.db.getLayout().rows.map((r) => r.notes)).toEqual([[id(1)], [id(3)]])
    lib.close()
  })

  it('stores images as managed files and removes them only when nothing uses them', () => {
    const dir = tempDir()
    const lib = new Library(dir)
    const a = lib.importImage({ bytes: makePng(8, 6, [200, 30, 30]), name: 'C:\\Users\\me\\Desktop\\shot.png', width: 8, height: 6, preview: { bytes: makePng(4, 3, [200, 30, 30]), width: 4, height: 3 } })
    const b = lib.importImage({ bytes: makePng(4, 4, [30, 200, 30]), name: null, width: 4, height: 4, preview: null })
    expect(a).toMatchObject({ mime: 'image/png', originalName: 'shot.png', hasPreview: true, width: 8, height: 6 })
    const rowA = lib.getAttachment(a.id)!
    expect(readFileSync(lib.attachments.originalPath(rowA)).equals(makePng(8, 6, [200, 30, 30]))).toBe(true)
    expect(lib.attachments.previewPath(rowA)).toContain('.preview.png')

    lib.createNote({ id: id(1), title: null, content: richDoc(a.id, b.id), tags: [], placement: atEnd })
    lib.createNote({ id: id(2), title: null, content: { type: 'doc', content: [{ type: 'noteImage', attrs: { attachmentId: a.id } }] }, tags: [], placement: atEnd })

    lib.trashNote(id(1))
    lib.purge([id(1)])
    expect(lib.getAttachment(b.id)).toBeNull()
    expect(existsSync(join(dir, 'attachments', `${b.id}.png`))).toBe(false)
    // Image A is still used by the second note.
    expect(lib.getAttachment(a.id)).not.toBeNull()
    expect(existsSync(lib.attachments.originalPath(rowA))).toBe(true)

    // Purge refuses notes that are not in Trash.
    lib.purge([id(2)])
    expect(lib.listLive().map((n) => n.id)).toEqual([id(2)])

    // Startup housekeeping removes images no note refers to, and nothing else.
    const orphan = lib.importImage({ bytes: makePng(2, 2, [1, 2, 3]), name: null, width: 2, height: 2, preview: null })
    expect(lib.collectGarbage().removed).toBe(1)
    expect(lib.getAttachment(orphan.id)).toBeNull()
    expect(lib.getAttachment(a.id)).not.toBeNull()
    lib.close()
  })

  it('rejects files that are not images', () => {
    const lib = new Library(tempDir())
    expect(() => lib.importImage({ bytes: Buffer.from('<svg onload=alert(1)>'), name: 'x.png', width: 1, height: 1, preview: null })).toThrow(/PNG, JPEG, WebP and GIF/)
    expect(() => lib.importImage({ bytes: new Uint8Array(), name: null, width: null, height: null, preview: null })).toThrow(/empty/)
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime).toBe('image/webp')
    expect(readdirSync(lib.attachments.dir)).toEqual([])
    lib.close()
  })

  it('keeps preferences, window state and session across restarts', () => {
    const dir = tempDir()
    let lib = new Library(dir)
    expect(lib.getPreferences().shortcut).toBe('Control+Shift+Space')
    expect(lib.getSession()).toEqual({ openNoteId: null, cleanExit: true })
    lib.setPreferences({ dockSide: 'left', fontSize: 19, theme: 'neon' })
    lib.setWindowState({ dock: 'custom', bounds: { x: 1, y: 2, width: 700, height: 800 }, displayId: 5, displayBounds: null })
    lib.setSession({ openNoteId: id(7), cleanExit: false })
    lib.close()
    lib = new Library(dir)
    expect(lib.getPreferences()).toMatchObject({ dockSide: 'left', fontSize: 19, theme: 'charcoal' })
    expect(lib.getWindowState()).toEqual({ dock: 'custom', bounds: { x: 1, y: 2, width: 700, height: 800 }, displayId: 5, displayBounds: null })
    expect(lib.getSession()).toEqual({ openNoteId: id(7), cleanExit: false })
    lib.close()
  })

  it('refuses to open a database from a newer version instead of damaging it', () => {
    const dir = tempDir()
    const file = join(dir, 'notes.db')
    new NotesDb(file).close()
    const raw = new DatabaseSync(file)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`)
    raw.close()
    expect(() => new NotesDb(file)).toThrow(SchemaTooNewError)
  })

  it('still loads a note whose stored JSON is damaged', () => {
    const dir = tempDir()
    const file = join(dir, 'notes.db')
    const db = new NotesDb(file)
    db.createNote({ id: id(1), title: null, content: text('line one'), tags: [], placement: atEnd })
    db.close()
    const raw = new DatabaseSync(file)
    raw.exec(`UPDATE notes SET content_json = '{broken'`)
    raw.close()
    const reopened = new NotesDb(file)
    expect(reopened.listLive()[0]!.plainText).toBe('line one')
    expect(reopened.listLive()[0]!.content.content?.[0]?.content?.[0]?.text).toBe('line one')
    reopened.close()
  })

  it('handles a few hundred notes quickly', () => {
    const lib = new Library(tempDir())
    const started = performance.now()
    lib.db.transaction(() => {
      for (let n = 0; n < 400; n++) lib.createNote({ id: id(n), title: n % 3 ? null : `Title ${n}`, content: text(`note ${n} `.repeat(40)), tags: [], placement: atEnd })
    })
    const layout = lib.db.getLayout()
    const reversed = { rows: [...layout.rows].reverse() }
    expect(lib.saveLayout(reversed).rows[0]!.notes).toEqual([id(399)])
    expect(lib.listLive()).toHaveLength(400)
    expect(performance.now() - started).toBeLessThan(8000)
    writeFileSync(join(lib.dataDir, 'marker'), '')
    lib.close()
  })
})
