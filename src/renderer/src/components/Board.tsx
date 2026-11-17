/**
 * The board: one vertical scrolling surface of notes.
 *
 *  - Clicking genuinely empty space starts a draft at that logical position.
 *  - Notes are rearranged by dragging their handle; the board reflows live to show exactly
 *    where the note will land, and the other notes move aside to make room.
 *  - Image files dropped on the board start an image note at the drop position.
 */
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type Modifier } from '@dnd-kit/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { hitDrag, hitEmptySpace, placementsEqual, type BoardGeometry, type Indicator } from '@shared/boardGeometry'
import { noteLabel } from '@shared/content'
import { findNote, insertNote, liftNote, placementOf } from '@shared/layout'
import type { BoardLayout, Placement } from '@shared/types'
import { overlayDepth } from '../lib/escape'
import { captureBoardPositions, motionReduced, playBoardAnimation, registerBoard } from '../lib/flip'
import { hasFiles, imageFilesFrom } from '../lib/images'
import { dropNote, startDraft } from '../state/actions'
import { useStore } from '../state/store'
import { NoteCard } from './NoteCard'

/** Content width from which a pair is shown side by side instead of stacked. */
const WIDE_FROM = 700
const CLICK_SLOP = 5

interface DragState {
  id: string
  base: BoardLayout
  target: Placement
}

function readGeometry(board: HTMLElement, wide: boolean): BoardGeometry {
  const style = getComputedStyle(board)
  const boxes = Array.from(board.querySelectorAll<HTMLElement>(':scope > [data-note-id]'), (element) => ({
    id: element.dataset.noteId!,
    rowId: element.dataset.rowId!,
    left: element.offsetLeft,
    top: element.offsetTop,
    width: element.offsetWidth,
    height: element.offsetHeight
  }))
  return {
    contentLeft: parseFloat(style.paddingLeft) || 0,
    contentRight: board.clientWidth - (parseFloat(style.paddingRight) || 0),
    wide,
    gap: parseFloat(style.rowGap) || 16,
    boxes
  }
}

/** Keep the small drag chip next to the pointer instead of where the note's corner was. */
const chipAtPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent || !('clientX' in activatorEvent)) return transform
  const event = activatorEvent as PointerEvent
  return { ...transform, x: transform.x + event.clientX - draggingNodeRect.left + 10, y: transform.y + event.clientY - draggingNodeRect.top + 10 }
}

export function Board({ hidden }: { hidden: boolean }) {
  const layout = useStore((s) => s.layout)
  const notes = useStore((s) => s.notes)
  const pins = useStore((s) => s.pins)
  const spotlight = useStore((s) => s.spotlight)
  const ready = useStore((s) => s.ready)

  const scroller = useRef<HTMLDivElement>(null)
  const board = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)
  const pointer = useRef({ x: 0, y: 0 })
  const press = useRef<{ x: number; y: number; scrollTop: number } | null>(null)
  const frame = useRef(0)

  const [wide, setWide] = useState(true)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [indicator, setIndicator] = useState<Indicator | null>(null)
  const [spotId, setSpotId] = useState<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  const pinSet = useMemo(() => new Set(pins), [pins])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // While dragging, draw the board as it would be if the note were dropped right now.
  const shown = useMemo(() => {
    if (!drag) return layout
    let n = 0
    return insertNote(drag.base, drag.id, drag.target, () => `preview-row-${n++}`)
  }, [layout, drag])

  useEffect(() => {
    registerBoard(board.current)
    return () => registerBoard(null)
  }, [])

  useEffect(() => {
    const element = board.current
    if (!element) return
    const measure = (): void => {
      const style = getComputedStyle(element)
      const content = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      if (content > 0) setWide(content >= WIDE_FROM)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Notes glide to their new places after every layout change that asked for it.
  useLayoutEffect(() => {
    playBoardAnimation()
  }, [shown, notes])

  // Leaving for the editor and coming back must not lose the reader's place.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (!hidden) element.scrollTop = savedScroll.current
  }, [hidden])

  // Reveal and briefly outline a note (after editing it, or when picked from search or pins).
  useEffect(() => {
    if (!spotlight || hidden) return
    const element = board.current?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(spotlight.noteId)}"]`)
    if (!element) return
    element.scrollIntoView({ block: 'nearest', behavior: motionReduced() ? 'auto' : 'smooth' })
    setSpotId(spotlight.noteId)
    const timer = window.setTimeout(() => setSpotId(null), 1700)
    return () => window.clearTimeout(timer)
  }, [spotlight, hidden])

  const boardPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = board.current!.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  // ------------------------------------------------------------ empty-space click

  const emptyHit = (clientX: number, clientY: number) => {
    const element = board.current!
    const point = boardPoint(clientX, clientY)
    return hitEmptySpace(readGeometry(element, wide), layout, point.x, point.y)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    press.current = null
    // Only a plain primary-button press that starts on the bare board counts, and not one
    // that is closing a menu or clearing a text selection.
    if (event.target !== event.currentTarget || event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return
    if (overlayDepth() > 0) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().length > 0) return
    press.current = { x: event.clientX, y: event.clientY, scrollTop: scroller.current?.scrollTop ?? 0 }
  }

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const start = press.current
    press.current = null
    if (!start || event.target !== event.currentTarget || dragRef.current) return
    // A drag, a scroll or a selection gesture is not a click on empty space.
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return
    if (Math.abs((scroller.current?.scrollTop ?? 0) - start.scrollTop) > 1) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().length > 0) return
    setIndicator(null)
    startDraft(emptyHit(event.clientX, event.clientY).placement)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current) return
    if (event.target !== event.currentTarget || event.buttons !== 0 || overlayDepth() > 0) {
      if (indicator) setIndicator(null)
      return
    }
    const { clientX, clientY } = event
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      if (!board.current || dragRef.current) return
      setIndicator(emptyHit(clientX, clientY).indicator)
    })
  }

  const clearIndicator = (): void => {
    cancelAnimationFrame(frame.current)
    setIndicator(null)
  }

  // ------------------------------------------------------------ dragging notes

  const updateDragTarget = useCallback(() => {
    const current = dragRef.current
    const element = board.current
    if (!current || !element) return
    const rect = element.getBoundingClientRect()
    const next = hitDrag(readGeometry(element, wide), current.base, pointer.current.x - rect.left, pointer.current.y - rect.top, current.id, current.target)
    if (placementsEqual(next, current.target)) return
    captureBoardPositions()
    const updated = { ...current, target: next }
    dragRef.current = updated
    setDrag(updated)
  }, [wide])

  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent): void => {
      pointer.current = { x: event.clientX, y: event.clientY }
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(updateDragTarget)
    }
    const onScroll = (): void => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(updateDragTarget)
    }
    const element = scroller.current
    window.addEventListener('pointermove', onMove)
    element?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      element?.removeEventListener('scroll', onScroll)
    }
    // Only (re)attach when a drag starts or ends, not on every target change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id, updateDragTarget])

  const onDragStart = (event: DragStartEvent): void => {
    const id = String(event.active.id)
    const target = placementOf(layout, id)
    if (!target) return
    const activator = event.activatorEvent as PointerEvent
    pointer.current = { x: activator.clientX, y: activator.clientY }
    setIndicator(null)
    captureBoardPositions()
    const state = { id, base: liftNote(layout, id), target }
    dragRef.current = state
    setDrag(state)
  }

  const finishDrag = (commit: boolean): void => {
    const current = dragRef.current
    if (!current) return
    cancelAnimationFrame(frame.current)
    captureBoardPositions()
    dragRef.current = null
    setDrag(null)
    if (commit) dropNote(current.id, current.target)
  }

  const onDragEnd = (_event: DragEndEvent): void => finishDrag(true)
  const onDragCancel = (): void => finishDrag(false)

  // ------------------------------------------------------------ dropping image files

  const onFileDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (event.target === board.current) setIndicator(emptyHit(event.clientX, event.clientY).indicator)
    else setIndicator(null)
  }

  const onFileDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    setIndicator(null)
    const files = imageFilesFrom(event.dataTransfer)
    if (files.length === 0) return
    let placement: Placement
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-note-id]')
    const position = card ? findNote(layout, card.dataset.noteId!) : null
    // Dropped onto an existing note: the new image note goes directly below it.
    if (position) placement = { kind: 'row', index: position.rowIndex + 1 }
    else placement = emptyHit(event.clientX, event.clientY).placement
    startDraft(placement, files)
  }

  const dragged = drag ? notes[drag.id] : null
  const empty = ready && layout.rows.length === 0

  return (
    <div
      ref={scroller}
      className="board-scroll"
      hidden={hidden}
      data-testid="board-scroll"
      onScroll={(event) => {
        // Remembered continuously, because a hidden element reports a scroll position of 0.
        if (!hidden) savedScroll.current = event.currentTarget.scrollTop
      }}
    >
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        autoScroll={{ threshold: { x: 0, y: 0.14 }, acceleration: 14 }}
        accessibility={{
          screenReaderInstructions: { draggable: 'Drag with the mouse to move this note. With the keyboard, focus the note and press Alt with an arrow key.' },
          announcements: { onDragStart: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => 'Move cancelled.' }
        }}
      >
        <div
          ref={board}
          className={`board${wide ? ' is-wide' : ' is-stacked'}${drag ? ' is-dragging' : ''}${empty ? ' is-empty' : ''}`}
          data-testid="board"
          onPointerDown={onPointerDown}
          onClick={onClick}
          onPointerMove={onPointerMove}
          onPointerLeave={clearIndicator}
          onDragOver={onFileDragOver}
          onDragLeave={clearIndicator}
          onDrop={onFileDrop}
        >
          {empty ? <p className="board-hint">Click anywhere to write</p> : null}
          {shown.rows.flatMap((row) =>
            row.notes.map((id, slot) => {
              const note = notes[id]
              if (!note) return null
              return (
                <NoteCard
                  key={id}
                  note={note}
                  rowId={row.id}
                  slot={slot}
                  paired={row.notes.length === 2}
                  pinned={pinSet.has(id)}
                  placeholder={drag?.id === id}
                  spotlit={spotId === id}
                />
              )
            })
          )}
          {indicator && !drag ? (
            <span
              className={`insert-mark is-${indicator.orientation}`}
              style={indicator.orientation === 'horizontal' ? { left: indicator.x, top: indicator.y, width: indicator.length } : { left: indicator.x, top: indicator.y, height: indicator.length }}
              aria-hidden
            />
          ) : null}
        </div>
        <DragOverlay dropAnimation={null} modifiers={[chipAtPointer]} zIndex={50}>
          {dragged ? <div className="drag-chip">{noteLabel(dragged, 44)}</div> : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
