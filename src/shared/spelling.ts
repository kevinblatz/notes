/**
 * The app's own spelling checker: offline, and aware of trading notes. It decides which words
 * are underlined, what a misspelled word becomes when autocorrected, and what is suggested on
 * right-click. Exactly the words Organize would correct are the ones that are underlined.
 *
 * Never underlined and never changed: numbers, prices ($500, 6,123.25), times (9:30, 10am),
 * percentages, timeframes and R multiples (5m, 4H, +2R), tickers (ES1!), web addresses and
 * emails, ALL-CAPS acronyms of 2 to 6 letters, words with a capital inside (TradingView), the
 * user's own words, and a capitalised word in the middle of a sentence that the word list does
 * not know (a name: Powell, Kenzie). Trading terms are never underlined either; autocorrect
 * only writes them in their usual form (fvg -> FVG).
 */
import { Dictionary, editDistance, parseWordList } from './dictionary'
import { AMBIGUOUS_TERMS, CANONICAL_TERMS, CASUAL_WORD_SET, CASUAL_WORDS, lookupTerm, SESSION_NEIGHBOURS, TRADING_WORD_SET, TRADING_WORDS } from './tradingTerms'
import { ABBREVIATIONS, ENGLISH_EXTRAS, WORD_FIXES } from './wordFixes'

// ---------------------------------------------------------------- letter case

const UPPER = /\p{Lu}/u
const LOWER = /\p{Ll}/u
const LETTER = /\p{L}/u

export function letterCount(word: string): number {
  let count = 0
  for (const ch of word) if (LETTER.test(ch)) count++
  return count
}

/** Every letter is a capital ("FVG", "DONT"). */
export function isAllCaps(word: string): boolean {
  return UPPER.test(word) && !LOWER.test(word)
}

/** A capital first, then only small letters ("London", "Dont"). */
export function isCapitalised(word: string): boolean {
  const first = word.charAt(0)
  return UPPER.test(first) && !UPPER.test(word.slice(1)) && LOWER.test(word.slice(1))
}

/** A capital after the first letter, with small letters too: TradingView, iPhone, McDonald. */
export function hasInnerCapital(word: string): boolean {
  return UPPER.test(word.slice(1)) && LOWER.test(word)
}

export function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * Write `replacement` with the letter case `original` was typed in: "Dont" -> "Don't",
 * "DISPLACMENT" -> "DISPLACEMENT". A replacement with capitals of its own (London, I'm, FVG)
 * keeps them.
 */
export function matchCase(original: string, replacement: string): string {
  if (isAllCaps(original) && letterCount(original) > 1) return replacement.toUpperCase()
  if (UPPER.test(replacement)) return replacement
  if (UPPER.test(original.charAt(0))) return capitalise(replacement)
  return replacement
}

// ---------------------------------------------------------------- words in text

export type TokenKind = 'word' | 'protected' | 'rmultiple'

export interface Token {
  /** Position of the word itself in the text, without punctuation around it. */
  from: number
  to: number
  text: string
  kind: TokenKind
  /** First in the text, after . ! ? or a line break, or the first word after a log time stamp. */
  sentenceStart: boolean
  /** Which sentence of the text it is in, counting from 0. */
  sentence: number
  /** Part of a hyphenated word (re-entered): each part is checked on its own. */
  hyphenPart: boolean
}

const URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/i
const DOMAIN_RE = /^[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|co|ai|app|dev|gov|edu|uk|us|me|tv|gg|xyz|info|ly)(?:[/:?#]\S*)?$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
const TICKER_RE = /^[A-Za-z]{1,6}\d{1,2}!$/
const LEAD_PUNCT = /^[("'“‘[{<*_¿¡,;:.!?…—–]+/
const TRAIL_PUNCT = /[)"'”’\]}>.,;:!?…*_]+$/
const R_MULTIPLE_RE = /^[+\-−]?\d+(?:[.,]\d+)?[rR]$/
const DOTTED_ABBREVIATION = /^(?:\p{L}\.){1,4}\p{L}?$/u
const CODE_LIKE = /[_=#@\\<>|~^`{}*$%&+]/
/** A log line's time stamp ("09:31:05") or any clock time. */
export const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?$/i
const CHUNK_RE = /[^\s￼]+/g

/** Shorthand and trading terms that contain a digit ("b4", "po3", "tp1"): words, not numbers. */
const DIGIT_WORDS = new Set([...WORD_FIXES.keys(), ...CANONICAL_TERMS.map((t) => t.toLowerCase())].filter((w) => /\d/.test(w)))

function isSentenceGap(gap: string, previous: Token | null, previousIsLineStart: boolean): boolean {
  if (!previous) return true
  if (gap.includes('\n')) return true
  // A log line, "09:31:05 — text": the text after the stamp starts a statement.
  if (previousIsLineStart && previous.kind === 'protected' && TIME_RE.test(previous.text) && /^\s*[—–-]\s*$/.test(gap)) return true
  const plain = gap.replace(/\.{2,}|…/g, '')
  if (!/[.!?]/.test(plain)) return false
  if (ABBREVIATIONS.has(previous.text.toLowerCase()) && plain.trimStart().startsWith('.')) return false
  return true
}

/**
 * Split text into the words a spelling checker looks at. Everything that is not a plain word
 * (a price, a time, a web address, "+2R") comes back as a protected token, so sentences and
 * neighbours can still be worked out around it.
 */
export function tokenize(text: string, isKnownWhole: (word: string) => boolean = () => false): Token[] {
  const tokens: Token[] = []
  let sentence = -1
  let lineStartIndex = 0
  const push = (from: number, to: number, kind: TokenKind, hyphenPart = false): void => {
    const previous = tokens[tokens.length - 1] ?? null
    const gap = text.slice(previous ? previous.to : 0, from)
    if (!previous || gap.includes('\n')) lineStartIndex = tokens.length
    const previousIsLineStart = previous !== null && tokens.length - 1 === lineStartIndex
    const sentenceStart = isSentenceGap(gap, previous, previousIsLineStart)
    if (sentenceStart) sentence++
    tokens.push({ from, to, text: text.slice(from, to), kind, sentenceStart, sentence: Math.max(0, sentence), hyphenPart })
  }

  for (const match of text.matchAll(CHUNK_RE)) {
    const raw = match[0]
    const start = match.index
    const lead = LEAD_PUNCT.exec(raw)?.[0].length ?? 0
    const afterLead = raw.slice(lead)
    if (URL_RE.test(afterLead) || EMAIL_RE.test(afterLead.replace(TRAIL_PUNCT, '')) || DOMAIN_RE.test(afterLead.replace(TRAIL_PUNCT, ''))) {
      const core = afterLead.replace(/[).,;:!?'"”’\]]+$/, '')
      push(start + lead, start + lead + core.length, 'protected')
      continue
    }
    let trail = TRAIL_PUNCT.exec(afterLead)?.[0].length ?? 0
    let core = afterLead.slice(0, afterLead.length - trail)
    // "ES1!" keeps its "!".
    if (trail > 0 && afterLead[core.length] === '!' && TICKER_RE.test(`${core}!`)) {
      core += '!'
      trail--
    }
    if (!core) continue
    const from = start + lead
    const lower = core.toLowerCase()
    if (/\d/.test(core)) {
      if (DIGIT_WORDS.has(lower)) push(from, from + core.length, 'word')
      else push(from, from + core.length, R_MULTIPLE_RE.test(core) ? 'rmultiple' : 'protected')
      continue
    }
    if (!LETTER.test(core) || CODE_LIKE.test(core.replace(/^&|&$/g, '')) || DOTTED_ABBREVIATION.test(core)) {
      if (LETTER.test(core)) push(from, from + core.length, 'protected')
      continue
    }
    splitWord(core, from, WORD_FIXES.has(lower), isKnownWhole, push)
  }
  return tokens
}

function splitWord(core: string, from: number, whole: boolean, isKnownWhole: (word: string) => boolean, push: (from: number, to: number, kind: TokenKind, hyphenPart?: boolean) => void): void {
  if (whole) return push(from, from + core.length, 'word')
  // "long/short", "time.then": each side is a word of its own.
  const separator = /[/.]/.exec(core)
  if (separator) {
    let offset = 0
    for (const part of core.split(/[/.]/)) {
      if (part && LETTER.test(part)) splitWord(part, from + offset, WORD_FIXES.has(part.toLowerCase()), isKnownWhole, push)
      offset += part.length + 1
    }
    return
  }
  if (core.includes('-') && !isKnownWhole(core)) {
    let offset = 0
    for (const part of core.split('-')) {
      if (part && LETTER.test(part)) push(from + offset, from + offset + part.length, 'word', true)
      offset += part.length + 1
    }
    return
  }
  push(from, from + core.length, 'word')
}

// ---------------------------------------------------------------- the checker

/** What the checker knows about where a word stands. */
export interface WordContext {
  sentenceStart: boolean
  /** The sentence mentions a price, a time, a timeframe or another trading term. */
  marketSentence: boolean
  /** The words right before and after it (lower case), when only spaces separate them. */
  previous: string | null
  next: string | null
}

export const NO_CONTEXT: WordContext = { sentenceStart: false, marketSentence: false, previous: null, next: null }

/** Words that make a sentence about the market, besides the trading terms. */
const MARKET_WORDS = new Set(['entry', 'entered', 'stop', 'stopped', 'target', 'liquidity', 'sweep', 'swept', 'displacement', 'bullish', 'bearish', 'long', 'short', 'killzone', 'killzones', 'session', 'premarket', 'imbalance', 'structure', 'futures', 'contracts', 'trade', 'traded', 'scalp', 'chart', 'candle'])
const AMBIGUOUS = new Set(AMBIGUOUS_TERMS.flatMap((t) => [t.toLowerCase(), `${t.toLowerCase()}s`]))
const PRICE_RE = /^[+\-−]?\$?\d{1,3}(?:[,.\s]\d{3})*(?:\.\d+)?$|^[+\-−]?\$?\d{3,}(?:\.\d+)?$/
const TIMEFRAME_RE = /^\d{1,3}(?:s|m|min|h|hr|d|w|mo)$|^[mhdw]\d{1,3}$/i

const POSSESSIVE_RE = /^(.+?)(['’]s)$/

/** QWERTY key positions, for "a neighbouring key was hit". */
const KEY_POSITIONS: ReadonlyMap<string, [number, number]> = (() => {
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
  const offsets = [0, 0.25, 0.75]
  const map = new Map<string, [number, number]>()
  rows.forEach((row, r) => [...row].forEach((ch, c) => map.set(ch, [c + offsets[r]!, r])))
  return map
})()

function adjacentKeys(a: string, b: string): boolean {
  const p = KEY_POSITIONS.get(a)
  const q = KEY_POSITIONS.get(b)
  if (!p || !q) return false
  return Math.hypot(p[0] - q[0], p[1] - q[1]) <= 1.3
}

/**
 * How likely a one-edit slip is, lower being likelier: two neighbours swapped, a letter left
 * out, or a doubled letter (1); a neighbouring key, or any other extra letter (2); any other
 * wrong letter (3). Left-out letters are the commonest typing slip ("enterd" is "entered",
 * not "enters").
 */
export function slipCost(typed: string, word: string): number {
  const a = typed.toLowerCase()
  const b = word.toLowerCase()
  if (a.length === b.length) {
    const diff: number[] = []
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i)
    if (diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!]) return 1
    if (diff.length === 1) return adjacentKeys(a[diff[0]!]!, b[diff[0]!]!) ? 2 : 3
    return 4
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a]
  if (longer.length - shorter.length !== 1) return 4
  let i = 0
  while (i < shorter.length && longer[i] === shorter[i]) i++
  if (longer.slice(i + 1) !== shorter.slice(i)) return 4
  const extra = longer[i]
  const doubled = extra === longer[i - 1] || extra === longer[i + 1]
  // The typed word is the shorter one: a letter was left out.
  if (doubled || a.length < b.length) return 1
  return 2
}

const ENDINGS = ['s', 'es', 'd', 'ed', 'ing', 'er', 'ers', 'ly']

/** A word with each common ending it could have taken away (a "-d" only after an "e": traded, not enterd). */
function stems(word: string): string[] {
  const out = [word]
  for (const ending of ENDINGS) {
    if (!word.endsWith(ending) || word.length - ending.length < 3) continue
    const stem = word.slice(0, -ending.length)
    if (ending === 'd' && !stem.endsWith('e')) continue
    out.push(stem)
  }
  return out
}

/**
 * The two words are one word with different endings ("overtrade" / "overtraded", "scalps" /
 * "scalped"): a typed word like that is most likely a real word the list lacks.
 */
export function isInflectionOf(a: string, b: string): boolean {
  const fromA = new Set(stems(a))
  return stems(b).some((stem) => fromA.has(stem))
}

interface Candidate {
  word: string
  distance: number
  boosted: boolean
  level: number
  cost: number
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return a.distance - b.distance || Number(b.boosted) - Number(a.boosted) || a.level - b.level || a.cost - b.cost
}

/**
 * Build the dictionary from the bundled word list, plus what the list leaves out: names of days
 * and months, contractions, and the trading vocabulary.
 */
export function buildDictionary(wordList: string): Dictionary {
  return addSpellingExtras(parseWordList(wordList))
}

/** What the English list leaves out, added to a dictionary read from it. */
export function addSpellingExtras(dictionary: Dictionary): Dictionary {
  for (const word of ENGLISH_EXTRAS) dictionary.add(word, word.includes("'") ? 10 : 20)
  for (const word of TRADING_WORDS) dictionary.add(word, 35)
  for (const term of CANONICAL_TERMS) if (!/\d/.test(term)) dictionary.add(term, 40)
  for (const word of CASUAL_WORDS) dictionary.add(word, 60)
  return dictionary
}

export class Speller {
  private readonly user: Set<string>
  private readonly userList: string[]
  private readonly guesses = new Map<string, string | null>()

  constructor(
    readonly dictionary: Dictionary | null,
    userWords: Iterable<string> = []
  ) {
    this.userList = [...userWords]
    this.user = new Set(this.userList.map((word) => word.toLowerCase()))
  }

  /** False until the word list has loaded: nothing is underlined or corrected before that. */
  get ready(): boolean {
    return this.dictionary !== null
  }

  isUserWord(word: string): boolean {
    return this.user.has(word.toLowerCase())
  }

  /** A hyphenated word the dictionary knows as a whole (e.g. "x-ray"). */
  knowsWhole = (word: string): boolean => this.dictionary?.level(word) !== undefined || lookupTerm(word) !== null

  /** Is this word fine as typed? */
  check(word: string, context: WordContext = NO_CONTEXT): boolean {
    if (!this.dictionary || !LETTER.test(word)) return true
    if (word.includes('’')) return this.check(word.replace(/’/g, "'"), context)
    const lower = word.toLowerCase()
    if (this.user.has(lower) || lookupTerm(word)) return true
    if (WORD_FIXES.has(lower)) return isAllCaps(word) && letterCount(word) <= 6
    const possessive = POSSESSIVE_RE.exec(word)
    if (possessive) return this.check(possessive[1]!, context)
    if (CASUAL_WORD_SET.has(lower)) return true
    if (isAllCaps(word) && letterCount(word) <= 6) return true
    if (hasInnerCapital(word)) return true
    if (lower === 'i') return word === 'I'
    const form = this.dictionary.form(lower)
    if (form !== undefined) return form === lower || word === form || isAllCaps(word)
    // Not a known word. A capitalised one mid-sentence is a name; at the start of a sentence
    // it is only flagged when it is clearly a misspelling ("Imapatient").
    if (isCapitalised(word) && !context.sentenceStart) return true
    if (isCapitalised(word) || isAllCaps(word)) return this.fix(word, context) === null
    return false
  }

  /** What autocorrect writes instead of `word`, or null to leave it as it is. */
  fix(word: string, context: WordContext = NO_CONTEXT): string | null {
    if (!LETTER.test(word)) return null
    // Typed with a curly apostrophe: looked up with a straight one, written back curly.
    if (word.includes('’')) return this.fix(word.replace(/’/g, "'"), context)?.replace(/'/g, '’') ?? null
    const lower = word.toLowerCase()
    if (this.user.has(lower)) return null
    const term = lookupTerm(word)
    if (term) {
      if (isAllCaps(word) && letterCount(word) > 1) return null
      if (term.canonical === word) return null
      if (AMBIGUOUS.has(lower) && !this.ambiguousIsTerm(lower, context)) return null
      return term.canonical
    }
    if (isAllCaps(word) && letterCount(word) <= 6) return null
    const fixed = WORD_FIXES.get(lower)
    if (fixed) return matchCase(word, fixed)
    const possessive = POSSESSIVE_RE.exec(word)
    if (possessive) {
      const base = this.fix(possessive[1]!, context)
      return base === null ? null : `${base}${possessive[2]}`
    }
    if (CASUAL_WORD_SET.has(lower)) return null
    if (lower === 'i') return word === 'I' ? null : 'I'
    if (hasInnerCapital(word) || !this.dictionary) return null
    const form = this.dictionary.form(lower)
    if (form !== undefined) return form === lower || word === form || isAllCaps(word) ? null : form
    if (isCapitalised(word) && !context.sentenceStart) return null
    if (letterCount(word) <= 2) return null
    const guess = this.guess(lower)
    return guess === null ? null : matchCase(word, guess)
  }

  /** Up to `limit` replacements for the right-click menu, best first. */
  suggest(word: string, context: WordContext = NO_CONTEXT, limit = 4): string[] {
    const out: string[] = []
    const add = (value: string | null): void => {
      if (value && value !== word && !out.includes(value) && out.length < limit) out.push(value)
    }
    add(this.fix(word, context))
    const lower = word.toLowerCase()
    if (!this.dictionary || !LETTER.test(word)) return out
    const possessive = POSSESSIVE_RE.exec(word)
    if (possessive) {
      for (const base of this.suggest(possessive[1]!, context, limit)) add(`${base}${possessive[2]}`)
      return out
    }
    for (const candidate of this.candidates(lower, letterCount(lower) >= 5 ? 2 : 1)) add(matchCase(word, candidate.word))
    return out
  }

  private ambiguousIsTerm(lower: string, context: WordContext): boolean {
    if (lower === 'am' || lower === 'pm') return (context.previous !== null && SESSION_NEIGHBOURS.has(context.previous)) || (context.next !== null && SESSION_NEIGHBOURS.has(context.next))
    return context.marketSentence
  }

  /** Every known word close enough to be meant, best first. */
  private candidates(lower: string, maxDistance: number): Candidate[] {
    if (!this.dictionary) return []
    const found: Candidate[] = this.dictionary
      .near(lower, maxDistance)
      .filter((near) => near.word.toLowerCase() !== lower && letterCount(near.word) >= 2)
      .map((near) => ({ word: near.word, distance: near.distance, level: near.level, boosted: TRADING_WORD_SET.has(near.word), cost: near.distance === 1 ? slipCost(lower, near.word) : 4 }))
    for (const own of this.userList) {
      const distance = editDistance(lower, own.toLowerCase())
      if (distance > 0 && distance <= maxDistance) found.push({ word: own, distance, level: 10, boosted: false, cost: distance === 1 ? slipCost(lower, own) : 4 })
    }
    return found.sort(compareCandidates)
  }

  /**
   * The one word a misspelling most likely stands for, or null when no candidate clearly
   * wins: within one edit, or two for words of five letters or more; closest first, then
   * trading words, then the more common word, then the likelier slip of the finger.
   */
  private guess(lower: string): string | null {
    const cached = this.guesses.get(lower)
    if (cached !== undefined) return cached
    if (this.guesses.size > 4000) this.guesses.clear()
    let result: string | null = null
    const letters = letterCount(lower)
    const ranked = this.candidates(lower, letters >= 5 ? 2 : 1).filter((c) => c.distance === 1 || c.word.charAt(0).toLowerCase() === lower.charAt(0))
    const [best, second] = ranked
    // The typed word is the candidate with another ending ("overtrade" for "overtraded"):
    // most likely a real word the list lacks, so it is left alone.
    if (best && isInflectionOf(lower, best.word.toLowerCase())) {
      this.guesses.set(lower, null)
      return null
    }
    if (best && (!second || compareCandidates(best, second) < 0)) {
      // Two edits away, a win on finger slips alone is not enough to be sure, and a
      // five-letter word with two letters replaced ("becuz") is too far gone to guess.
      const unsure =
        best.distance === 2 &&
        ((second !== undefined && second.distance === 2 && second.boosted === best.boosted && second.level === best.level) || (letters < 6 && best.word.length === lower.length))
      if (!unsure) result = best.word
    }
    this.guesses.set(lower, result)
    return result
  }
}

// ---------------------------------------------------------------- reading a whole text

export interface CheckedWord {
  token: Token
  context: WordContext
}

/** The word tokens of a text with what the checker needs to know about where each stands. */
export function wordsWithContext(text: string, speller: Speller): { tokens: Token[]; words: CheckedWord[] } {
  const tokens = tokenize(text, speller.knowsWhole)
  const market = new Set<number>()
  for (const token of tokens) {
    if (market.has(token.sentence)) continue
    const lower = token.text.toLowerCase()
    const signal =
      token.kind === 'rmultiple' ||
      (token.kind === 'protected' && (PRICE_RE.test(token.text) || TIME_RE.test(token.text) || TIMEFRAME_RE.test(token.text) || TICKER_RE.test(token.text))) ||
      (token.kind === 'word' && ((lookupTerm(token.text) !== null && !AMBIGUOUS.has(lower)) || MARKET_WORDS.has(lower)))
    if (signal) market.add(token.sentence)
  }
  const neighbour = (index: number, step: -1 | 1): string | null => {
    const here = tokens[index]!
    const other = tokens[index + step]
    if (!other) return null
    const gap = step === -1 ? text.slice(other.to, here.from) : text.slice(here.to, other.from)
    return /^ +$/.test(gap) ? other.text.toLowerCase() : null
  }
  const words: CheckedWord[] = []
  tokens.forEach((token, index) => {
    if (token.kind !== 'word') return
    words.push({ token, context: { sentenceStart: token.sentenceStart, marketSentence: market.has(token.sentence), previous: neighbour(index, -1), next: neighbour(index, 1) } })
  })
  return { tokens, words }
}

export interface TextRange {
  from: number
  to: number
}

/**
 * The words to underline in a text. `skip` leaves out ranges the checker must not judge
 * (link and code marks).
 */
export function findMisses(text: string, speller: Speller, skip?: (from: number, to: number) => boolean): TextRange[] {
  if (!speller.ready || !LETTER.test(text)) return []
  const misses: TextRange[] = []
  for (const { token, context } of wordsWithContext(text, speller).words) {
    if (skip?.(token.from, token.to)) continue
    if (!speller.check(token.text, context)) misses.push({ from: token.from, to: token.to })
  }
  return misses
}

/** The word at `offset` in a text (for the right-click menu), with its context, or null. */
export function wordAt(text: string, offset: number, speller: Speller): CheckedWord | null {
  for (const word of wordsWithContext(text, speller).words) if (word.token.from <= offset && offset <= word.token.to) return word
  return null
}
