import { X } from 'lucide-react'
import { dismissToast } from '../state/actions'
import { useStore } from '../state/store'

/** Brief confirmations with an Undo where one makes sense. Drawn inside the notes window. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.kind === 'error' ? ' is-error' : ''}`}>
          <span>{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                toast.action!.run()
                dismissToast(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
