import { isValidAccelerator } from './accelerator'
import { FONT_KEYS, MAX_FONT_SIZE, MIN_FONT_SIZE } from './content'
import { DEFAULT_PREFERENCES, type FontKey, type Preferences, type ReducedMotion, type ThemeKey } from './types'

export const THEMES: readonly ThemeKey[] = ['charcoal', 'midnight', 'paper']
export const THEME_LABELS: Record<ThemeKey, string> = { charcoal: 'Charcoal', midnight: 'Midnight', paper: 'Paper' }
const MOTION: readonly ReducedMotion[] = ['system', 'on', 'off']

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
  return next
}

export function loadPreferences(stored: unknown): Preferences {
  return mergePreferences(DEFAULT_PREFERENCES, stored)
}
