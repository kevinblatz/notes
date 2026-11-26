/**
 * The candle timer's clock. The window's own timers are throttled while it is hidden or
 * minimised, so the closes are scheduled here: one timer, to the next close, and only while
 * the user has the timer switched on. At each close the window is told, so it can chime.
 */
import { nextCandleClose, type CandleMinutes } from '@shared/candles'

/** A close noticed this much later than it happened (the computer slept) is not announced. */
const LATE_LIMIT_MS = 3000

export interface CandleClockState {
  on: boolean
  minutes: CandleMinutes
  /** When the next close is due (app clock), or null while off. */
  nextCloseAt: number | null
  /** Closes announced since start-up. */
  closes: number
  lastCloseAt: number | null
}

export class CandleClock {
  private on = false
  private minutes: CandleMinutes = 5
  private timer: NodeJS.Timeout | null = null
  private nextCloseAt: number | null = null
  private closes = 0
  private lastCloseAt: number | null = null

  constructor(
    private readonly now: () => number,
    private readonly onClose: (at: number, minutes: CandleMinutes) => void
  ) {}

  /** Switch on or off, or change the timeframe. Nothing is scheduled while off. */
  update(on: boolean, minutes: CandleMinutes): void {
    if (on === this.on && minutes === this.minutes) return
    this.on = on
    this.minutes = minutes
    this.reschedule()
  }

  /** Work out the next close afresh: after the clock changed or the computer woke up. */
  reschedule(): void {
    this.clear()
    if (!this.on) return
    const now = this.now()
    const at = nextCandleClose(now, this.minutes)
    this.nextCloseAt = at
    this.timer = setTimeout(() => this.fire(at), Math.max(0, at - now))
  }

  private fire(at: number): void {
    this.timer = null
    const now = this.now()
    // Timers can wake a millisecond early; wait out the rest rather than announce early.
    if (now < at) {
      this.timer = setTimeout(() => this.fire(at), at - now)
      return
    }
    if (now - at <= LATE_LIMIT_MS) {
      this.closes++
      this.lastCloseAt = at
      this.onClose(at, this.minutes)
    }
    this.reschedule()
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.nextCloseAt = null
  }

  state(): CandleClockState {
    return { on: this.on, minutes: this.minutes, nextCloseAt: this.nextCloseAt, closes: this.closes, lastCloseAt: this.lastCloseAt }
  }

  dispose(): void {
    this.clear()
    this.on = false
  }
}
