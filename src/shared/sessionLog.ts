/**
 * Today's session log: one ordinary note per local calendar day that quick notes and chart
 * snapshots are added to. It is found again through the note's free-form `extra` field
 * (extra.sessionLog = "2026-11-25"); everything else about it is a normal note.
 */
import { IMAGE_NODE } from './content'
import type { RichDoc, RichNode } from './types'

/** The key in Note.extra that marks a session log, holding its local date. */
export const SESSION_LOG_FIELD = 'sessionLog'
/** A quick note is one line; anything longer is cut here. */
export const MAX_QUICK_NOTE_LENGTH = 2000

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local calendar day of a moment: "2026-11-25". */
export function localDateKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "Session log · Wed 25 Nov" (the date in the given locale's own short form). */
export function sessionLogTitle(ms: number, locale?: string): string {
  let date: string
  try {
    date = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(ms)
  } catch {
    date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(ms)
  }
  return `Session log · ${date}`
}

/** Local time of day, 24-hour, to the second: "10:32:14". */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** What was typed, as one tidy line: runs of whitespace (line breaks included) become one space. */
export function cleanQuickNote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUICK_NOTE_LENGTH)
}

/** "10:32:14 — text" */
export function quickNoteLine(ms: number, text: string): string {
  return `${clockTime(ms)} — ${cleanQuickNote(text)}`
}

export interface ChartTitle {
  symbol: string
  price: string
}

/** Browser names Windows puts after the page title in a window title. */
const BROWSER_SUFFIX = /\s[-–—]\s(?:Google Chrome|Chromium|Microsoft​?\s?Edge|Brave|Opera|Vivaldi|Mozilla Firefox|Firefox)(?:\s[-–—]\s.*)?$/

/**
 * Read the symbol and last price from a TradingView chart title, as Chrome shows it in the
 * window title: "ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome" -> ES1!, 6,123.25.
 * Null for any title that does not look like one: nothing is ever guessed.
 */
export function parseTradingViewTitle(title: string): ChartTitle | null {
  const text = title.replace(BROWSER_SUFFIX, '').trim()
  const match = /^(?:\(\d+\)\s*)?([A-Z0-9][A-Z0-9._!:/&-]{0,39})\s+(\d{1,3}(?:[,   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s+(?:[▲▼△▽]\s*)?[+\-−]?\d[\d.,]*\s?%/u.exec(text)
  if (!match) return null
  return { symbol: match[1]!, price: match[2]!.replace(/[  ]/g, ' ') }
}

/** A window worth capturing as "the chart": TradingView's own window, or a TradingView chart tab. */
export function isTradingViewWindow(name: string): boolean {
  return /tradingview/i.test(name) || parseTradingViewTitle(name) !== null
}

/** "10:32:14 · ES1! 6,123.25", or just the time when the title says nothing certain. */
export function snapshotCaption(ms: number, windowTitle: string | null): string {
  const chart = windowTitle ? parseTradingViewTitle(windowTitle) : null
  return chart ? `${clockTime(ms)} · ${chart.symbol} ${chart.price}` : clockTime(ms)
}

export function logParagraph(text: string): RichNode {
  return text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }
}

export function logImage(attrs: { attachmentId: string; caption: string; width: number | null; height: number | null }): RichNode {
  return { type: IMAGE_NODE, attrs: { attachmentId: attrs.attachmentId, width: 100, caption: attrs.caption, naturalWidth: attrs.width, naturalHeight: attrs.height } }
}

function isEmptyParagraph(node: RichNode | undefined): boolean {
  if (!node || node.type !== 'paragraph') return false
  return (node.content ?? []).every((child) => child.type === 'text' && !(child.text ?? '').trim())
}

const isTextBlock = (node: RichNode | undefined): boolean => !!node && ['paragraph', 'heading'].includes(node.type)

/**
 * Where new log entries go: after the last block that holds anything. Empty paragraphs at the
 * very end (a line someone started) stay after the new entries.
 */
export function logInsertIndex(doc: RichDoc): number {
  const blocks = doc.content ?? []
  let index = blocks.length
  while (index > 0 && isEmptyParagraph(blocks[index - 1])) index--
  return index
}

/**
 * Add entries to a session log that is not open in the editor. Trailing empty paragraphs are
 * dropped first; a picture at the very end is followed by an empty line to write on, as a
 * pasted screenshot is.
 */
export function appendLogBlocks(doc: RichDoc, blocks: RichNode[]): RichDoc {
  const kept = (doc.content ?? []).slice(0, logInsertIndex(doc))
  const content = [...kept, ...blocks]
  if (!isTextBlock(content[content.length - 1])) content.push({ type: 'paragraph' })
  return { type: 'doc', content }
}
