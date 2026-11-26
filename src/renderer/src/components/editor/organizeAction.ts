/**
 * The Organize button (and Ctrl+Shift+O): fix the open note's words and punctuation and put
 * thoughts that strayed back together, as one editor transaction, so one Ctrl+Z puts it back
 * exactly as it was.
 * The title is corrected too; undo and redo take it along with the text.
 */
import type { Editor } from '@tiptap/core'
import { closeHistory, isHistoryTransaction, undoDepth } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Selection, type Transaction } from '@tiptap/pm/state'
import { organizeNote, organizeSummary } from '@shared/organize'
import type { RichDoc } from '@shared/types'
import { loadSpelling } from '../../lib/spelling'
import { announce, dismissToast, toast } from '../../state/actions'
import { cleanMessage } from '../../state/saver'
import { flashDecorations, flashKey, FLASH_MS } from './spelling'

export const ORGANIZE_SHORTCUT = 'Ctrl+Shift+O'

export function isOrganizeShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o'
}

/** How Organize reads and writes the title field, which lives outside the editor. */
export interface TitleAccess {
  get(): string
  set(next: string): void
}

/** The last Organize of a note: what undo and redo turn the title back and forth between. */
interface OrganizeRecord {
  before: PMNode
  after: PMNode
  /**
   * How many steps the undo history held just before Organize. Organize's own step is the one
   * that takes it from here to one more, so undoing it brings the history back to this depth
   * (undoing typing done after Organize does not, even when Organize left the text as it was).
   */
  depth: number
  titleBefore: string
  titleAfter: string
  undone: boolean
}

const records = new WeakMap<Editor, OrganizeRecord>()
let flashTimer: number | null = null

function reducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduce'
}

/** Organize the note open in `editor`. Resolves once it is done (or found nothing to do). */
export async function organizeOpenNote(editor: Editor, title: TitleAccess): Promise<void> {
  if (editor.isDestroyed) return
  let speller
  try {
    speller = await loadSpelling({ urgent: true })
  } catch (error) {
    toast(`Organize is not available: ${cleanMessage(error)}`, { kind: 'error' })
    return
  }
  if (editor.isDestroyed) return
  const titleBefore = title.get()
  const result = organizeNote({ doc: editor.getJSON() as RichDoc, title: titleBefore.trim() ? titleBefore : null }, speller)
  if (!result.changed) {
    toast('Already tidy')
    announce('Already tidy.')
    return
  }
  const { state, view } = editor
  const before = state.doc
  const depth = undoDepth(state)
  const content = state.schema.nodeFromJSON(result.doc).content
  // Its own undo step, not merged with the typing before it.
  const tr = closeHistory(state.tr.replaceWith(0, state.doc.content.size, content))
  tr.setSelection(Selection.atEnd(tr.doc))
  const flashing = !reducedMotion() && result.flashes.length > 0
  if (flashing) tr.setMeta(flashKey, flashDecorations(tr.doc, result.flashes))
  view.dispatch(tr)
  // ... and the typing after it starts a step of its own.
  view.dispatch(closeHistory(view.state.tr))
  const titleAfter = result.title ?? ''
  if (titleAfter !== titleBefore) title.set(titleAfter)
  const record: OrganizeRecord = { before, after: view.state.doc, depth, titleBefore, titleAfter, undone: false }
  records.set(editor, record)

  if (flashTimer !== null) window.clearTimeout(flashTimer)
  if (flashing) {
    flashTimer = window.setTimeout(() => {
      flashTimer = null
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(flashKey, 'clear').setMeta('addToHistory', false))
    }, FLASH_MS + 60)
  }
  const message = organizeSummary(result)
  const id = toast(message, { action: { label: 'Undo', run: () => undoOrganize(editor, record) } })
  offerUndoWhileItWorks(editor, record, id)
  announce(`${message}.`)
  view.focus()
}

/** How long the message with its Undo stays (the toast's own time for a message with an action). */
const UNDO_OFFER_MS = 8000

/**
 * The message's Undo is there only while it can work: once the note is no longer as Organize
 * left it (more typing, Ctrl+Z) or is closed (logged), the message goes. Ctrl+Z still undoes
 * step by step.
 */
function offerUndoWhileItWorks(editor: Editor, record: OrganizeRecord, id: number): void {
  const stop = (): void => {
    window.clearTimeout(timer)
    editor.off('transaction', onTransaction)
    editor.off('destroy', withdraw)
  }
  const withdraw = (): void => {
    stop()
    dismissToast(id)
  }
  const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    if (transaction.docChanged && !editor.state.doc.eq(record.after)) withdraw()
  }
  const timer = window.setTimeout(stop, UNDO_OFFER_MS + 500)
  editor.on('transaction', onTransaction)
  editor.on('destroy', withdraw)
}

/** The toast's Undo: the editor's own undo, while the note is still as Organize left it. */
function undoOrganize(editor: Editor, record: OrganizeRecord): void {
  if (editor.isDestroyed || records.get(editor) !== record || record.undone || !editor.state.doc.eq(record.after)) {
    toast('Nothing to undo here: the note has changed since Organize. Ctrl+Z undoes it step by step.')
    return
  }
  editor.chain().focus().undo().run()
}

/**
 * Keep the title in step with undo and redo of Organize: undoing it brings the old title back,
 * redoing it the corrected one (unless the title has been edited since).
 */
export function followTitleThroughUndo(editor: Editor, title: TitleAccess): () => void {
  const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    const record = records.get(editor)
    if (!record || !transaction.docChanged) return
    if (!isHistoryTransaction(transaction)) {
      // New writing after Organize was undone: it can no longer be redone.
      if (record.undone) records.delete(editor)
      return
    }
    // Organize's own step is undone when the history drops back to where it was before it,
    // and redone when it climbs back one step from there.
    const depth = undoDepth(editor.state)
    const doc = editor.state.doc
    if (!record.undone && depth === record.depth && doc.eq(record.before)) {
      record.undone = true
      if (title.get() === record.titleAfter) title.set(record.titleBefore)
    } else if (record.undone && depth === record.depth + 1 && doc.eq(record.after)) {
      record.undone = false
      if (title.get() === record.titleBefore) title.set(record.titleAfter)
    }
  }
  editor.on('transaction', onTransaction)
  return () => {
    editor.off('transaction', onTransaction)
  }
}
