/**
 * The global show/hide shortcut. Registration can fail when another app (or Windows itself)
 * already owns the key combination; that is reported to the window instead of being ignored,
 * so the user can pick a different one.
 */
import { globalShortcut } from 'electron'
import { formatAccelerator, isValidAccelerator } from '@shared/accelerator'
import type { ShortcutStatus } from '@shared/types'

export class ShortcutManager {
  private current: string | null = null
  private registered = false
  private suspended = false
  private error: string | null = null

  constructor(
    private readonly onTrigger: () => void,
    /** Test-only: accelerators that should behave as if another app owned them. */
    private readonly blocked: ReadonlySet<string> = new Set()
  ) {}

  private tryRegister(accelerator: string): string | null {
    if (!isValidAccelerator(accelerator)) return 'That key combination cannot be used as a global shortcut.'
    if (this.blocked.has(accelerator)) return this.conflictMessage(accelerator)
    try {
      const ok = globalShortcut.register(accelerator, this.onTrigger)
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

  private conflictMessage(accelerator: string): string {
    return `${formatAccelerator(accelerator)} is already in use by another app or by Windows.`
  }

  /** Register the saved shortcut at startup. */
  start(accelerator: string): ShortcutStatus {
    this.current = accelerator
    this.error = this.tryRegister(accelerator)
    this.registered = this.error === null
    return this.status()
  }

  /**
   * Switch to a new shortcut. The old one is released only after the new one is confirmed,
   * so a failed attempt never leaves the app without its working shortcut.
   */
  change(accelerator: string): { status: ShortcutStatus; accepted: boolean } {
    if (accelerator === this.current && this.registered) return { status: this.status(), accepted: true }
    const previous = this.current
    const previousWasRegistered = this.registered
    const error = this.tryRegister(accelerator)
    if (error) {
      return { status: { accelerator, registered: false, error }, accepted: false }
    }
    if (previous && previous !== accelerator && previousWasRegistered) globalShortcut.unregister(previous)
    this.current = accelerator
    this.registered = true
    this.error = null
    this.suspended = false
    return { status: this.status(), accepted: true }
  }

  /** Release the shortcut while the user records a new one, so pressing it does not hide the window. */
  suspend(flag: boolean): void {
    if (!this.current) return
    if (flag && this.registered && !this.suspended) {
      globalShortcut.unregister(this.current)
      this.suspended = true
    } else if (!flag && this.suspended) {
      this.suspended = false
      this.error = this.tryRegister(this.current)
      this.registered = this.error === null
    }
  }

  status(): ShortcutStatus {
    return { accelerator: this.current ?? '', registered: this.registered, error: this.error }
  }

  dispose(): void {
    globalShortcut.unregisterAll()
  }
}
