/**
 * Text fields with the app's own spelling underlines: SpellInput for one-line fields (the quick
 * note strip, the tag field) and SpellTextArea for text that wraps onto as many lines as it
 * needs (the note title and image captions, which must stay readable in a narrow window).
 *
 * A field cannot draw decorations inside itself, so a transparent copy of its text lies exactly
 * over it, with the misspelled words underlined; it is laid out from the field's own computed
 * style (again whenever the font or text size changes) and follows it when it scrolls. The copy
 * of a wrapping field wraps exactly as the field does, so every line's underlines stay under
 * their words. Right-click (or the menu key) opens the Edit menu, with the suggestions for a
 * misspelled word first.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type ClipboardEventHandler,
  type FocusEventHandler,
  type ForwardedRef,
  type InputHTMLAttributes,
  type KeyboardEventHandler,
  type MouseEvent as ReactMouseEvent,
  type ReactEventHandler,
  type ReactNode,
  type TextareaHTMLAttributes,
  type UIEventHandler
} from 'react'
import { createPortal } from 'react-dom'
import { findMisses } from '@shared/spelling'
import { useSpeller } from '../lib/spelling'
import { useStore } from '../state/store'
import { editEntries, openedFromKeyboard, spellingEntries } from './editMenu'
import { MenuList, Popover } from './ui'

type FieldElement = HTMLInputElement | HTMLTextAreaElement

interface FieldMenu {
  x: number
  y: number
  /** Opened from the keyboard: the menu takes the keyboard, and gives it back when it closes. */
  keyboard: boolean
  hasSelection: boolean
  miss: { from: number; to: number; word: string; suggestions: string[] } | null
}

/** Set a field's text as if typed, so its owner's onChange runs. */
function typeInto(field: FieldElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

interface Common {
  value: string
  /** Class of the wrapper that takes the field's place in the layout. */
  fieldClassName?: string
}
type SpellInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & Common
type SpellTextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'rows'> & Common

/** Style properties that decide where each character of a field's text is drawn. */
const COPIED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'fontFeatureSettings', 'fontVariationSettings', 'fontKerning',
  'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'textRendering', 'lineHeight', 'boxSizing', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'
] as const
/** ... and, for a field that wraps, where its lines break. */
const COPIED_WRAPPING = ['whiteSpace', 'overflowWrap', 'wordBreak', 'lineBreak', 'hyphens'] as const

/**
 * How far below a word's box (its font's descent) the wave of a field's underline is drawn, so
 * it sits where a wavy text decoration 0.2em under the baseline would (see spelling.css). Found
 * once per font by measuring where the baseline falls in a word's box.
 */
const waveDrops = new Map<string, number>()
document.fonts?.addEventListener('loadingdone', () => waveDrops.clear())
const FONT_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariationSettings', 'fontFeatureSettings'] as const
function waveDrop(style: CSSStyleDeclaration): number {
  const key = FONT_KEYS.map((name) => style[name]).join('|')
  let drop = waveDrops.get(key)
  if (drop === undefined) {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;white-space:nowrap;line-height:normal'
    for (const name of FONT_KEYS) probe.style[name] = style[name]
    const word = document.createElement('span')
    word.textContent = 'x'
    // An empty inline block sits on the baseline.
    const baseline = document.createElement('span')
    baseline.style.cssText = 'display:inline-block;width:0;height:0'
    probe.append(word, baseline)
    document.body.append(probe)
    const descent = word.getBoundingClientRect().bottom - baseline.getBoundingClientRect().bottom
    probe.remove()
    drop = Math.max(0, Math.round((parseFloat(style.fontSize) * 0.2 + 3 - descent) * 10) / 10)
    waveDrops.set(key, drop)
  }
  return drop
}

interface Handlers<E extends FieldElement> {
  onChange?: ChangeEventHandler<E>
  onBlur?: FocusEventHandler<E>
  onSelect?: ReactEventHandler<E>
  onKeyUp?: KeyboardEventHandler<E>
  onScroll?: UIEventHandler<E>
}

/** Everything a spell-checked field needs: its ref, the handlers to put on it, and the underlines and menu to render beside it. */
function useSpellField<E extends FieldElement>(value: string, forwarded: ForwardedRef<E>, own: Handlers<E>, wraps: boolean) {
  const speller = useSpeller()
  const enabled = useStore((s) => s.prefs.spellcheck)
  const fontFamily = useStore((s) => s.prefs.fontFamily)
  const fontSize = useStore((s) => s.prefs.fontSize)
  const input = useRef<E | null>(null)
  const mirror = useRef<HTMLSpanElement>(null)
  const track = useRef<HTMLSpanElement>(null)
  const menuAnchor = useRef<HTMLSpanElement>(null)
  // Where the caret was when the user last typed: the word there is not underlined yet.
  const [typedAt, setTypedAt] = useState<number | null>(null)
  const [menu, setMenu] = useState<FieldMenu | null>(null)

  const setRef = useCallback(
    (element: E | null) => {
      input.current = element
      if (typeof forwarded === 'function') forwarded(element)
      else if (forwarded) forwarded.current = element
    },
    [forwarded]
  )

  const misses = useMemo(() => (enabled && speller.ready ? findMisses(value, speller) : []), [value, speller, enabled])
  const shown = typedAt === null ? misses : misses.filter((miss) => !(miss.from <= typedAt && typedAt <= miss.to))

  // Lay the copy over the field: same box, same font, same line breaks, same scroll.
  const place = useCallback(() => {
    const field = input.current
    const copy = mirror.current
    if (!field || !copy) return
    const style = getComputedStyle(field)
    for (const key of COPIED) copy.style[key] = style[key]
    if (wraps) for (const key of COPIED_WRAPPING) copy.style[key] = style[key]
    copy.style.borderStyle = 'solid'
    copy.style.setProperty('--spell-drop', `${waveDrop(style)}px`)
    copy.style.left = `${field.offsetLeft}px`
    copy.style.top = `${field.offsetTop}px`
    copy.style.width = `${field.offsetWidth}px`
    copy.style.height = `${field.offsetHeight}px`
    if (track.current) {
      const shift = wraps ? (field.scrollTop ? `translateY(${-field.scrollTop}px)` : '') : field.scrollLeft ? `translateX(${-field.scrollLeft}px)` : ''
      track.current.style.transform = shift
    }
  }, [wraps])

  const hasMirror = shown.length > 0
  useLayoutEffect(() => {
    if (!hasMirror) return
    place()
    const field = input.current
    if (!field) return
    // A wrapping field grows and shrinks with its text and with the window's width.
    const observer = new ResizeObserver(place)
    observer.observe(field)
    return () => observer.disconnect()
  }, [hasMirror, place, value])
  // A new default font or text size reaches the field's style once the window has applied it
  // (in the same frame, after this component's effects), and a font file may still be loading.
  useEffect(() => {
    if (!hasMirror) return
    const frame = requestAnimationFrame(place)
    document.fonts?.addEventListener('loadingdone', place)
    return () => {
      cancelAnimationFrame(frame)
      document.fonts?.removeEventListener('loadingdone', place)
    }
  }, [hasMirror, place, fontFamily, fontSize])

  const openMenu = (event: ReactMouseEvent<E>): void => {
    event.preventDefault()
    event.stopPropagation()
    const field = event.currentTarget
    const keyboard = openedFromKeyboard(event)
    const caret = field.selectionStart ?? 0
    const found = keyboard ? misses.find((range) => range.from <= caret && caret <= range.to) : inputMissAt(field, event.clientX, event.clientY)
    const miss = enabled && speller.ready && found ? { from: found.from, to: found.to, word: value.slice(found.from, found.to), suggestions: speller.suggest(value.slice(found.from, found.to)) } : null
    const box = field.getBoundingClientRect()
    setMenu({
      x: keyboard ? box.left + 8 : event.clientX,
      y: keyboard ? box.bottom : event.clientY,
      keyboard,
      hasSelection: (field.selectionStart ?? 0) !== (field.selectionEnd ?? 0),
      miss
    })
  }
  const refocus = (): void => input.current?.focus({ preventScroll: true })
  const closeMenu = (): void => {
    if (menu?.keyboard) refocus()
    setMenu(null)
  }
  const replace = (miss: NonNullable<FieldMenu['miss']>, replacement: string): void => {
    const field = input.current
    if (!field || field.value.slice(miss.from, miss.to) !== miss.word) return
    typeInto(field, field.value.slice(0, miss.from) + replacement + field.value.slice(miss.to))
    refocus()
    const caret = miss.from + replacement.length
    field.setSelectionRange(caret, caret)
    setTypedAt(null)
  }

  const caretMoved = (): void => {
    const field = input.current
    if (typedAt !== null && field && field.selectionStart !== typedAt) setTypedAt(null)
    place()
  }

  const segments: ReactNode[] = []
  let cursor = 0
  for (const miss of shown) {
    if (miss.from > cursor) segments.push(value.slice(cursor, miss.from))
    segments.push(
      <span key={miss.from} className="spell-miss" data-miss-from={miss.from} data-miss-to={miss.to}>
        {value.slice(miss.from, miss.to)}
      </span>
    )
    cursor = miss.to
  }
  if (cursor < value.length) segments.push(value.slice(cursor))

  const fieldProps = {
    spellCheck: false,
    onChange: (event: Parameters<ChangeEventHandler<E>>[0]) => {
      setTypedAt(event.target.selectionStart)
      own.onChange?.(event)
    },
    onBlur: (event: Parameters<FocusEventHandler<E>>[0]) => {
      setTypedAt(null)
      own.onBlur?.(event)
    },
    onSelect: (event: Parameters<ReactEventHandler<E>>[0]) => {
      caretMoved()
      own.onSelect?.(event)
    },
    onKeyUp: (event: Parameters<KeyboardEventHandler<E>>[0]) => {
      caretMoved()
      own.onKeyUp?.(event)
    },
    onScroll: (event: Parameters<UIEventHandler<E>>[0]) => {
      place()
      own.onScroll?.(event)
    },
    onContextMenu: openMenu
  }

  const overlay = (
    <>
      {hasMirror ? (
        <span ref={mirror} className="spell-mirror" aria-hidden="true">
          <span ref={track} className="spell-mirror-text">
            {segments}
          </span>
        </span>
      ) : null}
      {createPortal(<span ref={menuAnchor} className="context-anchor" style={menu ? { left: menu.x, top: menu.y } : undefined} />, document.body)}
      <Popover anchor={menuAnchor.current} open={menu !== null} onClose={closeMenu} role="menu" label="Edit" keepFocus={!menu?.keyboard} closeOnScroll>
        {menu ? (
          <MenuList
            onDone={closeMenu}
            keepFocus={!menu.keyboard}
            entries={[...spellingEntries(menu.miss, (replacement) => menu.miss && replace(menu.miss, replacement)), ...editEntries(menu.hasSelection, refocus)]}
          />
        ) : null}
      </Popover>
    </>
  )

  return { setRef, fieldProps, overlay, input }
}

/** A one-line text field with spelling underlines. */
export const SpellInput = forwardRef<HTMLInputElement, SpellInputProps>(function SpellInput({ value, fieldClassName, onChange, onBlur, onSelect, onKeyUp, onScroll, ...rest }, forwarded) {
  const spell = useSpellField<HTMLInputElement>(value, forwarded, { onChange, onBlur, onSelect, onKeyUp, onScroll }, false)
  return (
    <span className={`spell-field${fieldClassName ? ` ${fieldClassName}` : ''}`}>
      <input ref={spell.setRef} value={value} {...rest} {...spell.fieldProps} />
      {spell.overlay}
    </span>
  )
})

const LINE_BREAKS = /\r\n|\r|\n/g

/**
 * A field for a single line of text that wraps onto as many lines as it needs, growing with its
 * text (no scroll bar, nothing cut off). It never holds a line break: Enter and Shift+Enter are
 * left to the owner's onKeyDown, and pasted or dropped line breaks become spaces.
 *
 * React does not hold the textarea's text (no `value` prop): a controlled textarea also gets its
 * default text (its child text node) rewritten on every change, and that ends Chromium's run of
 * typing, so Ctrl+Z would take back one letter at a time instead of what was typed. The text is
 * put in from `value` whenever the two differ (a note opened, Organize, a suggestion picked).
 */
export const SpellTextArea = forwardRef<HTMLTextAreaElement, SpellTextAreaProps>(function SpellTextArea({ value, fieldClassName, onChange, onBlur, onSelect, onKeyUp, onScroll, onPaste, ...rest }, forwarded) {
  const oneLine: ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    const field = event.target
    if (/[\r\n]/.test(field.value)) {
      const caret = field.value.slice(0, field.selectionStart ?? field.value.length).replace(LINE_BREAKS, ' ').length
      field.value = field.value.replace(LINE_BREAKS, ' ')
      field.setSelectionRange(caret, caret)
    }
    onChange?.(event)
  }
  const spell = useSpellField<HTMLTextAreaElement>(value, forwarded, { onChange: oneLine, onBlur, onSelect, onKeyUp, onScroll }, true)
  useLayoutEffect(() => {
    const field = spell.input.current
    if (field && field.value !== value) field.value = value
  }, [spell.input, value])
  // A line break is never typed in, whatever key or input method asks for one.
  useEffect(() => {
    const field = spell.input.current
    if (!field) return
    const refuse = (event: InputEvent): void => {
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') event.preventDefault()
    }
    field.addEventListener('beforeinput', refuse)
    return () => field.removeEventListener('beforeinput', refuse)
  }, [spell.input])
  // Pasted lines are joined with spaces as they go in, so Ctrl+Z takes the paste back, as one
  // step of its own (putting the selection back where it is ends the run of typing around it).
  const pasteOnOneLine: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
    onPaste?.(event)
    const text = event.clipboardData.getData('text/plain')
    if (event.defaultPrevented || !/[\r\n]/.test(text)) return
    event.preventDefault()
    const field = event.currentTarget
    const endTyping = (): void => field.setSelectionRange(field.selectionStart, field.selectionEnd, field.selectionDirection)
    endTyping()
    document.execCommand('insertText', false, text.replace(LINE_BREAKS, ' '))
    endTyping()
  }
  return (
    <span className={`spell-field is-wrapping${fieldClassName ? ` ${fieldClassName}` : ''}`}>
      <textarea ref={spell.setRef} rows={1} {...rest} {...spell.fieldProps} onPaste={pasteOnOneLine} />
      {spell.overlay}
    </span>
  )
})

/** The caret of a wrapping field is on its last line (as wrapped on screen): the next line down is outside the field. */
export function caretOnLastLine(field: HTMLTextAreaElement): boolean {
  const value = field.value
  const caret = field.selectionEnd ?? value.length
  if (caret >= value.length - 1) return true
  const probe = document.createElement('div')
  const style = getComputedStyle(field)
  for (const key of [...COPIED, ...COPIED_WRAPPING]) probe.style[key] = style[key]
  probe.style.borderStyle = 'solid'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.left = '-10000px'
  probe.style.top = '0'
  probe.style.width = `${field.offsetWidth}px`
  // The line of the character after the caret (a caret where a line wraps shows at the start
  // of the next line), against the line of the last character.
  const at = document.createElement('span')
  const end = document.createElement('span')
  at.textContent = value.charAt(caret)
  end.textContent = value.charAt(value.length - 1)
  probe.append(value.slice(0, caret), at, value.slice(caret + 1, -1), end)
  document.body.append(probe)
  const last = at.offsetTop >= end.offsetTop
  probe.remove()
  return last
}

/** The misspelled word of a SpellInput or SpellTextArea under a point on screen, from its underlines. */
export function inputMissAt(field: HTMLElement, x: number, y: number): { from: number; to: number; word: string } | null {
  const wrapper = field.closest('.spell-field')
  for (const span of Array.from(wrapper?.querySelectorAll<HTMLElement>('.spell-mirror .spell-miss') ?? [])) {
    // A word may be split over two lines: each of its pieces counts.
    for (const box of Array.from(span.getClientRects())) {
      if (x >= box.left && x <= box.right && y >= box.top - 4 && y <= box.bottom + 4) {
        return { from: Number(span.dataset.missFrom), to: Number(span.dataset.missTo), word: span.textContent ?? '' }
      }
    }
  }
  return null
}
