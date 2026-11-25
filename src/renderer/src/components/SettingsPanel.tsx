/** Settings: only the essentials. Window, hotkeys, trading tools, writing defaults, appearance, backup. */
import { FONT_KEYS, FONT_LABELS, FONT_SIZES } from '@shared/content'
import { OPACITY_SHORTCUT_LABELS, opacityPercent, THEME_LABELS, THEMES } from '@shared/preferences'
import type { DockSide, FontKey, ReducedMotion, ThemeKey } from '@shared/types'
import { X } from 'lucide-react'
import { api } from '../lib/api'
import { openPanel, setSolidWhileInUse, toast, updatePreferences } from '../state/actions'
import { setState, useStore } from '../state/store'
import { HotkeySettings, TradingSettings } from './HotkeySettings'
import { Sheet } from './Sheet'
import { OpacitySlider, useShownOpacity } from './TitleBar'
import { Segmented, Switch } from './ui'

/** The same slider and switch as the title bar's opacity control. */
function OpacitySettings() {
  const value = useShownOpacity()
  const solidWhileInUse = useStore((s) => s.prefs.opacitySolidOnHover)
  return (
    <>
      <div className="setting-block opacity-setting">
        <div className="setting-row">
          <div>
            <div className="setting-label">Opacity</div>
            <div className="setting-help">
              See what is behind the notes. Quicker: scroll over the drop in the title bar, or press {OPACITY_SHORTCUT_LABELS.down} / {OPACITY_SHORTCUT_LABELS.up}.
            </div>
          </div>
          <span className="opacity-value" aria-hidden="true">{opacityPercent(value)}%</span>
        </div>
        <OpacitySlider />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">Solid while I use it</div>
          <div className="setting-help">While see-through, the notes turn solid when the pointer is on them or you type in them.</div>
        </div>
        <Switch label="Solid while I use it" checked={solidWhileInUse} onChange={setSolidWhileInUse} />
      </div>
    </>
  )
}

/** The underline switch and the words added with "Add to dictionary". */
function SpellingSettings() {
  const on = useStore((s) => s.prefs.spellcheck)
  const words = useStore((s) => s.prefs.spellingWords)
  const sorted = [...words].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return (
    <>
      <div className="setting-row">
        <div>
          <div className="setting-label">Underline misspelled words</div>
          <div className="setting-help">The app’s own checker, which knows trading terms like FVG, NWOG and CHoCH. Organize (Ctrl+Shift+O) corrects words either way.</div>
        </div>
        <Switch label="Underline misspelled words" checked={on} onChange={(next) => void updatePreferences({ spellcheck: next })} />
      </div>
      <div className="setting-block">
        <div className="setting-label">Your dictionary</div>
        <div className="setting-help">
          {words.length === 0 ? 'Empty. Right-click an underlined word and choose Add to dictionary: it is never underlined or changed again.' : 'Never underlined or changed by Organize.'}
        </div>
        {words.length > 0 ? (
          <ul className="word-list" aria-label="Your dictionary">
            {sorted.map((word) => (
              <li key={word} className="word-chip">
                <span>{word}</span>
                <button type="button" aria-label={`Remove ${word} from your dictionary`} title="Remove" onClick={() => void updatePreferences({ spellingWords: words.filter((w) => w !== word) })}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
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
        <OpacitySettings />
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

      <section className="setting-section" aria-label="Hotkeys">
        <h2>Hotkeys</h2>
        <HotkeySettings />
      </section>

      <section className="setting-section" aria-label="Candle timer and risk calculator">
        <h2>Candle timer and risk calculator</h2>
        <TradingSettings />
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

      <section className="setting-section" aria-label="Spelling">
        <h2>Spelling</h2>
        <SpellingSettings />
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
