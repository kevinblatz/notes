/** Settings: only the essentials. Window, shortcut, writing defaults, appearance, backup. */
import { useEffect, useState } from 'react'
import { acceleratorFromEvent, formatAccelerator } from '@shared/accelerator'
import { FONT_KEYS, FONT_LABELS, FONT_SIZES } from '@shared/content'
import { THEME_LABELS, THEMES } from '@shared/preferences'
import type { DockSide, FontKey, ReducedMotion, ThemeKey } from '@shared/types'
import { api } from '../lib/api'
import { useEscape } from '../lib/escape'
import { openPanel, toast, updatePreferences } from '../state/actions'
import { setState, useStore } from '../state/store'
import { Sheet } from './Sheet'
import { Segmented, Switch } from './ui'

function ShortcutRecorder() {
  const shortcut = useStore((s) => s.shortcut)
  const [recording, setRecording] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const stop = (): void => {
    setRecording(false)
    void api.suspendShortcut(false).then((status) => setState({ shortcut: status }))
  }
  useEscape(recording, stop)

  useEffect(() => {
    if (!recording) return
    // Release the current shortcut while listening, so pressing it is captured here
    // instead of hiding the window.
    void api.suspendShortcut(true)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      const captured = acceleratorFromEvent(event)
      if (!captured.ok) {
        if (captured.reason === 'needs-modifier') setMessage('Include Ctrl, Alt or the Windows key so the shortcut does not interfere with typing.')
        else if (captured.reason === 'unsupported-key') setMessage('That key cannot be used. Try a letter, number, Space or a function key.')
        return
      }
      setRecording(false)
      void api.setShortcut(captured.accelerator).then(async ({ status, accepted }) => {
        if (accepted) {
          setState((s) => ({ shortcut: status, prefs: { ...s.prefs, shortcut: status.accelerator }, shortcutNoticeDismissed: false }))
          setMessage(`${formatAccelerator(status.accelerator)} now shows and hides your notes.`)
        } else {
          // Keep whatever was working before and say why the new one was refused.
          setState({ shortcut: await api.suspendShortcut(false) })
          setMessage(`${status.error ?? 'That shortcut is not available.'} Choose a different combination.`)
        }
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording])

  return (
    <div className="setting-block">
      <div className="setting-row">
        <div>
          <div className="setting-label">Show or hide notes</div>
          <div className="setting-help">Works from any app, including while your chart has focus.</div>
        </div>
        <button
          type="button"
          className={`shortcut-button${recording ? ' is-recording' : ''}`}
          onClick={() => {
            setMessage(null)
            if (recording) stop()
            else setRecording(true)
          }}
          data-testid="shortcut-button"
        >
          {recording ? 'Press the new shortcut…' : formatAccelerator(shortcut.accelerator)}
        </button>
      </div>
      {!shortcut.registered && !recording ? (
        <p className="setting-warning" role="alert">
          {shortcut.error ?? 'This shortcut could not be registered.'} Click the shortcut above and press a different combination.
        </p>
      ) : null}
      {message ? <p className="setting-help" role="status">{message}</p> : null}
    </div>
  )
}

export function SettingsPanel() {
  const prefs = useStore((s) => s.prefs)
  const windowStatus = useStore((s) => s.windowStatus)
  const app = useStore((s) => s.app)
  const startupSupported = app?.platform === 'win32' || app?.platform === 'darwin'

  return (
    <Sheet title="Settings" testId="settings">
      <section className="setting-section">
        <h2>Window</h2>
        <div className="setting-row">
          <div>
            <div className="setting-label">Dock to</div>
            <div className="setting-help">
              {windowStatus.dock === 'custom' ? 'The window has been moved or resized by hand. Choose a side to snap it back to half the screen.' : 'Half of the screen, next to your chart.'}
            </div>
          </div>
          <Segmented<DockSide>
            label="Dock side"
            value={windowStatus.dock === 'custom' ? ('' as DockSide) : windowStatus.dock}
            options={[
              { value: 'left', label: 'Left half' },
              { value: 'right', label: 'Right half' }
            ]}
            onChange={(side) => void api.windowAction(side === 'left' ? 'dock-left' : 'dock-right').then((status) => setState((s) => ({ windowStatus: status, prefs: { ...s.prefs, dockSide: side } })))}
          />
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">Always on top</div>
            <div className="setting-help">Notes stay visible while you click and type in other apps.</div>
          </div>
          <Switch label="Always on top" checked={prefs.alwaysOnTop} onChange={(next) => void updatePreferences({ alwaysOnTop: next })} />
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">Start with Windows</div>
            <div className="setting-help">{startupSupported ? 'Opens beside your chart when you sign in, without taking keyboard focus.' : 'Available in the installed Windows app.'}</div>
          </div>
          <Switch
            label="Start with Windows"
            checked={prefs.launchAtStartup}
            disabled={!startupSupported}
            onChange={(next) =>
              void updatePreferences({ launchAtStartup: next }).then(() => {
                if (next && !useStore.getState().prefs.launchAtStartup) toast('Starting with Windows is only available in the installed app.', { kind: 'error' })
              })
            }
          />
        </div>
      </section>

      <section className="setting-section">
        <h2>Shortcut</h2>
        <ShortcutRecorder />
      </section>

      <section className="setting-section">
        <h2>Writing</h2>
        <div className="setting-row">
          <div>
            <div className="setting-label">Default font</div>
            <div className="setting-help">Used wherever a note does not set its own font.</div>
          </div>
          <select className="select" aria-label="Default font" value={prefs.fontFamily} onChange={(event) => void updatePreferences({ fontFamily: event.target.value as FontKey })}>
            {FONT_KEYS.map((key) => (
              <option key={key} value={key}>{FONT_LABELS[key]}</option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">Default text size</div>
          </div>
          <select className="select" aria-label="Default text size" value={prefs.fontSize} onChange={(event) => void updatePreferences({ fontSize: Number(event.target.value) })}>
            {[...new Set([...FONT_SIZES.filter((size) => size <= 26), 18, 20, prefs.fontSize])].sort((a, b) => a - b).map((size) => (
              <option key={size} value={size}>{size} px</option>
            ))}
          </select>
        </div>
      </section>

      <section className="setting-section">
        <h2>Appearance</h2>
        <div className="setting-row">
          <div className="setting-label">Theme</div>
          <Segmented<ThemeKey> label="Theme" value={prefs.theme} options={THEMES.map((theme) => ({ value: theme, label: THEME_LABELS[theme] }))} onChange={(theme) => void updatePreferences({ theme })} />
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">Motion</div>
            <div className="setting-help">Reduced motion turns off the short transitions.</div>
          </div>
          <Segmented<ReducedMotion>
            label="Motion"
            value={prefs.reducedMotion}
            options={[
              { value: 'system', label: 'Follow Windows' },
              { value: 'off', label: 'Normal' },
              { value: 'on', label: 'Reduced' }
            ]}
            onChange={(reducedMotion) => void updatePreferences({ reducedMotion })}
          />
        </div>
      </section>

      <section className="setting-section">
        <h2>Your data</h2>
        <div className="setting-row">
          <div>
            <div className="setting-label">Backup and import</div>
            <div className="setting-help">Export everything to one file, or bring a backup in.</div>
          </div>
          <button type="button" className="small-button" onClick={() => openPanel('backup')}>Open</button>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">Notes folder</div>
            <div className="setting-help setting-path">{app?.dataDir}</div>
          </div>
          <button type="button" className="small-button" onClick={() => void api.openDataFolder()}>Show</button>
        </div>
        <p className="setting-help">Everything stays on this computer. No account, no sync, no network. Version {app?.version}.</p>
      </section>
    </Sheet>
  )
}
