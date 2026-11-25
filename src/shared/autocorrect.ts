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
 *    leave no doubt.
 *  - "new York" -> "New York".
 *
 * Nothing else is rewritten: no word order, no style, no "clever" grammar.
 */
import { isAllCaps, matchCase, wordsWithContext, type Speller, type Token } from './spelling'
import { lookupTerm } from './tradingTerms'
import { IRREGULAR_PAST, ITS_BEFORE, LOSE_AFTER, MODAL_ADVERBS, MODALS, NEVER_DOUBLED, TOO_AFTER, TOO_AFTER_BE, TOO_NEEDS_BE, TOO_NEEDS_CLAUSE_END, TOO_NEEDS_CONTEXT, TOO_WORDS } from './wordFixes'

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
    // "its not" -> "it's not"
    if (lower(a) === 'its' && ITS_BEFORE.has(lower(b))) a.out = matchCase(a.token.text, "it's")
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
