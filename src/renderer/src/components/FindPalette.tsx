/**
 * Find notes (Ctrl+K) and the pinned index, in one collapsible palette.
 * Searching reads titles, body text, image captions and tags. It never changes the board;
 * choosing a result scrolls to the note and outlines it.
 */
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Pin, PinOff, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { noteLabel } from '@shared/content'
import { collectTags, searchNotes, type SearchResult, type Segment } from '@shared/search'
import type { Note } from '@shared/types'
import { useEscape } from '../lib/escape'
import { closePanel, openNote, openPanel, reorderPins, revealNote, togglePin } from '../state/actions'
import { useStore } from '../state/store'
import { IconButton, useFocusTrap } from './ui'

const RECENT_COUNT = 8

function Marked({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((segment, index) => (segment.match ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>))}
    </>
  )
}

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(timestamp).toLocaleDateString()
}

function toResult(note: Note): SearchResult {
  const snippet = note.plainText.replace(/\s+/g, ' ').trim()
  const label = noteLabel(note)
  return {
    id: note.id,
    label: [{ text: label, match: false }],
    snippet: note.title && snippet ? [{ text: snippet.length > 150 ? `${snippet.slice(0, 149)}…` : snippet, match: false }] : [],
    source: 'body',
    tags: note.tags,
    matchedTags: [],
    updatedAt: note.updatedAt,
    score: 0
  }
}

function ResultRow({ result, active, pinned, onHover, optionId }: { result: SearchResult; active: boolean; pinned: boolean; onHover: () => void; optionId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <div
      ref={ref}
      id={optionId}
      role="option"
      aria-selected={active}
      className={`result${active ? ' is-active' : ''}`}
      onMouseMove={onHover}
      onClick={() => void revealNote(result.id)}
      onDoubleClick={() => void revealNote(result.id).then(() => openNote(result.id))}
    >
      <div className="result-main">
        <div className="result-label">
          {pinned ? <Pin size={12} className="result-pin" aria-label="Pinned" /> : null}
          <Marked segments={result.label} />
        </div>
        {result.snippet.length > 0 ? (
          <div className="result-snippet">
            {result.source === 'caption' ? <span className="result-source">Caption</span> : null}
            <Marked segments={result.snippet} />
          </div>
        ) : null}
      </div>
      <div className="result-meta">
        {[...result.matchedTags, ...result.tags.filter((tag) => !result.matchedTags.includes(tag))].slice(0, Math.max(3, result.matchedTags.length)).map((tag) => (
          <span key={tag} className={`result-tag${result.matchedTags.includes(tag) ? ' is-match' : ''}`}>{tag}</span>
        ))}
        <span>{ago(result.updatedAt)}</span>
      </div>
    </div>
  )
}

function SortablePin({ note }: { note: Note }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: note.id })
  const snippet = note.title ? note.plainText.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  return (
    <div ref={setNodeRef} className={`pin-row${isDragging ? ' is-dragging' : ''}`} style={{ transform: CSS.Translate.toString(transform), transition }}>
      <button ref={setActivatorNodeRef} type="button" className="icon-button pin-handle" {...attributes} {...listeners} aria-label={`Reorder ${noteLabel(note, 40)}`} title="Drag to reorder. With the keyboard: Space, then arrow keys.">
        <GripVertical size={15} />
      </button>
      <button type="button" className="pin-open" onClick={() => void revealNote(note.id)}>
        <span className="result-label">{noteLabel(note)}</span>
        {snippet ? <span className="result-snippet">{snippet}</span> : null}
      </button>
      <IconButton label="Unpin" onClick={() => togglePin(note.id)}>
        <PinOff size={15} />
      </IconButton>
    </div>
  )
}

function PinnedIndex() {
  const pins = useStore((s) => s.pins)
  const notes = useStore((s) => s.notes)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const pinned = pins.map((id) => notes[id]).filter((note): note is Note => !!note)
  const [sorting, setSorting] = useState(false)
  // While an entry is being moved, Esc belongs to the move (it cancels it), not to the palette.
  useEscape(sorting, () => undefined, { passthrough: true })

  const onDragEnd = (event: DragEndEvent): void => {
    setSorting(false)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = pins.indexOf(String(active.id))
    const to = pins.indexOf(String(over.id))
    if (from !== -1 && to !== -1) reorderPins(arrayMove(pins, from, to))
  }

  if (pinned.length === 0) {
    return <p className="palette-empty">Nothing pinned yet. Hover a note and choose Pin to keep a rule or setup one step away.</p>
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => setSorting(true)} onDragCancel={() => setSorting(false)} onDragEnd={onDragEnd}>
      <SortableContext items={pinned.map((n) => n.id)} strategy={verticalListSortingStrategy}>
        <div className="pin-list" data-testid="pin-list">
          {pinned.map((note) => (
            <SortablePin key={note.id} note={note} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

export function FindPalette({ mode }: { mode: 'find' | 'pins' }) {
  const notes = useStore((s) => s.notes)
  const pins = useStore((s) => s.pins)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEscape(true, closePanel)
  useFocusTrap(panel, true)
  // The keyboard goes into the palette as soon as it opens: the search field, or the first
  // pinned entry, one Enter away (the Pinned tab when nothing is pinned yet). Switching to
  // the pinned list by its tab leaves the keyboard on the tab the user just used.
  useEffect(() => {
    if (mode === 'find') {
      input.current?.focus()
      return
    }
    const tab = panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (tab && document.activeElement === tab) return
    ;(panel.current?.querySelector<HTMLElement>('.pin-open') ?? tab)?.focus()
  }, [mode])

  const all = useMemo(() => Object.values(notes), [notes])
  const tags = useMemo(() => collectTags(all), [all])
  const pinSet = useMemo(() => new Set(pins), [pins])
  const searching = query.trim().length > 0 || tag !== null

  const sections = useMemo(() => {
    if (searching) return [{ title: null as string | null, results: searchNotes(all, query, { tag, limit: 60 }) }]
    const pinned = pins.map((id) => notes[id]).filter((note): note is Note => !!note).map(toResult)
    const recent = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_COUNT).map(toResult)
    return [
      { title: 'Pinned', results: pinned },
      { title: 'Recently edited', results: recent }
    ].filter((section) => section.results.length > 0)
  }, [searching, all, query, tag, pins, notes])

  const flat = sections.flatMap((section) => section.results)
  useEffect(() => setActive(0), [query, tag, mode])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => Math.min(flat.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = flat[active]
      if (!chosen) return
      if (event.ctrlKey || event.metaKey) void revealNote(chosen.id).then(() => openNote(chosen.id))
      else void revealNote(chosen.id)
    }
  }

  let counter = -1
  return (
    <div
      className="palette-layer"
      data-overlay
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePanel()
      }}
    >
      <div ref={panel} className="palette" role="dialog" aria-modal="true" aria-label={mode === 'find' ? 'Find notes' : 'Pinned notes'} data-testid="palette">
        <div className="palette-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'find'} className={mode === 'find' ? 'is-selected' : ''} onClick={() => openPanel('find')}>
            Find
          </button>
          <button type="button" role="tab" aria-selected={mode === 'pins'} className={mode === 'pins' ? 'is-selected' : ''} onClick={() => openPanel('pins')}>
            Pinned{pins.length > 0 ? ` ${pins.length}` : ''}
          </button>
        </div>

        {mode === 'pins' ? (
          <div className="palette-body">
            <PinnedIndex />
          </div>
        ) : (
          <>
            <label className="palette-input">
              <Search size={16} aria-hidden />
              <input
                ref={input}
                type="text"
                value={query}
                placeholder="Find a word in your notes"
                aria-label="Find notes"
                role="combobox"
                aria-expanded="true"
                aria-controls="find-results"
                aria-activedescendant={flat[active] ? `find-option-${active}` : undefined}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
              />
            </label>
            {tags.length > 0 ? (
              <div className="palette-tags" aria-label="Filter by tag">
                {tags.slice(0, 10).map((name) => (
                  <button key={name} type="button" className={`tag-filter${tag === name ? ' is-selected' : ''}`} aria-pressed={tag === name} onClick={() => setTag(tag === name ? null : name)}>
                    {name}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="palette-body" id="find-results" role="listbox" aria-label="Results">
              {flat.length === 0 ? (
                <p className="palette-empty">
                  {searching ? 'No notes contain that. Search reads titles, text, captions and tags; text inside screenshots is not searched.' : 'Your notes will appear here once you have written some.'}
                </p>
              ) : (
                sections.map((section) => (
                  <div key={section.title ?? 'results'} className="palette-section">
                    {section.title ? <div className="palette-heading">{section.title}</div> : null}
                    {section.results.map((result) => {
                      counter++
                      const index = counter
                      return (
                        <ResultRow
                          key={`${section.title}-${result.id}`}
                          result={result}
                          active={index === active}
                          pinned={pinSet.has(result.id) && section.title !== 'Pinned'}
                          optionId={`find-option-${index}`}
                          onHover={() => setActive(index)}
                        />
                      )
                    })}
                  </div>
                ))
              )}
            </div>
            <div className="palette-foot">
              <span><kbd>↵</kbd> show on board</span>
              <span><kbd>Ctrl ↵</kbd> open</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
