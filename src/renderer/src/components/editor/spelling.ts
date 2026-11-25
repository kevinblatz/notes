/**
 * The editor side of spelling and Organize: wavy underlines under misspelled words, the word
 * under the pointer for the right-click menu, and the brief highlight of words Organize fixed.
 *
 * Underlines are ProseMirror decorations, so the note's stored content never carries them.
 * Only the text blocks a change touched are checked again, and the word the caret is still in
 * is left alone until the caret leaves it, as a native spelling checker does. Nothing runs
 * while nothing changes.
 */
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { findMisses, wordAt, type Speller, type WordContext } from '@shared/spelling'
import type { Flash } from '@shared/organize'

// ---------------------------------------------------------------- reading a text block

const LOCKED = new Set(['link', 'code'])

/**
 * A text block as the checker reads it: one character per position (a line break is "\n"),
 * so an offset in the text is an offset from the start of the block's content.
 */
export function blockText(node: PMNode): { text: string; locked: (from: number, to: number) => boolean } {
  let text = ''
  const lockedRanges: Array<[number, number]> = []
  node.forEach((child) => {
    const start = text.length
    if (child.isText) text += child.text ?? ''
    else text += child.type.name === 'hardBreak' ? '\n' : '￼'
    if (!child.isText || child.marks.some((mark) => LOCKED.has(mark.type.name))) lockedRanges.push([start, text.length])
  })
  const locked = (from: number, to: number): boolean => lockedRanges.some(([a, b]) => from < b && to > a)
  return { text, locked }
}

export interface WordUnderPointer {
  from: number
  to: number
  word: string
  context: WordContext
  misspelled: boolean
}

/** The word at a document position, with whether it is underlined. */
export function wordAtPosition(state: EditorState, pos: number, speller: Speller): WordUnderPointer | null {
  const $pos = state.doc.resolve(pos)
  const block = $pos.parent
  if (!block.isTextblock || block.type.name === 'codeBlock') return null
  const start = $pos.start()
  const { text, locked } = blockText(block)
  const found = wordAt(text, pos - start, speller)
  if (!found || locked(found.token.from, found.token.to)) return null
  return {
    from: start + found.token.from,
    to: start + found.token.to,
    word: found.token.text,
    context: found.context,
    misspelled: !speller.check(found.token.text, found.context)
  }
}

// ---------------------------------------------------------------- underlines

interface SpellState {
  speller: Speller
  enabled: boolean
  decorations: DecorationSet
  /** Start of the block whose word under the caret is waiting to be underlined, if any. */
  pending: number | null
}

export const spellKey = new PluginKey<SpellState>('spelling')

const MISS_CLASS = 'spell-miss'

/** The caret, when it is a plain caret in the text (the word it is in is not underlined yet). */
function typingCaret(state: EditorState): number | null {
  return state.selection.empty ? state.selection.head : null
}

/** Check one text block: the underlines it needs, and whether the caret's word was held back. */
function checkBlock(node: PMNode, pos: number, speller: Speller, caret: number | null): { decorations: Decoration[]; heldBack: boolean } {
  const { text, locked } = blockText(node)
  const out: Decoration[] = []
  let heldBack = false
  for (const miss of findMisses(text, speller, locked)) {
    const from = pos + 1 + miss.from
    const to = pos + 1 + miss.to
    if (caret !== null && from <= caret && caret <= to) {
      heldBack = true
      continue
    }
    out.push(Decoration.inline(from, to, { class: MISS_CLASS }))
  }
  return { decorations: out, heldBack }
}

/** Check every text block between `from` and `to` again. */
function recheck(doc: PMNode, set: DecorationSet, from: number, to: number, value: SpellState, caret: number | null): { set: DecorationSet; pending: number | null } {
  let next = set
  let pending: number | null = null
  doc.nodesBetween(from, Math.min(to, doc.content.size), (node, pos) => {
    if (node.type.name === 'codeBlock') {
      next = next.remove(next.find(pos, pos + node.nodeSize))
      return false
    }
    if (!node.isTextblock) return true
    next = next.remove(next.find(pos, pos + node.nodeSize))
    const checked = checkBlock(node, pos, value.speller, caret)
    if (checked.decorations.length > 0) next = next.add(doc, checked.decorations)
    if (checked.heldBack) pending = pos
    return false
  })
  return { set: next, pending }
}

function everything(doc: PMNode, value: SpellState, caret: number | null): SpellState {
  if (!value.enabled || !value.speller.ready) return { ...value, decorations: DecorationSet.empty, pending: null }
  const { set, pending } = recheck(doc, DecorationSet.empty, 0, doc.content.size, value, caret)
  return { ...value, decorations: set, pending }
}

function applySpelling(tr: Transaction, value: SpellState, oldState: EditorState, newState: EditorState): SpellState {
  const meta = tr.getMeta(spellKey) as Partial<Pick<SpellState, 'speller' | 'enabled'>> | undefined
  if (meta) return everything(newState.doc, { ...value, ...meta }, null)
  if (!value.enabled || !value.speller.ready) return value
  let decorations = value.decorations.map(tr.mapping, tr.doc)
  let pending = value.pending === null ? null : tr.mapping.map(value.pending, -1)
  const caret = typingCaret(newState)
  if (tr.docChanged) {
    const start = tr.doc.content.findDiffStart(oldState.doc.content)
    if (start !== null) {
      const end = tr.doc.content.findDiffEnd(oldState.doc.content)
      const changed = recheck(tr.doc, decorations, Math.max(0, start - 1), Math.max(start, end?.a ?? start) + 1, value, caret)
      decorations = changed.set
      if (changed.pending !== null) pending = changed.pending
    }
  }
  // The caret has moved on from a word that was being typed: underline it now if it needs it.
  if (pending !== null && (tr.docChanged || tr.selectionSet)) {
    const node = pending < tr.doc.content.size ? tr.doc.nodeAt(pending) : null
    if (!node?.isTextblock) pending = null
    else {
      const again = recheck(tr.doc, decorations, pending, pending + node.nodeSize, value, caret)
      decorations = again.set
      pending = again.pending
    }
  }
  return { ...value, decorations, pending }
}

export function spellingExtension(initial: () => { speller: Speller; enabled: boolean }) {
  return Extension.create({
    name: 'spelling',
    addProseMirrorPlugins() {
      return [
        new Plugin<SpellState>({
          key: spellKey,
          state: {
            init: (_config, state) => everything(state.doc, { ...initial(), decorations: DecorationSet.empty, pending: null }, null),
            apply: applySpelling
          },
          props: { decorations: (state) => spellKey.getState(state)?.decorations }
        }),
        new Plugin<DecorationSet>({
          key: flashKey,
          state: {
            init: () => DecorationSet.empty,
            apply: (tr, set) => {
              const meta = tr.getMeta(flashKey) as Decoration[] | 'clear' | undefined
              if (meta === 'clear') return DecorationSet.empty
              if (meta) return DecorationSet.create(tr.doc, meta)
              return set.map(tr.mapping, tr.doc)
            }
          },
          props: { decorations: (state) => flashKey.getState(state) }
        })
      ]
    }
  })
}

// ---------------------------------------------------------------- the highlight after Organize

export const flashKey = new PluginKey<DecorationSet>('organizeFlash')
/** Matches the length of the fade in feel.css. */
export const FLASH_MS = 900

/** The document position where the content of the block at `path` starts. */
export function contentStartOf(doc: PMNode, path: number[]): number | null {
  let node = doc
  let start = 0
  for (const index of path) {
    if (index >= node.childCount) return null
    let pos = start
    for (let i = 0; i < index; i++) pos += node.child(i).nodeSize
    node = node.child(index)
    start = pos + 1
  }
  return start
}

/** Decorations for the words Organize fixed, in the document it produced. */
export function flashDecorations(doc: PMNode, flashes: Flash[]): Decoration[] {
  const out: Decoration[] = []
  for (const flash of flashes) {
    const start = contentStartOf(doc, flash.path)
    if (start === null) continue
    const from = start + flash.from
    const to = start + flash.to
    if (to <= doc.content.size && from < to) out.push(Decoration.inline(from, to, { class: 'organize-flash' }))
  }
  return out
}
