/**
 * Candle timer arithmetic. Candles close on wall-clock boundaries of the local system clock:
 * a 5-minute candle closes at :00, :05, :10 ... of the local time, a 60-minute candle on the
 * local hour.
 */

export const CANDLE_MINUTES = [1, 5, 15, 60] as const
export type CandleMinutes = (typeof CANDLE_MINUTES)[number]
export const DEFAULT_CANDLE_MINUTES: CandleMinutes = 5
/** The last seconds of a candle are shown in the accent colour. */
export const CANDLE_URGENT_MS = 10_000

export function isCandleMinutes(value: unknown): value is CandleMinutes {
  return typeof value === 'number' && (CANDLE_MINUTES as readonly number[]).includes(value)
}

/** "1m", "5m", "15m", "1h" */
export function candleLabel(minutes: CandleMinutes): string {
  return minutes === 60 ? '1h' : `${minutes}m`
}

/** The local time zone's offset from UTC at a moment, in minutes east of UTC (+60 for Paris in winter). */
export function localOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset()
}

/**
 * The first candle close strictly after `now`. `offsetAt` gives the local offset from UTC (in
 * minutes, east positive) at a moment; it is the system clock's own unless a test passes one.
 * The offset in force at `now` decides, so a clock change only takes effect from the next close
 * on (the timer works out each close afresh once the previous one has passed).
 */
export function nextCandleClose(now: number, minutes: CandleMinutes, offsetAt: (ms: number) => number = localOffsetMinutes): number {
  const period = minutes * 60_000
  const offset = offsetAt(now) * 60_000
  const local = now + offset
  return (Math.floor(local / period) + 1) * period - offset
}

/** Time left as "m:ss", rounded up to the whole second: 133_000 -> "2:13", 400 -> "0:01". */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
