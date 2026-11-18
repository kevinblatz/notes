import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isNoteEmpty } from '@shared/content'
import { searchNotes } from '@shared/search'
import type { RichDoc } from '@shared/types'
import { BackupReader, exportBackup, importBackup } from '../../src/main/store/backup'
import { Library } from '../../src/main/store/library'
import { cleanupTempDirs, makePng, tempDir } from './helpers'

afterEach(cleanupTempDirs)

const DRAWING = makePng(12, 8, [37, 38, 42])

/** A note holding a drawing from the drawing space, with a caption, between two lines of text. */
function drawingNote(attachmentId: string): RichDoc {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Plan for the open' }] },
      { type: 'noteImage', attrs: { attachmentId, width: 62, caption: 'Sweep then retest', naturalWidth: 12, naturalHeight: 8, drawing: 1.5 } },
      { type: 'paragraph', content: [{ type: 'text', text: 'After the drawing' }] }
    ]
  }
}

describe('a drawing in a note', () => {
  it('is stored, searched, kept when it is all the note holds, and carried by backup and import', async () => {
    const source = new Library(tempDir())
    const image = source.importImage({ bytes: DRAWING, name: 'Drawing.png', width: 12, height: 8, preview: null })
    const { note } = source.createNote({ id: 'note-00000001', title: null, content: drawingNote(image.id), tags: [], placement: { kind: 'row', index: 0 } })
    expect(note.content).toEqual(drawingNote(image.id))
    expect(note.captions).toBe('Sweep then retest')

    // Search works on the text and caption as for any image.
    expect(searchNotes([note], 'retest').map((hit) => hit.id)).toEqual(['note-00000001'])
    // A note that holds only a drawing is not empty.
    expect(isNoteEmpty({ title: null, content: { type: 'doc', content: [drawingNote(image.id).content![1]!] } })).toBe(false)

    const file = join(tempDir(), 'drawing.tnbackup')
    await exportBackup(source, file, '0.0.0-test')
    const target = new Library(tempDir())
    const reader = await BackupReader.open(file)
    const result = await importBackup(target, reader, 'replace', { appVersion: '0.0.0-test' })
    reader.close()
    expect(result).toMatchObject({ ok: true, attachmentsImported: 1, missingAttachments: 0 })
    const restored = target.listLive()[0]!
    expect(restored.content).toEqual(drawingNote(image.id))
    expect(readFileSync(target.attachments.originalPath(target.getAttachment(image.id)!)).equals(DRAWING)).toBe(true)
  })
})
