/**
 * A one-line text field with the app's own spelling underlines (the note title, the quick note
 * strip, image captions, the tag field). A field cannot draw decorations inside itself, so a
 * transparent copy of its text lies exactly over it, with the misspelled words underlined; it is
 * laid out from the field's own computed style (again whenever the font or text size changes)
 * and follows it when it scrolls sideways. Right-click (or the menu key) opens the Edit menu,
 * with the suggestions for a misspelled word first.
 */
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { findMisses } from '@shared/spelling'
import { useSpeller } from '../lib/spelling'
import { useStore } from '../state/store'
import { editEntries, openedFromKeyboard, spellingEntries } from './editMenu'
import { MenuList, Popover } from './ui'

interface FieldMenu {
  x: number
  y: number
  /** Opened from the keyboard: the menu takes the keyboard, and gives it back when it closes. */
  keyboard: boolean
  hasSelection: boolean
  miss: { from: number; to: number; word: string; suggestions: string[] } | null
}

/** Set a field's text as if typed, so its owner's onChange runs. */
function typeInto(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

interface SpellInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> {
  value: string
  /** Class of the wrapper that takes the field's place in the layout. */
  fieldClassName?: string
}

/** Style properties that decide where each character of a field's text is drawn. */
const COPIED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'fontFeatureSettings', 'fontVariationSettings',
  'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'lineHeight', 'boxSizing',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'
] as const

export const SpellInput = forwardRef<HTMLInputElement, SpellInputProps>(function SpellInput({ value, fieldClassName, onChange, onBlur, onSelect, onKeyUp, onScroll, ...rest }, forwarded) {
  const speller = useSpeller()
  const enabled = useStore((s) => s.prefs.spellcheck)
  const fontFamily = useStore((s) => s.prefs.fontFamily)
  const fontSize = useStore((s) => s.prefs.fontSize)
  const input = useRef<HTMLInputElement | null>(null)
  const mirror = useRef<HTMLSpanElement>(null)
  const track = useRef<HTMLSpanElement>(null)
  const menuAnchor = useRef<HTMLSpanElement>(null)
  // Where the caret was when the user last typed: the word there is not underlined yet.
  const [typedAt, setTypedAt] = useState<number | null>(null)
  const [menu, setMenu] = useState<FieldMenu | null>(null)

  const setRef = useCallback(
    (element: HTMLInputElement | null) => {
      input.current = element
      if (typeof forwarded === 'function') forwarded(element)
      else if (forwarded) forwarded.current = element
    },
    [forwarded]
  )

  const misses = useMemo(() => (enabled && speller.ready ? findMisses(value, speller) : []), [value, speller, enabled])
  const shown = typedAt === null ? misses : misses.filter((miss) => !(miss.from <= typedAt && typedAt <= miss.to))

  // Lay the copy over the field: same box, same font, same scroll.
  const place = useCallback(() => {
    const field = input.current
    const copy = mirror.current
    if (!field || !copy) return
    const style = getComputedStyle(field)
    for (const key of COPIED) copy.style[key] = style[key]
    copy.style.borderStyle = 'solid'
    copy.style.left = `${field.offsetLeft}px`
    copy.style.top = `${field.offsetTop}px`
    copy.style.width = `${field.offsetWidth}px`
    copy.style.height = `${field.offsetHeight}px`
    if (track.current) track.current.style.transform = field.scrollLeft ? `translateX(${-field.scrollLeft}px)` : ''
  }, [])

  const hasMirror = shown.length > 0
  useLayoutEffect(() => {
    if (!hasMirror) return
    place()
    const field = input.current
    if (!field) return
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

  const openMenu = (event: ReactMouseEvent<HTMLInputElement>): void => {
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

  const segments: React.ReactNode[] = []
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

  return (
    <span className={`spell-field${fieldClassName ? ` ${fieldClassName}` : ''}`}>
      <input
        ref={setRef}
        value={value}
        spellCheck={false}
        {...rest}
        onChange={(event) => {
          setTypedAt(event.target.selectionStart)
          onChange?.(event)
        }}
        onBlur={(event) => {
          setTypedAt(null)
          onBlur?.(event)
        }}
        onSelect={(event) => {
          caretMoved()
          onSelect?.(event)
        }}
        onKeyUp={(event) => {
          caretMoved()
          onKeyUp?.(event)
        }}
        onScroll={(event) => {
          place()
          onScroll?.(event)
        }}
        onContextMenu={openMenu}
      />
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
    </span>
  )
})

/** The misspelled word of a SpellInput under a point on screen, from its underlines. */
export function inputMissAt(field: HTMLElement, x: number, y: number): { from: number; to: number; word: string } | null {
  const wrapper = field.closest('.spell-field')
  for (const span of Array.from(wrapper?.querySelectorAll<HTMLElement>('.spell-mirror .spell-miss') ?? [])) {
    const box = span.getBoundingClientRect()
    if (x >= box.left && x <= box.right && y >= box.top - 4 && y <= box.bottom + 4) {
      return { from: Number(span.dataset.missFrom), to: Number(span.dataset.missTo), word: span.textContent ?? '' }
    }
  }
  return null
}
