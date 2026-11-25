/**
 * The window's side of the trading hotkeys: the quick note strip and the risk calculator
 * (which hold the keyboard only while they are open), chart snapshots arriving from the main
 * process, the candle-close chime, and opening today's log.
 */
import { flushSync } from 'react-dom'
import { formatOpacity } from '@shared/preferences'
import { cleanQuickNote, logImage, logParagraph, quickNoteLine } from '@shared/sessionLog'
import type { HotkeyEvent, SnapshotEvent } from '@shared/types'
import { api } from '../lib/api'
import { playChime } from '../lib/chime'
import { announce, currentEditor, flashOpacityReadout, toast } from './actions'
import { cleanMessage } from './saver'
import { appendToSessionLog, openSessionLog } from './sessionLog'
import { appNow, getState, setState } from './store'

/** Where the keyboard was inside the window when a typing hotkey opened its panel. */
let returnFocusTo: Element | null = null

export function handleHotkey(event: HotkeyEvent): void {
  if (event.action === 'quickNote' || event.action === 'risk') {
    const current = getState().capture
    const sameSession = current?.token === event.token
    if (!sameSession) {
      returnFocusTo = document.activeElement
      if (returnFocusTo instanceof HTMLElement && returnFocusTo.closest('.ProseMirror')) currentEditor()?.captureSelection()
    }
    // Drawn and focused right now, not on the next frame: keys typed straight after the
    // hotkey must land in the strip, never in a note open underneath.
    flushSync(() => setState({ capture: { kind: event.action, token: event.token, at: event.at, presses: sameSession ? current.presses + 1 : 1 } }))
  } else if (event.action === 'openLog') {
    // The main process has already ended any typing session: the keyboard stays here now.
    returnFocusTo = null
    setState({ capture: null })
    void openSessionLog(event.at).catch((error) => toast(`Today’s log could not be opened. ${cleanMessage(error)}`, { kind: 'error', duration: 9000 }))
  } else if (event.action === 'seeThrough') {
    flashOpacityReadout()
    announce(event.opacity < 1 ? `See-through, ${formatOpacity(event.opacity)}` : 'Solid')
  }
}

/** Put the keyboard back where it was in the window: the caret in the note, a button, or nowhere. */
function restoreFocus(): void {
  const target = returnFocusTo
  returnFocusTo = null
  const editor = currentEditor()
  if (target instanceof HTMLElement && target.isConnected && target !== document.body) {
    if (editor && target.closest('.ProseMirror')) editor.restoreFocus()
    else target.focus({ preventScroll: true })
    return
  }
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}

/** Close the quick note strip or the risk calculator; the main process gives the keyboard back. */
export function endCapture(): void {
  const capture = getState().capture
  if (!capture) return
  setState({ capture: null })
  restoreFocus()
  api.endTyping(capture.token)
}

/**
 * Enter in the quick note strip. Resolves true once the line is in today's log (the strip then
 * closes, unless the hotkey was pressed again meanwhile for another line). An empty line just
 * closes. A failed write rejects and leaves the text in the strip.
 */
export async function submitQuickNote(text: string): Promise<boolean> {
  const capture = getState().capture
  if (!capture || capture.kind !== 'quickNote') return false
  const line = cleanQuickNote(text)
  if (!line) {
    endCapture()
    return true
  }
  const { token, presses, at } = capture
  await appendToSessionLog(at, [logParagraph(quickNoteLine(at, line))])
  announce('Added to today’s session log.')
  const now = getState().capture
  if (now?.token === token && now.presses === presses) endCapture()
  return true
}

/** Enter in the risk calculator: the contract count onto the clipboard, and close. */
export async function copyContractsAndClose(contracts: number): Promise<void> {
  await api.copyContracts(contracts)
  endCapture()
  const message = `${contracts} ${contracts === 1 ? 'contract' : 'contracts'} copied`
  toast(message, { duration: 2500 })
  announce(`${message}.`)
}

/** A chart snapshot was captured and stored by the main process: add it to today's log. */
export async function handleSnapshot(event: SnapshotEvent): Promise<void> {
  if (!event.ok) {
    toast(`Chart snapshot failed. ${event.message}`, { kind: 'error', duration: 9000 })
    return
  }
  try {
    await appendToSessionLog(event.at, [logImage({ attachmentId: event.attachment.id, caption: event.caption, width: event.width, height: event.height })])
    if (event.windowShown) toast('Chart snapshot added to today’s log', { duration: 4000, action: { label: 'Open', run: () => void openSessionLog(appNow()) } })
    announce('Chart snapshot added to today’s session log.')
  } catch (error) {
    toast(`The chart snapshot could not be added to today’s log. ${cleanMessage(error)}`, { kind: 'error', duration: 9000 })
  }
}

/** A candle closed: a soft chime (unless switched off) and a pulse of the chip. */
export function handleCandleClose(): void {
  const { prefs } = getState()
  if (!prefs.candleTimer) return
  setState((s) => ({ candleCloses: s.candleCloses + 1 }))
  if (prefs.candleChime) playChime()
}
