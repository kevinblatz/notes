/**
 * Autocorrect for one run of text (a paragraph, a heading, a title): every word the spelling
 * checker would underline is replaced by its correction when there is a confident one, R
 * multiples get their capital R (+2r -> +2R), and three small grammar slips are fixed where
 * there is no doubt:
 *
 *  - "re entered" -> "re-entered": "re" followed by a word that, joined to it, is a word.
 *  - "to early" -> "too early": only before words that cannot follow "to" as a verb, and for
 *    "many", "far", "small" and "big" only after words like "took" or "was" ("I took to many
 *    trades"; "this applies to many traders" is left alone).
 *  - "the the" -> "the": only for words that are never doubled on purpose.
 *  - "a IFVG" -> "an IFVG": before a trading code that starts with A, E, I or O, which takes
 *    "an" however it is read ("a FVG" is left: some read it "a fair value gap").
 *  - "should of waited" -> "should have waited": a modal, "of", then a past form.
 *  - "don't want to loose" -> "lose", and "its not" -> "it's not": only next to words that
 *    leave no doubt ("its just", "its a", "its hard to"; never "its range", "its wild swings").
 *  - "new York" -> "New York"; day and month names that are also words become names only as
 *    dates ("may 5th" -> "May 5th", "in march" -> "in March", "sat 11/22" -> "Sat 11/22").
 *
 * Nothing else is rewritten: no word order, no style, no "clever" grammar.
 */
import { isAllCaps, matchCase, wordsWithContext, type Speller, type Token } from './spelling'
import { lookupTerm } from './tradingTerms'
import {
  DATE_WORDS,
  IRREGULAR_PAST,
  ITS_ADJECTIVE_FOLLOWERS,
  ITS_BEFORE,
  ITS_BEFORE_ADJECTIVE,
  ITS_NOT_BEFORE,
  LOSE_AFTER,
  MODAL_ADVERBS,
  MODALS,
  MONTH_AFTER,
  MONTH_NAMES,
  NEVER_DOUBLED,
  TOO_AFTER,
  TOO_AFTER_BE,
  TOO_NEEDS_BE,
  TOO_NEEDS_CLAUSE_END,
  TOO_NEEDS_CONTEXT,
  TOO_WORDS
} from './wordFixes'

export interface TextEdit {
  from: number
  to: number
  insert: string
}

export interface Correction {
  edits: TextEdit[]
  /** Words changed (a merged "re-entered" or a dropped doubled word counts once). */
  fixed: number
}

/** After these, "to <word>" is the end of a clause: "re-entered to early and lost". */
const CLAUSE_WORDS = new Set(['and', 'but', 'so', 'then', 'or', 'lol', 'tho', 'though', 'because', 'bc', 'again', 'today', 'imo'])

interface Item {
  token: Token
  out: string
  locked: boolean
  /** Folded into the item before it ("re" + "entered"). */
  merged: boolean
  /** A doubled word that is dropped. */
  dropped: boolean
}

/**
 * The edits that autocorrect a text. `skip` names ranges that must stay exactly as they are
 * (text with a link or code mark); words touching them are neither checked nor changed.
 */
export function correctText(text: string, speller: Speller, skip?: (from: number, to: number) => boolean): Correction {
  const { tokens, words } = wordsWithContext(text, speller)
  const contexts = new Map(words.map((word) => [word.token, word.context]))
  const items: Item[] = tokens.map((token) => ({ token, out: token.text, locked: skip?.(token.from, token.to) ?? false, merged: false, dropped: false }))

  for (const item of items) {
    if (item.locked) continue
    if (item.token.kind === 'rmultiple') item.out = item.token.text.replace(/r$/, 'R')
    else if (item.token.kind === 'word') item.out = speller.fix(item.token.text, contexts.get(item.token)) ?? item.token.text
  }

  const spaced = (a: Item, b: Item): boolean => /^ +$/.test(text.slice(a.token.to, b.token.from))
  const isWord = (item: Item | undefined): item is Item => !!item && item.token.kind === 'word' && !item.locked && !item.merged && !item.dropped
  const lower = (item: Item): string => item.out.toLowerCase().replace(/’/g, "'")
  /** The word after `index` in the same sentence, with only spaces between, or null. */
  const nextWord = (index: number): Item | null => {
    const here = items[index]
    const next = items[index + 1]
    return here && isWord(next) && spaced(here, next) && next.token.sentence === here.token.sentence ? next : null
  }
  const isPastForm = (item: Item | null): boolean => !!item && (/(?:ed|en)$/.test(lower(item)) || IRREGULAR_PAST.has(lower(item)))
  const clauseEndsAfter = (index: number): boolean => {
    const item = items[index]!
    const rest = text.slice(item.token.to)
    if (/^\s*(?:$|[.,;:!?)\n—–])/.test(rest)) return true
    const next = items[index + 1]
    return !!next && next.token.kind === 'word' && spaced(item, next) && CLAUSE_WORDS.has(next.token.text.toLowerCase())
  }

  /** A description after "its" that ends there: "its hard.", "its crazy how", "its done lol". */
  const describesToTheEnd = (index: number): boolean => {
    const after = nextWord(index)
    return clauseEndsAfter(index) || (!!after && ITS_ADJECTIVE_FOLLOWERS.has(lower(after)))
  }
  /** The "its" before the word at `index` can only be "it is" (or "it has"). */
  const itsIsItIs = (index: number): boolean => {
    const word = items[index]!
    if (word.token.hyphenPart) return false
    const after = nextWord(index)
    const said = lower(word)
    if (after && ITS_NOT_BEFORE[said]?.has(lower(after))) return false
    if (said === 'very' || said === 'really') {
      if (!after || after.token.hyphenPart) return false
      return ITS_BEFORE.has(lower(after)) || describesToTheEnd(index + 1)
    }
    if (ITS_BEFORE.has(said)) return true
    return ITS_BEFORE_ADJECTIVE.has(said) && describesToTheEnd(index)
  }
  /** A day or month name that is also a word ("may", "march", "sat") used as a date: "may 5th", "in march", "sat 11/22". */
  const isDate = (index: number): boolean => {
    const word = items[index]!
    const said = lower(word)
    const rest = text.slice(word.token.to)
    // "may 5th", "march 20, 2026", "march 20." (not "may 2 more", "march 20 was")
    const dayAfter = /^ +(?:[1-9]|[12]\d|3[01])(?:(?:st|nd|rd|th)\b|(?=[.,;:!?)]|\s*$|\s*[–—-]|\s+(?:\d{4}|at|and|or|to|through|till|until)\b))/i.test(rest)
    const before = items[index - 1]
    const beforeText = before && before.token.sentence === word.token.sentence && /^ +$/.test(text.slice(before.token.to, word.token.from)) ? lower(before) : ''
    // ... "in may", "early march", "the 5th of may", "3rd march"
    if (said === 'may' || said === 'march') return dayAfter || MONTH_AFTER.has(beforeText) || /^(?:[1-9]|[12]\d|3[01])(?:st|nd|rd|th)$/.test(beforeText)
    // "sat 11/22", "wed nov 25"
    const next = items[index + 1]
    return /^ +\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(rest) || (!!next && next.token.kind === 'word' && /^ +$/.test(text.slice(word.token.to, next.token.from)) && MONTH_NAMES.has(next.token.text.toLowerCase()) && !DATE_WORDS[next.token.text.toLowerCase()])
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (!isWord(item) || item.token.hyphenPart) continue
    const date = DATE_WORDS[item.token.text]
    if (date && isDate(i)) item.out = date
  }

  for (let i = 0; i + 1 < items.length; i++) {
    const a = items[i]!
    const b = items[i + 1]!
    if (!isWord(a) || !isWord(b) || !spaced(a, b) || a.token.sentence !== b.token.sentence) continue
    // "re entered" -> "re-entered"
    if (lower(a) === 're' && !a.token.hyphenPart && !b.token.hyphenPart && speller.dictionary?.level(`re${lower(b)}`) !== undefined) {
      a.out = `${a.out}-${b.out}`
      b.merged = true
      continue
    }
    // "the the" -> "the"
    if (lower(a) === lower(b) && NEVER_DOUBLED.has(lower(a))) {
      b.dropped = true
      continue
    }
    // "to early" -> "too early"
    if (lower(a) === 'to' && TOO_WORDS.has(lower(b))) {
      const before = items[i - 1]
      const joined = isWord(before) && spaced(before, a)
      const afterVerb = joined && TOO_AFTER.has(lower(before))
      if (TOO_NEEDS_BE.has(lower(b))) {
        if (joined && TOO_AFTER_BE.has(lower(before)) && (!TOO_NEEDS_CLAUSE_END.has(lower(b)) || clauseEndsAfter(i + 1))) a.out = matchCase(a.token.text, 'too')
      } else if (!TOO_NEEDS_CONTEXT.has(lower(b)) || afterVerb || clauseEndsAfter(i + 1)) a.out = matchCase(a.token.text, 'too')
    }
    // "a IFVG" -> "an IFVG"
    if (lower(a) === 'a' && /^[AEIO]/.test(b.out) && isAllCaps(b.out) && lookupTerm(b.out) !== null) {
      a.out = a.token.text === 'A' && !a.token.sentenceStart ? 'AN' : matchCase(a.token.text, 'an')
    }
    // "should of waited" -> "should have waited"
    if (MODALS.has(lower(a)) && lower(b) === 'of') {
      const next = nextWord(i + 1)
      const verb = next && MODAL_ADVERBS.has(lower(next)) ? nextWord(i + 2) : next
      if (isPastForm(verb)) b.out = matchCase(b.token.text, 'have')
    }
    // "want to loose" -> "want to lose"
    if (lower(b) === 'loose' && LOSE_AFTER.has(lower(a))) b.out = matchCase(b.token.text, 'lose')
    // "its not" -> "it's not", "its hard to" -> "it's hard to"; never "its range", "its wild swings"
    if (lower(a) === 'its' && itsIsItIs(i + 1)) a.out = matchCase(a.token.text, "it's")
    // "new York" -> "New York"
    if (a.out === 'new' && b.out === 'York') a.out = 'New'
  }

  const edits: TextEdit[] = []
  let fixed = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.merged) continue
    if (item.dropped) {
      edits.push({ from: items[i - 1]!.token.to, to: item.token.to, insert: '' })
      fixed++
      continue
    }
    const next = items[i + 1]
    const to = next?.merged ? next.token.to : item.token.to
    if (item.out !== text.slice(item.token.from, to)) {
      edits.push({ from: item.token.from, to, insert: item.out })
      fixed++
    }
  }
  return { edits, fixed }
}

/** Apply edits (sorted, not overlapping) to a string. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += text.slice(cursor, edit.from) + edit.insert
    cursor = edit.to
  }
  return out + text.slice(cursor)
}
