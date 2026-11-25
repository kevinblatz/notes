/**
 * Settings > Hotkeys: the show/hide shortcut and the trading hotkeys, each with a recorder to
 * choose its combination, a switch to turn it off, and the reason when Windows or another
 * app already owns the combination. While a combination is being recorded every hotkey is
 * released, so pressing one is captured here instead of acting.
 */
import { useLayoutEffect, useState } from 'react'
import { acceleratorFromEvent, formatAccelerator } from '@shared/accelerator'
import { HOTKEY_IDS, HOTKEY_INFO, type HotkeyId } from '@shared/hotkeys'
import { dollarsInputText, INSTRUMENT_KEYS, parseDollars, type InstrumentKey, type StopUnit } from '@shared/risk'
import type { HotkeyStatuses } from '@shared/types'
import { api } from '../lib/api'
import { useEscape } from '../lib/escape'
import { updatePreferences } from '../state/actions'
import { setState, useStore } from '../state/store'
import { Segmented, Switch } from './ui'

function adoptStatuses(statuses: HotkeyStatuses): void {
  const { id: _id, ...shortcut } = statuses.toggle
  setState({ hotkeys: statuses, shortcut })
}

const joinLabels = (ids: HotkeyId[]): string => ids.map((id) => HOTKEY_INFO[id].label).join(' and ')

function HotkeyRow({ id, recording, onRecord }: { id: HotkeyId; recording: boolean; onRecord: (id: HotkeyId | null) => void }) {
  const status = useStore((s) => s.hotkeys[id])
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'warning' } | null>(null)
  const info = HOTKEY_INFO[id]

  const stop = (): void => {
    onRecord(null)
    void api.suspendShortcut(false)
  }
  useEscape(recording, stop)

  // A layout effect, so the key listener is in place in the same frame the button changes:
  // a key pressed immediately after the click is not missed.
  useLayoutEffect(() => {
    if (!recording) return
    // Release the hotkeys while listening, so pressing one is captured here instead of acting.
    void api.suspendShortcut(true)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      const captured = acceleratorFromEvent(event)
      if (!captured.ok) {
        if (captured.reason === 'needs-modifier') setMessage({ text: 'Include Ctrl, Alt or the Windows key so the shortcut does not interfere with typing.', kind: 'warning' })
        else if (captured.reason === 'unsupported-key') setMessage({ text: 'That key cannot be used. Try a letter, number, Space or a function key.', kind: 'warning' })
        return
      }
      onRecord(null)
      void api.setHotkey(id, captured.accelerator).then(async ({ status: next, accepted, takenFrom, statuses }) => {
        if (accepted) {
          adoptStatuses(statuses)
          if (id === 'toggle') setState({ shortcutNoticeDismissed: false })
          const taken = takenFrom.length > 0 ? ` It was set for ${joinLabels(takenFrom)}, which is now off.` : ''
          setMessage({ text: `${formatAccelerator(next.accelerator)} now ${info.does}.${taken}`, kind: 'info' })
        } else {
          // Keep whatever was working before and say why the new one was refused.
          await api.suspendShortcut(false)
          setMessage({ text: `${next.error ?? 'That shortcut is not available.'} Choose a different combination.`, kind: 'warning' })
        }
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, id, info.does])

  const toggle = (enabled: boolean): void => {
    setMessage(null)
    void api.setHotkeyEnabled(id, enabled).then(({ status: next, accepted, statuses }) => {
      adoptStatuses(statuses)
      if (!accepted) setMessage({ text: `${next.error ?? 'That shortcut is not available.'} Click it and press a different combination.`, kind: 'warning' })
    })
  }

  const failing = status.enabled && !status.registered && !recording
  return (
    <div className={`hotkey-row${status.enabled ? '' : ' is-off'}`} data-testid={`hotkey-row-${id}`}>
      <div className="hotkey-main">
        <div className="hotkey-text">
          <div className="setting-label">{info.label}</div>
          <div className="setting-help">{info.help}</div>
        </div>
        <button
          type="button"
          className={`shortcut-button hotkey-keys${recording ? ' is-recording' : ''}${failing ? ' is-failing' : ''}`}
          aria-label={`${info.label}: ${recording ? 'press the new combination' : formatAccelerator(status.accelerator)}. Click to change.`}
          onClick={() => {
            setMessage(null)
            if (recording) stop()
            else onRecord(id)
          }}
          data-testid={id === 'toggle' ? 'shortcut-button' : `hotkey-button-${id}`}
        >
          {recording ? 'Press keys…' : formatAccelerator(status.accelerator)}
        </button>
        <Switch label={`${info.label} hotkey`} checked={status.enabled} onChange={toggle} />
      </div>
      {failing ? (
        <p className="setting-warning" role="alert">
          {status.error ?? 'This shortcut could not be registered.'} Click the shortcut above and press a different combination.
        </p>
      ) : null}
      {message ? (
        <p className={message.kind === 'warning' ? 'setting-warning' : 'setting-help'} role="status">
          {message.text}
        </p>
      ) : null}
    </div>
  )
}

export function HotkeySettings() {
  const [recording, setRecording] = useState<HotkeyId | null>(null)
  return (
    <>
      <p className="setting-help hotkey-intro">
        These work from any app, your chart included. On some keyboard layouts Ctrl+Alt is the same as AltGr: if a hotkey types a character instead, give it another combination.
      </p>
      <div className="hotkey-list">
        {HOTKEY_IDS.map((id) => (
          <HotkeyRow key={id} id={id} recording={recording === id} onRecord={setRecording} />
        ))}
      </div>
    </>
  )
}

/** The candle chime and the risk calculator's starting values. */
export function TradingSettings() {
  const prefs = useStore((s) => s.prefs)
  const [risk, setRisk] = useState(prefs.riskCents ? dollarsInputText(prefs.riskCents) : '')
  const saveRisk = (): void => {
    const cents = parseDollars(risk)
    const next = cents && cents > 0 ? cents : null
    if (next !== prefs.riskCents) void updatePreferences({ riskCents: next })
    setRisk(next ? dollarsInputText(next) : '')
  }
  return (
    <>
      <div className="setting-row">
        <div>
          <div className="setting-label">Chime at candle close</div>
          <div className="setting-help">A short, soft sound when the candle timer reaches zero.</div>
        </div>
        <Switch label="Chime at candle close" checked={prefs.candleChime} onChange={(next) => void updatePreferences({ candleChime: next })} />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">Risk calculator instrument</div>
          <div className="setting-help">Where the calculator starts. It remembers the last one used.</div>
        </div>
        <Segmented<InstrumentKey>
          label="Risk calculator instrument"
          value={prefs.riskInstrument}
          options={INSTRUMENT_KEYS.map((key) => ({ value: key, label: key }))}
          onChange={(riskInstrument) => void updatePreferences({ riskInstrument })}
        />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">Dollar risk</div>
          <div className="setting-help">What one trade may lose. Changed in the calculator, it is remembered.</div>
        </div>
        <span className="money-input">
          <span aria-hidden="true">$</span>
          <input
            inputMode="decimal"
            aria-label="Dollar risk"
            placeholder="200"
            value={risk}
            onChange={(event) => setRisk(event.target.value)}
            onBlur={saveRisk}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveRisk()
            }}
            data-testid="settings-risk"
          />
        </span>
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">Stop distance in</div>
        </div>
        <Segmented<StopUnit>
          label="Stop distance in"
          value={prefs.riskUnit}
          options={[
            { value: 'points', label: 'Points' },
            { value: 'ticks', label: 'Ticks' }
          ]}
          onChange={(riskUnit) => void updatePreferences({ riskUnit })}
        />
      </div>
    </>
  )
}
