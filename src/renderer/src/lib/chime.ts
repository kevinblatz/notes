/**
 * The candle-close chime: a short, soft bell made with Web Audio (no sound files). A fresh
 * audio context is made for each chime and closed once it has rung, so nothing keeps the
 * audio system running between closes.
 */
export function playChime(): void {
  const AudioContextClass = window.AudioContext
  if (!AudioContextClass) return
  let context: AudioContext
  try {
    context = new AudioContextClass()
  } catch {
    return
  }
  const start = context.currentTime + 0.02
  const master = context.createGain()
  master.gain.value = 0.16
  master.connect(context.destination)
  // Two partials a fifth apart, each with a quick soft attack and a long gentle decay.
  const partials: Array<[frequency: number, level: number, length: number]> = [
    [880, 1, 1.1],
    [1320, 0.35, 0.7]
  ]
  let last: OscillatorNode | null = null
  for (const [frequency, level, length] of partials) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(level, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
    oscillator.connect(gain).connect(master)
    oscillator.start(start)
    oscillator.stop(start + length + 0.05)
    if (!last || length >= 1) last = oscillator
  }
  if (last) last.onended = () => void context.close().catch(() => undefined)
}
