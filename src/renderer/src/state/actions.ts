/**
 * Everything the interface can do, in one place. Components call these; they never talk to
 * the main process directly.
 */
import { isNoteEmpty, noteLabel, setTaskChecked } from '@shared/content'
import { anchorOf, describePosition, findNote, keyboardMove, layoutsEqual, moveNote, placeByAnchor, type MoveDirection } from '@shared/layout'
import type { BoardLayout, Note, Placement, Preferences } from '@shared/types'
import { api } from '../lib/api'
import { captureBoardPositions } from '../lib/flip'
import { newId } from '../lib/ids'
import { cleanMessage, type NoteSaver } from './saver'
import { getState, setState, type CaretHint, type Panel, type Toast, type UndoEntry } from './store'

const MAX_UNDO = 30
let toastCounter = 0
let spotlightCounter = 0

/** The saver of the note currently open in the editor, registered by the editor itself. */
let activeSaver: NoteSaver | null = null
export function setActiveSaver(saver: NoteSaver | null): void {
  activeSaver = saver
}

// ---------------------------------------------------------------- startup

/**
 * Load everything from the main process. `restoreSession` is true only for the first load
 * after start-up, when the note that was open last time is reopened; a reload after an
 * import must show the board, not jump back into that note.
 */
export async function initialize(restoreSession = true): Promise<void> {
  try {
    const snapshot = await api.loadSnapshot()
    setState({
      ready: true,
      loadError: null,
      notes: Object.fromEntries(snapshot.notes.map((n) => [n.id, n])),
      layout: snapshot.layout,
      pins: snapshot.pins,
      trashCount: snapshot.trashCount,
      prefs: snapshot.preferences,
      shortcut: snapshot.shortcut,
      windowStatus: snapshot.window,
      app: snapshot.app
    })
    const open = restoreSession ? snapshot.session.openNoteId : null
    if (open && snapshot.notes.some((n) => n.id === open)) {
      setState({
        view: { mode: 'note', noteId: open, isNew: false, placement: null, caret: null, initialFiles: [] },
        recoveredNotice: snapshot.session.recoveredFromUncleanExit
      })
    }
  } catch (error) {
    setState({ ready: true, loadError: cleanMessage(error) })
  }
}

/** Reload everything after an import replaced or extended the collection. */
export async function reloadAfterImport(): Promise<void> {
  activeSaver = null
  setState({ view: { mode: 'board' }, undo: [], preview: null, recoveredNotice: false })
  void api.setSession(null)
  await initialize(false)
}

// ---------------------------------------------------------------- toasts / announcements

export function toast(message: string, options: { kind?: Toast['kind']; action?: Toast['action']; duration?: number } = {}): number {
  const id = ++toastCounter
  setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, kind: options.kind ?? 'info', action: options.action }] }))
  window.setTimeout(() => dismissToast(id), options.duration ?? (options.action ? 8000 : 5000))
  return id
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function announce(message: string): void {
  // Changing the text is what makes assistive tech read it; clear first so repeats are spoken.
  setState({ announcement: '' })
  window.setTimeout(() => setState({ announcement: message }), 30)
}

function reportError(prefix: string, error: unknown): void {
  toast(`${prefix} ${cleanMessage(error)}`, { kind: 'error', duration: 9000 })
}

// ---------------------------------------------------------------- panels

export function openPanel(panel: Panel): void {
  setState({ panel, gearOpen: false })
}

export function closePanel(): void {
  setState({ panel: null })
}

export function setGearOpen(open: boolean): void {
  setState({ gearOpen: open })
}

export function openImagePreview(attachmentId: string, caption: string): void {
  setState({ preview: { attachmentId, caption } })
}

export function closeImagePreview(): void {
  setState({ preview: null })
}

// ---------------------------------------------------------------- board <-> focused note

/** Click on empty board space: open a blank draft that will land at `placement`. */
export function startDraft(placement: Placement, files: File[] = []): void {
  if (getState().view.mode !== 'board') return
  const noteId = newId()
  setState({ view: { mode: 'note', noteId, isNew: true, placement, caret: null, initialFiles: files }, panel: null, gearOpen: false })
  void api.setSession(noteId)
}

export function openNote(noteId: string, caret: CaretHint | null = null): void {
  const state = getState()
  if (!state.notes[noteId] || state.view.mode !== 'board') return
  setState({ view: { mode: 'note', noteId, isNew: false, placement: null, caret, initialFiles: [] }, panel: null, gearOpen: false })
  void api.setSession(noteId)
}

/** Called by the saver whenever the open note has been written. */
export function noteSaved(note: Note, layout: BoardLayout | null): void {
  setState((s) => ({
    notes: { ...s.notes, [note.id]: note },
    layout: layout ?? s.layout,
    view: s.view.mode === 'note' && s.view.noteId === note.id && s.view.isNew ? { ...s.view, isNew: false } : s.view
  }))
}

/**
 * Back / Log note / Ctrl+Enter / Esc. Writes pending edits first. If that write fails the
 * editor stays open with the text intact; nothing is discarded.
 */
let returning: Promise<boolean> | null = null

export function returnToBoard(): Promise<boolean> {
  // Back, Log note, Ctrl+Enter and Esc can arrive together; they share one return.
  returning ??= leaveNote().finally(() => {
    returning = null
  })
  return returning
}

async function leaveNote(): Promise<boolean> {
  const state = getState()
  if (state.view.mode !== 'note') return true
  const { noteId } = state.view
  const saver = activeSaver
  if (saver) {
    const ok = await saver.flush()
    if (!ok) {
      toast('This note could not be saved yet, so it stays open. Your text is still here.', { kind: 'error', duration: 9000 })
      return false
    }
  }
  const note = getState().notes[noteId]
  let spotlightId: string | null = noteId
  if (!note) {
    // A draft that never held anything: nothing was stored, nothing to remove.
    spotlightId = null
  } else if (isNoteEmpty(note)) {
    // Stored once, then emptied again. Remove it; the main process re-checks that it is empty.
    try {
      const result = await api.discardNote(noteId)
      if (result.discarded) {
        setState((s) => {
          const { [noteId]: _gone, ...rest } = s.notes
          return { notes: rest, layout: result.layout, pins: result.pins, trashCount: result.trashCount }
        })
        spotlightId = null
      }
    } catch (error) {
      reportError('The empty note could not be removed.', error)
    }
  }
  activeSaver = null
  setState({ view: { mode: 'board' }, recoveredNotice: false, spotlight: spotlightId ? { noteId: spotlightId, token: ++spotlightCounter } : null })
  void api.setSession(null)
  return true
}

/** Scroll the board to a note and outline it briefly. Leaves the editor first if needed. */
export async function revealNote(noteId: string): Promise<void> {
  if (!getState().notes[noteId]) return
  if (getState().view.mode === 'note') {
    const ok = await returnToBoard()
    if (!ok) return
  }
  setState({ panel: null, gearOpen: false, spotlight: { noteId, token: ++spotlightCounter } })
}

/** Write whatever is pending. Used before the window hides, the app quits, or a backup runs. */
export async function flushAll(): Promise<void> {
  try {
    await activeSaver?.flush()
    await layoutChain
  } catch {
    // Errors are already shown by whoever started the write.
  }
}

// ---------------------------------------------------------------- layout

let layoutChain: Promise<void> = Promise.resolve()

function persistLayout(layout: BoardLayout): void {
  // Layout writes are queued so they reach the main process in the order they happened.
  layoutChain = layoutChain.then(async () => {
    try {
      const stored = await api.saveLayout(layout)
      // The main process may have repaired the layout; adopt its version if ours is still current.
      if (layoutsEqual(getState().layout, layout) && !layoutsEqual(stored, layout)) setState({ layout: stored })
    } catch (error) {
      reportError('The new arrangement could not be saved.', error)
    }
  })
}

function pushUndo(entry: UndoEntry): void {
  setState((s) => ({ undo: [...s.undo.slice(-(MAX_UNDO - 1)), entry] }))
}

/** Replace the board layout, animating notes to their new places. */
export function applyLayout(next: BoardLayout, options: { undoLabel?: string; movedNoteId?: string; animate?: boolean; persist?: boolean } = {}): void {
  const before = getState().layout
  if (layoutsEqual(before, next)) return
  if (options.animate !== false) captureBoardPositions()
  if (options.undoLabel) {
    const noteId = options.movedNoteId ?? null
    pushUndo({ kind: 'layout', before, after: next, noteId, anchor: noteId ? anchorOf(before, noteId) : null, label: options.undoLabel })
  }
  setState({ layout: next })
  if (options.persist !== false) persistLayout(next)
}

/** Drop a dragged note at `placement` (interpreted against the board without that note). */
export function dropNote(noteId: string, placement: Placement): void {
  const next = moveNote(getState().layout, noteId, placement, newId)
  if (layoutsEqual(next, getState().layout)) return
  applyLayout(next, { undoLabel: 'Move', movedNoteId: noteId })
  const label = noteLabelOf(noteId)
  announce(`Moved "${label}" to ${describePosition(next, noteId)}.`)
  toast('Note moved', { action: { label: 'Undo', run: () => void undoLast() }, duration: 5000 })
}

/** Alt+Arrow on a focused note, or the Move items in its menu. */
export function moveNoteByKeyboard(noteId: string, direction: MoveDirection): void {
  const next = keyboardMove(getState().layout, noteId, direction, newId)
  if (!next) {
    announce(`Cannot move ${direction} from here.`)
    return
  }
  applyLayout(next, { undoLabel: 'Move', movedNoteId: noteId })
  announce(`Moved to ${describePosition(next, noteId)}.`)
}

export async function undoLast(): Promise<void> {
  const state = getState()
  const entry = state.undo[state.undo.length - 1]
  if (!entry) return
  setState({ undo: state.undo.slice(0, -1) })
  if (entry.kind === 'layout') {
    // If the board is exactly as the move left it, restore the earlier arrangement as it was.
    // If anything has changed since (a note written, deleted or recovered), only the moved
    // note goes back, next to its old neighbours; every other note stays where it is now.
    const current = state.layout
    let target = entry.before
    if (!layoutsEqual(current, entry.after)) {
      target = entry.noteId && entry.anchor && findNote(current, entry.noteId) ? placeByAnchor(current, entry.noteId, entry.anchor, newId) : current
    }
    captureBoardPositions()
    setState({ layout: target })
    persistLayout(target)
    announce(`${entry.label} undone.`)
  } else {
    await restoreNote(entry.noteId)
  }
}

// ---------------------------------------------------------------- note actions on the board

function noteLabelOf(noteId: string): string {
  const note = getState().notes[noteId]
  return note ? noteLabel(note, 40) : 'note'
}

function applyLayoutResult(result: { layout: BoardLayout; pins: string[]; trashCount: number }): void {
  captureBoardPositions()
  setState({ layout: result.layout, pins: result.pins, trashCount: result.trashCount })
}

export async function trashNote(noteId: string): Promise<void> {
  const note = getState().notes[noteId]
  if (!note) return
  try {
    const result = await api.trashNote(noteId)
    setState((s) => {
      const { [noteId]: _gone, ...rest } = s.notes
      return { notes: rest }
    })
    applyLayoutResult(result)
    pushUndo({ kind: 'trash', noteId, label: 'Delete' })
    toast('Note moved to Trash', { action: { label: 'Undo', run: () => void restoreNote(noteId) } })
    announce('Note moved to Trash.')
  } catch (error) {
    reportError('The note could not be moved to Trash.', error)
  }
}

export async function restoreNote(noteId: string): Promise<void> {
  try {
    const result = await api.restoreNote(noteId)
    if (!result) return
    setState((s) => ({ notes: { ...s.notes, [result.note.id]: result.note }, undo: s.undo.filter((u) => !(u.kind === 'trash' && u.noteId === noteId)) }))
    applyLayoutResult(result)
    setState({ spotlight: { noteId, token: ++spotlightCounter } })
    announce('Note restored.')
  } catch (error) {
    reportError('The note could not be restored.', error)
  }
}

export async function purgeNotes(ids: string[] | 'all'): Promise<void> {
  try {
    const result = await api.purge(ids)
    setState((s) => ({
      layout: result.layout,
      pins: result.pins,
      trashCount: result.trashCount,
      undo: s.undo.filter((u) => u.kind !== 'trash' || (ids !== 'all' && !ids.includes(u.noteId)))
    }))
  } catch (error) {
    reportError('Trash could not be emptied.', error)
  }
}

/** Save a change to a note that is not open in the editor (checklist tick, collapse). */
async function patchNote(noteId: string, patch: { content?: Note['content']; collapsed?: boolean }): Promise<void> {
  const note = getState().notes[noteId]
  if (!note) return
  // Show the change immediately; roll back if the write fails.
  setState((s) => ({ notes: { ...s.notes, [noteId]: { ...note, ...patch } } }))
  try {
    let result = await api.saveNote({ id: noteId, expectedRevision: note.revision, ...patch })
    if (!result.ok && result.reason === 'stale') {
      result = await api.saveNote({ id: noteId, expectedRevision: result.current.revision, ...patch })
    }
    if (!result.ok) throw new Error('The note changed elsewhere.')
    const saved = result.note
    setState((s) => ({ notes: { ...s.notes, [noteId]: saved } }))
  } catch (error) {
    setState((s) => ({ notes: { ...s.notes, [noteId]: note } }))
    reportError('That change could not be saved.', error)
  }
}

export function toggleTask(noteId: string, taskIndex: number, checked: boolean): void {
  const note = getState().notes[noteId]
  if (note) void patchNote(noteId, { content: setTaskChecked(note.content, taskIndex, checked) })
}

export function setCollapsed(noteId: string, collapsed: boolean): void {
  captureBoardPositions()
  void patchNote(noteId, { collapsed })
}

// ---------------------------------------------------------------- pins

async function savePins(next: string[]): Promise<void> {
  const before = getState().pins
  setState({ pins: next })
  try {
    setState({ pins: await api.setPins(next) })
  } catch (error) {
    setState({ pins: before })
    reportError('Pinned notes could not be updated.', error)
  }
}

/** Pinning adds a reference to the pinned index; the note itself does not move. */
export function togglePin(noteId: string): void {
  const pins = getState().pins
  const pinned = pins.includes(noteId)
  void savePins(pinned ? pins.filter((id) => id !== noteId) : [...pins, noteId])
  announce(pinned ? 'Unpinned.' : 'Pinned.')
}

export function reorderPins(next: string[]): void {
  void savePins(next)
}

// ---------------------------------------------------------------- preferences & window

export async function updatePreferences(patch: Partial<Preferences>): Promise<void> {
  const before = getState().prefs
  setState({ prefs: { ...before, ...patch } })
  try {
    setState({ prefs: await api.setPreferences(patch) })
  } catch (error) {
    setState({ prefs: before })
    reportError('That setting could not be saved.', error)
  }
}

export function isOnBoard(noteId: string): boolean {
  return findNote(getState().layout, noteId) !== null
}
