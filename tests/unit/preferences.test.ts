import { describe, expect, it } from 'vitest'
import {
  clampOpacity,
  formatOpacity,
  loadPreferences,
  MAX_USER_WORDS,
  mergePreferences,
  MIN_WINDOW_OPACITY,
  OPACITY_PRESETS,
  OPACITY_STEP,
  opacityAtFraction,
  opacityFadeSteps,
  opacityFraction,
  opacityMenuChoices,
  opacityPercent,
  opacityShortcutSteps,
  opacityWheelSteps,
  stepOpacity,
  windowOpacityTarget,
  type OpacityInputs
} from '@shared/preferences'
import { DEFAULT_PREFERENCES } from '@shared/types'

describe('window opacity preferences', () => {
  it('default to a solid window, and a chosen opacity that stays while the notes are in use', () => {
    expect(DEFAULT_PREFERENCES.windowOpacity).toBe(1)
    // Off by default: notes taken over something must stay see-through while they are written.
    expect(DEFAULT_PREFERENCES.opacitySolidOnHover).toBe(false)
    expect(loadPreferences(undefined)).toMatchObject({ windowOpacity: 1, opacitySolidOnHover: false })
    expect(windowOpacityTarget({ chosen: 0.7, solidOnHover: DEFAULT_PREFERENCES.opacitySolidOnHover, pointerInside: true, focused: true, preview: null })).toBe(0.7)
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
    expect(mergePreferences(DEFAULT_PREFERENCES, { opacitySolidOnHover: true }).opacitySolidOnHover).toBe(true)
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
    expect(loaded.opacitySolidOnHover).toBe(false)
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

describe('opacityFadeSteps', () => {
  it('passes through a few values and ends exactly on the target', () => {
    const steps = opacityFadeSteps(0.6, 1, 6)
    expect(steps).toHaveLength(6)
    expect(steps.at(-1)).toBe(1)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    for (const value of steps) {
      expect(value).toBeGreaterThan(0.6)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('eases out: most of the change happens in the first steps', () => {
    const steps = opacityFadeSteps(1, 0.5, 6)
    expect(steps.at(-1)).toBe(0.5)
    expect([...steps].sort((a, b) => b - a)).toEqual(steps)
    expect(1 - steps[0]!).toBeGreaterThan(steps[4]! - steps[5]!)
    expect(steps[2]!).toBeLessThan(0.75)
  })

  it('is empty when nothing changes, and a single step when asked for one', () => {
    expect(opacityFadeSteps(0.7, 0.7, 6)).toEqual([])
    expect(opacityFadeSteps(1, 0.4, 1)).toEqual([0.4])
    expect(opacityFadeSteps(1, 0.4, 0)).toEqual([0.4])
  })
})

describe('slider positions', () => {
  it('put the minimum at the left end and solid at the right end, in whole percent', () => {
    expect(opacityAtFraction(0)).toBe(MIN_WINDOW_OPACITY)
    expect(opacityAtFraction(1)).toBe(1)
    expect(opacityAtFraction(0.5)).toBe(0.65)
    expect(opacityAtFraction(-3)).toBe(MIN_WINDOW_OPACITY)
    expect(opacityAtFraction(7)).toBe(1)
    expect(opacityAtFraction(Number.NaN)).toBe(1)
  })

  it('map back to the same place', () => {
    expect(opacityFraction(MIN_WINDOW_OPACITY)).toBe(0)
    expect(opacityFraction(1)).toBe(1)
    for (const value of [0.3, 0.45, 0.5, 0.7, 0.85, 1]) expect(opacityAtFraction(opacityFraction(value))).toBe(value)
    expect(opacityFraction(0.1)).toBe(0)
  })
})

describe('opacityShortcutSteps', () => {
  const key = (patch: Partial<Parameters<typeof opacityShortcutSteps>[0]>) =>
    opacityShortcutSteps({ key: '', code: '', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, ...patch })

  it('Ctrl+Shift+Minus is more see-through, Ctrl+Shift+Plus more solid', () => {
    expect(key({ key: '_', code: 'Minus' })).toBe(-1)
    expect(key({ key: '+', code: 'Equal' })).toBe(1)
    expect(key({ key: '-', code: 'NumpadSubtract' })).toBe(-1)
    expect(key({ key: '+', code: 'NumpadAdd' })).toBe(1)
    // Layouts where the keys sit elsewhere still match by the character typed.
    expect(key({ key: '_', code: 'Slash' })).toBe(-1)
    expect(key({ key: '+', code: 'BracketRight' })).toBe(1)
  })

  it('needs Ctrl (or Cmd) and Shift, and never fires with Alt (AltGr on many keyboards)', () => {
    expect(key({ key: '-', code: 'Minus', shiftKey: false })).toBe(0)
    expect(key({ key: '-', code: 'Minus', ctrlKey: false })).toBe(0)
    expect(key({ key: '-', code: 'Minus', ctrlKey: false, metaKey: true })).toBe(-1)
    expect(key({ key: '-', code: 'Minus', altKey: true })).toBe(0)
    expect(key({ key: 'K', code: 'KeyK' })).toBe(0)
    expect(key({ key: 'ArrowUp', code: 'ArrowUp' })).toBe(0)
  })
})

describe('opacityWheelSteps', () => {
  it('gives one step per mouse-wheel notch; scrolling up is more solid', () => {
    expect(opacityWheelSteps(100, 0)).toEqual({ steps: -1, carry: 0 })
    expect(opacityWheelSteps(-100, 0)).toEqual({ steps: 1, carry: 0 })
    expect(opacityWheelSteps(120, 0).steps).toBe(-1)
    expect(opacityWheelSteps(53, 0).steps).toBe(-1)
  })

  it('counts several notches that arrive in one event', () => {
    expect(opacityWheelSteps(300, 0).steps).toBe(-3)
    expect(opacityWheelSteps(-200, 0).steps).toBe(2)
  })

  it('adds up a touchpad’s small deltas into whole notches', () => {
    let carry = 0
    const steps: number[] = []
    for (let i = 0; i < 10; i++) {
      const result = opacityWheelSteps(20, carry)
      carry = result.carry
      steps.push(result.steps)
    }
    expect(steps.filter((s) => s !== 0)).toEqual([-1, -1])
    expect(steps.indexOf(-1)).toBe(4)
  })

  it('starts counting afresh when the direction changes, and ignores nothing-deltas', () => {
    expect(opacityWheelSteps(-20, 80)).toEqual({ steps: 0, carry: -20 })
    expect(opacityWheelSteps(0, 40)).toEqual({ steps: 0, carry: 40 })
    expect(opacityWheelSteps(Number.NaN, 40)).toEqual({ steps: 0, carry: 40 })
  })
})

describe('opacityMenuChoices', () => {
  it('offers the presets from solid down', () => {
    expect(opacityMenuChoices(1)).toEqual([1, 0.85, 0.7, 0.5])
    expect(opacityMenuChoices(0.7)).toEqual([1, 0.85, 0.7, 0.5])
  })

  it('adds the current value in its place when it is not a preset', () => {
    expect(opacityMenuChoices(0.65)).toEqual([1, 0.85, 0.7, 0.65, 0.5])
    expect(opacityMenuChoices(0.3)).toEqual([1, 0.85, 0.7, 0.5, 0.3])
    expect(opacityMenuChoices(0.95)).toEqual([1, 0.95, 0.85, 0.7, 0.5])
    expect(opacityMenuChoices(0.1)).toEqual([1, 0.85, 0.7, 0.5, 0.3])
  })

  it('does not change the presets', () => {
    opacityMenuChoices(0.4)
    expect(OPACITY_PRESETS).toEqual([1, 0.85, 0.7, 0.5])
  })
})

describe('spelling preferences', () => {
  it('underline misspellings and start with an empty dictionary', () => {
    expect(DEFAULT_PREFERENCES.spellcheck).toBe(true)
    expect(DEFAULT_PREFERENCES.spellingWords).toEqual([])
    expect(loadPreferences(undefined)).toMatchObject({ spellcheck: true, spellingWords: [] })
  })

  it('keep the switch and the user’s words, checked like every other preference', () => {
    const next = mergePreferences(DEFAULT_PREFERENCES, { spellcheck: false, spellingWords: [' Kenzie ', 'kenzie', 'Smoove', 'two words', 7, ''] })
    expect(next.spellcheck).toBe(false)
    expect(next.spellingWords).toEqual(['Kenzie', 'Smoove'])
    // Bad values leave what was stored.
    expect(mergePreferences(next, { spellcheck: 'no' }).spellcheck).toBe(false)
    expect(mergePreferences(next, {}).spellingWords).toEqual(['Kenzie', 'Smoove'])
    expect(mergePreferences(next, { spellingWords: 'Kenzie' }).spellingWords).toEqual([])
    // A stored settings row from before this version gets the defaults.
    expect(loadPreferences({ theme: 'paper' })).toMatchObject({ theme: 'paper', spellcheck: true, spellingWords: [] })
  })

  it('cap the dictionary', () => {
    const many = Array.from({ length: MAX_USER_WORDS + 20 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`)
    expect(mergePreferences(DEFAULT_PREFERENCES, { spellingWords: many }).spellingWords).toHaveLength(MAX_USER_WORDS)
  })
})
