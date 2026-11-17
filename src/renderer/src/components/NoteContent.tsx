/**
 * Read-only rendering of a note's structured content for the board. This is plain React
 * output (no editor instance per note), which is what keeps a board of several hundred
 * notes light. Checklists stay tickable, links stay clickable, images open the preview.
 */
import { memo, type CSSProperties, type ReactNode } from 'react'
import { IMAGE_NODE } from '@shared/content'
import { attachmentUrl, type RichDoc, type RichMark, type RichNode } from '@shared/types'

export interface NoteContentHandlers {
  onToggleTask: (taskIndex: number, checked: boolean) => void
  onOpenLink: (href: string) => void
  onOpenImage: (attachmentId: string, caption: string) => void
}

interface Context extends NoteContentHandlers {
  taskCounter: { value: number }
}

function applyMarks(text: ReactNode, marks: RichMark[] | undefined, key: number, context: Context): ReactNode {
  let node = text
  if (!marks) return <span key={key}>{node}</span>
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        node = <strong>{node}</strong>
        break
      case 'italic':
        node = <em>{node}</em>
        break
      case 'underline':
        node = <u>{node}</u>
        break
      case 'strike':
        node = <s>{node}</s>
        break
      case 'code':
        node = <code>{node}</code>
        break
      case 'highlight':
        node = <mark style={{ backgroundColor: String(mark.attrs?.color ?? 'var(--hl-amber)') }}>{node}</mark>
        break
      case 'textStyle': {
        const style: CSSProperties = {}
        if (mark.attrs?.color) style.color = String(mark.attrs.color)
        if (mark.attrs?.fontFamily) style.fontFamily = String(mark.attrs.fontFamily)
        if (mark.attrs?.fontSize) style.fontSize = String(mark.attrs.fontSize)
        node = <span style={style}>{node}</span>
        break
      }
      case 'link': {
        const href = String(mark.attrs?.href ?? '')
        node = (
          <a
            href={href}
            data-interactive
            title={href}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              context.onOpenLink(href)
            }}
          >
            {node}
          </a>
        )
        break
      }
    }
  }
  return <span key={key}>{node}</span>
}

function renderInline(nodes: RichNode[] | undefined, context: Context): ReactNode {
  if (!nodes || nodes.length === 0) return <br />
  return nodes.map((node, index) => {
    if (node.type === 'text') return applyMarks(node.text ?? '', node.marks, index, context)
    if (node.type === 'hardBreak') return <br key={index} />
    return null
  })
}

function renderBlocks(nodes: RichNode[] | undefined, context: Context): ReactNode {
  return nodes?.map((node, index) => renderBlock(node, index, context))
}

function renderBlock(node: RichNode, key: number, context: Context): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={key}>{renderInline(node.content, context)}</p>
    case 'heading': {
      const level = Number(node.attrs?.level ?? 2)
      const Tag = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
      return <Tag key={key}>{renderInline(node.content, context)}</Tag>
    }
    case 'bulletList':
      return <ul key={key}>{renderBlocks(node.content, context)}</ul>
    case 'orderedList':
      return (
        <ol key={key} start={Number(node.attrs?.start ?? 1)}>
          {renderBlocks(node.content, context)}
        </ol>
      )
    case 'listItem':
      return <li key={key}>{renderBlocks(node.content, context)}</li>
    case 'taskList':
      return (
        <ul key={key} data-type="taskList">
          {renderBlocks(node.content, context)}
        </ul>
      )
    case 'taskItem': {
      const taskIndex = context.taskCounter.value++
      const checked = node.attrs?.checked === true
      return (
        <li key={key} data-type="taskItem" data-checked={checked}>
          <label data-interactive contentEditable={false}>
            <input type="checkbox" checked={checked} onChange={(event) => context.onToggleTask(taskIndex, event.target.checked)} aria-label="Done" />
          </label>
          <div>{renderBlocks(node.content, context)}</div>
        </li>
      )
    }
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks(node.content, context)}</blockquote>
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{node.content?.map((child) => child.text ?? '').join('')}</code>
        </pre>
      )
    case 'horizontalRule':
      return <hr key={key} />
    case IMAGE_NODE: {
      const id = String(node.attrs?.attachmentId ?? '')
      const caption = typeof node.attrs?.caption === 'string' ? node.attrs.caption : ''
      const width = Number(node.attrs?.width ?? 100)
      const naturalWidth = Number(node.attrs?.naturalWidth) || undefined
      const naturalHeight = Number(node.attrs?.naturalHeight) || undefined
      return (
        <figure key={key} className="note-image" style={{ width: `${width}%` }}>
          <button type="button" className="note-image-button" data-interactive onClick={() => context.onOpenImage(id, caption)} aria-label={caption ? `Open image: ${caption}` : 'Open image'}>
            <img
              src={attachmentUrl(id, 'preview')}
              alt={caption}
              width={naturalWidth}
              height={naturalHeight}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={(event) => event.currentTarget.closest('figure')?.setAttribute('data-missing', 'true')}
            />
            <span className="note-image-missing">Image file missing</span>
          </button>
          {caption ? <figcaption>{caption}</figcaption> : null}
        </figure>
      )
    }
    default:
      return null
  }
}

interface Props extends NoteContentHandlers {
  doc: RichDoc
}

export const NoteContent = memo(
  function NoteContent({ doc, onToggleTask, onOpenLink, onOpenImage }: Props) {
    const context: Context = { onToggleTask, onOpenLink, onOpenImage, taskCounter: { value: 0 } }
    return <div className="prose">{renderBlocks(doc.content, context)}</div>
  },
  // The handlers only close over the note's ID, so the content needs re-rendering only when
  // the document itself changes. This keeps typing in one note from re-rendering the rest.
  (previous, next) => previous.doc === next.doc
)
