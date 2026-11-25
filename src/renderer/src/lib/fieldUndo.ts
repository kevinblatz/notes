/**
 * Chromium keeps one undo history for the whole window, not one per field. Ctrl+Z in the title,
 * pressed more often than there were edits in it, would go on to undo a caption's edits out of
 * sight, or the note text itself (the editor takes the browser's undo as its own): pictures and
 * paragraphs gone from a press in the title. The browser's own undo and redo here change only the
 * field that has the keyboard; the note text has its own, Ctrl+Z in the note text.
 */
export function installFieldUndo(): void {
  document.addEventListener(
    'beforeinput',
    (event) => {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return
      if (event.target === document.activeElement) return
      event.preventDefault()
      event.stopPropagation()
    },
    true
  )
}
