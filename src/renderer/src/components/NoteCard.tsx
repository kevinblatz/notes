/**
 * One note on the board. Controls appear only on hover or keyboard focus: a drag handle,
 * pin, and a small menu. Clicking the note opens it; links, checkboxes, images and text
 * selection keep their normal behaviour. Pinning gives a small "pressed in" pop.
 */
import { useDraggable } from '@dnd-kit/core'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsDownUp, ChevronsUpDown, Ellipsis, GripVertical, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState, type AnimationEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { noteLabel } from '@shared/content'
import type { MoveDirection } from '@shared/layout'
import type { Note } from '@shared/types'
import { api } from '../lib/api'
import { motionReduced } from '../lib/flip'
import { moveNoteByKeyboard, openImagePreview, openNote, setCollapsed, togglePin, toggleTask, trashNote } from '../state/actions'
import { useStore, type CaretHint } from '../state/store'
import { NoteContent } from './NoteContent'
import { IconButton, MenuList, Popover, type MenuEntry } from './ui'

interface Props {
  note: Note
  rowId: string
  slot: number
  paired: boolean
  pinned: boolean
  placeholder: boolean
  spotlit: boolean
}

/** Which block and character of the note's text sits under the pointer. */
function caretHintAt(card: HTMLElement, x: number, y: number): CaretHint | null {
  const prose = card.querySelector('.prose')
  if (!prose) return null
  const position = document.caretPositionFromPoint?.(x, y)
  const node = position?.offsetNode
  if (!position || !node || !prose.contains(node)) return null
  let block: Node = node
  while (block.parentNode && block.parentNode !== prose) block = block.parentNode
  const blockIndex = Array.prototype.indexOf.call(prose.childNodes, block)
  if (blockIndex < 0) return null
  try {
    const range = document.createRange()
    range.setStart(block, 0)
    range.setEnd(node, position.offset)
    return { blockIndex, textOffset: range.toString().length }
  } catch {
    return { blockIndex, textOffset: 0 }
  }
}

const ARROWS: Record<string, MoveDirection> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

export const NoteCard = memo(function NoteCard({ note, rowId, slot, paired, pinned, placeholder, spotlit }: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useDraggable({ id: note.id })
  const [menuOpen, setMenuOpen] = useState(false)
  const [pinPop, setPinPop] = useState(false)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLElement | null>(null)
  const label = noteLabel(note)

  const setRefs = useCallback(
    (element: HTMLElement | null) => {
      card.current = element
      setNodeRef(element)
    },
    [setNodeRef]
  )

  const refocus = (): void => {
    // Rearranging moves the element in the document, which drops focus; put it back.
    requestAnimationFrame(() => {
      card.current?.focus({ preventScroll: true })
      card.current?.scrollIntoView({ block: 'nearest' })
    })
  }

  const pin = (): void => {
    // Only pinning pops (not unpinning), and only when the user did it, so it never replays.
    setPinPop(!pinned && !motionReduced())
    togglePin(note.id)
  }

  const onPinAnimationEnd = (event: AnimationEvent<HTMLButtonElement>): void => {
    if (event.animationName === 'pin-pop') setPinPop(false)
  }

  // Opening a note hides the board, which cuts a pop short; it ends there too, so it does not
  // play again when the board comes back. (Subscribed only while the pop is running.)
  useEffect(() => {
    if (!pinPop) return
    return useStore.subscribe((state) => {
      if (state.view.mode !== 'board') setPinPop(false)
    })
  }, [pinPop])

  const move = (direction: MoveDirection): void => {
    moveNoteByKeyboard(note.id, direction)
    refocus()
  }

  const onClick = (event: MouseEvent<HTMLElement>): void => {
    if (placeholder || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-interactive], button, a, input, .note-tools')) return
    // Finishing a text selection inside the note is not a request to open it.
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0 && event.currentTarget.contains(selection.anchorNode)) return
    openNote(note.id, note.collapsed ? null : caretHintAt(event.currentTarget, event.clientX, event.clientY))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return
    const direction = ARROWS[event.key]
    if (event.altKey && direction) {
      event.preventDefault()
      move(direction)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openNote(note.id)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      void trashNote(note.id)
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      setMenuOpen(true)
    }
  }

  const entries: MenuEntry[] = [
    { label: 'Open', icon: <Pencil size={15} />, hint: 'Enter', onSelect: () => openNote(note.id) },
    { label: pinned ? 'Unpin' : 'Pin', icon: pinned ? <PinOff size={15} /> : <Pin size={15} />, onSelect: pin },
    {
      label: note.collapsed ? 'Expand' : 'Collapse',
      icon: note.collapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />,
      onSelect: () => setCollapsed(note.id, !note.collapsed)
    },
    { kind: 'separator' },
    { label: 'Move up', icon: <ArrowUp size={15} />, hint: 'Alt+↑', onSelect: () => move('up') },
    { label: 'Move down', icon: <ArrowDown size={15} />, hint: 'Alt+↓', onSelect: () => move('down') },
    { label: 'Move left', icon: <ArrowLeft size={15} />, hint: 'Alt+←', onSelect: () => move('left') },
    { label: 'Move right', icon: <ArrowRight size={15} />, hint: 'Alt+→', onSelect: () => move('right') },
    { kind: 'separator' },
    { label: 'Move to Trash', icon: <Trash2 size={15} />, hint: 'Del', danger: true, onSelect: () => void trashNote(note.id) }
  ]

  const className = ['note', paired ? (slot === 0 ? 'is-left' : 'is-right') : 'is-full', placeholder ? 'is-placeholder' : '', spotlit ? 'is-spotlit' : '', pinned ? 'is-pinned' : '', menuOpen ? 'has-menu' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <article
      ref={setRefs}
      className={className}
      data-note-id={note.id}
      data-row-id={rowId}
      data-slot={slot}
      tabIndex={0}
      aria-label={`Note: ${label}${pinned ? ', pinned' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('a, input')) return
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <div className="note-tools">
        <button ref={setActivatorNodeRef} type="button" className="icon-button note-handle" {...listeners} {...attributes} tabIndex={-1} aria-label="Drag to move this note" title="Drag to move">
          <GripVertical size={15} />
        </button>
        <IconButton label={pinned ? 'Unpin' : 'Pin'} active={pinned} className={pinPop ? 'is-popping' : undefined} onClick={pin} onAnimationEnd={onPinAnimationEnd}>
          {pinned ? <PinOff size={15} /> : <Pin size={15} />}
        </IconButton>
        <IconButton ref={menuAnchor} label="Note actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <Ellipsis size={16} />
        </IconButton>
      </div>
      <Popover anchor={menuAnchor.current} open={menuOpen} onClose={() => setMenuOpen(false)} align="end" role="menu" label="Note actions">
        <MenuList entries={entries} onDone={() => setMenuOpen(false)} />
      </Popover>

      {pinned ? <Pin className="note-pin-mark" size={13} aria-hidden /> : null}
      {note.title ? <h2 className="note-title">{note.title}</h2> : null}
      {note.collapsed ? (
        <p className="note-collapsed">
          {note.title ? noteLabel({ ...note, title: null }) : label}
          <button
            type="button"
            className="link-button"
            data-interactive
            onClick={(event) => {
              event.stopPropagation()
              setCollapsed(note.id, false)
            }}
          >
            Expand
          </button>
        </p>
      ) : (
        <NoteContent
          doc={note.content}
          onToggleTask={(index, checked) => toggleTask(note.id, index, checked)}
          onOpenLink={(href) => void api.openExternal(href)}
          onOpenImage={openImagePreview}
        />
      )}
      {note.tags.length > 0 ? (
        <div className="note-tags">
          {note.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
    </article>
  )
})
