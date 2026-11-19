/** A side sheet inside the notes window, used for Settings, Backup and Trash. */
import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useEscape } from '../lib/escape'
import { closePanel } from '../state/actions'
import { IconButton, useFocusTrap } from './ui'

export function Sheet({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  const panel = useRef<HTMLDivElement>(null)
  useEscape(true, closePanel)
  useFocusTrap(panel, true)
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[data-autofocus], button')?.focus({ preventScroll: true })
  }, [])
  return (
    <div
      className="sheet-layer"
      data-overlay
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePanel()
      }}
    >
      <div ref={panel} className="sheet" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <header className="sheet-head">
          <h1>{title}</h1>
          <IconButton label="Close" hint="Esc" onClick={closePanel}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
