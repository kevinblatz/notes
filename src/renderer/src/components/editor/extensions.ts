/**
 * Editor configuration. Built entirely from Tiptap's free, open-source extensions plus one
 * small custom node for managed images.
 */
import { Extension, mergeAttributes, Node, type Editor } from '@tiptap/core'
import { Highlight } from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Placeholder } from '@tiptap/extensions'
import type { Node as PMNode } from '@tiptap/pm/model'
import { ReactNodeViewRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { IMAGE_NODE, isValidId, safeLinkHref } from '@shared/content'
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
      naturalHeight: numberAttr('data-natural-height', null)
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

/** Import image files and insert them as image blocks, one after another, at `position` (or the selection). */
export async function insertImageFiles(editor: Editor, files: File[], position?: number): Promise<string[]> {
  const errors: string[] = []
  let at = position
  for (const file of files) {
    try {
      const { attachment, width, height } = await importImageFile(file)
      if (editor.isDestroyed) break
      const node = { type: IMAGE_NODE, attrs: { attachmentId: attachment.id, width: 100, caption: '', naturalWidth: width, naturalHeight: height } }
      if (at === undefined) {
        editor.chain().insertContent(node).run()
      } else {
        const safe = Math.max(0, Math.min(at, editor.state.doc.content.size))
        editor.chain().insertContentAt(safe, node).run()
        // Later images follow the one just inserted.
        at = editor.state.selection.to
      }
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
