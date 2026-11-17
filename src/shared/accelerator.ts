/**
 * Global-shortcut helpers: turn a key press into an Electron accelerator string, validate
 * one before it reaches `globalShortcut.register`, and format one for display.
 */

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'] as const
type Modifier = (typeof MODIFIERS)[number]

const NAMED_KEYS = new Set([
  'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Up', 'Down', 'Left', 'Right', 'Plus', 'Enter', 'Escape',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)
])

const PUNCTUATION = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/'])

const CODE_TO_KEY: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/'
}

function keyFromEvent(event: KeyLike): string | null {
  const { code } = event
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return CODE_TO_KEY[code] ?? null
}

export type AcceleratorCapture =
  | { ok: true; accelerator: string }
  | { ok: false; reason: 'modifier-only' | 'needs-modifier' | 'unsupported-key' }

/**
 * A usable global shortcut needs Ctrl, Alt or the Windows key (Shift alone would swallow
 * ordinary typing) plus one non-modifier key. Function keys may stand alone with a modifier
 * or with none at all.
 */
export function acceleratorFromEvent(event: KeyLike): AcceleratorCapture {
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(event.key)) return { ok: false, reason: 'modifier-only' }
  const key = keyFromEvent(event)
  if (!key) return { ok: false, reason: 'unsupported-key' }
  const mods: Modifier[] = []
  if (event.ctrlKey) mods.push('Control')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  if (event.metaKey) mods.push('Super')
  const isFunctionKey = /^F\d+$/.test(key)
  const hasStrongModifier = event.ctrlKey || event.altKey || event.metaKey
  if (!hasStrongModifier && !isFunctionKey) return { ok: false, reason: 'needs-modifier' }
  return { ok: true, accelerator: [...mods, key].join('+') }
}

export function isValidAccelerator(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false
  const parts = value.split('+')
  // "Control+Plus" style keys never contain '+', so an empty part means a malformed string.
  if (parts.some((p) => p.length === 0)) return false
  const key = parts[parts.length - 1]!
  const mods = parts.slice(0, -1)
  if (new Set(mods).size !== mods.length) return false
  if (!mods.every((m): m is Modifier => (MODIFIERS as readonly string[]).includes(m))) return false
  const keyOk = /^[A-Z0-9]$/.test(key) || NAMED_KEYS.has(key) || PUNCTUATION.has(key)
  if (!keyOk) return false
  const isFunctionKey = /^F\d+$/.test(key)
  const strong = mods.includes('Control') || mods.includes('Alt') || mods.includes('Super')
  return strong || isFunctionKey
}

/** "Control+Shift+Space" -> "Ctrl + Shift + Space" */
export function formatAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => (part === 'Control' ? 'Ctrl' : part === 'Super' ? 'Win' : part))
    .join(' + ')
}
