/**
 * The slim strip at the top: a drag region, the window opacity control, the settings gear
 * (the only other permanent toolbar button) and the two essential window controls.
 */
import { Archive, EyeOff, Minus, Pin, Power, Search, Settings, SlidersHorizontal, Trash2, X } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { formatAccelerator } from '@shared/accelerator'
import {
  MIN_WINDOW_OPACITY,
  OPACITY_PRESETS,
  OPACITY_SHORTCUT_LABELS,
  formatOpacity,
  opacityAtFraction,
  opacityFraction,
  opacityPercent,
  opacityWheelSteps,
  stepOpacity
} from '@shared/preferences'
import { api } from '../lib/api'
import {
  adjustOpacity,
  beginOpacityAdjust,
  flushAll,
  getOpacityLive,
  openPanel,
  setGearOpen,
  setSolidWhileInUse,
  shownOpacity,
  stepWindowOpacity,
  subscribeOpacity
} from '../state/actions'
import { useStore } from '../state/store'
import { CandleChip } from './CandleChip'
import { IconButton, MenuList, Popover, Switch, type MenuEntry } from './ui'

/** The opacity the controls show: the value being adjusted, or else the stored one. */
export function useShownOpacity(): number {
  const stored = useStore((s) => s.prefs.windowOpacity)
  const live = useSyncExternalStore(subscribeOpacity, getOpacityLive)
  return live.draft ?? stored
}

/** How long the small readout under the icon stays after the wheel or the shortcut changed the value. */
const READOUT_MS = 1100
const DROP = 'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z'

/**
 * Where the fill of the drop ends (y in its 24-unit box; the drop spans 2 to 22). Solid fills
 * it to the tip. Any see-through value empties the narrow tip, so the difference shows at a
 * glance even at 16 px, and then drains the body evenly down to the minimum.
 */
function dropFillTop(value: number): number {
  const percent = opacityPercent(value)
  if (percent >= 100) return 2
  const drained = (95 - Math.min(95, percent)) / (95 - opacityPercent(MIN_WINDOW_OPACITY))
  return 9 + 10 * Math.min(1, Math.max(0, drained))
}

/** A drop that is full when the window is solid and drains as it becomes see-through. */
function OpacityGlyph({ value }: { value: number }) {
  const id = `tn-drop-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const top = dropFillTop(value)
  return (
    <svg className="opacity-glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <defs>
        <clipPath id={id}>
          <rect x="0" y={top} width="24" height={24 - top} />
        </clipPath>
      </defs>
      <path className="opacity-glyph-fill" d={DROP} fill="currentColor" stroke="none" clipPath={`url(#${id})`} />
      <path d={DROP} />
    </svg>
  )
}

/**
 * The opacity slider, in the title bar popover and in Settings: the minimum at the left end,
 * solid at the right. Arrow keys move 5 %, Page Up / Page Down 10 %, Home and End go to the
 * ends. A drag follows the pointer once a frame and stores the value on release.
 */
export function OpacitySlider({ label = 'Window opacity' }: { label?: string }) {
  const value = useShownOpacity()
  const percent = opacityPercent(value)
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; frame: number | null; end: () => void } | null>(null)

  const valueAt = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return shownOpacity()
    return opacityAtFraction((clientX - rect.left) / rect.width)
  }

  const finish = (pointerId: number, clientX: number | null): void => {
    const current = drag.current
    if (!current || current.pointerId !== pointerId) return
    drag.current = null
    if (current.frame !== null) cancelAnimationFrame(current.frame)
    adjustOpacity(valueAt(clientX ?? current.x), 'now')
    current.end()
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || drag.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, x: event.clientX, frame: null, end: beginOpacityAdjust() }
    adjustOpacity(valueAt(event.clientX), 'later')
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    current.x = event.clientX
    if (current.frame !== null) return
    current.frame = requestAnimationFrame(() => {
      current.frame = null
      if (drag.current === current) adjustOpacity(valueAt(current.x), 'later')
    })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const now = shownOpacity()
    let next: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = stepOpacity(now, -1)
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = stepOpacity(now, 1)
    else if (event.key === 'PageDown') next = stepOpacity(now, -2)
    else if (event.key === 'PageUp') next = stepOpacity(now, 2)
    else if (event.key === 'Home') next = MIN_WINDOW_OPACITY
    else if (event.key === 'End') next = 1
    if (next === null || event.ctrlKey || event.altKey || event.metaKey) return
    event.preventDefault()
    adjustOpacity(next, 'soon')
  }

  // A drag cut short (the popover closed under it) still ends the preview and stores the value.
  useEffect(() => () => {
    const current = drag.current
    if (current) finish(current.pointerId, null)
  }, [])

  return (
    <div
      className="opacity-slider"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={opacityPercent(MIN_WINDOW_OPACITY)}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent} percent`}
      style={{ '--opacity-fill': `${opacityFraction(value) * 100}%` } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event.pointerId, event.clientX)}
      onPointerCancel={(event) => finish(event.pointerId, null)}
      onLostPointerCapture={(event) => finish(event.pointerId, null)}
      onKeyDown={onKeyDown}
      data-testid="opacity-slider"
    >
      <div ref={track} className="opacity-track">
        <div className="opacity-track-fill" />
        <div className="opacity-thumb" />
      </div>
    </div>
  )
}

/** The popover: slider with live preview, quick presets and "Solid while I use it". */
function OpacityPanel() {
  const value = useShownOpacity()
  const solidWhileInUse = useStore((s) => s.prefs.opacitySolidOnHover)
  const percent = opacityPercent(value)
  // Left to right, like the slider: most see-through first.
  const presets = [...OPACITY_PRESETS].sort((a, b) => a - b)
  return (
    <div className="opacity-panel">
      <div className="opacity-head">
        <span className="opacity-title">Window opacity</span>
        <span className="opacity-value" aria-hidden="true" data-testid="opacity-value">{percent}%</span>
      </div>
      <OpacitySlider />
      <div className="opacity-presets" role="group" aria-label="Quick choices">
        {presets.map((preset) => (
          <button key={preset} type="button" className="opacity-preset" aria-pressed={opacityPercent(preset) === percent} onClick={() => adjustOpacity(preset, 'now')}>
            {formatOpacity(preset)}
          </button>
        ))}
      </div>
      <div className="opacity-solid">
        <div>
          <div className="opacity-solid-label">Solid while I use it</div>
          <div className="opacity-help">While the pointer is on the notes or you type in them.</div>
        </div>
        <Switch label="Solid while I use it" checked={solidWhileInUse} onChange={setSolidWhileInUse} />
      </div>
      <p className="opacity-keys">
        Scroll over the drop to change it quickly, or press {OPACITY_SHORTCUT_LABELS.down} / Plus.
      </p>
    </div>
  )
}

/** The title bar button: shows the current opacity, opens the popover, and takes the mouse wheel. */
function OpacityControl() {
  const value = useShownOpacity()
  const { flash } = useSyncExternalStore(subscribeOpacity, getOpacityLive)
  const gearOpen = useStore((s) => s.gearOpen)
  const [open, setOpen] = useState(false)
  const [readout, setReadout] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const wheelCarry = useRef(0)
  const percent = opacityPercent(value)

  // While the popover is open the window shows the value as it is, even under the pointer.
  useEffect(() => (open ? beginOpacityAdjust() : undefined), [open])

  // A quick change (wheel, shortcut) shows the new value under the icon for a moment.
  useEffect(() => {
    if (flash === 0) return
    setReadout(true)
    const timer = window.setTimeout(() => setReadout(false), READOUT_MS)
    return () => window.clearTimeout(timer)
  }, [flash])

  const onWheel = (event: ReactWheelEvent<HTMLButtonElement>): void => {
    const pixels = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY
    const { steps, carry } = opacityWheelSteps(pixels, wheelCarry.current)
    wheelCarry.current = carry
    if (steps !== 0) stepWindowOpacity(steps, 'wheel')
  }

  const title = `Window opacity: ${percent}%\nScroll over this, or ${OPACITY_SHORTCUT_LABELS.down} / ${OPACITY_SHORTCUT_LABELS.up}`

  return (
    <span className="opacity-control">
      <IconButton
        ref={button}
        label={`Window opacity ${percent}%`}
        title={title}
        className={`opacity-button${percent < 100 ? ' is-see-through' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onWheel={onWheel}
        data-testid="opacity-button"
      >
        <OpacityGlyph value={value} />
      </IconButton>
      {readout && !open && !gearOpen ? (
        <span className="opacity-flash" aria-hidden="true" data-testid="opacity-flash">
          {percent}%
        </span>
      ) : null}
      <Popover anchor={button.current} open={open} onClose={() => setOpen(false)} align="end" label="Window opacity" className="opacity-popover">
        <OpacityPanel />
      </Popover>
    </span>
  )
}

export function TitleBar() {
  const gearOpen = useStore((s) => s.gearOpen)
  const trashCount = useStore((s) => s.trashCount)
  const pinCount = useStore((s) => s.pins.length)
  const shortcut = useStore((s) => s.shortcut)
  const gear = useRef<HTMLButtonElement>(null)

  const hide = (): void => {
    void flushAll().finally(() => void api.windowAction('hide'))
  }

  const entries: MenuEntry[] = [
    { label: 'Settings', icon: <SlidersHorizontal size={15} />, onSelect: () => openPanel('settings') },
    { label: 'Find notes', icon: <Search size={15} />, hint: 'Ctrl+K', onSelect: () => openPanel('find') },
    { label: pinCount > 0 ? `Pinned notes (${pinCount})` : 'Pinned notes', icon: <Pin size={15} />, onSelect: () => openPanel('pins') },
    { label: 'Backup and import', icon: <Archive size={15} />, onSelect: () => openPanel('backup') },
    { label: trashCount > 0 ? `Trash (${trashCount})` : 'Trash', icon: <Trash2 size={15} />, onSelect: () => openPanel('trash') },
    { kind: 'separator' },
    { label: 'Hide to tray', icon: <EyeOff size={15} />, hint: shortcut.registered ? formatAccelerator(shortcut.accelerator) : undefined, onSelect: hide },
    { label: 'Quit Trading Notes', icon: <Power size={15} />, onSelect: () => void api.windowAction('quit') }
  ]

  return (
    <header className="titlebar">
      <div className="titlebar-drag" onDoubleClick={() => void api.windowAction('toggle-maximize')} />
      <div className="titlebar-controls">
        <CandleChip />
        <OpacityControl />
        <IconButton ref={gear} label="Menu" aria-haspopup="menu" aria-expanded={gearOpen} onClick={() => setGearOpen(!gearOpen)} data-testid="gear">
          <Settings size={16} />
        </IconButton>
        <Popover anchor={gear.current} open={gearOpen} onClose={() => setGearOpen(false)} align="end" role="menu" label="Menu">
          <MenuList entries={entries} onDone={() => setGearOpen(false)} />
        </Popover>
        <IconButton label="Minimize" className="window-control" onClick={() => void api.windowAction('minimize')}>
          <Minus size={16} />
        </IconButton>
        <IconButton label="Hide to tray" className="window-control" onClick={hide} data-testid="hide-window">
          <X size={16} />
        </IconButton>
      </div>
    </header>
  )
}
