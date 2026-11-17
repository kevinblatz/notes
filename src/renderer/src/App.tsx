/**
 * The window has two states: the Board (all notes) and Focused Note (one note, full window).
 * Panels (find, pins, settings, backup, trash) and the image preview are overlays inside
 * this same window.
 */
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fontVar } from '@shared/content'
import { api } from './lib/api'
import { overlayDepth } from './lib/escape'
import { BackupPanel } from './components/BackupPanel'
import { Board } from './components/Board'
import { NoteEditor } from './components/editor/NoteEditor'
import { FindPalette } from './components/FindPalette'
import { ImagePreview } from './components/ImagePreview'
import { SettingsPanel } from './components/SettingsPanel'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { TrashPanel } from './components/TrashPanel'
import { flushAll, initialize, openPanel, startDraft, undoLast } from './state/actions'
import { setState, useStore } from './state/store'

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || !element.tagName) return false
  return element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
}

export function App() {
  const ready = useStore((s) => s.ready)
  const loadError = useStore((s) => s.loadError)
  const view = useStore((s) => s.view)
  const panel = useStore((s) => s.panel)
  const prefs = useStore((s) => s.prefs)
  const shortcut = useStore((s) => s.shortcut)
  const noticeDismissed = useStore((s) => s.shortcutNoticeDismissed)
  const announcement = useStore((s) => s.announcement)
  const [returning, setReturning] = useState(false)
  const wasNote = useRef(false)

  useEffect(() => {
    void initialize()
    const unsubscribe = [
      // The main process asks for pending edits to be written before hiding or quitting.
      api.on('flush-request', ({ token }) => void flushAll().then((saved) => api.flushDone(token, saved))),
      api.on('shortcut-status', (status) => setState({ shortcut: status })),
      api.on('window-status', (status) => setState({ windowStatus: status })),
      api.on('preferences-changed', (next) => setState({ prefs: next }))
    ]
    return () => unsubscribe.forEach((off) => off())
  }, [])

  // Appearance and writing defaults are plain CSS variables on the document.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = prefs.theme
    root.style.setProperty('--note-font', fontVar(prefs.fontFamily))
    root.style.setProperty('--note-size', `${prefs.fontSize}px`)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = (): void => {
      root.dataset.motion = prefs.reducedMotion === 'on' || (prefs.reducedMotion === 'system' && media.matches) ? 'reduce' : 'normal'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [prefs.theme, prefs.fontFamily, prefs.fontSize, prefs.reducedMotion])

  // A short "back out to the board" transition when leaving a note.
  useEffect(() => {
    if (view.mode === 'board' && wasNote.current) {
      setReturning(true)
      const timer = window.setTimeout(() => setReturning(false), 260)
      wasNote.current = false
      return () => window.clearTimeout(timer)
    }
    wasNote.current = view.mode === 'note'
  }, [view.mode])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault()
        openPanel('find')
      } else if (key === ',' && !event.shiftKey) {
        event.preventDefault()
        openPanel('settings')
      } else if (useStore.getState().view.mode === 'board' && overlayDepth() === 0 && !isTypingTarget(event.target)) {
        if (key === 'n' && !event.shiftKey) {
          event.preventDefault()
          startDraft({ kind: 'row', index: Number.MAX_SAFE_INTEGER })
        } else if (key === 'z' && !event.shiftKey) {
          event.preventDefault()
          void undoLast()
        }
      }
    }
    // Files dropped outside a drop zone must not make the window navigate to them.
    const blockDrop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('dragover', blockDrop)
    window.addEventListener('drop', blockDrop)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('dragover', blockDrop)
      window.removeEventListener('drop', blockDrop)
    }
  }, [])

  return (
    <div className={`app${returning ? ' is-returning' : ''}`} data-view={view.mode} data-ready={ready}>
      <TitleBar />
      {!shortcut.registered && !noticeDismissed && ready ? (
        <div className="banner" role="alert" data-testid="shortcut-banner">
          <span>{shortcut.error ?? 'The show/hide shortcut could not be registered.'} It will not open your notes until you pick another.</span>
          <button type="button" className="link-button" onClick={() => openPanel('settings')}>
            Choose another shortcut
          </button>
          <button type="button" className="banner-close" aria-label="Dismiss" onClick={() => setState({ shortcutNoticeDismissed: true })}>
            <X size={14} />
          </button>
        </div>
      ) : null}

      <main className="stage">
        {loadError ? (
          <div className="load-error" role="alert">
            <h1>Your notes could not be loaded</h1>
            <p>{loadError}</p>
            <button type="button" className="primary-button" onClick={() => void initialize()}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <Board hidden={view.mode !== 'board'} />
            {view.mode === 'note' ? <NoteEditor key={view.noteId} view={view} /> : null}
          </>
        )}
      </main>

      {panel === 'find' || panel === 'pins' ? <FindPalette mode={panel} /> : null}
      {panel === 'settings' ? <SettingsPanel /> : null}
      {panel === 'backup' ? <BackupPanel /> : null}
      {panel === 'trash' ? <TrashPanel /> : null}
      <ImagePreview />
      <Toasts />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  )
}
