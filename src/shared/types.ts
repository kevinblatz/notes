/**
 * Shared data model. Everything here is plain JSON so it can cross the IPC bridge,
 * be written to SQLite, and be exported in a backup without translation.
 */
import { DEFAULT_CANDLE_MINUTES, type CandleMinutes } from './candles'
import { DEFAULT_HOTKEYS, type HotkeyBindings, type HotkeyId } from './hotkeys'
import type { InstrumentKey, StopUnit } from './risk'

/** ProseMirror/Tiptap-compatible structured document. This is the source of truth for note content. */
export interface RichMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface RichNode {
  type: string
  attrs?: Record<string, unknown>
  content?: RichNode[]
  marks?: RichMark[]
  text?: string
}

export interface RichDoc {
  type: 'doc'
  content?: RichNode[]
}

export interface Note {
  id: string
  /**
   * Record type. Only 'note' exists today. A future trading journal can add kinds such as
   * 'trade' and keep their structured fields in `extra` (or a dedicated table) without
   * changing how notes are stored, laid out, pinned or searched.
   */
  kind: string
  title: string | null
  content: RichDoc
  /** Derived from content on every save; used for search, snippets and fallback labels. */
  plainText: string
  /** Image captions, derived from content on every save. */
  captions: string
  tags: string[]
  collapsed: boolean
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  /** Incremented on every successful save. A save must name the revision it was based on. */
  revision: number
  /** Reserved for future structured fields (trade symbol, direction, R multiple, ...). */
  extra: Record<string, unknown>
}

/** A board row holds one note (full width) or two notes (a side-by-side pair, left to right). */
export interface BoardRow {
  id: string
  notes: string[]
}

export interface BoardLayout {
  rows: BoardRow[]
}

/**
 * Where a note goes on the board.
 *  - row:  becomes a new full-width row at `index` (0 = top, rows.length = bottom).
 *  - slot: joins the row `rowId` at position `index` (0 = left of everything in that row).
 *          If the row already holds two notes, one of them is displaced into its own adjacent
 *          row; see `insertNote` in layout.ts for the exact rule.
 */
export type Placement = { kind: 'row'; index: number } | { kind: 'slot'; rowId: string; index: number }

/** Remembered board position of a trashed note so restoring puts it back where it was. */
export interface TrashOrigin {
  rowIndex: number
  slot: number
  partnerId: string | null
  /** Last note of the row that was above it (null = it was in the top row). Absent in older records. */
  previousNoteId?: string | null
}

export interface AttachmentMeta {
  id: string
  mime: string
  width: number | null
  height: number | null
  byteSize: number
  originalName: string | null
  hasPreview: boolean
  createdAt: number
}

export type FontKey = 'sans' | 'serif' | 'mono' | 'system'
export type ThemeKey = 'charcoal' | 'midnight' | 'paper'
export type DockSide = 'left' | 'right'
export type ReducedMotion = 'system' | 'on' | 'off'

export interface Preferences {
  dockSide: DockSide
  alwaysOnTop: boolean
  launchAtStartup: boolean
  /** Electron accelerator string, e.g. "Control+Shift+Space". */
  shortcut: string
  /** The show/hide shortcut is registered at all (it can be switched off in Settings). */
  shortcutEnabled: boolean
  /** The trading hotkeys (quick note, snapshot, risk calculator, ...). */
  hotkeys: HotkeyBindings
  fontFamily: FontKey
  fontSize: number
  theme: ThemeKey
  reducedMotion: ReducedMotion
  /** How opaque the notes window is, from MIN_WINDOW_OPACITY to 1 (solid). */
  windowOpacity: number
  /**
   * While see-through: turn solid while the pointer is over the notes or they have the keyboard.
   * Off by default, so notes taken over something stay see-through while you write them.
   */
  opacitySolidOnHover: boolean
  /** The formatting bar under an open note is folded away. */
  formatBarCollapsed: boolean
  /** The see-through opacity last chosen (below 1); the see-through hotkey goes back to it. */
  seeThroughOpacity: number
  /** The candle countdown chip is showing in the title bar. */
  candleTimer: boolean
  candleMinutes: CandleMinutes
  /** A soft chime at each candle close. */
  candleChime: boolean
  /** Risk calculator: the instrument, dollar risk (in cents) and stop unit last used. */
  riskInstrument: InstrumentKey
  riskCents: number | null
  riskUnit: StopUnit
  /** Underline misspelled words (the app's own checker; Organize works either way). */
  spellcheck: boolean
  /** Words added to the spelling dictionary with "Add to dictionary": never underlined or changed. */
  spellingWords: string[]
}

export const DEFAULT_PREFERENCES: Preferences = {
  dockSide: 'right',
  alwaysOnTop: true,
  launchAtStartup: false,
  shortcut: 'Control+Shift+Space',
  fontFamily: 'sans',
  fontSize: 17,
  theme: 'charcoal',
  reducedMotion: 'system',
  windowOpacity: 1,
  opacitySolidOnHover: false,
  formatBarCollapsed: false,
  shortcutEnabled: true,
  hotkeys: DEFAULT_HOTKEYS,
  seeThroughOpacity: 0.7,
  candleTimer: false,
  candleMinutes: DEFAULT_CANDLE_MINUTES,
  candleChime: true,
  riskInstrument: 'MES',
  riskCents: null,
  riskUnit: 'points',
  spellcheck: true,
  spellingWords: []
}

export interface ShortcutStatus {
  accelerator: string
  /** False when the user switched this shortcut off in Settings. */
  enabled: boolean
  registered: boolean
  /** Human-readable reason when registration failed. */
  error: string | null
}

/** One global hotkey as the system has it right now. */
export interface HotkeyStatus extends ShortcutStatus {
  id: HotkeyId
}

export type HotkeyStatuses = Record<HotkeyId, HotkeyStatus>

export interface WindowStatus {
  dock: DockSide | 'custom'
  alwaysOnTop: boolean
  focused: boolean
  maximized: boolean
}

export interface SessionInfo {
  /** Note that was open in the editor when the app last stopped, if it still exists. */
  openNoteId: string | null
  /** True when the previous run did not shut down cleanly. */
  recoveredFromUncleanExit: boolean
}

export interface AppInfo {
  version: string
  dataDir: string
  platform: string
  schemaVersion: number
}

/** Everything the window needs at startup, in one round trip. */
export interface Snapshot {
  notes: Note[]
  layout: BoardLayout
  pins: string[]
  preferences: Preferences
  trashCount: number
  session: SessionInfo
  shortcut: ShortcutStatus
  hotkeys: HotkeyStatuses
  window: WindowStatus
  app: AppInfo
  /** Test runs can set the app's clock; 0 in normal use. */
  clockOffsetMs: number
}

export interface TrashEntry {
  id: string
  label: string
  snippet: string
  imageCount: number
  deletedAt: number
}

export interface CreateNoteInput {
  id: string
  title: string | null
  content: RichDoc
  tags: string[]
  placement: Placement
}

export interface SaveNoteInput {
  id: string
  /** Revision the edit was based on. A mismatch means the save is stale and is rejected. */
  expectedRevision: number
  title?: string | null
  content?: RichDoc
  tags?: string[]
  collapsed?: boolean
}

export type SaveNoteResult =
  | { ok: true; note: Note }
  | { ok: false; reason: 'stale'; current: Note }
  | { ok: false; reason: 'missing' }

export interface CreateNoteResult {
  note: Note
  layout: BoardLayout
}

export interface LayoutResult {
  layout: BoardLayout
  pins: string[]
  trashCount: number
}

export interface RestoreResult extends LayoutResult {
  note: Note
}

export interface ImportImageInput {
  bytes: ArrayBuffer
  name: string | null
  width: number | null
  height: number | null
  preview: { bytes: ArrayBuffer; width: number; height: number } | null
}

export interface ExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  noteCount?: number
  attachmentCount?: number
  byteSize?: number
  /** Images a note refers to whose file was missing on disk, so they are not in the backup. */
  missingFiles?: number
  error?: string
}

export interface ImportPreview {
  /** Opaque handle to the inspected file, valid until the next inspection or app exit. */
  token: string
  fileName: string
  createdAt: number | null
  appVersion: string | null
  noteCount: number
  trashedCount: number
  attachmentCount: number
  pinCount: number
  /** Images that notes reference but the archive does not contain. */
  missingAttachments: number
  /** Notes in the backup whose ID already exists in the current collection. */
  overlappingNotes: number
  warnings: string[]
  currentNoteCount: number
}

export type ImportMode = 'merge' | 'replace'

export interface ImportResult {
  ok: boolean
  mode: ImportMode
  added: number
  skipped: number
  copied: number
  attachmentsImported: number
  missingAttachments: number
  /** Where the automatic safety copy of the previous collection was written (replace only). */
  safetyBackupPath: string | null
  error?: string
}

export type EditCommand = 'cut' | 'copy' | 'paste' | 'pastePlain' | 'selectAll' | 'undo' | 'redo'

/** Events pushed from the main process to the window. */
export interface MainEvents {
  'flush-request': { token: string }
  'shortcut-status': ShortcutStatus
  'window-status': WindowStatus
  'preferences-changed': Preferences
  'data-replaced': null
  'command': { name: 'find' | 'settings' | 'new-note' }
  'hotkey-status': HotkeyStatuses
  /** A hotkey that the window acts on was pressed (or chosen in the tray). */
  'hotkey': HotkeyEvent
  'snapshot': SnapshotEvent
  /** A candle closed (sent by the main process, which keeps time while the window is hidden). */
  'candle-close': { at: number; minutes: CandleMinutes }
  /** Test runs only: the app's clock was moved. */
  'clock': { offsetMs: number }
}

export type HotkeyEvent =
  /** Typing hotkeys: the window has the keyboard until it calls endTyping(token). */
  | { action: 'quickNote' | 'risk'; token: number; at: number }
  | { action: 'openLog'; at: number }
  | { action: 'seeThrough'; opacity: number }

export type SnapshotEvent =
  | { ok: true; at: number; attachment: AttachmentMeta; width: number; height: number; caption: string; windowShown: boolean }
  | { ok: false; at: number; message: string; windowShown: boolean }

export interface SessionLogResult {
  note: Note
  layout: BoardLayout
  created: boolean
}

export const ATTACHMENT_SCHEME = 'tn-attachment'

export function attachmentUrl(id: string, variant: 'preview' | 'full'): string {
  return `${ATTACHMENT_SCHEME}://file/${encodeURIComponent(id)}?v=${variant}`
}
