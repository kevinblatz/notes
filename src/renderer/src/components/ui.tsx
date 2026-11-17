/** Small shared interface pieces: icon buttons, anchored popovers, menus, switches. */
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { useEscape } from '../lib/escape'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  /** Optional keyboard shortcut shown in the tooltip. */
  hint?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, active, hint, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-button${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={hint ? `${label} (${hint})` : label}
      {...rest}
    >
      {children}
    </button>
  )
})

interface PopoverProps {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  placement?: 'top' | 'bottom'
  align?: 'start' | 'end' | 'center'
  className?: string
  role?: string
  label?: string
  /** Keep focus where it is (used by the text-selection controls so the editor keeps its selection). */
  keepFocus?: boolean
  children: ReactNode
}

/**
 * A floating panel attached to its trigger. It is drawn inside the notes window (fixed to
 * the viewport and clamped to its edges), never as a separate OS window.
 */
export function Popover({ anchor, open, onClose, placement = 'bottom', align = 'start', className, role = 'dialog', label, keepFocus, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Until it has been measured and placed, the panel is transparent rather than hidden: a
  // hidden element cannot take keyboard focus, and menus must be focusable the moment they open.
  const [style, setStyle] = useState<CSSProperties>({ top: 0, left: 0, opacity: 0 })

  const reposition = useCallback(() => {
    const panel = ref.current
    if (!panel || !anchor) return
    const a = anchor.getBoundingClientRect()
    const width = panel.offsetWidth
    const height = panel.offsetHeight
    const margin = 8
    let top = placement === 'bottom' ? a.bottom + 6 : a.top - height - 6
    if (placement === 'bottom' && top + height > window.innerHeight - margin && a.top - height - 6 >= margin) top = a.top - height - 6
    if (placement === 'top' && top < margin && a.bottom + 6 + height <= window.innerHeight - margin) top = a.bottom + 6
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin))
    let left = align === 'start' ? a.left : align === 'end' ? a.right - width : a.left + a.width / 2 - width / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
    setStyle({ top, left })
  }, [anchor, placement, align])

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ top: 0, left: 0, opacity: 0 })
      return
    }
    reposition()
    if (keepFocus) return
    // Move the keyboard into the panel so arrow keys, Tab and Enter work straight away.
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], button:not([disabled]), input, [tabindex="0"]')
    first?.focus({ preventScroll: true })
  }, [open, reposition, keepFocus])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    const anchoredAt = anchor?.getBoundingClientRect()
    const onScroll = (event: Event): void => {
      if (ref.current?.contains(event.target as Node)) return
      // Close only when the thing the panel is attached to has actually moved. A menu on the
      // title bar stays open while the board underneath scrolls.
      const now = anchor?.getBoundingClientRect()
      if (anchoredAt && now && Math.abs(now.top - anchoredAt.top) < 2 && Math.abs(now.left - anchoredAt.left) < 2) return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, anchor, onClose, reposition])

  useEscape(open, () => {
    onClose()
    if (!keepFocus) anchor?.focus()
  })

  if (!open) return null
  return createPortal(
    <div ref={ref} className={`popover${className ? ` ${className}` : ''}`} style={style} role={role} aria-label={label} data-overlay>
      {children}
    </div>,
    document.body
  )
}

export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; checked?: boolean; onSelect: () => void }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }

/** Vertical menu with arrow-key navigation. */
export function MenuList({ entries, onDone, keepFocus }: { entries: MenuEntry[]; onDone: () => void; keepFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1]?.focus()
    }
  }
  return (
    <div ref={ref} className="menu" role="menu" onKeyDown={onKeyDown}>
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') return <div key={index} className="menu-separator" role="separator" />
        if (entry.kind === 'label') return <div key={index} className="menu-label">{entry.label}</div>
        return (
          <button
            key={index}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            className={`menu-item${entry.danger ? ' is-danger' : ''}`}
            disabled={entry.disabled}
            onMouseDown={keepFocus ? (event) => event.preventDefault() : undefined}
            onClick={() => {
              onDone()
              entry.onSelect()
            }}
          >
            <span className="menu-icon">{entry.icon}</span>
            <span className="menu-text">{entry.label}</span>
            {entry.hint ? <span className="menu-hint">{entry.hint}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-thumb" />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (next: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? 'is-selected' : ''} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Trap Tab inside a panel while it is open. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const previous = document.activeElement as HTMLElement | null
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !ref.current) return
      const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex="0"]')).filter(
        (el) => el.offsetParent !== null
      )
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus?.({ preventScroll: true })
    }
  }, [ref, active])
}
