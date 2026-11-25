/**
 * A one-line text field with the app's own spelling underlines (the note title, the quick note
 * strip, image captions). A field cannot draw decorations inside itself, so a transparent copy
 * of its text lies exactly over it, with the misspelled words underlined; it is laid out from
 * the field's own computed style and follows it when it scrolls sideways.
 */
import { forwardRef, useCallback, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes } from 'react'
import { findMisses } from '@shared/spelling'
import { useSpeller } from '../lib/spelling'
import { useStore } from '../state/store'

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
  const input = useRef<HTMLInputElement | null>(null)
  const mirror = useRef<HTMLSpanElement>(null)
  const track = useRef<HTMLSpanElement>(null)
  // Where the caret was when the user last typed: the word there is not underlined yet.
  const [typedAt, setTypedAt] = useState<number | null>(null)

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
      />
      {hasMirror ? (
        <span ref={mirror} className="spell-mirror" aria-hidden="true">
          <span ref={track} className="spell-mirror-text">
            {segments}
          </span>
        </span>
      ) : null}
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
