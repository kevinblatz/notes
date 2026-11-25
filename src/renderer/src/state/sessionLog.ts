/**
 * Adding to today's session log. The open editor and its saver are the source of truth for
 * the note they show: when the log is open, entries go in through the editor. Otherwise they
 * are saved through the ordinary save path, naming the revision they are based on; a stale
 * save is retried on top of the stored note, so nothing written elsewhere is lost.
 */
import { appendLogBlocks } from '@shared/sessionLog'
import type { Note, RichNode } from '@shared/types'
import { api } from '../lib/api'
import { captureBoardPositions } from '../lib/flip'
import { editorFor, openNote, returnToBoard } from './actions'
import { getState, setState } from './store'

/** Fetch (or create) the log for the day of `at`, and bring the board up to date with it. */
export async function ensureSessionLog(at: number): Promise<Note> {
  const result = await api.ensureSessionLog(at)
  const { note } = result
  if (result.created) captureBoardPositions()
  setState((s) => {
    const known = s.notes[note.id]
    const newer = known && known.revision > note.revision ? known : note
    return { notes: { ...s.notes, [note.id]: newer }, layout: result.created ? result.layout : s.layout }
  })
  return note
}

let chain: Promise<unknown> = Promise.resolve()

/** Add entries to the log for the day of `at`. Appends run one after another, in order. */
export function appendToSessionLog(at: number, blocks: RichNode[]): Promise<Note> {
  const run = chain.then(() => appendNow(at, blocks))
  chain = run.catch(() => undefined)
  return run
}

async function appendNow(at: number, blocks: RichNode[]): Promise<Note> {
  // A log moved to Trash meanwhile makes the save report it missing: a new one is made.
  for (let attempt = 0; attempt < 3; attempt++) {
    let note = await ensureSessionLog(at)
    const open = editorFor(note.id)
    if (open) {
      open.appendBlocks(blocks)
      return note
    }
    for (let tries = 0; tries < 4; tries++) {
      const result = await api.saveNote({ id: note.id, expectedRevision: note.revision, content: appendLogBlocks(note.content, blocks) })
      if (result.ok) {
        const saved = result.note
        setState((s) => ({ notes: { ...s.notes, [saved.id]: saved } }))
        // Opened in the editor while this was being written, from the note as it was before:
        // the editor would save over the entry, so it gets the entry too.
        const late = editorFor(saved.id)
        if (late && late.openedAt < saved.revision) late.appendBlocks(blocks)
        return saved
      }
      if (result.reason !== 'stale') break
      note = result.current
    }
  }
  throw new Error('Today’s session log could not be written.')
}

/** Open today's log in the editor with the caret at the end. */
export async function openSessionLog(at: number): Promise<void> {
  const note = await ensureSessionLog(at)
  const open = editorFor(note.id)
  if (open) {
    setState({ panel: null, gearOpen: false, preview: null })
    open.focusEnd()
    return
  }
  if (getState().view.mode === 'note') {
    const left = await returnToBoard()
    if (!left) return
  }
  setState({ preview: null })
  openNote(note.id)
}
