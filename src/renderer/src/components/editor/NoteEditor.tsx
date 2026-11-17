/**
 * Focused Note: one note fills the window. The other notes are hidden, and the only controls
 * on screen are the ones needed to write. Nothing here reacts to the window losing focus, so
 * checking the chart leaves the draft, the caret and any open control exactly as they were.
 */
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { ArrowLeft, ClipboardPaste, Copy, Plus, Scissors, Tag, TextSelect, Type, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { emptyDoc, SUGGESTED_TAGS, sanitizeTags } from '@shared/content'
import { collectTags } from '@shared/search'
import type { RichDoc } from '@shared/types'
import { api } from '../../lib/api'
import { useEscape } from '../../lib/escape'
import { ACCEPT_ATTRIBUTE, hasFiles, imageFilesFrom } from '../../lib/images'
import { sanitizePastedHtml } from '../../lib/pasteSanitizer'
import { noteSaved, returnToBoard, setActiveSaver, toast } from '../../state/actions'
import { NoteSaver, type SaveState } from '../../state/saver'
import { getState, useStore, type View } from '../../state/store'
import { MenuList, Popover } from '../ui'
import { buildExtensions, insertImageFiles, positionFromHint } from './extensions'
import { FormatBar, SelectionBubble } from './FormatBar'

type NoteView = Extract<View, { mode: 'note' }>

function reportImageErrors(errors: string[]): void {
  if (errors.length > 0) toast(errors[0]!, { kind: 'error', duration: 8000 })
}

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state.kind === 'idle') return <span className="save-status" aria-live="polite" />
  if (state.kind === 'error') {
    return (
      <span className="save-status is-error" role="alert">
        <strong>Not saved.</strong> <span className="save-error-text">{state.message}</span>{' '}
        <button type="button" className="link-button" onClick={onRetry}>
          Try again
        </button>
      </span>
    )
  }
  return (
    <span className="save-status" aria-live="polite" data-state={state.kind}>
      {state.kind === 'saved' ? 'Saved' : 'Saving…'}
    </span>
  )
}

function TagRow({ tags, onChange }: { tags: string[]; onChange: (next: string[]) => void }) {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState('')
  const notes = useStore((s) => s.notes)
  const suggestions = useMemo(() => {
    const known = [...SUGGESTED_TAGS, ...collectTags(Object.values(notes))]
    const taken = new Set(tags.map((t) => t.toLowerCase()))
    const seen = new Set<string>()
    return known.filter((t) => !taken.has(t.toLowerCase()) && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 8)
  }, [notes, tags])
  useEscape(adding, () => {
    setAdding(false)
    setValue('')
  })
  const add = (raw: string): void => {
    const next = sanitizeTags([...tags, raw])
    if (next.length !== tags.length) onChange(next)
    setValue('')
  }
  return (
    <div className="tag-row" aria-label="Tags">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          {tag}
          <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter((t) => t !== tag))}>
            <X size={12} />
          </button>
        </span>
      ))}
      {adding ? (
        <span className="tag-adder">
          <input
            autoFocus
            type="text"
            value={value}
            maxLength={32}
            placeholder="Tag name"
            aria-label="New tag"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (value.trim()) add(value)
                else setAdding(false)
              }
            }}
            onBlur={() => {
              if (value.trim()) add(value)
              setAdding(false)
            }}
          />
          {suggestions.map((tag) => (
            <button key={tag} type="button" className="tag-suggestion" onMouseDown={(event) => event.preventDefault()} onClick={() => add(tag)}>
              {tag}
            </button>
          ))}
        </span>
      ) : (
        <button type="button" className="tag-add" onClick={() => setAdding(true)}>
          {tags.length === 0 ? <Tag size={13} /> : <Plus size={13} />}
          {tags.length === 0 ? 'Add tag' : 'Tag'}
        </button>
      )}
    </div>
  )
}

export function NoteEditor({ view }: { view: NoteView }) {
  // The stored note as it was when the editor opened. Later saves must not reset the editor.
  const initial = useRef(getState().notes[view.noteId] ?? null).current
  const recovered = useStore((s) => s.recoveredNotice)
  const [title, setTitle] = useState(initial?.title ?? '')
  const [tags, setTags] = useState<string[]>(initial?.tags ?? [])
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const [dropActive, setDropActive] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const titleRef = useRef(title)
  const tagsRef = useRef(tags)
  const saverRef = useRef<NoteSaver | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const menuAnchor = useRef<HTMLSpanElement>(null)
  titleRef.current = title
  tagsRef.current = tags

  const editorRef = useRef<Editor | null>(null)
  const extensions = useMemo(() => buildExtensions({ onSubmit: () => void returnToBoard() }), [])

  const editor = useEditor({
    extensions,
    content: initial?.content ?? emptyDoc(),
    editorProps: {
      attributes: { class: 'prose editor-prose', 'aria-label': 'Note text', role: 'textbox', 'aria-multiline': 'true' },
      transformPastedHTML: sanitizePastedHtml,
      handlePaste: (_view, event) => {
        // Read the clipboard only now, at the moment of pasting.
        const files = imageFilesFrom(event.clipboardData)
        const text = event.clipboardData?.getData('text/plain').trim() ?? ''
        // Office apps put a picture of the text on the clipboard as well; prefer the text then.
        if (files.length === 0 || text.length > 0) return false
        event.preventDefault()
        const current = editorRef.current
        if (current) void insertImageFiles(current, files).then(reportImageErrors)
        return true
      },
      handleDrop: (pmView, event, _slice, moved) => {
        if (moved) return false
        const files = imageFilesFrom(event.dataTransfer)
        if (files.length === 0) return false
        event.preventDefault()
        const position = pmView.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        const current = editorRef.current
        if (current) void insertImageFiles(current, files, position).then(reportImageErrors)
        return true
      },
      handleClick: (pmView, pos, event) => {
        if (!(event.ctrlKey || event.metaKey)) return false
        const link = pmView.state.doc.resolve(pos).marks().find((mark) => mark.type.name === 'link')
        if (!link) return false
        void api.openExternal(String(link.attrs.href))
        return true
      }
    },
    onUpdate: () => saverRef.current?.touch()
  })
  editorRef.current = editor

  // One saver per editing session.
  useEffect(() => {
    const saver = new NoteSaver({
      id: view.noteId,
      existing: initial,
      placement: view.placement,
      read: () => ({ title: titleRef.current.trim() || null, content: editor.getJSON() as RichDoc, tags: tagsRef.current }),
      onState: setSaveState,
      onSaved: noteSaved
    })
    saverRef.current = saver
    setActiveSaver(saver)
    return () => {
      saver.dispose()
      saverRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, view.noteId])

  // Place the caret: where the user clicked on the board, or at the end, or at the start of a new draft.
  // Focus happens in the same frame the editor appears, so typing can start immediately
  // after the click without losing the first keystrokes.
  useLayoutEffect(() => {
    if (editor.isDestroyed) return
    const hinted = positionFromHint(editor.state.doc, view.caret)
    editor.commands.focus(hinted ?? (view.isNew ? 'start' : 'end'), { scrollIntoView: true })
    // The command above moves keyboard focus on the next frame; do it now as well.
    editor.view.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  useEffect(() => {
    if (view.initialFiles.length > 0) void insertImageFiles(editor, view.initialFiles).then(reportImageErrors)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  useEscape(true, () => void returnToBoard())

  const changed = (): void => saverRef.current?.touch()

  const onContainerDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDropActive(false)
    if (event.defaultPrevented) return
    const files = imageFilesFrom(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    // Dropped beside the text rather than into it: add at the end of the note.
    void insertImageFiles(editor, files, editor.state.doc.content.size).then(reportImageErrors)
  }

  const onContextMenu = (event: ReactMouseEvent): void => {
    const target = event.target as HTMLElement
    if (!target.closest('.ProseMirror, .focus-title')) return
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const hasSelection = !editor.state.selection.empty
  const closeMenu = (): void => setMenu(null)

  return (
    <section
      className="focus-view"
      aria-label="Note"
      data-testid="focus-view"
      onKeyDown={(event) => {
        // Ctrl+Enter logs the note from anywhere in this view (title, caption, a toolbar
        // button), not only while the caret is in the text.
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.defaultPrevented) {
          event.preventDefault()
          void returnToBoard()
        }
      }}
    >
      <header className="focus-bar">
        <button type="button" className="ghost-button" onClick={() => void returnToBoard()} title="Back to the board (Esc)">
          <ArrowLeft size={16} />
          Back
        </button>
        <SaveStatus state={saveState} onRetry={() => void saverRef.current?.flush()} />
        <button type="button" className="primary-button" onClick={() => void returnToBoard()} title="Log note and return to the board (Ctrl+Enter)">
          Log note
          <kbd>Ctrl ↵</kbd>
        </button>
      </header>

      <div
        className={`focus-scroll${dropActive ? ' is-drop-target' : ''}`}
        onDragOver={(event) => {
          if (!hasFiles(event.dataTransfer)) return
          event.preventDefault()
          setDropActive(true)
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onContainerDrop}
        onContextMenu={onContextMenu}
        onMouseDown={(event) => {
          // Clicking the open space under the text continues writing at the end.
          if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('focus-column')) {
            event.preventDefault()
            editor.commands.focus('end')
          }
        }}
      >
        <div className="focus-column">
          {recovered ? (
            <p className="notice" role="status">
              The app did not close normally last time. This is the note you had open, as it was last saved; anything typed in the final moment before it closed may be missing.
            </p>
          ) : null}
          <input
            className="focus-title"
            type="text"
            value={title}
            placeholder="Title (optional)"
            aria-label="Title (optional)"
            maxLength={200}
            onChange={(event) => {
              setTitle(event.target.value)
              titleRef.current = event.target.value
              changed()
            }}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'ArrowDown') {
                event.preventDefault()
                editor.commands.focus('start')
              } else if (event.key === 'Enter') {
                event.preventDefault()
                void returnToBoard()
              }
            }}
          />
          <EditorContent editor={editor} className="focus-editor" />
          <TagRow
            tags={tags}
            onChange={(next) => {
              setTags(next)
              tagsRef.current = next
              changed()
            }}
          />
        </div>
      </div>

      <FormatBar editor={editor} onAddImage={() => fileInput.current?.click()} />
      <SelectionBubble editor={editor} />

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        multiple
        hidden
        data-testid="image-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) void insertImageFiles(editor, files).then(reportImageErrors)
        }}
      />

      <span ref={menuAnchor} className="context-anchor" style={menu ? { left: menu.x, top: menu.y } : undefined} />
      <Popover anchor={menuAnchor.current} open={menu !== null} onClose={closeMenu} role="menu" label="Edit" keepFocus>
        <MenuList
          onDone={closeMenu}
          keepFocus
          entries={[
            { label: 'Cut', icon: <Scissors size={15} />, hint: 'Ctrl+X', disabled: !hasSelection, onSelect: () => void api.edit('cut') },
            { label: 'Copy', icon: <Copy size={15} />, hint: 'Ctrl+C', disabled: !hasSelection, onSelect: () => void api.edit('copy') },
            { label: 'Paste', icon: <ClipboardPaste size={15} />, hint: 'Ctrl+V', onSelect: () => void api.edit('paste') },
            { label: 'Paste as plain text', icon: <Type size={15} />, hint: 'Ctrl+Shift+V', onSelect: () => void api.edit('pastePlain') },
            { kind: 'separator' },
            { label: 'Select all', icon: <TextSelect size={15} />, hint: 'Ctrl+A', onSelect: () => void api.edit('selectAll') }
          ]}
        />
      </Popover>
    </section>
  )
}
