/**
 * The candle timer in the title bar: "5m 2:13" to the next candle close. The main process
 * keeps the time of the closes (and says when one happens, for the chime); this chip only
 * redraws its countdown, once a second, while it is on and the window can be seen.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatAccelerator } from '@shared/accelerator'
import { CANDLE_MINUTES, CANDLE_URGENT_MS, candleLabel, formatCountdown, nextCandleClose, type CandleMinutes } from '@shared/candles'
import { updatePreferences } from '../state/actions'
import { appNow, useStore } from '../state/store'
import { MenuList, Popover, type MenuEntry } from './ui'

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
const pageVisible = (): boolean => document.visibilityState === 'visible'

export function CandleChip() {
  const on = useStore((s) => s.prefs.candleTimer)
  return on ? <CandleCountdown /> : null
}

const MINUTE_NAMES: Record<CandleMinutes, string> = { 1: '1 minute', 5: '5 minutes', 15: '15 minutes', 60: '1 hour' }

function CandleCountdown() {
  const minutes = useStore((s) => s.prefs.candleMinutes)
  const chime = useStore((s) => s.prefs.candleChime)
  const offset = useStore((s) => s.clockOffsetMs)
  const closes = useStore((s) => s.candleCloses)
  const hotkey = useStore((s) => s.hotkeys.candleTimer)
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible)
  const [now, setNow] = useState(appNow)
  const [open, setOpen] = useState(false)
  const [pulsing, setPulsing] = useState(false)
  const button = useRef<HTMLButtonElement>(null)

  // One timer, and only while the chip can be seen: it wakes when the shown second changes.
  useEffect(() => {
    if (!visible) return
    let timer = 0
    const tick = (): void => {
      const t = appNow()
      setNow(t)
      const remaining = nextCandleClose(t, minutes) - t
      timer = window.setTimeout(tick, (remaining % 1000 || 1000) + 4)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [visible, minutes, offset])

  // A brief pulse at each close (not with reduced motion).
  useEffect(() => {
    if (closes === 0 || document.documentElement.dataset.motion === 'reduce') return
    setPulsing(true)
  }, [closes])

  const remaining = nextCandleClose(now, minutes) - now
  const countdown = formatCountdown(remaining)
  const urgent = remaining <= CANDLE_URGENT_MS
  const keys = hotkey.enabled && hotkey.registered ? ` (${formatAccelerator(hotkey.accelerator)} hides it)` : ''

  const entries: MenuEntry[] = [
    { kind: 'label', label: 'Candle' },
    ...CANDLE_MINUTES.map<MenuEntry>((value) => ({
      label: MINUTE_NAMES[value],
      checked: value === minutes,
      onSelect: () => void updatePreferences({ candleMinutes: value })
    })),
    { kind: 'separator' },
    { label: 'Chime at close', checked: chime, onSelect: () => void updatePreferences({ candleChime: !chime }) },
    { label: 'Hide timer', onSelect: () => void updatePreferences({ candleTimer: false }) }
  ]

  return (
    <span className="candle-control">
      <button
        ref={button}
        type="button"
        className={`candle-chip${urgent ? ' is-urgent' : ''}${pulsing ? ' is-pulsing' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Candle timer: ${MINUTE_NAMES[minutes]}, ${countdown} to the close`}
        title={`Next ${candleLabel(minutes)} candle closes in ${countdown}${keys}`}
        onClick={() => setOpen(!open)}
        onAnimationEnd={() => setPulsing(false)}
        data-testid="candle-chip"
        data-urgent={urgent}
        data-closes={closes}
      >
        <span className="candle-frame" data-testid="candle-frame">{candleLabel(minutes)}</span>
        <span className="candle-time" data-testid="candle-time">{countdown}</span>
      </button>
      <Popover anchor={button.current} open={open} onClose={() => setOpen(false)} align="end" role="menu" label="Candle timer" className="candle-popover">
        <MenuList entries={entries} onDone={() => setOpen(false)} />
      </Popover>
    </span>
  )
}
