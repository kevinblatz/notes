/**
 * Whether the drawing space is open over the note, and for what: a new drawing for the caret,
 * or an existing drawing reopened from its image controls. The format bar hosts the space;
 * the image controls only ask for it here.
 */
import { create } from 'zustand'

export type DrawingTarget =
  | { kind: 'new' }
  | {
      kind: 'edit'
      attachmentId: string
      /** Pixels per CSS pixel the drawing was saved at (null: unknown, the screen's own is assumed). */
      scale: number | null
      /** Where the image block was when editing started (it is looked up again on Done). */
      getPos: () => number | undefined
    }

export const useDrawingSession = create<{ target: DrawingTarget | null }>(() => ({ target: null }))

export function openDrawing(target: DrawingTarget): void {
  if (useDrawingSession.getState().target) return
  useDrawingSession.setState({ target })
}

export function closeDrawing(): void {
  useDrawingSession.setState({ target: null })
}

export function isDrawingOpen(): boolean {
  return useDrawingSession.getState().target !== null
}
