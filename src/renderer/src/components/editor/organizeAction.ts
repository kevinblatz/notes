/**
 * The Organize button (and Ctrl+Shift+O): fix the open note's words and punctuation and put
 * thoughts that strayed back together, as one editor transaction, so one Ctrl+Z puts it back
 * exactly as it was.
 * The title is corrected too; undo and redo take it along with the text.
 */
import type { Editor } from '@tiptap/core'
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Selection, type Transaction } from '@tiptap/pm/state'
import { organizeNote, organizeSummary } from '@shared/organize'
import type { RichDoc } from '@shared/types'
import { loadSpelling } from '../../lib/spelling'
import { announce, toast } from '../../state/actions'
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
  records.set(editor, { before, after: view.state.doc, titleBefore, titleAfter, undone: false })

  if (flashTimer !== null) window.clearTimeout(flashTimer)
  if (flashing) {
    flashTimer = window.setTimeout(() => {
      flashTimer = null
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(flashKey, 'clear').setMeta('addToHistory', false))
    }, FLASH_MS + 60)
  }
  const message = organizeSummary(result)
  toast(message, { action: { label: 'Undo', run: () => undoOrganize(editor) } })
  announce(`${message}.`)
  view.focus()
}

/** The toast's Undo: the editor's own undo, while the note is still as Organize left it. */
function undoOrganize(editor: Editor): void {
  const record = records.get(editor)
  if (editor.isDestroyed || !record || record.undone || !editor.state.doc.eq(record.after)) return
  editor.chain().focus().undo().run()
}

/**
 * Keep the title in step with undo and redo of Organize: undoing it brings the old title back,
 * redoing it the corrected one (unless the title has been edited since).
 */
export function followTitleThroughUndo(editor: Editor, title: TitleAccess): () => void {
  const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    const record = records.get(editor)
    if (!record || !transaction.docChanged || !isHistoryTransaction(transaction)) return
    const doc = editor.state.doc
    if (!record.undone && doc.eq(record.before)) {
      record.undone = true
      if (title.get() === record.titleAfter) title.set(record.titleBefore)
    } else if (record.undone && doc.eq(record.after)) {
      record.undone = false
      if (title.get() === record.titleBefore) title.set(record.titleAfter)
    }
  }
  editor.on('transaction', onTransaction)
  return () => {
    editor.off('transaction', onTransaction)
  }
}
