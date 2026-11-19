import { describe, expect, it } from 'vitest'
import {
  clampOpacity,
  formatOpacity,
  loadPreferences,
  mergePreferences,
  MIN_WINDOW_OPACITY,
  OPACITY_PRESETS,
  OPACITY_STEP,
  opacityPercent,
  stepOpacity,
  windowOpacityTarget,
  type OpacityInputs
} from '@shared/preferences'
import { DEFAULT_PREFERENCES } from '@shared/types'

describe('window opacity preferences', () => {
  it('default to a solid window that turns solid while in use', () => {
    expect(DEFAULT_PREFERENCES.windowOpacity).toBe(1)
    expect(DEFAULT_PREFERENCES.opacitySolidOnHover).toBe(true)
    expect(loadPreferences(undefined)).toMatchObject({ windowOpacity: 1, opacitySolidOnHover: true })
  })

  it('accept any opacity from the minimum to solid, in whole percent', () => {
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 0.7 }).windowOpacity).toBe(0.7)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 0.3 }).windowOpacity).toBe(0.3)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 1 }).windowOpacity).toBe(1)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 0.666 }).windowOpacity).toBe(0.67)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 0.855 }).windowOpacity).toBe(0.86)
  })

  it('never go below the minimum or above solid', () => {
    expect(MIN_WINDOW_OPACITY).toBe(0.3)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 0.1 }).windowOpacity).toBe(0.3)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 0 }).windowOpacity).toBe(0.3)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: -4 }).windowOpacity).toBe(0.3)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 1.5 }).windowOpacity).toBe(1)
    expect(mergePreferences(DEFAULT_PREFERENCES, { windowOpacity: 70 }).windowOpacity).toBe(1)
  })

  it('ignore values that are not finite numbers and keep the previous one', () => {
    const base = { ...DEFAULT_PREFERENCES, windowOpacity: 0.6 }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.5', null, true, {}, [0.5]]) {
      expect(mergePreferences(base, { windowOpacity: bad }).windowOpacity, String(bad)).toBe(0.6)
    }
  })

  it('take only a real boolean for "solid while I use it"', () => {
    expect(mergePreferences(DEFAULT_PREFERENCES, { opacitySolidOnHover: false }).opacitySolidOnHover).toBe(false)
    const off = { ...DEFAULT_PREFERENCES, opacitySolidOnHover: false }
    expect(mergePreferences(off, { opacitySolidOnHover: true }).opacitySolidOnHover).toBe(true)
    for (const bad of ['false', 0, 1, null, undefined]) {
      expect(mergePreferences(off, { opacitySolidOnHover: bad }).opacitySolidOnHover, String(bad)).toBe(false)
    }
  })

  it('survive a damaged settings row', () => {
    const loaded = loadPreferences({ windowOpacity: 'see-through', opacitySolidOnHover: 'yes', theme: 'neon' })
    expect(loaded.windowOpacity).toBe(1)
    expect(loaded.opacitySolidOnHover).toBe(true)
    expect(loaded.theme).toBe('charcoal')
    expect(loadPreferences('not an object')).toEqual(DEFAULT_PREFERENCES)
    expect(loadPreferences({ windowOpacity: 0.05 }).windowOpacity).toBe(0.3)
  })

  it('leave other preferences alone when only the opacity changes', () => {
    const base = { ...DEFAULT_PREFERENCES, theme: 'paper' as const, fontSize: 20 }
    expect(mergePreferences(base, { windowOpacity: 0.5 })).toEqual({ ...base, windowOpacity: 0.5 })
  })
})

describe('opacity helpers', () => {
  it('clamp and round to whole percent; anything that is not a number means solid', () => {
    expect(clampOpacity(0.704)).toBe(0.7)
    expect(clampOpacity(0.2)).toBe(0.3)
    expect(clampOpacity(2)).toBe(1)
    expect(clampOpacity(Number.NaN)).toBe(1)
    expect(clampOpacity(undefined as unknown as number)).toBe(1)
  })

  it('format as a whole percentage', () => {
    expect(opacityPercent(0.7)).toBe(70)
    expect(opacityPercent(0.29999)).toBe(30)
    expect(formatOpacity(0.85)).toBe('85%')
    expect(formatOpacity(1)).toBe('100%')
  })

  it('offer the presets from solid down, all inside the allowed range', () => {
    expect(OPACITY_PRESETS).toEqual([1, 0.85, 0.7, 0.5])
    for (const preset of OPACITY_PRESETS) expect(clampOpacity(preset)).toBe(preset)
  })

  it('step by 5 % and land on the step grid', () => {
    expect(OPACITY_STEP).toBe(0.05)
    expect(stepOpacity(1, -1)).toBe(0.95)
    expect(stepOpacity(0.7, -1)).toBe(0.65)
    expect(stepOpacity(0.7, 1)).toBe(0.75)
    expect(stepOpacity(0.72, -1)).toBe(0.7)
    expect(stepOpacity(0.72, 1)).toBe(0.75)
    expect(stepOpacity(0.67, -2)).toBe(0.6)
    expect(stepOpacity(0.5, 0)).toBe(0.5)
  })

  it('stop at the minimum and at solid', () => {
    expect(stepOpacity(0.3, -1)).toBe(0.3)
    expect(stepOpacity(0.35, -5)).toBe(0.3)
    expect(stepOpacity(1, 1)).toBe(1)
    expect(stepOpacity(0.97, 3)).toBe(1)
    let value = 1
    for (let i = 0; i < 40; i++) value = stepOpacity(value, -1)
    expect(value).toBe(MIN_WINDOW_OPACITY)
  })
})

describe('windowOpacityTarget', () => {
  const base: OpacityInputs = { chosen: 0.6, solidOnHover: true, pointerInside: false, focused: false, preview: null }
  const target = (patch: Partial<OpacityInputs>): number => windowOpacityTarget({ ...base, ...patch })

  it('shows the chosen opacity while the notes are not in use', () => {
    expect(target({})).toBe(0.6)
  })

  it('turns solid while the pointer is over the notes or they have the keyboard', () => {
    expect(target({ pointerInside: true })).toBe(1)
    expect(target({ focused: true })).toBe(1)
    expect(target({ pointerInside: true, focused: true })).toBe(1)
  })

  it('stays see-through while in use when "solid while I use it" is off', () => {
    expect(target({ solidOnHover: false, pointerInside: true, focused: true })).toBe(0.6)
  })

  it('shows the value being adjusted as it is, even under the pointer', () => {
    expect(target({ preview: 0.45, pointerInside: true, focused: true })).toBe(0.45)
    expect(target({ preview: 1 })).toBe(1)
    expect(target({ chosen: 1, preview: 0.5 })).toBe(0.5)
  })

  it('is always solid when the chosen opacity is solid', () => {
    expect(target({ chosen: 1 })).toBe(1)
    expect(target({ chosen: 1, solidOnHover: false })).toBe(1)
  })

  it('never goes below the minimum, whatever it is given', () => {
    expect(target({ chosen: 0.05 })).toBe(0.3)
    expect(target({ preview: 0 })).toBe(0.3)
    expect(target({ preview: -1 })).toBe(0.3)
    expect(target({ chosen: Number.NaN })).toBe(1)
  })
})
