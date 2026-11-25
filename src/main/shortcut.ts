/**
 * The global hotkeys: show/hide plus the trading hotkeys, each with its own key combination
 * and a switch to turn it off.
 *
 * Registration can fail when another app (or Windows itself) already owns a combination;
 * that is reported to the window instead of being ignored, so the user can pick another one.
 * A failed attempt never removes a hotkey that works: a new combination is confirmed before
 * the old one is released.
 */
import { globalShortcut } from 'electron'
import { formatAccelerator, isValidAccelerator } from '@shared/accelerator'
import { HOTKEY_IDS, HOTKEY_INFO, type HotkeyBinding, type HotkeyId } from '@shared/hotkeys'
import type { HotkeyStatus, HotkeyStatuses, ShortcutStatus } from '@shared/types'

interface Entry {
  accelerator: string
  enabled: boolean
  /** Registered with the system (or, while suspended, registered before the suspension). */
  registered: boolean
  error: string | null
}

export interface ChangeResult {
  status: HotkeyStatus
  accepted: boolean
  /** Other hotkeys of this app that had the combination; they are switched off. */
  takenFrom: HotkeyId[]
}

const INVALID = 'That key combination cannot be used as a global shortcut.'

export class ShortcutManager {
  private entries: Record<HotkeyId, Entry>
  private suspended = false

  constructor(
    /** What each hotkey does. A real press and the test trigger run exactly this. */
    private readonly handlers: Record<HotkeyId, () => void>,
    /** Test-only: accelerators that should behave as if another app owned them. */
    private readonly blocked: ReadonlySet<string> = new Set(),
    /** Called after anything about the hotkeys changed. */
    private readonly onChange: () => void = () => undefined
  ) {
    this.entries = Object.fromEntries(HOTKEY_IDS.map((id) => [id, { accelerator: '', enabled: false, registered: false, error: null }])) as Record<HotkeyId, Entry>
  }

  private conflictMessage(accelerator: string, owner: HotkeyId | null = null): string {
    if (owner) return `${formatAccelerator(accelerator)} is already set for ${HOTKEY_INFO[owner].label}.`
    return `${formatAccelerator(accelerator)} is already in use by another app or by Windows.`
  }

  /** The hotkey of this app other than `id` that is registered with this combination, if any. */
  private ownerOf(accelerator: string, except: HotkeyId): HotkeyId | null {
    return HOTKEY_IDS.find((other) => other !== except && this.entries[other].enabled && this.entries[other].registered && this.entries[other].accelerator === accelerator) ?? null
  }

  private tryRegister(id: HotkeyId, accelerator: string): string | null {
    if (!isValidAccelerator(accelerator)) return INVALID
    const owner = this.ownerOf(accelerator, id)
    if (owner) return this.conflictMessage(accelerator, owner)
    if (this.blocked.has(accelerator)) return this.conflictMessage(accelerator)
    try {
      const ok = globalShortcut.register(accelerator, () => this.handlers[id]())
      // register() can report success even when the OS refused; isRegistered() is the confirmation.
      if (!ok || !globalShortcut.isRegistered(accelerator)) {
        if (ok) globalShortcut.unregister(accelerator)
        return this.conflictMessage(accelerator)
      }
      return null
    } catch {
      return this.conflictMessage(accelerator)
    }
  }

  private release(entry: Entry): void {
    if (entry.registered && !this.suspended) globalShortcut.unregister(entry.accelerator)
    entry.registered = false
  }

  /** Register the saved hotkeys at startup. */
  start(bindings: Record<HotkeyId, HotkeyBinding>): HotkeyStatuses {
    for (const id of HOTKEY_IDS) {
      const { accelerator, enabled } = bindings[id]
      const entry: Entry = { accelerator, enabled, registered: false, error: null }
      this.entries[id] = entry
      if (!enabled) continue
      entry.error = this.tryRegister(id, accelerator)
      entry.registered = entry.error === null
    }
    this.onChange()
    return this.statuses()
  }

  /**
   * Give a hotkey a new combination. The old one is released only after the new one is
   * confirmed. A combination another hotkey of this app has is taken from it, and that one is
   * switched off: two hotkeys can never share a combination.
   */
  change(id: HotkeyId, accelerator: string): ChangeResult {
    this.resume()
    const entry = this.entries[id]
    if (!isValidAccelerator(accelerator)) return { status: { id, accelerator, enabled: entry.enabled, registered: false, error: INVALID }, accepted: false, takenFrom: [] }
    if (accelerator === entry.accelerator && entry.enabled && entry.registered) return { status: this.statusOf(id), accepted: true, takenFrom: [] }

    const holders = HOTKEY_IDS.filter((other) => other !== id && this.entries[other].enabled && this.entries[other].accelerator === accelerator)
    const released = holders.filter((other) => this.entries[other].registered)
    if (released.length > 0) {
      globalShortcut.unregister(accelerator)
      for (const other of released) this.entries[other].registered = false
    }
    const error = this.tryRegister(id, accelerator)
    if (error) {
      // Give the combination back to the hotkey that had it.
      for (const other of released) {
        const holder = this.entries[other]
        holder.error = this.tryRegister(other, accelerator)
        holder.registered = holder.error === null
      }
      this.onChange()
      return { status: { id, accelerator, enabled: entry.enabled, registered: false, error }, accepted: false, takenFrom: [] }
    }
    if (entry.registered && entry.accelerator !== accelerator) globalShortcut.unregister(entry.accelerator)
    this.entries[id] = { accelerator, enabled: true, registered: true, error: null }
    for (const other of holders) this.entries[other] = { ...this.entries[other], enabled: false, registered: false, error: null }
    this.onChange()
    return { status: this.statusOf(id), accepted: true, takenFrom: holders }
  }

  /**
   * Take on a whole set of bindings (a restored backup). A hotkey whose restored combination
   * cannot be had keeps the one it has.
   */
  apply(bindings: Record<HotkeyId, HotkeyBinding>): void {
    this.resume()
    for (const id of HOTKEY_IDS) {
      const wanted = bindings[id]
      if (wanted.enabled) continue
      this.release(this.entries[id])
      this.entries[id] = { accelerator: isValidAccelerator(wanted.accelerator) ? wanted.accelerator : this.entries[id].accelerator, enabled: false, registered: false, error: null }
    }
    for (const id of HOTKEY_IDS) {
      const wanted = bindings[id]
      if (wanted.enabled) this.change(id, wanted.accelerator)
    }
    this.onChange()
  }

  /** Switch a hotkey on or off. Switching on fails, and it stays off, when the combination is taken. */
  setEnabled(id: HotkeyId, enabled: boolean): { status: HotkeyStatus; accepted: boolean } {
    this.resume()
    const entry = this.entries[id]
    if (!enabled) {
      this.release(entry)
      entry.enabled = false
      entry.error = null
      this.onChange()
      return { status: this.statusOf(id), accepted: true }
    }
    if (entry.enabled && entry.registered) return { status: this.statusOf(id), accepted: true }
    const error = this.tryRegister(id, entry.accelerator)
    if (error) {
      this.onChange()
      return { status: { id, accelerator: entry.accelerator, enabled: false, registered: false, error }, accepted: false }
    }
    this.entries[id] = { accelerator: entry.accelerator, enabled: true, registered: true, error: null }
    this.onChange()
    return { status: this.statusOf(id), accepted: true }
  }

  /**
   * Release every hotkey while the user records a new combination, so pressing one is captured
   * by the recorder instead of acting (hiding the window, say).
   */
  suspend(flag: boolean): void {
    if (flag) {
      if (this.suspended) return
      for (const id of HOTKEY_IDS) {
        const entry = this.entries[id]
        if (entry.registered) globalShortcut.unregister(entry.accelerator)
      }
      this.suspended = true
    } else {
      this.resume()
    }
  }

  private resume(): void {
    if (!this.suspended) return
    this.suspended = false
    for (const id of HOTKEY_IDS) {
      const entry = this.entries[id]
      if (!entry.enabled || !entry.registered) continue
      entry.registered = false
      entry.error = this.tryRegister(id, entry.accelerator)
      entry.registered = entry.error === null
    }
    this.onChange()
  }

  private statusOf(id: HotkeyId): HotkeyStatus {
    const { accelerator, enabled, registered, error } = this.entries[id]
    return { id, accelerator, enabled, registered: enabled && registered, error: enabled ? error : null }
  }

  /** The show/hide shortcut. */
  status(): ShortcutStatus {
    const { accelerator, enabled, registered, error } = this.statusOf('toggle')
    return { accelerator, enabled, registered, error }
  }

  statuses(): HotkeyStatuses {
    return Object.fromEntries(HOTKEY_IDS.map((id) => [id, this.statusOf(id)])) as HotkeyStatuses
  }

  /** What should be stored: every hotkey's combination and switch. */
  bindings(): Record<HotkeyId, HotkeyBinding> {
    return Object.fromEntries(HOTKEY_IDS.map((id) => [id, { accelerator: this.entries[id].accelerator, enabled: this.entries[id].enabled }])) as Record<HotkeyId, HotkeyBinding>
  }

  /** For the automated desktop tests: do exactly what pressing the hotkey does. */
  trigger(id: HotkeyId): boolean {
    if (!HOTKEY_IDS.includes(id)) return false
    this.handlers[id]()
    return true
  }

  dispose(): void {
    globalShortcut.unregisterAll()
  }
}
