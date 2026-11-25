import { isValidAccelerator } from './accelerator'
import { isCandleMinutes } from './candles'
import { FONT_KEYS, MAX_FONT_SIZE, MIN_FONT_SIZE } from './content'
import { mergeHotkeys } from './hotkeys'
import { INSTRUMENT_KEYS, MAX_RISK_CENTS } from './risk'
import { DEFAULT_PREFERENCES, type FontKey, type Preferences, type ReducedMotion, type ThemeKey } from './types'

export const THEMES: readonly ThemeKey[] = ['charcoal', 'midnight', 'paper']
export const THEME_LABELS: Record<ThemeKey, string> = { charcoal: 'Charcoal', midnight: 'Midnight', paper: 'Paper' }
const MOTION: readonly ReducedMotion[] = ['system', 'on', 'off']
/** Below this the notes become hard to read and easy to lose on the screen. */
export const MIN_WINDOW_OPACITY = 0.3
/** The quick choices in the opacity control, Settings and the tray menu, most solid first. */
export const OPACITY_PRESETS: readonly number[] = [1, 0.85, 0.7, 0.5]
/** One wheel notch over the opacity icon, one arrow key on the slider, one press of the shortcut. */
export const OPACITY_STEP = 0.05

/** Whole percent, as shown to the user: 0.7 -> 70. */
export function opacityPercent(value: number): number {
  return Math.round(value * 100)
}

/** "70%" */
export function formatOpacity(value: number): string {
  return `${opacityPercent(value)}%`
}

/** Keep an opacity inside the allowed range, in whole percent. Anything that is not a number means solid. */
export function clampOpacity(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(100, Math.max(MIN_WINDOW_OPACITY * 100, Math.round(value * 100))) / 100
}

/**
 * Move by whole steps, landing on the step grid: from 72 % one step down is 70 %, one step up
 * is 75 %, so values picked with the mouse fall back into line after one wheel notch.
 */
export function stepOpacity(value: number, steps: number): number {
  const grid = opacityPercent(OPACITY_STEP)
  const percent = opacityPercent(clampOpacity(value))
  if (steps === 0) return percent / 100
  const onGrid = steps > 0 ? Math.floor(percent / grid) : Math.ceil(percent / grid)
  return clampOpacity(((onGrid + steps) * grid) / 100)
}

export interface OpacityInputs {
  /** The opacity the user chose (the stored preference). */
  chosen: number
  /** Turn solid while in use (the stored preference). */
  solidOnHover: boolean
  /** The pointer is over the window. */
  pointerInside: boolean
  /** The window has the keyboard. */
  focused: boolean
  /** A value being adjusted right now, shown as it is so the user can judge it. */
  preview: number | null
}

/** The opacity the notes window should have at this moment. */
export function windowOpacityTarget(inputs: OpacityInputs): number {
  if (inputs.preview !== null) return clampOpacity(inputs.preview)
  const chosen = clampOpacity(inputs.chosen)
  if (chosen >= 1) return 1
  if (inputs.solidOnHover && (inputs.pointerInside || inputs.focused)) return 1
  return chosen
}

/**
 * The values a fade from `from` to `to` passes through, ending exactly on `to`. Eased out, so
 * most of the change happens at once and the last steps settle gently. Empty when nothing changes.
 */
export function opacityFadeSteps(from: number, to: number, count: number): number[] {
  if (from === to) return []
  const steps: number[] = []
  const total = Math.max(1, Math.round(count))
  for (let i = 1; i < total; i++) {
    const t = i / total
    const eased = 1 - (1 - t) * (1 - t)
    steps.push(Math.round((from + (to - from) * eased) * 1000) / 1000)
  }
  steps.push(to)
  return steps
}

/** A point along the slider (0 = left end, 1 = right end) as an opacity: the left end is the minimum. */
export function opacityAtFraction(fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 1
  return clampOpacity(MIN_WINDOW_OPACITY + f * (1 - MIN_WINDOW_OPACITY))
}

/** Where an opacity sits along the slider, from 0 (the minimum) to 1 (solid). */
export function opacityFraction(value: number): number {
  return (clampOpacity(value) - MIN_WINDOW_OPACITY) / (1 - MIN_WINDOW_OPACITY)
}

/** The keyboard shortcuts: Ctrl+Shift+Minus is more see-through, Ctrl+Shift+Plus more solid. */
export const OPACITY_SHORTCUT_LABELS = { down: 'Ctrl+Shift+Minus', up: 'Ctrl+Shift+Plus' } as const

interface ShortcutKey {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Steps to take for a key press: -1 for Ctrl+Shift+Minus, +1 for Ctrl+Shift+Plus (the = key,
 * or + on the number pad), 0 for anything else. Alt must be up: Ctrl+Alt is AltGr on many keyboards.
 */
export function opacityShortcutSteps(event: ShortcutKey): number {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return 0
  if (event.key === '-' || event.key === '_' || event.code === 'Minus' || event.code === 'NumpadSubtract') return -1
  if (event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd') return 1
  return 0
}

/** Scrolling this far counts as one notch of a mouse wheel. */
const WHEEL_NOTCH = 100

/**
 * Turn a wheel event into opacity steps. A mouse wheel gives one step per notch (one event of
 * about 100 pixels, or several notches coalesced into one event); a touchpad's small deltas
 * are added up in `carry` until they make a notch. Scrolling up (negative delta) is more solid.
 */
export function opacityWheelSteps(deltaY: number, carry: number): { steps: number; carry: number } {
  if (!Number.isFinite(deltaY) || deltaY === 0) return { steps: 0, carry }
  if (Math.abs(deltaY) >= WHEEL_NOTCH / 2) {
    return { steps: -Math.sign(deltaY) * Math.max(1, Math.round(Math.abs(deltaY) / WHEEL_NOTCH)), carry: 0 }
  }
  // A change of direction starts counting afresh.
  const total = Math.sign(carry) === Math.sign(deltaY) ? carry + deltaY : deltaY
  if (Math.abs(total) < WHEEL_NOTCH) return { steps: 0, carry: total }
  return { steps: -Math.sign(total), carry: 0 }
}

/**
 * The see-through hotkey: from solid to the see-through value last chosen, and from any
 * see-through value back to solid.
 */
export function seeThroughToggleTarget(current: number, seeThrough: number): number {
  if (clampOpacity(current) < 1) return 1
  const remembered = clampOpacity(seeThrough)
  return remembered < 1 ? remembered : DEFAULT_SEE_THROUGH
}

/** Used by the see-through hotkey until a see-through value has been chosen. */
export const DEFAULT_SEE_THROUGH = 0.7

/**
 * Preferences as stored after an update: a see-through opacity that is set (from the title
 * bar, Settings, the tray or the hotkey) is also remembered as the one the see-through hotkey
 * goes back to.
 */
export function rememberSeeThrough(next: Preferences): Preferences {
  const opacity = clampOpacity(next.windowOpacity)
  return opacity < 1 && opacity !== next.seeThroughOpacity ? { ...next, seeThroughOpacity: opacity } : next
}

/** The tray menu's choices: the presets, plus the current value when it is not one of them. */
export function opacityMenuChoices(current: number): number[] {
  const value = clampOpacity(current)
  const choices = OPACITY_PRESETS.includes(value) ? [...OPACITY_PRESETS] : [...OPACITY_PRESETS, value]
  return choices.sort((a, b) => b - a)
}

/**
 * Apply an untrusted partial update on top of known-good preferences. Unknown keys and
 * invalid values are ignored, so a bad settings row or backup can never leave the app with
 * unusable preferences.
 */
export function mergePreferences(base: Preferences, patch: unknown): Preferences {
  const next: Preferences = { ...base }
  if (typeof patch !== 'object' || patch === null) return next
  const p = patch as Record<string, unknown>
  if (p.dockSide === 'left' || p.dockSide === 'right') next.dockSide = p.dockSide
  if (typeof p.alwaysOnTop === 'boolean') next.alwaysOnTop = p.alwaysOnTop
  if (typeof p.launchAtStartup === 'boolean') next.launchAtStartup = p.launchAtStartup
  if (isValidAccelerator(p.shortcut)) next.shortcut = p.shortcut
  if (typeof p.fontFamily === 'string' && (FONT_KEYS as readonly string[]).includes(p.fontFamily)) next.fontFamily = p.fontFamily as FontKey
  if (typeof p.fontSize === 'number' && Number.isFinite(p.fontSize)) {
    next.fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(p.fontSize)))
  }
  if (typeof p.theme === 'string' && (THEMES as readonly string[]).includes(p.theme)) next.theme = p.theme as ThemeKey
  if (typeof p.reducedMotion === 'string' && (MOTION as readonly string[]).includes(p.reducedMotion)) next.reducedMotion = p.reducedMotion as ReducedMotion
  if (typeof p.windowOpacity === 'number' && Number.isFinite(p.windowOpacity)) next.windowOpacity = clampOpacity(p.windowOpacity)
  if (typeof p.opacitySolidOnHover === 'boolean') next.opacitySolidOnHover = p.opacitySolidOnHover
  if (typeof p.formatBarCollapsed === 'boolean') next.formatBarCollapsed = p.formatBarCollapsed
  if (typeof p.shortcutEnabled === 'boolean') next.shortcutEnabled = p.shortcutEnabled
  if (p.hotkeys !== undefined) next.hotkeys = mergeHotkeys(base.hotkeys, p.hotkeys)
  if (typeof p.seeThroughOpacity === 'number' && Number.isFinite(p.seeThroughOpacity) && clampOpacity(p.seeThroughOpacity) < 1) {
    next.seeThroughOpacity = clampOpacity(p.seeThroughOpacity)
  }
  if (typeof p.candleTimer === 'boolean') next.candleTimer = p.candleTimer
  if (isCandleMinutes(p.candleMinutes)) next.candleMinutes = p.candleMinutes
  if (typeof p.candleChime === 'boolean') next.candleChime = p.candleChime
  if (typeof p.riskInstrument === 'string' && (INSTRUMENT_KEYS as readonly string[]).includes(p.riskInstrument)) next.riskInstrument = p.riskInstrument as Preferences['riskInstrument']
  if (p.riskCents === null) next.riskCents = null
  else if (typeof p.riskCents === 'number' && Number.isSafeInteger(p.riskCents) && p.riskCents > 0 && p.riskCents <= MAX_RISK_CENTS) next.riskCents = p.riskCents
  if (p.riskUnit === 'points' || p.riskUnit === 'ticks') next.riskUnit = p.riskUnit
  if (typeof p.spellcheck === 'boolean') next.spellcheck = p.spellcheck
  if (p.spellingWords !== undefined) next.spellingWords = sanitizeUserWords(p.spellingWords)
  return next
}

/** Most words a user can add to their own spelling dictionary. */
export const MAX_USER_WORDS = 500
/** Longest word that can be added. */
export const MAX_USER_WORD_LENGTH = 48

/** Keep only usable dictionary words: single words with a letter, trimmed, no duplicates (ignoring case), capped. */
export function sanitizeUserWords(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const word = raw.trim()
    const key = word.toLowerCase()
    // No spaces, and no control or invisible characters (NUL, zero-width spaces, byte-order marks).
    if (!word || word.length > MAX_USER_WORD_LENGTH || /[\s\p{C}]/u.test(word) || !/\p{L}/u.test(word) || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length >= MAX_USER_WORDS) break
  }
  return out
}

export function loadPreferences(stored: unknown): Preferences {
  return mergePreferences(DEFAULT_PREFERENCES, stored)
}
