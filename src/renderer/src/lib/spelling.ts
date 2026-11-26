/**
 * The spelling checker in the window. The word list (about 730 kB) is not part of the startup
 * bundle: it is a separate file of the app's own, loaded the first time a note or the quick
 * note strip opens and read in the browser's idle moments, so typing and transitions are never
 * held up. Until it is in, nothing is underlined. Organize asks for it at once.
 */
import { useSyncExternalStore } from 'react'
import { Dictionary, parseWordListPart } from '@shared/dictionary'
import { addSpellingExtras, Speller } from '@shared/spelling'
import { useStore } from '../state/store'

let dictionary: Dictionary | null = null
let loading: Promise<Speller> | null = null
let words: readonly string[] = useStore.getState().prefs.spellingWords
let speller = new Speller(null, words)
const listeners = new Set<() => void>()

function publish(): void {
  speller = new Speller(dictionary, words)
  for (const listener of listeners) listener()
}

// "Add to dictionary" and Settings change the user's words; the checker follows at once.
useStore.subscribe((state) => {
  if (state.prefs.spellingWords === words) return
  words = state.prefs.spellingWords
  publish()
})

export function getSpeller(): Speller {
  return speller
}

export function subscribeSpeller(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current checker; components re-render when the word list arrives or the user's words change. */
export function useSpeller(): Speller {
  return useSyncExternalStore(subscribeSpeller, getSpeller)
}

/** Organize asked for the list: read it now, in short tasks, without waiting for idle moments. */
let urgent = false
/** The wait for an idle moment in progress, so an urgent request can end it. */
let waiting: ((deadline: IdleDeadline) => void) | null = null

/** A few milliseconds of work, then the browser gets a turn. */
function shortTask(): IdleDeadline {
  const until = performance.now() + 8
  return { didTimeout: true, timeRemaining: () => Math.max(0, until - performance.now()) }
}

/**
 * Wait until the browser has nothing else to do: the word list is read in the idle moments
 * between key presses and frames, so it never delays typing or a transition on screen.
 */
function idle(): Promise<IdleDeadline> {
  return new Promise((resolve) => {
    if (urgent) {
      setTimeout(() => resolve(shortTask()), 0)
      return
    }
    const done = (deadline: IdleDeadline): void => {
      if (waiting !== done) return
      waiting = null
      resolve(deadline)
    }
    waiting = done
    if (typeof requestIdleCallback === 'function') requestIdleCallback(done, { timeout: 2000 })
    else setTimeout(() => done(shortTask()), 0)
  })
}

/** Characters of the word list read at a time (well under a millisecond of work). */
const STEP = 4000

async function readWordList(): Promise<Dictionary> {
  await idle()
  const { default: text } = await import('@shared/words/en-US.txt?raw')
  const next = new Dictionary()
  let level = 60
  let start = 0
  while (start < text.length) {
    const deadline = await idle()
    // At least one step per idle moment, more while the moment lasts.
    do {
      const newline = text.indexOf('\n', Math.min(text.length, start + STEP))
      const end = newline === -1 ? text.length : newline + 1
      level = parseWordListPart(text.slice(start, end), next, level)
      start = end
    } while (start < text.length && deadline.timeRemaining() > 2)
  }
  return addSpellingExtras(next)
}

/**
 * Start loading the word list if it is not in yet; resolves with a ready checker. `urgent`
 * (Organize) reads it at once rather than in idle moments.
 */
export function loadSpelling(options: { urgent?: boolean } = {}): Promise<Speller> {
  if (dictionary) return Promise.resolve(speller)
  loading ??= readWordList().then(
    (loaded) => {
      dictionary = loaded
      publish()
      return speller
    },
    (error: unknown) => {
      loading = null
      throw error
    }
  )
  if (options.urgent && !urgent) {
    urgent = true
    waiting?.(shortTask())
  }
  return loading
}
