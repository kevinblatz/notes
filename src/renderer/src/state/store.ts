/**
 * Window state. Notes, layout and pins mirror what the main process has stored; everything
 * else is view state (which screen is showing, open panels, toasts, undo history).
 */
import { create } from 'zustand'
import { bindingsFromPreferences, HOTKEY_IDS } from '@shared/hotkeys'
import type { MoveAnchor } from '@shared/layout'
import {
  DEFAULT_PREFERENCES,
  type AppInfo,
  type BoardLayout,
  type HotkeyStatuses,
  type Note,
  type Placement,
  type Preferences,
  type ShortcutStatus,
  type WindowStatus
} from '@shared/types'

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
  | { kind: 'layout'; before: BoardLayout; after: BoardLayout; noteId: string | null; anchor: MoveAnchor | null; label: string }
  | { kind: 'trash'; noteId: string; label: string }

/** Quick note or the risk calculator, open because its hotkey was pressed. */
export interface CaptureState {
  kind: 'quickNote' | 'risk'
  /** Names the typing session in the main process; ending it gives the keyboard back. */
  token: number
  /** When the hotkey was pressed (app clock): the time a quick note line carries. */
  at: number
  /** Counts presses within the session, so a press during a save keeps the strip open for another line. */
  presses: number
}

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
  hotkeys: HotkeyStatuses
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
  capture: CaptureState | null
  /** Added to Date.now() for the app's clock; only the automated tests move it. */
  clockOffsetMs: number
  /** Candle closes announced by the main process since the window loaded. */
  candleCloses: number
}

function defaultStatuses(): HotkeyStatuses {
  const bindings = bindingsFromPreferences(DEFAULT_PREFERENCES)
  return Object.fromEntries(HOTKEY_IDS.map((id) => [id, { id, ...bindings[id], registered: bindings[id].enabled, error: null }])) as HotkeyStatuses
}

export const useStore = create<AppState>(() => ({
  ready: false,
  loadError: null,
  notes: {},
  layout: { rows: [] },
  pins: [],
  trashCount: 0,
  prefs: DEFAULT_PREFERENCES,
  shortcut: { accelerator: DEFAULT_PREFERENCES.shortcut, enabled: true, registered: true, error: null },
  hotkeys: defaultStatuses(),
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
  announcement: '',
  capture: null,
  clockOffsetMs: 0,
  candleCloses: 0
}))

export const getState = useStore.getState
export const setState = useStore.setState

/** The app's clock: the system clock, unless an automated test moved it. */
export function appNow(): number {
  return Date.now() + getState().clockOffsetMs
}
