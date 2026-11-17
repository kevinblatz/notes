/**
 * Window state. Notes, layout and pins mirror what the main process has stored; everything
 * else is view state (which screen is showing, open panels, toasts, undo history).
 */
import { create } from 'zustand'
import { DEFAULT_PREFERENCES, type AppInfo, type BoardLayout, type Note, type Placement, type Preferences, type ShortcutStatus, type WindowStatus } from '@shared/types'

/** Where to put the caret when a note opens: the block and character the user clicked. */
export interface CaretHint {
  blockIndex: number
  textOffset: number
}

export type View =
  | { mode: 'board' }
  | {
      mode: 'note'
      noteId: string
      /** True for a draft that has not been stored yet. */
      isNew: boolean
      placement: Placement | null
      caret: CaretHint | null
      /** Images dropped on the board that should be inserted as soon as the editor is ready. */
      initialFiles: File[]
    }

export type Panel = 'find' | 'pins' | 'settings' | 'backup' | 'trash'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
  action?: { label: string; run: () => void }
}

export type UndoEntry =
  | { kind: 'layout'; before: BoardLayout; label: string }
  | { kind: 'trash'; noteId: string; label: string }

export interface ImagePreviewState {
  attachmentId: string
  caption: string
}

export interface AppState {
  ready: boolean
  loadError: string | null
  notes: Record<string, Note>
  layout: BoardLayout
  pins: string[]
  trashCount: number
  prefs: Preferences
  shortcut: ShortcutStatus
  windowStatus: WindowStatus
  app: AppInfo | null
  view: View
  panel: Panel | null
  gearOpen: boolean
  preview: ImagePreviewState | null
  toasts: Toast[]
  /** Note to scroll to and briefly outline on the board. */
  spotlight: { noteId: string; token: number } | null
  /** Shown once after a restart that followed an unclean exit. */
  recoveredNotice: boolean
  shortcutNoticeDismissed: boolean
  undo: UndoEntry[]
  /** Screen-reader announcement (aria-live). */
  announcement: string
}

export const useStore = create<AppState>(() => ({
  ready: false,
  loadError: null,
  notes: {},
  layout: { rows: [] },
  pins: [],
  trashCount: 0,
  prefs: DEFAULT_PREFERENCES,
  shortcut: { accelerator: DEFAULT_PREFERENCES.shortcut, registered: true, error: null },
  windowStatus: { dock: 'right', alwaysOnTop: true, focused: true, maximized: false },
  app: null,
  view: { mode: 'board' },
  panel: null,
  gearOpen: false,
  preview: null,
  toasts: [],
  spotlight: null,
  recoveredNotice: false,
  shortcutNoticeDismissed: false,
  undo: [],
  announcement: ''
}))

export const getState = useStore.getState
export const setState = useStore.setState
