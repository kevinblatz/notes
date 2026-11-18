/**
 * Backup export and import. Import first shows what the chosen file contains, then asks how
 * to bring it in. Replacing the current collection is never the default and needs a second,
 * explicit confirmation.
 */
import { useState } from 'react'
import type { ExportResult, ImportMode, ImportPreview, ImportResult } from '@shared/types'
import { api } from '../lib/api'
import { flushAll, reloadAfterImport } from '../state/actions'
import { cleanMessage } from '../state/saver'
import { Sheet } from './Sheet'

/** Shown when the note being written cannot be stored: a backup taken now would miss its newest text. */
const UNSAVED_NOTE = 'The note you are writing could not be saved yet, so nothing was done. Go back to it and use Try again first.'

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`
const megabytes = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

export function BackupPanel() {
  const [busy, setBusy] = useState<string | null>(null)
  const [exported, setExported] = useState<ExportResult | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mode, setMode] = useState<ImportMode>('merge')
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (label: string, work: () => Promise<void>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await work()
    } catch (problem) {
      setError(cleanMessage(problem))
    } finally {
      setBusy(null)
    }
  }

  const doExport = (): Promise<void> =>
    run('Exporting…', async () => {
      if (!(await flushAll())) throw new Error(UNSAVED_NOTE)
      const outcome = await api.exportBackup()
      if (outcome.canceled) return
      // A new attempt replaces whatever the previous one reported.
      setExported(null)
      if (!outcome.ok) throw new Error(outcome.error ?? 'The backup could not be written.')
      setExported(outcome)
    })

  const chooseFile = (): Promise<void> =>
    run('Reading backup…', async () => {
      setResult(null)
      const inspected = await api.inspectBackup()
      if (!inspected) return
      if ('error' in inspected) throw new Error(inspected.error)
      setPreview(inspected)
      setMode('merge')
      setConfirmReplace(false)
    })

  const doImport = (): Promise<void> =>
    run(mode === 'replace' ? 'Restoring…' : 'Importing…', async () => {
      if (!preview) return
      if (!(await flushAll())) throw new Error(UNSAVED_NOTE)
      const outcome = await api.runImport(preview.token, mode)
      setPreview(null)
      if (!outcome.ok) throw new Error(outcome.error ?? 'The import did not complete.')
      setResult(outcome)
      await reloadAfterImport()
    })

  return (
    <Sheet title="Backup and import" testId="backup">
      <section className="setting-section">
        <h2>Export</h2>
        <p className="setting-help">
          Writes one <code>.tnbackup</code> file with every note (including Trash), every screenshot at full resolution, your board arrangement, pins and settings. Keep it somewhere other than this computer.
        </p>
        <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void doExport()} data-testid="export-backup">
          Export backup…
        </button>
        {exported?.ok ? (
          <p className="setting-success" role="status">
            Saved {plural(exported.noteCount ?? 0, 'note')} and {plural(exported.attachmentCount ?? 0, 'image')} ({megabytes(exported.byteSize ?? 0)}).{' '}
            <button type="button" className="link-button" onClick={() => exported.path && void api.showInFolder(exported.path)}>Show file</button>
          </p>
        ) : null}
        {exported?.ok && (exported.missingFiles ?? 0) > 0 ? (
          <p className="setting-warning" role="alert">
            {plural(exported.missingFiles ?? 0, 'image')} could not be included because {exported.missingFiles === 1 ? 'its file is' : 'their files are'} missing from the notes folder. The notes themselves are in the backup.
          </p>
        ) : null}
      </section>

      <section className="setting-section">
        <h2>Import</h2>
        {!preview ? (
          <>
            <p className="setting-help">Choose a backup file. You will see what it contains before anything changes.</p>
            <button type="button" className="small-button" disabled={busy !== null} onClick={() => void chooseFile()} data-testid="choose-backup">
              Choose backup file…
            </button>
          </>
        ) : (
          <div className="import-preview" data-testid="import-preview">
            <p className="setting-label">{preview.fileName}</p>
            <p className="setting-help">
              {preview.createdAt ? `Made ${new Date(preview.createdAt).toLocaleString()}. ` : ''}
              Contains {plural(preview.noteCount, 'note')}, {plural(preview.attachmentCount, 'image')} and {plural(preview.pinCount, 'pin')}
              {preview.trashedCount > 0 ? `, plus ${plural(preview.trashedCount, 'note')} in Trash` : ''}.
            </p>
            {preview.warnings.map((warning) => (
              <p key={warning} className="setting-warning">{warning}</p>
            ))}

            <div className="choice-list" role="radiogroup" aria-label="How to import">
              <label className={`choice${mode === 'merge' ? ' is-selected' : ''}`}>
                <input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
                <span>
                  <strong>Add to my notes</strong>
                  <span className="setting-help">
                    Keeps everything you have now ({plural(preview.currentNoteCount, 'note')}). Notes from the backup are added at the bottom of the board.
                    {preview.overlappingNotes > 0
                      ? ` ${plural(preview.overlappingNotes, 'note')} in the backup already ${preview.overlappingNotes === 1 ? 'exists' : 'exist'} here: identical ones are skipped, and where the wording differs the backup's version is added as a separate copy. Nothing is overwritten.`
                      : ' Nothing is overwritten.'}
                  </span>
                </span>
              </label>
              <label className={`choice is-danger${mode === 'replace' ? ' is-selected' : ''}`}>
                <input type="radio" name="import-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} data-testid="mode-replace" />
                <span>
                  <strong>Replace my notes with this backup</strong>
                  <span className="setting-help">
                    Removes your current {plural(preview.currentNoteCount, 'note')}, Trash, pins and arrangement, and restores exactly what the backup holds, including its settings. A safety backup of what you have now is saved automatically first.
                  </span>
                </span>
              </label>
            </div>

            {mode === 'replace' ? (
              <label className="confirm-line">
                <input type="checkbox" checked={confirmReplace} onChange={(event) => setConfirmReplace(event.target.checked)} data-testid="confirm-replace" />
                I understand my current notes will be replaced.
              </label>
            ) : null}

            <div className="button-row">
              <button type="button" className={mode === 'replace' ? 'danger-button' : 'primary-button'} disabled={busy !== null || (mode === 'replace' && !confirmReplace)} onClick={() => void doImport()} data-testid="run-import">
                {mode === 'replace' ? 'Replace my notes' : 'Add to my notes'}
              </button>
              <button type="button" className="small-button" disabled={busy !== null} onClick={() => setPreview(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {result?.ok ? (
          <div className="setting-success" role="status" data-testid="import-result">
            {result.mode === 'replace' ? (
              <p>Restored {plural(result.added, 'note')} and {plural(result.attachmentsImported, 'image')} from the backup.</p>
            ) : (
              <p>
                Added {plural(result.added + result.copied, 'note')}
                {result.copied > 0 ? ` (${result.copied} as a separate copy because your version differs)` : ''}
                {result.skipped > 0 ? `, skipped ${result.skipped} you already have` : ''}, with {plural(result.attachmentsImported, 'new image')}.
              </p>
            )}
            {result.missingAttachments > 0 ? <p>{plural(result.missingAttachments, 'image')} could not be found in the backup; those notes show an empty placeholder.</p> : null}
            {result.safetyBackupPath ? (
              <p>
                Your previous notes were saved to a safety backup.{' '}
                <button type="button" className="link-button" onClick={() => void api.showInFolder(result.safetyBackupPath!)}>Show file</button>
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {busy ? <p className="setting-help" role="status">{busy}</p> : null}
      {error ? <p className="setting-warning" role="alert">{error}</p> : null}
    </Sheet>
  )
}
