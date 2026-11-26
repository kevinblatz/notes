/**
 * The global hotkeys: which ones exist, their default key combinations and how they are
 * described. `toggle` is the show/hide shortcut, stored in Preferences.shortcut as it always
 * was; the trading hotkeys are stored in Preferences.hotkeys.
 *
 * The defaults use Ctrl+Alt because Chrome owns Ctrl+Shift+N/T/R/O: a global hotkey takes
 * its combination away from every other app, the chart in Chrome included.
 */
import { isValidAccelerator } from './accelerator'

export const HOTKEY_IDS = ['toggle', 'quickNote', 'snapshot', 'risk', 'candleTimer', 'seeThrough', 'openLog'] as const
export type HotkeyId = (typeof HOTKEY_IDS)[number]
export type TradingHotkeyId = Exclude<HotkeyId, 'toggle'>
export const TRADING_HOTKEY_IDS = HOTKEY_IDS.filter((id): id is TradingHotkeyId => id !== 'toggle')

export interface HotkeyBinding {
  /** Electron accelerator string, e.g. "Control+Alt+N". */
  accelerator: string
  /** Switched off in Settings: not registered with the system at all. */
  enabled: boolean
}

export type HotkeyBindings = Record<TradingHotkeyId, HotkeyBinding>

export const DEFAULT_HOTKEYS: HotkeyBindings = {
  quickNote: { accelerator: 'Control+Alt+N', enabled: true },
  snapshot: { accelerator: 'Control+Alt+S', enabled: true },
  risk: { accelerator: 'Control+Alt+R', enabled: true },
  candleTimer: { accelerator: 'Control+Alt+T', enabled: true },
  seeThrough: { accelerator: 'Control+Alt+O', enabled: true },
  openLog: { accelerator: 'Control+Alt+L', enabled: true }
}

export const HOTKEY_INFO: Record<HotkeyId, { label: string; help: string; does: string }> = {
  toggle: { label: 'Show or hide notes', help: 'Works from any app, including while your chart has focus.', does: 'shows and hides your notes' },
  quickNote: { label: 'Quick note', help: 'One line into today’s session log, then back to your chart.', does: 'opens a quick note' },
  snapshot: { label: 'Snapshot chart', help: 'The chart into today’s session log, without leaving it.', does: 'takes a chart snapshot' },
  risk: { label: 'Risk calculator', help: 'Contracts for a dollar risk and a stop. Enter copies the count.', does: 'opens the risk calculator' },
  candleTimer: { label: 'Candle timer', help: 'Shows or hides the countdown to the next candle close.', does: 'shows and hides the candle timer' },
  seeThrough: { label: 'See-through', help: 'Solid, or the see-through opacity you chose last.', does: 'switches see-through on and off' },
  openLog: { label: 'Open today’s log', help: 'Today’s session log, ready to write at the end.', does: 'opens today’s session log' }
}

/** Apply an untrusted update to stored bindings. Unknown hotkeys and invalid values are ignored. */
export function mergeHotkeys(base: HotkeyBindings, patch: unknown): HotkeyBindings {
  const next = { ...base }
  if (typeof patch !== 'object' || patch === null) return next
  const p = patch as Record<string, unknown>
  for (const id of TRADING_HOTKEY_IDS) {
    const entry = p[id]
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    next[id] = {
      accelerator: isValidAccelerator(e.accelerator) ? e.accelerator : next[id].accelerator,
      enabled: typeof e.enabled === 'boolean' ? e.enabled : next[id].enabled
    }
  }
  return next
}

/** Every binding, show/hide included, from the stored preferences. */
export function bindingsFromPreferences(prefs: { shortcut: string; shortcutEnabled: boolean; hotkeys: HotkeyBindings }): Record<HotkeyId, HotkeyBinding> {
  return { toggle: { accelerator: prefs.shortcut, enabled: prefs.shortcutEnabled }, ...prefs.hotkeys }
}

/** The preference fields that store these bindings. */
export function preferencesFromBindings(bindings: Record<HotkeyId, HotkeyBinding>): { shortcut: string; shortcutEnabled: boolean; hotkeys: HotkeyBindings } {
  const { toggle, ...hotkeys } = bindings
  return { shortcut: toggle.accelerator, shortcutEnabled: toggle.enabled, hotkeys }
}
