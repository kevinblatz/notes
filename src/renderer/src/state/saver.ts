/**
 * Autosave for the note being edited.
 *
 * - Edits are written after a short pause in typing (DEBOUNCE_MS), and immediately on demand.
 *   Someone typing without ever pausing still gets a save at least every MAX_WAIT_MS.
 * - Only one save is ever in flight. A save always sends the newest content at the moment it
 *   starts, and names the revision it is based on, so an older write can never replace
 *   newer typing: the main process rejects any save whose base revision is out of date.
 * - A brand-new note is created on its first non-empty save. Until then nothing is stored,
 *   which is what lets an untouched draft disappear without a trace.
 * - A failed save keeps the content in the editor, reports the error, and retries.
 */
import { isContentEmpty } from '@shared/content'
import type { BoardLayout, Note, Placement, RichDoc } from '@shared/types'
import { api } from '../lib/api'

export const DEBOUNCE_MS = 450
/** Longest that typed text waits for its first save attempt, however fast the typing. */
export const MAX_WAIT_MS = 1500
const RETRY_DELAYS = [1500, 4000, 10000, 20000]

export interface DraftSnapshot {
  title: string | null
  content: RichDoc
  tags: string[]
}

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }

export interface SaverOptions {
  id: string
  /** The stored note, or null for a draft that has not been written yet. */
  existing: Note | null
  placement: Placement | null
  read: () => DraftSnapshot
  onState: (state: SaveState) => void
  onSaved: (note: Note, layout: BoardLayout | null) => void
}

export class NoteSaver {
  private revision: number | null
  private dirty = false
  /** When the oldest change that has not been sent for saving was made. */
  private dirtySince: number | null = null
  private timer: number | null = null
  private retryTimer: number | null = null
  private running: Promise<boolean> | null = null
  private failures = 0
  private disposed = false
  private state: SaveState = { kind: 'idle' }

  constructor(private readonly options: SaverOptions) {
    this.revision = options.existing ? options.existing.revision : null
  }

  get created(): boolean {
    return this.revision !== null
  }

  get current(): SaveState {
    return this.state
  }

  private setState(state: SaveState): void {
    this.state = state
    if (!this.disposed) this.options.onState(state)
  }

  /** Note that the content changed; a save follows after a short pause. */
  touch(): void {
    this.dirty = true
    const now = Date.now()
    if (this.dirtySince === null) this.dirtySince = now
    if (this.state.kind !== 'saving' && this.state.kind !== 'error') this.setState({ kind: 'pending' })
    if (this.timer !== null) window.clearTimeout(this.timer)
    // Wait for a pause in typing, but never longer than MAX_WAIT_MS since the oldest unsaved change.
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - this.dirtySince)))
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.run()
    }, delay)
  }

  /** Write now. Resolves true once everything typed so far is stored (or there was nothing to store). */
  async flush(): Promise<boolean> {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    return this.run()
  }

  private run(): Promise<boolean> {
    if (this.running) {
      // A save is in flight; once it ends, run again if more was typed meanwhile.
      return this.running.then((ok) => (this.dirty ? this.run() : ok))
    }
    if (!this.dirty) return Promise.resolve(this.state.kind !== 'error')
    this.running = this.saveLoop().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async saveLoop(): Promise<boolean> {
    while (this.dirty) {
      this.dirty = false
      this.dirtySince = null
      const snapshot = this.options.read()
      try {
        if (this.revision === null) {
          if (isContentEmpty(snapshot.title, snapshot.content)) {
            this.setState({ kind: 'idle' })
            continue
          }
          this.setState({ kind: 'saving' })
          const created = await api.createNote({
            id: this.options.id,
            title: snapshot.title,
            content: snapshot.content,
            tags: snapshot.tags,
            placement: this.options.placement ?? { kind: 'row', index: Number.MAX_SAFE_INTEGER }
          })
          this.revision = created.note.revision
          this.options.onSaved(created.note, created.layout)
        } else {
          this.setState({ kind: 'saving' })
          let result = await api.saveNote({ id: this.options.id, expectedRevision: this.revision, ...snapshot })
          if (!result.ok && result.reason === 'stale') {
            // Something else touched the note (for example a checklist tick on the board).
            // The editor holds the newest writing, so save again on top of the stored revision.
            result = await api.saveNote({ id: this.options.id, expectedRevision: result.current.revision, ...snapshot })
          }
          if (!result.ok) {
            throw new Error(result.reason === 'missing' ? 'This note is no longer in your collection (it may have been deleted).' : 'The note changed elsewhere while saving.')
          }
          this.revision = result.note.revision
          this.options.onSaved(result.note, null)
        }
        this.failures = 0
        this.setState({ kind: 'saved', at: Date.now() })
      } catch (error) {
        this.dirty = true
        this.failures++
        this.setState({ kind: 'error', message: cleanMessage(error) })
        if (!this.disposed) {
          const delay = RETRY_DELAYS[Math.min(this.failures - 1, RETRY_DELAYS.length - 1)]!
          if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
          this.retryTimer = window.setTimeout(() => {
            this.retryTimer = null
            void this.run()
          }, delay)
        }
        return false
      }
    }
    return true
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
  }
}

export function cleanMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  // Electron prefixes rejected IPC calls with "Error invoking remote method '...': Error: ".
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}
