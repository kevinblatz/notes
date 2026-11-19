import { isValidAccelerator } from './accelerator'
import { FONT_KEYS, MAX_FONT_SIZE, MIN_FONT_SIZE } from './content'
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
  return next
}

export function loadPreferences(stored: unknown): Preferences {
  return mergePreferences(DEFAULT_PREFERENCES, stored)
}
