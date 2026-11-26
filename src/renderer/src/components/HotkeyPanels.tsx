/**
 * The two panels a typing hotkey opens at the top of the notes window, under the title bar:
 * the quick note strip and the risk calculator. Whatever is open underneath (a note in the
 * editor, the board, a panel) is left exactly as it was. Closing either one gives the keyboard
 * back to where it was before the hotkey.
 */
import { CornerDownLeft, Copy, PenLine } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  convertStopText,
  distanceFromPrices,
  dollarsInputText,
  evaluateRisk,
  formatContracts,
  formatDollars,
  formatPoints,
  formatTicks,
  INSTRUMENT_KEYS,
  INSTRUMENTS,
  parseDollars,
  tickValueCents,
  type InstrumentKey,
  type StopUnit
} from '@shared/risk'
import { clockTime } from '@shared/sessionLog'
import { useEscape } from '../lib/escape'
import { loadSpelling } from '../lib/spelling'
import { updatePreferences } from '../state/actions'
import { copyContractsAndClose, endCapture, registerQuickNoteFlush, submitQuickNote } from '../state/hotkeys'
import { cleanMessage } from '../state/saver'
import { useStore, type CaptureState } from '../state/store'
import { SpellInput } from './SpellInput'
import { Segmented } from './ui'

export function HotkeyPanels() {
  const capture = useStore((s) => s.capture)
  if (!capture) return null
  // Kept (with what is typed in it) when a later press takes the panel over in a new session.
  return capture.kind === 'quickNote' ? <QuickNoteStrip key="quickNote" capture={capture} /> : <RiskPanel key="risk" capture={capture} />
}

/**
 * Tab and Shift+Tab go round the panel's own fields and buttons, wherever the keyboard is
 * (also after a title bar button was clicked): they never reach a note or a sheet underneath,
 * where the next keys typed would land.
 */
function useTabInside(card: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey || !card.current) return
      const items = Array.from(card.current.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])')).filter(
        (item) => item.tabIndex >= 0 && item.offsetParent !== null
      )
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      const wrapTo = index === -1 ? (event.shiftKey ? last : first) : event.shiftKey && index === 0 ? last : !event.shiftKey && index === items.length - 1 ? first : null
      if (!wrapTo) return
      event.preventDefault()
      wrapTo.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [card])
}

/** Clicking beside the panel closes it, unless that would throw away typing. */
function Layer({ children, onOutside, label }: { children: React.ReactNode; onOutside: () => void; label: string }) {
  const card = useRef<HTMLDivElement>(null)
  useTabInside(card)
  return (
    <div
      className="capture-layer"
      data-overlay
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        onOutside()
      }}
    >
      <div ref={card} className="capture-card" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

function QuickNoteStrip({ capture }: { capture: CaptureState }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // In the same frame the strip appears (and again on every further press), so the first
  // keystrokes are not lost.
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true })
  }, [capture.presses])
  // The strip underlines misspellings with the app's own checker (Chromium's is off).
  useEffect(() => {
    void loadSpelling().catch(() => undefined)
  }, [])

  useEscape(true, () => {
    if (!busy) endCapture()
  })

  const textNow = useRef(text)
  textNow.current = text
  const inFlight = useRef<Promise<boolean> | null>(null)

  /** Adds the line (one write at a time); resolves false if it could not be written. */
  const submit = (event?: FormEvent): Promise<boolean> => {
    event?.preventDefault()
    if (inFlight.current) return inFlight.current
    setBusy(true)
    setError(null)
    const run = (async () => {
      try {
        if (await submitQuickNote(textNow.current)) setText('')
        return true
      } catch (failure) {
        setError(`Not added yet: ${cleanMessage(failure)} Your text is still here; press Enter to try again.`)
        return false
      } finally {
        inFlight.current = null
        setBusy(false)
        input.current?.focus({ preventScroll: true })
      }
    })()
    inFlight.current = run
    return run
  }
  const submitNow = useRef(submit)
  submitNow.current = submit
  // Opening today's log by its hotkey adds what is in the strip first.
  useEffect(() => {
    registerQuickNoteFlush(() => submitNow.current())
    return () => registerQuickNoteFlush(null)
  }, [])

  return (
    <Layer label="Quick note" onOutside={() => (text.trim() ? input.current?.focus() : endCapture())}>
      <form className="quick-note" onSubmit={(event) => void submit(event)} data-testid="quick-note">
        <PenLine className="quick-note-icon" size={15} aria-hidden="true" />
        <span className="quick-note-time" title="The time this line will carry">{clockTime(capture.at)}</span>
        <SpellInput
          ref={input}
          fieldClassName="quick-note-field"
          className="quick-note-input"
          type="text"
          value={text}
          maxLength={2000}
          placeholder="Quick note for today’s log"
          aria-label="Quick note"
          aria-describedby="quick-note-hint"
          aria-invalid={error ? true : undefined}
          readOnly={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the line (Ctrl+Enter too, so it never reaches a note open underneath).
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <span className="capture-keys" id="quick-note-hint">
          <kbd>
            <CornerDownLeft size={11} aria-hidden="true" />
            <span className="sr-only">Enter</span>
          </kbd>{' '}
          adds to today’s log <span className="capture-keys-sep" aria-hidden="true">·</span> <kbd>Esc</kbd>
        </span>
      </form>
      {error ? (
        <p className="capture-error" role="alert">
          {error}
        </p>
      ) : null}
    </Layer>
  )
}

function RiskPanel({ capture }: { capture: CaptureState }) {
  const prefs = useStore((s) => s.prefs)
  const [instrument, setInstrument] = useState<InstrumentKey>(prefs.riskInstrument)
  const [risk, setRisk] = useState(prefs.riskCents ? dollarsInputText(prefs.riskCents) : '')
  const [unit, setUnit] = useState<StopUnit>(prefs.riskUnit)
  const [stop, setStop] = useState('')
  const [entry, setEntry] = useState('')
  const [stopPrice, setStopPrice] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const riskInput = useRef<HTMLInputElement>(null)
  const stopInput = useRef<HTMLInputElement>(null)
  const outcome = evaluateRisk({ instrument, risk, stop, unit })
  const fill = distanceFromPrices(entry, stopPrice, unit)

  // Focus the first field that still needs typing: the stop when the risk is remembered.
  useLayoutEffect(() => {
    const target = risk.trim() ? stopInput.current : riskInput.current
    target?.focus({ preventScroll: true })
    target?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture.presses])

  // Remembered for next time when the panel closes: the instrument, the dollar risk and the unit.
  const latest = useRef({ instrument, risk, unit })
  latest.current = { instrument, risk, unit }
  useEffect(
    () => () => {
      const { instrument: lastInstrument, risk: lastRisk, unit: lastUnit } = latest.current
      const cents = parseDollars(lastRisk)
      const patch = { riskInstrument: lastInstrument, riskUnit: lastUnit, riskCents: cents && cents > 0 ? cents : null }
      const stored = useStore.getState().prefs
      if (patch.riskInstrument !== stored.riskInstrument || patch.riskUnit !== stored.riskUnit || patch.riskCents !== stored.riskCents) void updatePreferences(patch)
    },
    []
  )

  useEscape(true, endCapture)

  const fillFromPrices = (nextEntry: string, nextStop: string): void => {
    const result = distanceFromPrices(nextEntry, nextStop, unit)
    if (result && 'text' in result) setStop(result.text)
  }

  const switchUnit = (next: StopUnit): void => {
    setStop((current) => convertStopText(current, unit, next))
    setUnit(next)
  }

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    // Enter on one of the panel's own buttons presses that button.
    if ((event.target as HTMLElement).tagName === 'BUTTON') return
    event.preventDefault()
    if (outcome.kind === 'ok' && outcome.contracts > 0) void copyContractsAndClose(outcome.contracts)
    else setHint(outcome.kind === 'ok' ? 'Nothing to copy: the stop is too wide for this risk.' : 'Enter a risk and a stop first.')
  }

  const contractsLabel = outcome.kind === 'ok' ? formatContracts(outcome.contracts) : '–'
  const point = INSTRUMENTS[instrument].pointValueCents

  return (
    <Layer label="Risk calculator" onOutside={endCapture}>
      <div className="risk" onKeyDown={onKeyDown} data-testid="risk-panel">
        <div className="risk-head">
          <span className="risk-title">Position size</span>
          <Segmented<InstrumentKey>
            label="Instrument"
            value={instrument}
            options={INSTRUMENT_KEYS.map((key) => ({ value: key, label: key }))}
            onChange={(next) => {
              setInstrument(next)
              setHint(null)
            }}
          />
        </div>
        <p className="risk-instrument">
          {INSTRUMENTS[instrument].name}: {formatDollars(point)} a point, {formatDollars(tickValueCents(instrument))} a tick
        </p>

        <div className="risk-fields">
          <label className="risk-field">
            <span className="risk-label">Risk</span>
            <span className="risk-input has-prefix">
              <span className="risk-affix" aria-hidden="true">$</span>
              <input
                ref={riskInput}
                inputMode="decimal"
                value={risk}
                placeholder="200"
                aria-label="Dollar risk"
                aria-invalid={outcome.kind === 'invalid' && outcome.field === 'risk' ? true : undefined}
                onChange={(event) => {
                  setRisk(event.target.value)
                  setHint(null)
                }}
                data-testid="risk-dollars"
              />
            </span>
          </label>
          <label className="risk-field">
            <span className="risk-label">Stop</span>
            <span className="risk-input">
              <input
                ref={stopInput}
                inputMode="decimal"
                value={stop}
                placeholder={unit === 'points' ? '4.5' : '18'}
                aria-label={`Stop distance in ${unit}`}
                aria-invalid={outcome.kind === 'invalid' && outcome.field === 'stop' ? true : undefined}
                onChange={(event) => {
                  setStop(event.target.value)
                  setHint(null)
                }}
                data-testid="risk-stop"
              />
            </span>
          </label>
          <div className="risk-field risk-unit">
            <span className="risk-label" aria-hidden="true">In</span>
            <Segmented<StopUnit>
              label="Stop distance in"
              value={unit}
              options={[
                { value: 'points', label: 'pts' },
                { value: 'ticks', label: 'ticks' }
              ]}
              onChange={switchUnit}
            />
          </div>
        </div>

        <div className="risk-prices">
          <span className="risk-prices-label">Or from prices</span>
          <input
            className="risk-price"
            inputMode="decimal"
            value={entry}
            placeholder="Entry"
            aria-label="Entry price"
            onChange={(event) => {
              setEntry(event.target.value)
              fillFromPrices(event.target.value, stopPrice)
            }}
            data-testid="risk-entry"
          />
          <input
            className="risk-price"
            inputMode="decimal"
            value={stopPrice}
            placeholder="Stop"
            aria-label="Stop price"
            onChange={(event) => {
              setStopPrice(event.target.value)
              fillFromPrices(entry, event.target.value)
            }}
            data-testid="risk-stop-price"
          />
          {fill && 'error' in fill ? <span className="risk-note is-warning">{fill.error}</span> : null}
        </div>

        <div className={`risk-result${outcome.kind === 'ok' && outcome.contracts === 0 ? ' is-zero' : ''}`} aria-live="polite" data-testid="risk-result">
          <div className="risk-contracts" data-testid="risk-contracts">
            {contractsLabel}
          </div>
          <div className="risk-detail">
            {outcome.kind === 'ok' ? (
              outcome.contracts > 0 ? (
                <>
                  <span data-testid="risk-actual">{formatDollars(outcome.actualRiskCents)} at risk</span>
                  <span className="risk-sep" aria-hidden="true">·</span>
                  <span data-testid="risk-per-contract">{formatDollars(outcome.perContractCents)} per contract</span>
                </>
              ) : (
                <>
                  <strong>Stop too wide for this risk.</strong>
                  <span data-testid="risk-per-contract">One contract risks {formatDollars(outcome.perContractCents)}.</span>
                </>
              )
            ) : outcome.kind === 'invalid' ? (
              <span className="is-warning">{outcome.message}</span>
            ) : (
              <span>{outcome.needs === 'risk' ? 'Type the dollars you are willing to lose.' : 'Type the stop distance, or an entry and a stop price.'}</span>
            )}
          </div>
          {outcome.kind === 'ok' && outcome.roundedUp ? <div className="risk-note">Stop rounded up to whole ticks: {formatPoints(outcome.ticks)} pts ({formatTicks(outcome.ticks)}).</div> : null}
        </div>

        <div className="risk-foot">
          <span className="capture-keys">
            {hint ?? (
              <>
                <kbd>
                  <CornerDownLeft size={11} aria-hidden="true" />
                  <span className="sr-only">Enter</span>
                </kbd>{' '}
                copies {outcome.kind === 'ok' && outcome.contracts > 0 ? outcome.contracts : 'the count'} <span className="capture-keys-sep" aria-hidden="true">·</span> <kbd>Esc</kbd> closes
              </>
            )}
          </span>
          <button
            type="button"
            className="small-button"
            disabled={!(outcome.kind === 'ok' && outcome.contracts > 0)}
            onClick={() => outcome.kind === 'ok' && outcome.contracts > 0 && void copyContractsAndClose(outcome.contracts)}
          >
            <Copy size={13} aria-hidden="true" />
            Copy
          </button>
        </div>
      </div>
    </Layer>
  )
}
