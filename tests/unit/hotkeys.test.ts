import { afterEach, describe, expect, it } from 'vitest'
import { candleLabel, formatCountdown, isCandleMinutes, nextCandleClose } from '@shared/candles'
import { bindingsFromPreferences, DEFAULT_HOTKEYS, HOTKEY_IDS, mergeHotkeys, preferencesFromBindings } from '@shared/hotkeys'
import { loadPreferences, mergePreferences, rememberSeeThrough, seeThroughToggleTarget } from '@shared/preferences'
import {
  convertStopText,
  distanceFromPrices,
  dollarsInputText,
  evaluateRisk,
  formatDollars,
  formatPoints,
  parseDecimal,
  parseDollars,
  positionSize,
  stopTicksFromPrices,
  stopTicksFromText,
  tickValueCents,
  type RiskFields
} from '@shared/risk'
import {
  appendLogBlocks,
  cleanQuickNote,
  clockTime,
  isTradingViewWindow,
  localDateKey,
  logImage,
  logInsertIndex,
  logParagraph,
  parseTradingViewTitle,
  quickNoteLine,
  sessionLogTitle,
  snapshotCaption
} from '@shared/sessionLog'
import { DEFAULT_PREFERENCES, type RichDoc } from '@shared/types'
import { Library } from '../../src/main/store/library'
import { chooseChartWindow, cropAwayNotes } from '../../src/main/snapshot'
import { cleanupTempDirs, tempDir } from './helpers'

afterEach(cleanupTempDirs)

/** A moment in local time, so these tests read the same in every time zone. */
const local = (day: number, h: number, m: number, s: number, ms = 0): number => new Date(2026, 10, day, h, m, s, ms).getTime()

describe('risk calculator arithmetic', () => {
  it('knows the four contracts in whole cents per tick', () => {
    expect(tickValueCents('MES')).toBe(125)
    expect(tickValueCents('ES')).toBe(1250)
    expect(tickValueCents('MNQ')).toBe(50)
    expect(tickValueCents('NQ')).toBe(500)
  })

  it('reads numbers as people type them, exactly', () => {
    expect(parseDecimal('4.5', 4)).toBe(45000)
    expect(parseDecimal('4,5', 4)).toBe(45000)
    expect(parseDecimal('1,250', 2)).toBe(125000)
    expect(parseDecimal('6,123.25', 4)).toBe(61232500)
    expect(parseDecimal('6.123,25', 4)).toBe(61232500)
    expect(parseDecimal('6 123.25', 4)).toBe(61232500)
    expect(parseDecimal('.25', 4)).toBe(2500)
    expect(parseDecimal('$300', 2)).toBe(30000)
    expect(parseDecimal('100.555', 2)).toBe(10056)
    for (const bad of ['', ' ', '-5', 'abc', '1.2.3', '.', '1e5', '5-']) expect(parseDecimal(bad, 2), bad).toBeNull()
    expect(parseDollars('250')).toBe(25000)
    expect(parseDollars('99999999999999')).toBeNull()
  })

  it('turns a stop distance into whole ticks, rounding up between ticks', () => {
    expect(stopTicksFromText('4.5', 'points')).toEqual({ ticks: 18, roundedUp: false })
    expect(stopTicksFromText('0.25', 'points')).toEqual({ ticks: 1, roundedUp: false })
    expect(stopTicksFromText('3.1', 'points')).toEqual({ ticks: 13, roundedUp: true })
    expect(stopTicksFromText('18', 'ticks')).toEqual({ ticks: 18, roundedUp: false })
    expect(stopTicksFromText('2.5', 'ticks')).toEqual({ ticks: 3, roundedUp: true })
    expect(stopTicksFromText('0', 'points')).toBeNull()
    expect(stopTicksFromPrices('6123.25', '6119.75')).toEqual({ ticks: 14, roundedUp: false })
    expect(stopTicksFromPrices('6119.75', '6123.25')).toEqual({ ticks: 14, roundedUp: false })
    expect(stopTicksFromPrices('6100', '6100')).toBeNull()
  })

  it('sizes positions with floor(risk / (ticks x tick value)), with no floating-point slips', () => {
    expect(positionSize('MES', 25000, 18)).toEqual({ contracts: 11, perContractCents: 2250, actualRiskCents: 24750 })
    expect(positionSize('ES', 25000, 18)).toEqual({ contracts: 1, perContractCents: 22500, actualRiskCents: 22500 })
    expect(positionSize('ES', 25000, 24)).toEqual({ contracts: 0, perContractCents: 30000, actualRiskCents: 0 })
    expect(positionSize('MNQ', 25000, 49)).toEqual({ contracts: 10, perContractCents: 2450, actualRiskCents: 24500 })
    expect(positionSize('NQ', 100000, 40)).toEqual({ contracts: 5, perContractCents: 20000, actualRiskCents: 100000 })
    // The classic trap: 0.1 + 0.2 style sums never decide a boundary. $30 at 2.8 points on MES
    // is exactly 2 contracts (2.8 x 4 = 11.2 ticks, rounded up to 12 x $1.25 = $15).
    expect(positionSize('MES', 3000, 12)).toEqual({ contracts: 2, perContractCents: 1500, actualRiskCents: 3000 })
    expect(positionSize('MES', 2999, 12).contracts).toBe(1)
  })

  it('evaluates the panel fields, and says what is missing', () => {
    const fields = (patch: Partial<RiskFields>): RiskFields => ({ instrument: 'MES', risk: '250', stop: '4.5', unit: 'points', ...patch })
    expect(evaluateRisk(fields({}))).toMatchObject({ kind: 'ok', contracts: 11, ticks: 18, actualRiskCents: 24750 })
    expect(evaluateRisk(fields({ risk: '' }))).toEqual({ kind: 'empty', needs: 'risk' })
    expect(evaluateRisk(fields({ stop: '' }))).toEqual({ kind: 'empty', needs: 'stop' })
    expect(evaluateRisk(fields({ risk: '0' }))).toMatchObject({ kind: 'invalid', field: 'risk' })
    expect(evaluateRisk(fields({ stop: 'x' }))).toMatchObject({ kind: 'invalid', field: 'stop' })
    expect(evaluateRisk(fields({ stop: '10', unit: 'ticks' }))).toMatchObject({ kind: 'ok', contracts: 20, ticks: 10 })
    expect(evaluateRisk(fields({ instrument: 'ES', stop: '6' }))).toMatchObject({ kind: 'ok', contracts: 0, perContractCents: 30000 })
  })

  it('fills the distance from prices, and converts between points and ticks', () => {
    expect(distanceFromPrices('6123.25', '6119.75', 'points')).toEqual({ text: '3.5' })
    expect(distanceFromPrices('6123.25', '6119.75', 'ticks')).toEqual({ text: '14' })
    expect(distanceFromPrices('6123.25', '', 'points')).toBeNull()
    expect(distanceFromPrices('6123.25', '6123.25', 'points')).toEqual({ error: 'Entry and stop are the same price.' })
    expect(distanceFromPrices('abc', '6123.25', 'points')).toMatchObject({ error: expect.any(String) })
    expect(convertStopText('4.5', 'points', 'ticks')).toBe('18')
    expect(convertStopText('18', 'ticks', 'points')).toBe('4.5')
    expect(convertStopText('', 'ticks', 'points')).toBe('')
    expect(formatPoints(1)).toBe('0.25')
    expect(formatPoints(19)).toBe('4.75')
    expect(formatPoints(8)).toBe('2')
  })

  it('formats dollars plainly', () => {
    expect(formatDollars(25000)).toBe('$250')
    expect(formatDollars(18750)).toBe('$187.50')
    expect(formatDollars(12345600)).toBe('$123,456')
    expect(dollarsInputText(25000)).toBe('250')
    expect(dollarsInputText(18705)).toBe('187.05')
  })
})

describe('candle timer boundaries', () => {
  it('closes on wall-clock boundaries of the local clock', () => {
    expect(nextCandleClose(local(25, 10, 4, 57), 5)).toBe(local(25, 10, 5, 0))
    expect(nextCandleClose(local(25, 10, 4, 57), 1)).toBe(local(25, 10, 5, 0))
    expect(nextCandleClose(local(25, 10, 4, 57), 15)).toBe(local(25, 10, 15, 0))
    expect(nextCandleClose(local(25, 10, 4, 57), 60)).toBe(local(25, 11, 0, 0))
    expect(nextCandleClose(local(25, 23, 59, 59, 500), 60)).toBe(local(26, 0, 0, 0))
    // Exactly on a close: the next one.
    expect(nextCandleClose(local(25, 10, 5, 0), 5)).toBe(local(25, 10, 10, 0))
  })

  it('aligns 60-minute candles to the local hour, also in half-hour time zones', () => {
    const utc = Date.UTC(2026, 10, 25, 4, 10, 0)
    // India is UTC+5:30: 09:40 local, so the local hour closes at 10:00 local = 04:30 UTC.
    expect(nextCandleClose(utc, 60, () => 330)).toBe(Date.UTC(2026, 10, 25, 4, 30, 0))
    expect(nextCandleClose(utc, 15, () => 330)).toBe(Date.UTC(2026, 10, 25, 4, 15, 0))
    // Nepal, UTC+5:45: 09:55 local; the hour closes at 04:15 UTC.
    expect(nextCandleClose(utc, 60, () => 345)).toBe(Date.UTC(2026, 10, 25, 4, 15, 0))
    expect(nextCandleClose(utc, 60, () => 0)).toBe(Date.UTC(2026, 10, 25, 5, 0, 0))
  })

  it('shows the time left as m:ss, rounded up to the second', () => {
    expect(formatCountdown(133_000)).toBe('2:13')
    expect(formatCountdown(132_001)).toBe('2:13')
    expect(formatCountdown(400)).toBe('0:01')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(3_600_000)).toBe('60:00')
    expect([1, 5, 15, 60].map((m) => candleLabel(m as 1))).toEqual(['1m', '5m', '15m', '1h'])
    expect(isCandleMinutes(5)).toBe(true)
    expect(isCandleMinutes(30)).toBe(false)
  })
})

describe('session log', () => {
  it('formats lines and captions in local 24-hour time', () => {
    expect(clockTime(local(25, 10, 32, 14))).toBe('10:32:14')
    expect(clockTime(local(25, 0, 0, 5))).toBe('00:00:05')
    expect(clockTime(local(25, 23, 59, 59))).toBe('23:59:59')
    expect(quickNoteLine(local(25, 10, 32, 14), '  Swept the\nlow  ')).toBe('10:32:14 — Swept the low')
    expect(cleanQuickNote('a'.repeat(3000))).toHaveLength(2000)
    expect(localDateKey(local(25, 23, 59, 59))).toBe('2026-11-25')
    expect(localDateKey(local(26, 0, 0, 0))).toBe('2026-11-26')
    expect(sessionLogTitle(local(25, 10, 0, 0), 'en-GB')).toBe('Session log · Wed 25 Nov')
    expect(sessionLogTitle(local(25, 10, 0, 0), 'en-US')).toBe('Session log · Wed, Nov 25')
  })

  it('reads symbol and price from a TradingView chart title, and never guesses', () => {
    expect(parseTradingViewTitle('ES1! 6,123.25 ▲ +0.35% Unnamed')).toEqual({ symbol: 'ES1!', price: '6,123.25' })
    expect(parseTradingViewTitle('ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome')).toEqual({ symbol: 'ES1!', price: '6,123.25' })
    expect(parseTradingViewTitle('MNQZ2026 21,345.50 ▼ −1.12% My layout - Microsoft​ Edge')).toEqual({ symbol: 'MNQZ2026', price: '21,345.50' })
    expect(parseTradingViewTitle('(2) NQ1! 21345.5 ▲ +0.02% Scalping')).toEqual({ symbol: 'NQ1!', price: '21345.5' })
    expect(parseTradingViewTitle('CME_MINI:ES1! 6123 +0.10%')).toEqual({ symbol: 'CME_MINI:ES1!', price: '6123' })
    for (const other of ['TradingView — Track All Markets', 'Inbox (3) - Gmail - Google Chrome', 'Trading Notes', 'ES1! chart ideas', '', 'Session log 2026 notes 5%']) {
      expect(parseTradingViewTitle(other), other).toBeNull()
    }
    expect(isTradingViewWindow('Supercharts — TradingView')).toBe(true)
    expect(isTradingViewWindow('ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome')).toBe(true)
    expect(isTradingViewWindow('Inbox - Mail')).toBe(false)
    expect(snapshotCaption(local(25, 10, 32, 14), 'ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome')).toBe('10:32:14 · ES1! 6,123.25')
    expect(snapshotCaption(local(25, 10, 32, 14), 'Supercharts — TradingView')).toBe('10:32:14')
    expect(snapshotCaption(local(25, 10, 32, 14), null)).toBe('10:32:14')
  })

  it('adds entries after the last line with content', () => {
    const doc = (...texts: string[]): RichDoc => ({ type: 'doc', content: texts.map(logParagraph) })
    const texts = (d: RichDoc): string[] => (d.content ?? []).map((n) => (n.type === 'paragraph' ? (n.content?.[0]?.text ?? '') : `[${n.type}]`))
    expect(texts(appendLogBlocks(doc(''), [logParagraph('a')]))).toEqual(['a'])
    expect(texts(appendLogBlocks(doc('a', '', ''), [logParagraph('b')]))).toEqual(['a', 'b'])
    expect(logInsertIndex(doc('a', 'b', ''))).toBe(2)
    const image = logImage({ attachmentId: 'abcdefgh-1234', caption: '10:32:14', width: 1600, height: 900 })
    // A picture at the end gets a line after it to write on, as a pasted one does.
    const withImage = appendLogBlocks(doc('a'), [image])
    expect(texts(withImage)).toEqual(['a', '[noteImage]', ''])
    expect(texts(appendLogBlocks(withImage, [logParagraph('b')]))).toEqual(['a', '[noteImage]', 'b'])
    expect(image.attrs).toEqual({ attachmentId: 'abcdefgh-1234', width: 100, caption: '10:32:14', naturalWidth: 1600, naturalHeight: 900 })
  })

  it('is one note per local day, found again by its date, and new again once trashed', () => {
    const lib = new Library(tempDir())
    const first = lib.ensureSessionLog(local(25, 9, 0, 0), 'en-GB')
    expect(first.created).toBe(true)
    expect(first.note).toMatchObject({ title: 'Session log · Wed 25 Nov', extra: { sessionLog: '2026-11-25' } })
    expect(first.layout.rows[0]!.notes).toEqual([first.note.id])
    const again = lib.ensureSessionLog(local(25, 23, 59, 0))
    expect(again).toMatchObject({ created: false, note: { id: first.note.id } })
    const next = lib.ensureSessionLog(local(26, 0, 1, 0), 'en-GB')
    expect(next.created).toBe(true)
    expect(next.note.id).not.toBe(first.note.id)
    expect(next.layout.rows[0]!.notes).toEqual([next.note.id])
    lib.trashNote(next.note.id)
    const replaced = lib.ensureSessionLog(local(26, 8, 0, 0))
    expect(replaced.created).toBe(true)
    expect(replaced.note.id).not.toBe(next.note.id)
    // An ordinary note otherwise: it saves with the revision rule like any other.
    const saved = lib.saveNote({ id: first.note.id, expectedRevision: first.note.revision, content: appendLogBlocks(first.note.content, [logParagraph('09:00:00 — x')]) })
    expect(saved.ok).toBe(true)
    expect(lib.saveNote({ id: first.note.id, expectedRevision: first.note.revision, content: first.note.content })).toMatchObject({ ok: false, reason: 'stale' })
    expect(lib.ensureSessionLog(local(25, 12, 0, 0)).note.plainText).toBe('09:00:00 — x')
    lib.close()
  })
})

describe('hotkey preferences', () => {
  it('default to Ctrl+Alt combinations that leave Chrome its own shortcuts', () => {
    expect(DEFAULT_PREFERENCES.hotkeys).toEqual(DEFAULT_HOTKEYS)
    const all = Object.values(bindingsFromPreferences(DEFAULT_PREFERENCES)).map((b) => b.accelerator)
    expect(new Set(all).size).toBe(HOTKEY_IDS.length)
    for (const chrome of ['Control+Shift+N', 'Control+Shift+T', 'Control+Shift+R', 'Control+Shift+O']) expect(all).not.toContain(chrome)
    expect(DEFAULT_PREFERENCES).toMatchObject({ shortcutEnabled: true, candleTimer: false, candleMinutes: 5, candleChime: true, seeThroughOpacity: 0.7, riskInstrument: 'MES', riskCents: null, riskUnit: 'points' })
  })

  it('accept only valid bindings, keeping the rest', () => {
    const merged = mergeHotkeys(DEFAULT_HOTKEYS, { quickNote: { accelerator: 'Control+Alt+Q', enabled: false }, snapshot: { accelerator: 'S' }, bogus: { accelerator: 'Control+Alt+B' }, risk: 'x' })
    expect(merged.quickNote).toEqual({ accelerator: 'Control+Alt+Q', enabled: false })
    expect(merged.snapshot).toEqual(DEFAULT_HOTKEYS.snapshot)
    expect(merged.risk).toEqual(DEFAULT_HOTKEYS.risk)
    expect(Object.keys(merged)).not.toContain('bogus')
    const prefs = mergePreferences(DEFAULT_PREFERENCES, { hotkeys: { openLog: { enabled: false } }, shortcutEnabled: 'no' })
    expect(prefs.hotkeys.openLog).toEqual({ accelerator: 'Control+Alt+L', enabled: false })
    expect(prefs.shortcutEnabled).toBe(true)
    const bindings = bindingsFromPreferences(prefs)
    expect(bindings.toggle).toEqual({ accelerator: 'Control+Shift+Space', enabled: true })
    expect(preferencesFromBindings(bindings)).toEqual({ shortcut: prefs.shortcut, shortcutEnabled: true, hotkeys: prefs.hotkeys })
  })

  it('validate the trading tools’ settings', () => {
    const next = mergePreferences(DEFAULT_PREFERENCES, { candleTimer: true, candleMinutes: 60, candleChime: false, riskInstrument: 'NQ', riskCents: 25000, riskUnit: 'ticks' })
    expect(next).toMatchObject({ candleTimer: true, candleMinutes: 60, candleChime: false, riskInstrument: 'NQ', riskCents: 25000, riskUnit: 'ticks' })
    const bad = mergePreferences(next, { candleMinutes: 30, riskInstrument: 'CL', riskCents: -5, riskUnit: 'pips', candleTimer: 'yes' })
    expect(bad).toMatchObject({ candleMinutes: 60, riskInstrument: 'NQ', riskCents: 25000, riskUnit: 'ticks', candleTimer: true })
    expect(mergePreferences(next, { riskCents: 12.5 }).riskCents).toBe(25000)
    expect(mergePreferences(next, { riskCents: null }).riskCents).toBeNull()
  })

  it('remember the see-through value last chosen for the see-through hotkey', () => {
    expect(seeThroughToggleTarget(1, 0.7)).toBe(0.7)
    expect(seeThroughToggleTarget(0.7, 0.7)).toBe(1)
    expect(seeThroughToggleTarget(0.45, 0.7)).toBe(1)
    expect(seeThroughToggleTarget(1, 1)).toBe(0.7)
    // Any see-through value that is stored, from anywhere, is the one remembered.
    const lib = new Library(tempDir())
    expect(lib.setPreferences({ windowOpacity: 0.5 }).seeThroughOpacity).toBe(0.5)
    expect(lib.setPreferences({ windowOpacity: 1 })).toMatchObject({ windowOpacity: 1, seeThroughOpacity: 0.5 })
    expect(lib.setPreferences({ seeThroughOpacity: 1 }).seeThroughOpacity).toBe(0.5)
    expect(lib.setPreferences({ seeThroughOpacity: 0.6 }).seeThroughOpacity).toBe(0.6)
    lib.close()
    expect(rememberSeeThrough({ ...DEFAULT_PREFERENCES, windowOpacity: 0.85 }).seeThroughOpacity).toBe(0.85)
    expect(rememberSeeThrough(DEFAULT_PREFERENCES)).toBe(DEFAULT_PREFERENCES)
    expect(loadPreferences({ shortcut: 'Control+Alt+K' })).toMatchObject({ shortcut: 'Control+Alt+K', shortcutEnabled: true, hotkeys: DEFAULT_HOTKEYS })
  })
})

describe('chart capture', () => {
  it('picks the TradingView chart window, never the notes', () => {
    const sources = [
      { id: 'window:1:0', name: 'Trading Notes' },
      { id: 'window:2:0', name: 'Supercharts — TradingView' },
      { id: 'window:3:0', name: 'ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome' },
      { id: 'screen:0:0', name: 'Entire screen' }
    ]
    expect(chooseChartWindow(sources, 'Trading Notes')?.id).toBe('window:3:0')
    expect(chooseChartWindow(sources.filter((s) => s.id !== 'window:3:0'), 'Trading Notes')?.id).toBe('window:2:0')
    expect(chooseChartWindow([{ id: 'window:4:0', name: 'Inbox - Mail' }], 'Trading Notes')).toBeNull()
  })

  it('cuts the docked notes out of a display picture', () => {
    const display = { id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
    // Docked right on a 150 % display: keep the left half, in physical pixels.
    expect(cropAwayNotes(display, { displayId: 7, bounds: { x: 960, y: 0, width: 960, height: 1040 } }, { width: 2880, height: 1620 })).toEqual({ x: 0, y: 0, width: 1440, height: 1620 })
    // Docked left: keep the right half.
    expect(cropAwayNotes(display, { displayId: 7, bounds: { x: 0, y: 0, width: 960, height: 1040 } }, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 0, width: 960, height: 1080 })
    // Another display, or not docked: nothing cut.
    expect(cropAwayNotes(display, { displayId: 8, bounds: { x: 1920, y: 0, width: 960, height: 1040 } }, { width: 1920, height: 1080 })).toBeNull()
    expect(cropAwayNotes(display, null, { width: 1920, height: 1080 })).toBeNull()
  })
})
