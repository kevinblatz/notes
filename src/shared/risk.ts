/**
 * Position-size arithmetic for the risk calculator. Everything is worked in whole ticks and
 * whole cents, so no answer ever depends on floating-point rounding. The calculator only
 * does this arithmetic: it never places, prepares or suggests an order.
 */

export type InstrumentKey = 'MES' | 'ES' | 'MNQ' | 'NQ'
export type StopUnit = 'points' | 'ticks'

export interface Instrument {
  key: InstrumentKey
  name: string
  /** Dollars per full point, in cents. */
  pointValueCents: number
}

/** All four trade in quarter-point ticks. */
export const TICKS_PER_POINT = 4

export const INSTRUMENTS: Record<InstrumentKey, Instrument> = {
  MES: { key: 'MES', name: 'Micro E-mini S&P 500', pointValueCents: 500 },
  ES: { key: 'ES', name: 'E-mini S&P 500', pointValueCents: 5000 },
  MNQ: { key: 'MNQ', name: 'Micro E-mini Nasdaq-100', pointValueCents: 200 },
  NQ: { key: 'NQ', name: 'E-mini Nasdaq-100', pointValueCents: 2000 }
}
export const INSTRUMENT_KEYS: readonly InstrumentKey[] = ['MES', 'ES', 'MNQ', 'NQ']

/** The value of one tick in cents: MES 125, ES 1250, MNQ 50, NQ 500. */
export function tickValueCents(instrument: InstrumentKey): number {
  return INSTRUMENTS[instrument].pointValueCents / TICKS_PER_POINT
}

/** Largest amounts the calculator accepts; anything bigger is a typing slip. */
export const MAX_RISK_CENTS = 100_000_000 * 100
const MAX_SCALED = 1e14

/**
 * Read a number as a person types it ("1,250", "4.5", "4,5", "$300", "6 123.25") as an
 * exact integer count of 1/10^decimals units. Digits beyond `decimals` are rounded half up.
 * Null for an empty field, a negative number or anything that is not a number.
 *
 * With both a comma and a point present, the last one is the decimal mark. A single comma
 * followed by exactly three digits groups thousands ("1,250"); otherwise a comma is the
 * decimal mark ("4,5").
 */
export function parseDecimal(text: string, decimals: number): number | null {
  let s = text.trim().replace(/^\$/, '').replace(/[\s  ']/g, '')
  if (s.length === 0 || s.length > 40) return null
  const lastComma = s.lastIndexOf(',')
  const lastPoint = s.lastIndexOf('.')
  if (lastComma !== -1 && lastPoint !== -1) {
    const mark = lastComma > lastPoint ? ',' : '.'
    const group = mark === ',' ? '.' : ','
    s = s.split(group).join('')
    if (mark === ',') s = s.replace(',', '.')
  } else if (lastComma !== -1) {
    const commas = s.split(',').length - 1
    const grouping = commas > 1 || /^\d{1,3},\d{3}$/.test(s)
    s = grouping ? s.split(',').join('') : s.replace(',', '.')
  }
  const match = /^(\d*)(?:\.(\d*))?$/.exec(s)
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) return null
  const whole = match[1] || '0'
  const fraction = match[2] ?? ''
  const kept = (fraction + '0'.repeat(decimals)).slice(0, decimals)
  const roundUp = fraction.length > decimals && Number(fraction[decimals]) >= 5
  const scaled = Number(whole) * 10 ** decimals + Number(kept || '0') + (roundUp ? 1 : 0)
  if (!Number.isSafeInteger(scaled) || scaled > MAX_SCALED) return null
  return scaled
}

/** Dollars typed by a person, in cents. */
export function parseDollars(text: string): number | null {
  const cents = parseDecimal(text, 2)
  return cents === null || cents > MAX_RISK_CENTS ? null : cents
}

/** Points and prices are read to 1/10,000 of a point, far finer than a tick. */
const POINT_DECIMALS = 4
const SCALE = 10 ** POINT_DECIMALS
const SCALED_PER_TICK = SCALE / TICKS_PER_POINT

export interface StopTicks {
  ticks: number
  /** The distance was not a whole number of ticks and was rounded up to the next tick. */
  roundedUp: boolean
}

function toTicks(scaled: number, perTick: number): StopTicks | null {
  if (scaled <= 0) return null
  const ticks = Math.ceil(scaled / perTick)
  return { ticks, roundedUp: ticks * perTick !== scaled }
}

/**
 * A stop distance typed in points or in ticks, as whole ticks. A distance that is not a
 * whole number of ticks is rounded up (a wider stop, so never more contracts than fit).
 */
export function stopTicksFromText(text: string, unit: StopUnit): StopTicks | null {
  const scaled = parseDecimal(text, POINT_DECIMALS)
  if (scaled === null) return null
  return unit === 'points' ? toTicks(scaled, SCALED_PER_TICK) : toTicks(scaled, SCALE)
}

/** The distance between an entry and a stop price, as whole ticks (rounded up the same way). */
export function stopTicksFromPrices(entryText: string, stopText: string): StopTicks | null {
  const entry = parseDecimal(entryText, POINT_DECIMALS)
  const stop = parseDecimal(stopText, POINT_DECIMALS)
  if (entry === null || stop === null) return null
  return toTicks(Math.abs(entry - stop), SCALED_PER_TICK)
}

export interface PositionSize {
  contracts: number
  /** What one contract loses at the stop, in cents. */
  perContractCents: number
  /** What the whole position loses at the stop, in cents. */
  actualRiskCents: number
}

/** contracts = floor(risk / (stop ticks x tick value)), all in whole cents. */
export function positionSize(instrument: InstrumentKey, riskCents: number, stopTicks: number): PositionSize {
  const perContractCents = stopTicks * tickValueCents(instrument)
  const contracts = perContractCents > 0 && riskCents > 0 ? Math.floor(riskCents / perContractCents) : 0
  return { contracts, perContractCents, actualRiskCents: contracts * perContractCents }
}

/** Whole ticks as points: 18 -> "4.5", 1 -> "0.25". */
export function formatPoints(ticks: number): string {
  const whole = Math.floor(ticks / TICKS_PER_POINT)
  const rest = ticks % TICKS_PER_POINT
  return rest === 0 ? String(whole) : `${whole}.${['', '25', '5', '75'][rest]}`
}

/** A distance in the unit the field shows: points "4.5" or ticks "18". */
export function formatStop(ticks: number, unit: StopUnit): string {
  return unit === 'points' ? formatPoints(ticks) : String(ticks)
}

const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const WHOLE_DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** Cents as dollars: 25000 -> "$250", 18750 -> "$187.50", 12345600 -> "$123,456". */
export function formatDollars(cents: number): string {
  const whole = cents % 100 === 0
  return (whole ? WHOLE_DOLLARS : DOLLARS).format(cents / 100)
}

/** Cents as the plain number a person would type into the risk field: 25000 -> "250", 18750 -> "187.50". */
export function dollarsInputText(cents: number): string {
  const whole = Math.floor(cents / 100)
  const rest = cents % 100
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`
}

export interface RiskFields {
  instrument: InstrumentKey
  /** Dollars the trade may lose, as typed. */
  risk: string
  /** Stop distance as typed, in `unit`. */
  stop: string
  unit: StopUnit
}

export type RiskOutcome =
  | { kind: 'empty'; needs: 'risk' | 'stop' }
  | { kind: 'invalid'; field: 'risk' | 'stop'; message: string }
  | ({ kind: 'ok'; riskCents: number; ticks: number; roundedUp: boolean } & PositionSize)

/** The whole calculation for the panel, from what is in its fields. */
export function evaluateRisk(fields: RiskFields): RiskOutcome {
  const riskText = fields.risk.trim()
  if (riskText === '') return { kind: 'empty', needs: 'risk' }
  const riskCents = parseDollars(riskText)
  if (riskCents === null || riskCents === 0) return { kind: 'invalid', field: 'risk', message: 'Enter the dollars you are willing to lose.' }
  if (fields.stop.trim() === '') return { kind: 'empty', needs: 'stop' }
  const stop = stopTicksFromText(fields.stop, fields.unit)
  if (!stop) return { kind: 'invalid', field: 'stop', message: `Enter a stop distance in ${fields.unit}.` }
  return { kind: 'ok', riskCents, ticks: stop.ticks, roundedUp: stop.roundedUp, ...positionSize(fields.instrument, riskCents, stop.ticks) }
}

/**
 * What an entry and a stop price put in the distance field (in `unit`, whole ticks, rounded
 * up), or why they cannot: null while either price is still missing.
 */
export function distanceFromPrices(entryText: string, stopText: string, unit: StopUnit): { text: string } | { error: string } | null {
  if (entryText.trim() === '' || stopText.trim() === '') return null
  if (parseDecimal(entryText, 4) === null || parseDecimal(stopText, 4) === null) return { error: 'Prices are numbers like 6123.25.' }
  const stop = stopTicksFromPrices(entryText, stopText)
  if (!stop) return { error: 'Entry and stop are the same price.' }
  return { text: formatStop(stop.ticks, unit) }
}

/** The same distance in the other unit, for when the points / ticks toggle is flipped. */
export function convertStopText(text: string, from: StopUnit, to: StopUnit): string {
  if (from === to) return text
  const stop = stopTicksFromText(text, from)
  return stop ? formatStop(stop.ticks, to) : text
}
