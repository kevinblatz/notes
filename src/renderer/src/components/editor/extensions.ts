/**
 * Editor configuration. Built entirely from Tiptap's free, open-source extensions plus one
 * small custom node for managed images.
 */
import { Extension, mergeAttributes, Node, type Editor } from '@tiptap/core'
import { Highlight } from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Placeholder } from '@tiptap/extensions'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { ReactNodeViewRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { IMAGE_NODE, isValidId, safeLinkHref } from '@shared/content'
import { drawingScaleAttr } from '@shared/drawing'
import { importImageFile } from '../../lib/images'
import type { CaretHint } from '../../state/store'
import { ImageNodeView } from './ImageNodeView'

const numberAttr = (name: string, fallback: number | null) => ({
  default: fallback,
  parseHTML: (element: HTMLElement) => {
    const value = Number(element.getAttribute(name))
    return Number.isFinite(value) && value > 0 ? value : fallback
  },
  renderHTML: (attrs: Record<string, unknown>) => {
    const key = name === 'data-width' ? 'width' : name === 'data-natural-width' ? 'naturalWidth' : 'naturalHeight'
    return attrs[key] == null ? {} : { [name]: String(attrs[key]) }
  }
})

/** An image stored in the managed attachments folder, referenced by ID (never by path or data URL). */
export const NoteImage = Node.create({
  name: IMAGE_NODE,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-attachment-id'),
        renderHTML: (attrs) => ({ 'data-attachment-id': attrs.attachmentId as string })
      },
      width: numberAttr('data-width', 100),
      caption: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-caption') ?? '',
        renderHTML: (attrs) => (attrs.caption ? { 'data-caption': attrs.caption as string } : {})
      },
      naturalWidth: numberAttr('data-natural-width', null),
      naturalHeight: numberAttr('data-natural-height', null),
      /**
       * Set on a picture made in the drawing space, which can reopen it for editing: the pixel
       * density it was saved at (pixels per CSS pixel), so it reopens at the size it was drawn.
       */
      drawing: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute('data-drawing')
          if (value === null) return null
          return drawingScaleAttr(value === '' ? true : Number(value))
        },
        renderHTML: (attrs) => {
          const value = drawingScaleAttr(attrs.drawing)
          return value === null ? {} : { 'data-drawing': value === true ? '' : String(value) }
        }
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-note-image]',
        getAttrs: (element) => (isValidId((element as HTMLElement).getAttribute('data-attachment-id')) ? {} : false)
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes({ 'data-note-image': '' }, HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView)
  }
})

function linkCandidate(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
}

export function buildExtensions(options: { onSubmit: () => void }) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      dropcursor: { color: 'var(--accent)', width: 2 },
      link: {
        // A plain click places the caret; Ctrl+click (handled by the editor) opens the link.
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        protocols: ['http', 'https', 'mailto'],
        isAllowedUri: (url) => safeLinkHref(linkCandidate(url)) !== null,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null }
      }
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: 'Write…' }),
    NoteImage,
    Extension.create({
      name: 'logNoteShortcut',
      priority: 1000,
      addKeyboardShortcuts() {
        return {
          'Mod-Enter': () => {
            options.onSubmit()
            return true
          }
        }
      }
    })
  ]
}

/**
 * Insert one image block at `position` (or at the selection) and leave the caret in the
 * paragraph after it, so typing or adding another image continues below instead of
 * replacing the image that was just added.
 */
function insertImageNode(editor: Editor, attrs: Record<string, unknown>, position?: number, ownUndoStep = false): void {
  editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      const type = state.schema.nodes[IMAGE_NODE]
      const paragraph = state.schema.nodes.paragraph
      if (!type || !paragraph) return false
      // Not merged into the typing just before it: one Ctrl+Z takes away exactly this image.
      if (ownUndoStep) closeHistory(tr)
      const selection = tr.selection
      // A selected block (for example another image) is kept; the new image goes after it.
      const reference = position ?? (selection instanceof NodeSelection ? selection.to : selection.from)
      const at = Math.max(0, Math.min(reference, tr.doc.content.size))
      // Places the block before/after the current paragraph when the caret is at its edge,
      // and splits the paragraph when the caret is in the middle of it.
      tr.replaceRangeWith(at, at, type.create(attrs))
      let inserted = -1
      tr.doc.descendants((node, pos) => {
        if (node.type === type && node.attrs.attachmentId === attrs.attachmentId) inserted = pos
        return inserted === -1
      })
      if (inserted === -1) return true
      const after = inserted + 1
      const next = tr.doc.resolve(after).nodeAfter
      if (!next || !next.isTextblock) tr.insert(after, paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView()
      return true
    })
    .run()
}

/** Start a new undo step with whatever is typed next, so it is not merged into the change just made. */
function endUndoStep(editor: Editor): void {
  if (!editor.isDestroyed) editor.view.dispatch(closeHistory(editor.state.tr))
}

/**
 * Put a finished drawing into the note at the caret, exactly where and how a pasted
 * screenshot goes, as a single undo step of its own.
 */
export function insertDrawingNode(editor: Editor, attrs: Record<string, unknown> & { drawing: number }): void {
  insertImageNode(editor, { caption: '', ...attrs }, undefined, true)
  endUndoStep(editor)
}

/** Position of the image block showing `attachmentId`: `hint` when it still is that block, else the first one found. */
function findImage(editor: Editor, attachmentId: string, hint: number | undefined): { pos: number; node: PMNode } | null {
  const { doc, schema } = editor.state
  const type = schema.nodes[IMAGE_NODE]
  if (typeof hint === 'number' && hint >= 0 && hint < doc.content.size) {
    const node = doc.nodeAt(hint)
    if (node && node.type === type && node.attrs.attachmentId === attachmentId) return { pos: hint, node }
  }
  let found: { pos: number; node: PMNode } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.type === type && node.attrs.attachmentId === attachmentId) found = { pos, node }
    return !found
  })
  return found
}

/**
 * Swap the picture of an edited drawing in place: same spot, same width, same caption, one
 * undo step. Returns false when that image is no longer in the note.
 */
export function replaceDrawingNode(editor: Editor, previousAttachmentId: string, hint: number | undefined, attrs: Record<string, unknown> & { drawing: number }): boolean {
  if (editor.isDestroyed) return false
  const target = findImage(editor, previousAttachmentId, hint)
  if (!target) return false
  const tr = editor.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, ...attrs })
  tr.setSelection(NodeSelection.create(tr.doc, target.pos)).scrollIntoView()
  editor.view.dispatch(closeHistory(tr))
  endUndoStep(editor)
  editor.view.focus()
  return true
}

/** An edited drawing that was cleared and finished empty leaves the note (Ctrl+Z brings it back). */
export function removeDrawingNode(editor: Editor, attachmentId: string, hint: number | undefined): boolean {
  if (editor.isDestroyed) return false
  const target = findImage(editor, attachmentId, hint)
  if (!target) return false
  const tr = editor.state.tr.delete(target.pos, target.pos + target.node.nodeSize).scrollIntoView()
  editor.view.dispatch(closeHistory(tr))
  endUndoStep(editor)
  editor.view.focus()
  return true
}

/** Import image files and insert them as image blocks, one after another, at `position` (or the selection). */
export async function insertImageFiles(editor: Editor, files: File[], position?: number): Promise<string[]> {
  const errors: string[] = []
  let at = position
  for (const file of files) {
    try {
      const { attachment, width, height } = await importImageFile(file)
      if (editor.isDestroyed) break
      insertImageNode(editor, { attachmentId: attachment.id, width: 100, caption: '', naturalWidth: width, naturalHeight: height }, at)
      // Later images follow the one just inserted.
      at = undefined
    } catch (error) {
      errors.push(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : String(error))
    }
  }
  return errors
}

/**
 * Translate "the user clicked block N at character K" (measured on the board's read-only
 * rendering) into a document position, so the editor opens with the caret where they clicked.
 */
export function positionFromHint(doc: PMNode, hint: CaretHint | null): number | null {
  if (!hint || hint.blockIndex < 0 || hint.blockIndex >= doc.childCount) return null
  let blockStart = 0
  for (let i = 0; i < hint.blockIndex; i++) blockStart += doc.child(i).nodeSize
  const block = doc.child(hint.blockIndex)
  if (block.isAtom) return blockStart
  let remaining = hint.textOffset
  let found: number | null = null
  let lastTextEnd: number | null = null
  block.descendants((node, pos) => {
    if (found !== null) return false
    if (node.isText) {
      const length = node.text?.length ?? 0
      const start = blockStart + 1 + pos
      if (remaining <= length) {
        found = start + remaining
        return false
      }
      remaining -= length
      lastTextEnd = start + length
    }
    return true
  })
  return found ?? lastTextEnd ?? blockStart + 1
}
