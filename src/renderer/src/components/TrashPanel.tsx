/** Trash: deleted notes wait here until restored or removed for good. */
import { RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TrashEntry } from '@shared/types'
import { api } from '../lib/api'
import { purgeNotes, restoreNote } from '../state/actions'
import { useStore } from '../state/store'
import { Sheet } from './Sheet'
import { IconButton } from './ui'

export function TrashPanel() {
  const trashCount = useStore((s) => s.trashCount)
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [confirming, setConfirming] = useState<'all' | string | null>(null)

  useEffect(() => {
    let live = true
    void api.listTrash().then((list) => {
      if (live) setEntries(list)
    })
    return () => {
      live = false
    }
  }, [trashCount])

  return (
    <Sheet title="Trash" testId="trash">
      {entries === null ? null : entries.length === 0 ? (
        <p className="setting-help">Trash is empty. Deleted notes are kept here until you remove them.</p>
      ) : (
        <>
          <p className="setting-help">Deleted notes stay here, with their screenshots, until you delete them for good.</p>
          <div className="trash-list">
            {entries.map((entry) => (
              <div key={entry.id} className="trash-row">
                <div className="trash-text">
                  <div className="result-label">{entry.label}</div>
                  {entry.snippet && entry.snippet !== entry.label ? <div className="result-snippet">{entry.snippet}</div> : null}
                  <div className="trash-meta">
                    Deleted {new Date(entry.deletedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                    {entry.imageCount > 0 ? `, ${entry.imageCount} ${entry.imageCount === 1 ? 'image' : 'images'}` : ''}
                  </div>
                </div>
                {confirming === entry.id ? (
                  <span className="button-row">
                    <button type="button" className="danger-button" onClick={() => void purgeNotes([entry.id]).then(() => setConfirming(null))}>Delete forever</button>
                    <button type="button" className="small-button" onClick={() => setConfirming(null)}>Keep</button>
                  </span>
                ) : (
                  <span className="button-row">
                    <button type="button" className="small-button" onClick={() => void restoreNote(entry.id)} data-testid="restore-note">
                      <RotateCcw size={14} /> Restore
                    </button>
                    <IconButton label="Delete forever" onClick={() => setConfirming(entry.id)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="button-row sheet-foot">
            {confirming === 'all' ? (
              <>
                <span className="setting-warning">Delete {entries.length} {entries.length === 1 ? 'note' : 'notes'} for good? This cannot be undone.</span>
                <button type="button" className="danger-button" onClick={() => void purgeNotes('all').then(() => setConfirming(null))}>Empty Trash</button>
                <button type="button" className="small-button" onClick={() => setConfirming(null)}>Cancel</button>
              </>
            ) : (
              <button type="button" className="small-button" onClick={() => setConfirming('all')}>Empty Trash…</button>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}
