/**
 * Organize: turn a note typed in a hurry into a tidy one, as a pure function on the note's
 * Tiptap JSON (the editor applies the result as one undoable step). It is deliberately light:
 * the note keeps its own shape and wording, it is only fixed and, where a thought wandered off
 * and came back, put back together.
 *
 *  1. Fix words (see autocorrect.ts), keeping bold, links, highlights and colours, in the text
 *     and in picture captions.
 *  2. Fix punctuation: a capital at the start of each sentence, single spaces, no space before a
 *     comma or full stop and one after it, a full stop at the end of a sentence-like line of a
 *     paragraph, a long run-on sentence without any punctuation split into sentences at a few
 *     strong cues ("... into the FVG then I waited ..." -> "... into the FVG. Then I waited ..."),
 *     a colon after a bare label ("lesson dont chase" -> "Lesson: don't chase") and a comma
 *     before its second instruction. Headings, list items, session log lines and code get none
 *     of the sentence fixes.
 *  3. Put a stray back: when the writing leaves a thought for a sentence or two and comes back
 *     to it ("price swept the low. ugh my neighbor is drilling again. anyway the displacement
 *     left a FVG ..."), the stray moves out, as a paragraph of its own, after the paragraph the
 *     writing came back in. Deliberately narrow (see `regroupPlan`): only close by, only with an
 *     explicit return ("anyway", "back to ...") or the same level named again, and never where
 *     a story is told in order (trade, reaction, trade). Everything else keeps its order and
 *     the user's paragraphs stay exactly as they were.
 *  4. Never moved, never merged: headings, lists, checklists, quotes, code, pictures and drawings,
 *     session log lines ("09:31:05 — text"), lines broken with Shift+Enter, and a label line
 *     ("Lessons:") with the lines under it. Each of them ends a run of paragraphs, so everything
 *     keeps its place around them, and so does a paragraph that starts a new day ("Tuesday ...").
 *
 * Nothing is ever lost or duplicated, and organizing an organized note changes nothing: a
 * regrouping is only made when a second look at the result would leave it as it is.
 */
import { applyTextEdits, correctText, type TextEdit } from './autocorrect'
import { capitalise, isAllCaps, isCapitalised, letterCount, TIME_RE, tokenize, type Speller, type Token } from './spelling'
import { lookupTerm, TERMS } from './tradingTerms'
import { IRREGULAR_PAST } from './wordFixes'
import type { RichDoc, RichMark, RichNode } from './types'

export type TopicKey = 'setup' | 'trades' | 'mindset' | 'lessons'
export const TOPICS: readonly TopicKey[] = ['setup', 'trades', 'mindset', 'lessons']

export interface Flash {
  /** Index path of the text block in the result's doc.content (e.g. [2, 0, 0]: third block, its first item, its paragraph). */
  path: number[]
  /** Offsets in that block's text (a line break counts as one character). */
  from: number
  to: number
}

export interface OrganizeResult {
  doc: RichDoc
  title: string | null
  /** Anything at all changed (words, punctuation, order, title). */
  changed: boolean
  /** Words corrected, in the text and the title. */
  wordsFixed: number
  /** Every fix: words, plus capitals, spacing and punctuation. */
  fixes: number
  /** Thoughts moved back to the topic they belong to. */
  regrouped: number
  /** Where the corrected words are in the result, to highlight them briefly. */
  flashes: Flash[]
}

export interface OrganizeOptions {
  /** 'auto' (the default) fixes and regroups; 'tidy' only fixes. */
  mode?: 'auto' | 'tidy'
}

// ---------------------------------------------------------------- text with marks, one character at a time

/** Marks the inserted text of a correction until the result is finished (never stored). */
const FIX_MARK = '__organizeFix'

interface Cell {
  ch: string
  marks: RichMark[] | undefined
  /** An inline node that is not text (a line break); its `ch` is "\n". */
  atom?: RichNode
}

/**
 * One cell per UTF-16 code unit, the unit every text offset here counts in (an emoji is two
 * cells, its two halves joined back together by fromCells), so a cell index is a text offset.
 */
function toCells(nodes: RichNode[] | undefined): Cell[] {
  const cells: Cell[] = []
  for (const node of nodes ?? []) {
    if (node.type === 'text') {
      const value = node.text ?? ''
      for (let i = 0; i < value.length; i++) cells.push({ ch: value[i]!, marks: node.marks })
    } else cells.push({ ch: node.type === 'hardBreak' ? '\n' : '￼', marks: undefined, atom: node })
  }
  return cells
}

const cellsText = (cells: Cell[]): string => cells.map((cell) => cell.ch).join('')

function fromCells(cells: Cell[]): RichNode[] {
  const out: RichNode[] = []
  let text = ''
  let marks: RichMark[] | undefined
  const flush = (): void => {
    if (!text) return
    out.push(marks && marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text })
    text = ''
  }
  for (const cell of cells) {
    if (cell.atom) {
      flush()
      out.push(cell.atom)
      continue
    }
    if (text && !sameMarks(cell.marks, marks)) flush()
    if (!text) marks = cell.marks
    text += cell.ch
  }
  flush()
  return out
}

function sameMarks(a: RichMark[] | undefined, b: RichMark[] | undefined): boolean {
  if (a === b) return true
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}

const LOCKED_MARKS = new Set(['link', 'code'])
const isLockedCell = (cell: Cell | undefined): boolean => !!cell && (!!cell.atom || !!cell.marks?.some((mark) => LOCKED_MARKS.has(mark.type)))

/** Ranges that must not be touched: text with a link or code mark. */
function lockedChecker(cells: Cell[]): (from: number, to: number) => boolean {
  return (from, to) => {
    for (let i = from; i < to; i++) if (cells[i] && !cells[i]!.atom && isLockedCell(cells[i])) return true
    return false
  }
}

const withFixMark = new WeakMap<object, RichMark[]>()
const NO_MARKS: RichMark[] = []
function fixMarks(marks: RichMark[] | undefined): RichMark[] {
  const key = marks ?? NO_MARKS
  let found = withFixMark.get(key)
  if (!found) {
    found = [...key, { type: FIX_MARK }]
    withFixMark.set(key, found)
  }
  return found
}

/**
 * Apply edits to cells. Replacement text takes the marks of the first character it replaces;
 * inserted text takes those of the character before it, minus links and code.
 */
function editCells(cells: Cell[], edits: readonly TextEdit[], flash: boolean): Cell[] {
  if (edits.length === 0) return cells
  const out: Cell[] = []
  let cursor = 0
  for (const edit of edits) {
    // An edit never swallows a line break or a picture; drop any that would.
    if (cells.slice(edit.from, edit.to).some((cell) => cell.atom)) continue
    if (edit.from < cursor) continue
    out.push(...cells.slice(cursor, edit.from))
    let marks: RichMark[] | undefined
    if (edit.to > edit.from) marks = cells[edit.from]!.marks
    else {
      const before = cells[edit.from - 1]
      const source = before && !before.atom ? before.marks : cells[edit.from] && !cells[edit.from]!.atom ? cells[edit.from]!.marks : undefined
      marks = source?.filter((mark) => !LOCKED_MARKS.has(mark.type) && mark.type !== FIX_MARK)
    }
    if (flash && edit.insert) marks = fixMarks(marks?.filter((mark) => mark.type !== FIX_MARK))
    for (let i = 0; i < edit.insert.length; i++) out.push({ ch: edit.insert[i]!, marks })
    cursor = edit.to
  }
  out.push(...cells.slice(cursor))
  return out
}

// ---------------------------------------------------------------- fixing punctuation

/** What has been fixed so far. */
interface Counter {
  words: number
  /** Capitals, spacing and punctuation. */
  tidy: number
}

/** Run a pass that computes edits from the current text, then apply them. */
function pass(cells: Cell[], compute: (text: string, locked: (from: number, to: number) => boolean) => TextEdit[], counter?: Counter): Cell[] {
  const edits = compute(cellsText(cells), lockedChecker(cells))
  if (edits.length === 0) return cells
  if (counter) counter.tidy += edits.length
  return editCells(cells, edits, false)
}

/** An edit replacing every match of a pattern, except where it touches locked text. */
function matchEdits(text: string, pattern: RegExp, insert: string, locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (const match of text.matchAll(pattern)) {
    const from = match.index
    const to = from + match[0].length
    if (match[0] === insert) continue
    if (to > from ? locked(from, to) : locked(Math.max(0, from - 1), Math.min(text.length, from + 1))) continue
    edits.push({ from, to, insert })
  }
  return edits
}

/**
 * Spacing: no spaces at the start or end of a line, single spaces between words, none before
 * , . ; : ! ? and one after a comma or semicolon that runs into the next word; a doubled
 * comma or semicolon made single.
 */
function tidySpacing(cells: Cell[], counter: Counter): Cell[] {
  cells = pass(cells, (text, locked) => [...matchEdits(text, /(?<=^|\n)[ \t]+/g, '', locked), ...matchEdits(text, /[ \t]+(?=\n|$)/g, '', locked)].sort((a, b) => a.from - b.from), counter)
  cells = pass(cells, (text, locked) => matchEdits(text, /[ \t]{2,}|\t/g, ' ', locked), counter)
  cells = pass(cells, (text, locked) => matchEdits(text, /(?<=\p{L}) +(?=[,;]|[.:!?](?:\s|$))/gu, '', locked), counter)
  cells = pass(cells, (text, locked) => matchEdits(text, /(?<=\p{L}[,;])(?=\p{L})/gu, ' ', locked), counter)
  // "ok,, so" -> "ok, so"
  cells = pass(cells, (text, locked) => [...matchEdits(text, /,{2,}/g, ',', locked), ...matchEdits(text, /;{2,}/g, ';', locked)].sort((a, b) => a.from - b.from), counter)
  return cells
}

/** A space after a full stop, ! or ? that runs straight into the next word: "time.Then". */
function sentenceSpaceEdits(text: string, tokens: Token[], locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i - 1]!
    const b = tokens[i]!
    const gap = text.slice(a.to, b.from)
    if (a.kind === 'word' && b.kind === 'word' && /^[.!?]$/.test(gap) && letterCount(a.text) >= 2 && letterCount(b.text) >= 2 && !locked(a.from, b.to)) {
      edits.push({ from: b.from, to: b.from, insert: ' ' })
    }
  }
  return edits
}

/** Words up to this commonness level are everyday English ("am", "spy"); "es" (the letter) is rarer. */
const COMMON_LEVEL = 35
/** Codes that are also English abbreviations: "dr" and "mt" starting a sentence are "Dr" and "Mt". */
const START_AS_WORD = new Set(['dr', 'drs', 'mt', 'mts'])

/**
 * A capital at the start of each sentence (and each log line after its time). A trading code
 * that is not an English word is written in its own capitals there: "es was slow" -> "ES was
 * slow", never "Es".
 */
function capitalEdits(tokens: Token[], speller: Speller, locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (const token of tokens) {
    if (!token.sentenceStart || token.kind !== 'word') continue
    const first = token.text.charAt(0)
    if (first === first.toUpperCase() || locked(token.from, token.to)) continue
    // Words with their own capitals (iPhone) and the user's own words stay as typed.
    if (/\p{Lu}/u.test(token.text.slice(1)) || speller.isUserWord(token.text)) continue
    const lower = token.text.toLowerCase()
    const term = TERMS.get(lower)
    // Codes that are also common words ("am", "spy") are capitalised as words.
    if (term && term.ambiguous && !START_AS_WORD.has(lower) && (speller.dictionary?.level(lower) ?? Infinity) > COMMON_LEVEL) {
      edits.push({ from: token.from, to: token.to, insert: term.canonical })
      continue
    }
    edits.push({ from: token.from, to: token.from + 1, insert: first.toUpperCase() })
  }
  return edits
}

const SENTENCE_END = /[\p{L}\p{N})\]"'”’%]$/u
const LOG_LINE = /^\d{1,2}:\d{2}(?::\d{2})?\s*[—–-]\s*/

/** Each line of a text (between line breaks), with where it starts. */
function linesOf(text: string): Array<{ start: number; line: string }> {
  const out: Array<{ start: number; line: string }> = []
  let start = 0
  for (const line of text.split('\n')) {
    out.push({ start, line })
    start += line.length + 1
  }
  return out
}

/** Lines (between line breaks) that read as a sentence but stop without punctuation get a full stop. */
function fullStopEdits(text: string, tokens: Token[], locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (const { start, line } of linesOf(text)) {
    // Session log lines ("09:31:05 — London high taken") are notes, not sentences.
    if (LOG_LINE.test(line)) continue
    const end = start + line.length
    const trimmedEnd = start + line.trimEnd().length
    const inLine = tokens.filter((token) => token.from >= start && token.to <= end)
    const words = inLine.filter((token) => token.kind === 'word')
    const last = inLine[inLine.length - 1]
    const sentenceLike =
      words.length >= 4 &&
      words.some((word) => !isCapitalised(word.text) && !isAllCaps(word.text)) &&
      SENTENCE_END.test(line.trimEnd()) &&
      !!last &&
      last.to === trimmedEnd &&
      !/^(?:https?:|www\.)|@/i.test(last.text) &&
      !locked(trimmedEnd - 1, trimmedEnd)
    if (sentenceLike) edits.push({ from: trimmedEnd, to: trimmedEnd, insert: '.' })
  }
  return edits
}

/** Words a run-on sentence may be split before ("... first push then wait ..."). */
const RUN_ON_BEFORE = new Set(['then', 'but', 'also', 'anyway', 'btw', 'so'])
const RUN_ON_AFTER = new Set(['lol', 'lmao', 'haha'])
const RUN_ON_MIN_WORDS = 20
const RUN_ON_MIN_PART = 5
/**
 * After these a cue is not the start of a new sentence: "swept at 11:15", "to form and then",
 * "the so-called". A sentence never ends on a preposition, a conjunction or an article.
 */
const WEAK_BEFORE = new Set([
  'at', 'by', 'before', 'after', 'around', 'until', 'til', 'till', 'from', 'to', 'since', 'and', 'or', 'but', 'if', 'the', 'a', 'an', 'of',
  'for', 'with', 'in', 'on', 'into', 'onto', 'than', 'about', 'near', 'like', 'as', 'when', 'once', 'because', 'bc', 'is', 'was', 'were',
  'be', 'just', 'even', 'only', 'not', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'that'
])
/** "so" starts a sentence only before these ("so the bias was right", "so I waited"), not in "so annoying". */
const SO_STARTS = new Set(['i', "i'm", 'im', 'we', 'you', 'they', 'he', 'she', 'the', 'it', "it's", 'its', 'that', 'this', 'there', 'now', 'then', 'my', 'price', 'market', 'today', 'overall', 'basically', 'yeah', 'ok', 'okay'])
const COMMON_VERBS = new Set(['is', 'was', 'are', 'were', 'has', 'have', 'had', 'gets', 'goes', 'takes', 'comes', 'runs', 'ran', 'broke', 'gave', 'saw', 'dumped', 'ripped', 'swept', 'tapped', 'wicked'])
/** A cue followed by a verb is inside its clause: "price then reversed", "I also took a short". */
const isVerbLike = (lower: string): boolean => /ed$/.test(lower) || IRREGULAR_PAST.has(lower) || COMMON_VERBS.has(lower)
/** A sentence that starts with these runs on to its "then": "if price takes the PDH then ...". */
const CONDITIONAL_STARTS = new Set(['if', 'when', 'once', 'whenever', 'unless', 'after', 'as', 'until', 'before'])
/** "stop 6096", "TP 6130": a trade's levels, set off with commas in a run-on sentence. */
const LEVEL_WORDS = new Set(['stop', 'sl', 'tp', 'tp1', 'tp2', 'tp3', 'target', 'tgt', 'targets'])
/** After a trade's levels, these carry on the same clause: no comma before them. */
const SAME_CLAUSE = new Set([...WEAK_BEFORE, ...RUN_ON_BEFORE, ...RUN_ON_AFTER, 'which', 'that', 'where', 'while', 'plus', 'then'])

/** The edit that ends a sentence just before `at` (the start of the next one), if one is needed. */
function sentenceBreakEdit(text: string, at: number, locked: (from: number, to: number) => boolean): TextEdit | null {
  let end = at
  while (end > 0 && /[ \t]/.test(text[end - 1]!)) end--
  if (end === 0 || locked(end - 1, end)) return null
  const before = text[end - 1]!
  if (/[.!?]/.test(before)) return null
  if (/[,;:]/.test(before)) return { from: end - 1, to: end, insert: '.' }
  return { from: end, to: end, insert: '.' }
}

/** Tokens grouped by the sentence they are in. */
function bySentence(tokens: Token[]): Token[][] {
  const out: Token[][] = []
  for (const token of tokens) {
    const last = out[out.length - 1]
    if (last && last[0]!.sentence === token.sentence) last.push(token)
    else out.push([token])
  }
  return out
}

/**
 * A long sentence written without any punctuation inside it (20 words or more) is split into
 * sentences, conservatively: only at "then", "but", "also", "so", "anyway", "btw" or a clock
 * time, or after "lol", where both parts are at least five words long, and never after a
 * preposition, a conjunction or an article ("swept at 11:15", "and then") or at the "then" of
 * an "if ... then". "and then" gets a comma instead. A trade's levels in it are set off with
 * commas: "took long at 6104 in the IFVG stop 6096 TP 6130 got stopped out" -> "took long at
 * 6104 in the IFVG, stop 6096, TP 6130, got stopped out".
 */
function runOnEdits(text: string, tokens: Token[], locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (const { start, line } of linesOf(text)) {
    if (LOG_LINE.test(line)) continue
    const end = start + line.length
    for (const inside of bySentence(tokens.filter((token) => token.from >= start && token.to <= end))) {
      // Any punctuation between its words: the writer punctuated it, it is left as it is.
      const punctuated = inside.some((token, index) => {
        const previous = inside[index - 1]
        if (!previous) return false
        const gap = text.slice(previous.to, token.from)
        return /[^\s]/.test(gap) && !(gap === '-' && previous.hyphenPart && token.hyphenPart)
      })
      if (punctuated) continue
      const total = inside.filter((token) => token.kind === 'word').length
      if (total < RUN_ON_MIN_WORDS) continue
      const lowerAt = (index: number): string => (inside[index]?.kind === 'word' ? inside[index]!.text.toLowerCase() : '')
      const conditional = CONDITIONAL_STARTS.has(lowerAt(inside.findIndex((token) => token.kind === 'word')))
      let wordsBefore = 0
      let seen = 0
      let pricesSeen = 0
      inside.forEach((token, index) => {
        const lower = token.text.toLowerCase()
        const remaining = total - seen
        const previous = lowerAt(index - 1)
        const isCue = (token.kind === 'word' && RUN_ON_BEFORE.has(lower)) || (token.kind === 'protected' && TIME_RE.test(token.text))
        const following = lowerAt(index + 1)
        const weak =
          WEAK_BEFORE.has(previous) ||
          (lower === 'then' && conditional) ||
          (lower === 'so' && !SO_STARTS.has(following.replace(/’/g, "'"))) ||
          ((lower === 'then' || lower === 'also' || lower === 'but') && isVerbLike(following))
        if (isCue && wordsBefore >= RUN_ON_MIN_PART && remaining >= RUN_ON_MIN_PART) {
          if (!weak) {
            const edit = sentenceBreakEdit(text, token.from, locked)
            if (edit) edits.push(edit)
            wordsBefore = 0
          } else if (lower === 'then' && previous === 'and' && !conditional && wordsBefore - 1 >= RUN_ON_MIN_PART) {
            // "... for the setup to form and then at 10:40 ..." -> "... to form, and then at 10:40 ..."
            const before = inside[index - 2]
            if (before && !locked(before.to - 1, before.to)) edits.push({ from: before.to, to: before.to, insert: ',' })
            wordsBefore = 0
          }
        }
        // A trade's levels: ", stop 6096, TP 6130," after an entry price.
        const next = inside[index + 1]
        if (token.kind === 'word' && LEVEL_WORDS.has(lower) && next?.kind === 'protected' && PRICE_RE.test(next.text) && pricesSeen > 0) {
          const prev = inside[index - 1]
          const afterLevel = prev && (PRICE_RE.test(prev.text) || (prev.kind === 'word' && lookupTerm(prev.text) !== null && !LEVEL_WORDS.has(prev.text.toLowerCase())))
          if (prev && afterLevel && !locked(prev.to - 1, prev.to)) edits.push({ from: prev.to, to: prev.to, insert: ',' })
          const after = inside[index + 2]
          const afterLower = after?.text.toLowerCase() ?? ''
          if (after && after.kind === 'word' && !LEVEL_WORDS.has(afterLower) && !SAME_CLAUSE.has(afterLower) && !locked(next.to - 1, next.to)) {
            edits.push({ from: next.to, to: next.to, insert: ',' })
          }
        }
        if (token.kind === 'protected' && PRICE_RE.test(token.text)) pricesSeen++
        if (token.kind === 'word') {
          wordsBefore++
          seen++
        }
        if (token.kind === 'word' && RUN_ON_AFTER.has(lower) && next && wordsBefore >= RUN_ON_MIN_PART && total - seen >= RUN_ON_MIN_PART) {
          const edit = sentenceBreakEdit(text, next.from, locked)
          if (edit) edits.push(edit)
          wordsBefore = 0
        }
      })
    }
  }
  // One edit per place (a comma and a full stop at the same spot: the full stop).
  const sorted = edits.sort((a, b) => a.from - b.from || (a.insert === '.' ? -1 : 1))
  return sorted.filter((edit, index) => index === 0 || edit.from !== sorted[index - 1]!.from)
}

/** A statement that starts like an instruction to oneself is a rule. */
const IMPERATIVE_STARTS = new Set(["don't", 'dont', 'never', 'always', 'wait', 'only', 'stop', 'avoid', 'trust', 'remember', 'stay', 'keep', 'no', 'do', 'be', 'let'])
/** Labels written without a colon before an instruction: "lesson dont chase" -> "Lesson: don't chase". */
const BARE_LABELS = new Set(['lesson', 'lessons', 'rule', 'rules', 'reminder', 'takeaway'])

/** A second instruction after a label: "Lesson: don't chase the first push, wait for MSS". */
const SECOND_INSTRUCTIONS = new Set(['wait', "don't", 'dont', 'never', 'always', 'take', 'trust', 'avoid', 'walk', 'let'])
/** Words after which a second instruction is not one: "need to wait", "and wait", "just wait". */
const INSTRUCTION_JOINED = new Set(['to', 'and', 'or', 'but', 'then', 'i', 'you', 'we', 'just', 'not', 'will', 'would', 'should', 'can', 'could', 'must', 'gonna', 'wanna', 'the', 'a', 'an', 'for', 'of', 'in', 'on', 'at', 'with', 'never', 'always', "don't", 'dont', 'only'])

/**
 * A label sentence with two instructions and no punctuation between them gets a comma before
 * the second: "Lesson: don't chase the first push wait for MSS" -> "... first push, wait for MSS".
 */
function labelCommaEdits(text: string, tokens: Token[], locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (const sentence of bySentence(tokens)) {
    const [label, first] = sentence
    if (!label || !first || label.kind !== 'word' || first.kind !== 'word' || !BARE_LABELS.has(label.text.toLowerCase())) continue
    if (!/^:\s+$/.test(text.slice(label.to, first.from)) || !IMPERATIVE_STARTS.has(first.text.toLowerCase().replace(/’/g, "'"))) continue
    if (sentence.slice(2).some((token, index) => /[^\s]/.test(text.slice(sentence[index + 1]!.to, token.from)))) continue
    for (let i = 4; i < sentence.length; i++) {
      const word = sentence[i]!
      const before = sentence[i - 1]!
      if (word.kind !== 'word' || !SECOND_INSTRUCTIONS.has(word.text.toLowerCase().replace(/’/g, "'"))) continue
      if (before.kind !== 'word' || INSTRUCTION_JOINED.has(before.text.toLowerCase().replace(/’/g, "'")) || locked(before.to - 1, before.to)) break
      edits.push({ from: before.to, to: before.to, insert: ',' })
      break
    }
  }
  return edits
}

function labelColonEdits(text: string, tokens: Token[], locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (let i = 0; i + 1 < tokens.length; i++) {
    const label = tokens[i]!
    const next = tokens[i + 1]!
    if (!label.sentenceStart || label.kind !== 'word' || next.kind !== 'word' || !BARE_LABELS.has(label.text.toLowerCase())) continue
    if (!/^ +$/.test(text.slice(label.to, next.from)) || !IMPERATIVE_STARTS.has(next.text.toLowerCase().replace(/’/g, "'"))) continue
    if (!locked(label.from, next.to)) edits.push({ from: label.to, to: label.to, insert: ':' })
  }
  return edits
}

/**
 * Fix one block's inline content. A paragraph (not in a list) also gets the sentence fixes:
 * run-on lines split, label colons, full stops.
 */
function polishInline(nodes: RichNode[] | undefined, speller: Speller, sentences: boolean, counter: Counter): Cell[] {
  let cells = toCells(nodes)
  const correction = correctText(cellsText(cells), speller, lockedChecker(cells))
  counter.words += correction.fixed
  cells = editCells(cells, correction.edits, true)
  cells = tidySpacing(cells, counter)
  cells = pass(cells, (text, locked) => sentenceSpaceEdits(text, tokenize(text), locked), counter)
  if (sentences) {
    cells = pass(cells, (text, locked) => runOnEdits(text, tokenize(text), locked), counter)
    cells = pass(cells, (text, locked) => labelColonEdits(text, tokenize(text), locked), counter)
    cells = pass(cells, (text, locked) => labelCommaEdits(text, tokenize(text), locked), counter)
  }
  cells = pass(cells, (text, locked) => capitalEdits(tokenize(text), speller, locked), counter)
  if (sentences) cells = pass(cells, (text, locked) => fullStopEdits(text, tokenize(text), locked), counter)
  return cells
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading'])

/** A picture's caption gets its words fixed (nothing else: it is a label, not a sentence). */
function fixCaption(node: RichNode, speller: Speller, counter: Counter): RichNode {
  const caption = node.attrs?.caption
  if (typeof caption !== 'string' || !caption.trim()) return node
  const correction = correctText(caption, speller)
  if (correction.fixed === 0) return node
  counter.words += correction.fixed
  return { ...node, attrs: { ...node.attrs, caption: applyTextEdits(caption, correction.edits) } }
}

/** Fix every text block and picture caption. Code is left exactly as it is. */
function fixNodes(nodes: RichNode[] | undefined, speller: Speller, inList: boolean, counter: Counter): RichNode[] | undefined {
  return nodes?.map((node) => {
    if (node.type === 'codeBlock') return node
    if (node.type === 'noteImage') return fixCaption(node, speller, counter)
    if (TEXT_BLOCKS.has(node.type)) return withInline(node, fromCells(polishInline(node.content, speller, node.type === 'paragraph' && !inList, counter)))
    if (!node.content) return node
    return { ...node, content: fixNodes(node.content, speller, inList || node.type === 'listItem' || node.type === 'taskItem', counter) }
  })
}

function withInline(node: RichNode, content: RichNode[]): RichNode {
  const next: RichNode = { ...node }
  if (content.length > 0) next.content = content
  else delete next.content
  return next
}

// ---------------------------------------------------------------- what a sentence is about

type Weights = Record<string, number>
type Source = 'plan' | 'market' | 'trades' | 'mindset' | 'lessons'
const TOPIC_OF: Record<Source, TopicKey> = { plan: 'setup', market: 'setup', trades: 'trades', mindset: 'mindset', lessons: 'lessons' }

/** Words that say what a sentence is about. Plan and market words both count for the setup. */
const KEYWORDS: Record<Source, Weights> = {
  plan: {
    bias: 3, plan: 3, planning: 3, plans: 2, expecting: 2, expect: 2, expected: 1, narrative: 2, scenario: 2, scenarios: 2, objective: 2,
    premarket: 1, htf: 1, daily: 1, weekly: 1, dol: 2, bullish: 1, bearish: 1, news: 1.5, fomc: 1.5, cpi: 1.5, nfp: 1.5, ppi: 1.5,
    tomorrow: 1, watchlist: 2, idea: 1, ideas: 1, hoping: 1, anticipate: 2, anticipating: 2, prepared: 1, prep: 2
  },
  market: {
    liquidity: 1.5, swept: 1.5, sweep: 1.5, sweeps: 1.5, raid: 1.5, raided: 1.5, taken: 1, high: 1, highs: 1, low: 1, lows: 1, eqh: 1.5, eql: 1.5,
    pdh: 1, pdl: 1, pwh: 1, pwl: 1, onh: 1, onl: 1, nwog: 1.5, ndog: 1.5, fvg: 1.5, fvgs: 1.5, ifvg: 1, ifvgs: 1, bisi: 1.5, sibi: 1.5, bpr: 1.5,
    ob: 1, bb: 1, mb: 1, rb: 1, vi: 1, ote: 1, smt: 1.5, mss: 1, bos: 1.5, choch: 1.5, cisd: 1.5, premium: 1, discount: 1, equilibrium: 1,
    imbalance: 1, displacement: 1.5, rebalance: 1, rebalanced: 1, mitigation: 1, mitigated: 1, consolidation: 1, consolidating: 1,
    expansion: 1, retracement: 1, retraced: 1, reversal: 1, range: 1, accumulation: 1, manipulation: 1, distribution: 1, amd: 1,
    po3: 1, killzone: 1.5, kz: 1, judas: 1.5, unicorn: 1.5, macro: 1, asia: 1.5, asian: 1.5, london: 1.5, ny: 1, session: 1, open: 1,
    opened: 1.5, chop: 1.5, choppy: 1.5, trend: 1, trending: 1, gap: 1, wick: 1, wicked: 1, filled: 0.5, respected: 1.5, rejected: 1,
    rejection: 1, volume: 1, dxy: 1.5, spx: 1, structure: 1.5, delivery: 1, draw: 1, ssl: 1.5, bsl: 1.5, erl: 1, irl: 1, pda: 1, vwap: 1,
    rth: 1, market: 0.5, price: 0.5, unswept: 1.5, untapped: 1.5, ran: 1, run: 0.5, broke: 1, held: 1, tapped: 1.5, reversed: 1
  },
  trades: {
    entered: 2, entry: 2, entries: 2, long: 1, short: 1, longs: 1.5, shorts: 1.5, stop: 1.5, stopped: 2, sl: 1.5, tp: 1.5, tp1: 1.5, tp2: 1.5,
    target: 1, exit: 2, exited: 2, closed: 1, partials: 2, partial: 1.5, runner: 2, breakeven: 2, contracts: 2, contract: 1, size: 1,
    sized: 1, risk: 1, risked: 2, pnl: 2, profit: 2, loss: 2, lost: 1.5, won: 1, winner: 2, loser: 2, win: 1, scalp: 2, scalped: 2, trade: 2,
    trades: 1.5, traded: 2, position: 1, fill: 1, filled: 0.5, bought: 1.5, sold: 1.5, took: 1, reentered: 2
  },
  mindset: {
    felt: 2, feel: 2, feeling: 2, feelings: 2, emotional: 2, emotions: 2, emotion: 2, fomo: 2.5, fear: 2, scared: 2, greedy: 2, greed: 2,
    impatient: 2.5, impatience: 2.5, patience: 2, patient: 2, calm: 2, anxious: 2, anxiety: 2, nervous: 2, frustrated: 2, frustrating: 2,
    angry: 2, mad: 1, revenge: 2, tilt: 2, tilted: 2, confident: 2, confidence: 2, discipline: 1.5, disciplined: 1.5, focus: 1.5,
    focused: 1.5, tired: 2, sleep: 1.5, mindset: 3, mental: 2, mentally: 2, psychology: 2, stressed: 2, stress: 2, overtrade: 2, overtrading: 2,
    overtraded: 2, bored: 2, boredom: 2, happy: 2, proud: 2, ego: 2, hesitated: 2, hesitation: 2, doubt: 2, trust: 1, process: 1,
    grateful: 2, motivated: 2, mood: 2, energy: 1, rushed: 1.5, rushing: 1.5, chasing: 1, chased: 1, emotionally: 2, upset: 2, excited: 2
  },
  lessons: {
    lesson: 3, lessons: 3, learned: 2.5, learnt: 2.5, learn: 1.5, rule: 3, rules: 3, never: 1.5, always: 1.5, should: 1.5, "shouldn't": 1.5,
    "should've": 2, must: 1.5, remember: 2, reminder: 2.5, avoid: 1.5, mistake: 2, mistakes: 2, takeaway: 3, "don't": 1, wait: 1
  }
}

const PHRASES: Array<[RegExp, Source, number]> = [
  [/\b(?:took|went|got) (?:a )?(?:long|short)\b/i, 'trades', 3],
  [/\bstopped out\b/i, 'trades', 3],
  [/\btrust the process\b/i, 'mindset', 3],
  [/\b(?:looking|look|waiting) for\b/i, 'plan', 1],
  [/\bwant(?:ed)? to see\b/i, 'plan', 4],
  [/\b(?:plan|bias|idea|game plan) for (?:today|tomorrow|the day|the session|this week|next week)\b/i, 'plan', 4],
  [/^(?:\d{1,2}:\d{2}(?::\d{2})?\s*[—–-]\s*)?if\b/i, 'plan', 2],
  [/\bdraw on liquidity\b/i, 'plan', 2],
  [/\bgame plan\b/i, 'plan', 3],
  [/\b(?:silver bullet|turtle soup|judas swing|order block|breaker block|fair value gap|power of three)\b/i, 'market', 1.5],
  [/\bnext time\b/i, 'lessons', 2.5],
  [/\bnote to self\b/i, 'lessons', 3],
  [/\bneed to\b/i, 'lessons', 1.5],
  [/\bshould (?:have|of)\b/i, 'lessons', 2],
  [/\bdo not\b/i, 'lessons', 1.5],
  [/\bonly take\b/i, 'lessons', 2],
  [/\bwait for\b/i, 'lessons', 1.5],
  [/\bin the zone\b/i, 'mindset', 2]
]

/** Labels that name the topic of the sentence they start: "Lesson: don't chase", "bias: bearish". */
const LABELS: Record<string, TopicKey> = {
  lesson: 'lessons', lessons: 'lessons', rule: 'lessons', rules: 'lessons', reminder: 'lessons', takeaway: 'lessons', takeaways: 'lessons',
  plan: 'setup', bias: 'setup', setup: 'setup', mindset: 'mindset', psychology: 'mindset', trade: 'trades', trades: 'trades'
}

/** A sentence is clearly about a topic when it scores at least this, and this much more than any other. */
const CLEAR_SCORE = 2
const CLEAR_MARGIN = 1

export interface StatementTopic {
  /** What the sentence is clearly about, or null when that is not clear. */
  topic: TopicKey | null
  /** A label at its start named the topic. */
  labelled: boolean
  scores: Record<TopicKey, number>
}

export function classifyStatement(text: string): StatementTopic {
  const scores: Record<TopicKey, number> = { setup: 0, trades: 0, mindset: 0, lessons: 0 }
  const stamp = LOG_LINE.exec(text)?.[0].length ?? 0
  const body = text.slice(stamp)
  const label = /^([A-Za-z]+)\s*[:—–-]\s*/.exec(body)
  const named = label ? LABELS[label[1]!.toLowerCase()] : undefined
  if (named) return { topic: named, labelled: true, scores }

  const tokens = tokenize(body)
  let prices = 0
  for (const token of tokens) {
    const lower = token.text.toLowerCase().replace(/’/g, "'")
    if (token.kind === 'rmultiple') scores.trades += 2
    else if (token.kind === 'protected' && TIME_RE.test(token.text) && token !== tokens[0]) scores.setup += 0.5
    else if (token.kind === 'protected') {
      if (/^[+\-−]?\$/.test(token.text)) scores.trades += 1.5
      else if (PRICE_RE.test(token.text) && prices < 4) {
        scores.trades += 0.5
        prices++
      }
    } else {
      const key = lower.replace(/'s$/, '')
      for (const source of Object.keys(KEYWORDS) as Source[]) scores[TOPIC_OF[source]] += KEYWORDS[source][key] ?? KEYWORDS[source][lower] ?? 0
    }
  }
  for (const [pattern, source, weight] of PHRASES) if (pattern.test(body)) scores[TOPIC_OF[source]] += weight
  const firstWord = tokens.find((token) => token.kind === 'word')?.text.toLowerCase().replace(/’/g, "'")
  if (firstWord && IMPERATIVE_STARTS.has(firstWord)) scores.lessons += 2

  const ranked = [...TOPICS].sort((a, b) => scores[b] - scores[a])
  const best = ranked[0]!
  const second = ranked[1]!
  const clear = scores[best] >= CLEAR_SCORE && scores[best] - scores[second] >= CLEAR_MARGIN
  return { topic: clear ? best : null, labelled: false, scores }
}

const PRICE_RE = /^\d{4,}(?:\.\d+)?$|^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/

/** ICT terms specific enough that two sentences naming the same one are about the same thing. */
const SPECIFIC_TERMS = new Set([
  'nwog', 'ndog', 'fvg', 'ifvg', 'bisi', 'sibi', 'bpr', 'ob', 'bb', 'mb', 'rb', 'vi', 'ote', 'smt', 'mss', 'bos', 'choch', 'cisd', 'pdh', 'pdl',
  'pwh', 'pwl', 'pmh', 'pml', 'pda', 'eqh', 'eql', 'erl', 'irl', 'dol', 'ssl', 'bsl', 'onh', 'onl', 'ibh', 'ibl', 'hod', 'lod', 'poc', 'vah', 'lvn', 'hvn'
])

/** The specific ICT terms and the prices a sentence names. */
export function sharedKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const token of tokenize(text)) {
    if (token.kind === 'protected' && PRICE_RE.test(token.text)) keys.add(`price:${token.text.replace(/,/g, '')}`)
    if (token.kind !== 'word') continue
    const word = token.text.replace(/['’]s$/, '')
    const term = lookupTerm(word)
    if (!term || (term.ambiguous && word !== word.toUpperCase())) continue
    let key = term.canonical.toLowerCase()
    if (!SPECIFIC_TERMS.has(key) && key.endsWith('s') && SPECIFIC_TERMS.has(key.slice(0, -1))) key = key.slice(0, -1)
    if (SPECIFIC_TERMS.has(key)) keys.add(key)
  }
  return keys
}

/**
 * The topic of each sentence, in order. A label decides; a sentence that names the same ICT term
 * or price as the one before it, or has no clear topic, goes with the one before it. Sentences
 * at the start with no clear topic go with the first one that has one. Null for all when none has.
 */
export function topicsOf(texts: readonly string[]): Array<TopicKey | null> {
  const topics: Array<TopicKey | null> = []
  let previousKeys = new Set<string>()
  texts.forEach((text, index) => {
    const classified = classifyStatement(text)
    const keys = sharedKeys(text)
    const previous = index > 0 ? topics[index - 1]! : null
    const continues = [...keys].some((key) => previousKeys.has(key))
    if (classified.labelled) topics.push(classified.topic)
    else if (continues && previous) topics.push(previous)
    else topics.push(classified.topic ?? previous)
    previousKeys = keys
  })
  const first = topics.find((topic) => topic !== null) ?? null
  return topics.map((topic) => topic ?? first)
}

// ---------------------------------------------------------------- strays

/**
 * The three threads a journal entry runs on. A thought strays when it leaves one for another
 * and comes back: the setup and the trades are one thread (the market), feelings another.
 */
type Thread = 'market' | 'mind' | 'lessons'
const THREAD_OF: Record<TopicKey, Thread> = { setup: 'market', trades: 'market', mindset: 'mind', lessons: 'lessons' }
const threadOf = (topic: TopicKey | null): Thread | null => (topic === null ? null : THREAD_OF[topic])

/** "Anyway ...", "ok back to the trade ...": the writing comes back from a stray. */
const RETURN_CUE = /^(?:(?:ok(?:ay)?|so|but|and|well|yeah)[,]?\s+)*(?:any ?ways?\b|(?:getting |going |coming )?back to\b(?! back)|as i was saying\b|where was i\b)/i
/**
 * A sentence that starts like this continues the one before it ("After that I felt anxious",
 * "Then it ran", "Second entry worked"), so it is never separated from it.
 */
const REFERENCE_OPENER =
  /^(?:after|afterwards|then|still|so|but|and|or|plus|also|it|its|it's|that|that's|this|these|those|they|they're|he|she|there|again|which|because|bc|since|though|tho|yet|until|till|til|before|now|same|even|instead|otherwise|meanwhile|cause|cuz)\b/i
const REFERENCE_SOON = /^(?:\S+\s+){0,2}(?:another|second|third|2nd|3rd|again|same|next (?:trade|entry|one|long|short|setup))\b/i
/** A sentence that says what it follows from ("felt better after that"): it stays after it. */
const REFERENCE_ANYWHERE = /\b(?:after (?:that|this|it|those|the (?:loss|losses|win|trade|stop|first|second|last))|because of (?:that|it|this)|since then|that's why|which is why|from that)\b/i

/** Feelings about the trading itself (FOMO, impatient, angry): a reaction that belongs to the story, not a stray. */
const NOT_REACTIONS = ['felt', 'feel', 'feeling', 'feelings', 'tired', 'sleep', 'energy', 'focus', 'focused', 'mood', 'happy', 'grateful', 'motivated', 'excited', 'bored', 'boredom', 'stress', 'stressed', 'mental', 'mentally']
const REACTION_WORDS = new Set(Object.keys(KEYWORDS.mindset).filter((word) => !NOT_REACTIONS.includes(word)))

interface SentenceInfo {
  thread: Thread | null
  words: number
  keys: Set<string>
  returns: boolean
  opensWithReference: boolean
  refersBack: boolean
  /** Says nothing about the market or the trading at all ("my neighbor is drilling again"). */
  offMarket: boolean
}

function describe(text: string): SentenceInfo {
  const classified = classifyStatement(text)
  const keys = sharedKeys(text)
  const returns = RETURN_CUE.test(text)
  let offMarket = classified.scores.setup === 0 && classified.scores.trades === 0 && keys.size === 0
  for (const token of offMarket ? tokenize(text) : []) {
    // A price, a time or an R multiple; a trading term; a feeling about the trading.
    const lower = token.text.toLowerCase().replace(/’/g, "'")
    const term = token.kind === 'word' ? lookupTerm(token.text) : null
    if (token.kind !== 'word' || (term && (!term.ambiguous || isAllCaps(token.text))) || REACTION_WORDS.has(lower) || MARKET_WORDS_LOWER.has(lower)) {
      offMarket = false
      break
    }
  }
  return {
    thread: threadOf(classified.topic),
    words: tokenize(text).filter((token) => token.kind === 'word').length,
    keys,
    returns,
    opensWithReference: !returns && (REFERENCE_OPENER.test(text) || REFERENCE_SOON.test(text)),
    refersBack: REFERENCE_ANYWHERE.test(text),
    offMarket
  }
}

/** Words that tie a sentence to the market even when no keyword scores it. */
const MARKET_WORDS_LOWER = new Set(['price', 'market', 'chart', 'charts', 'trade', 'trades', 'trading', 'setup', 'setups', 'entry', 'level', 'levels', 'candle', 'candles', 'open', 'close', 'pdh', 'pdl'])

export interface StrayMove {
  /** The sentences that strayed (consecutive indexes). */
  stray: number[]
  /** The sentence the writing came back with. */
  returnsAt: number
  /** Came back with "anyway", "back to ..." rather than by naming the same level again. */
  cued: boolean
}

export interface RegroupPlan {
  moves: StrayMove[]
  /** Strays moved: each counts as one thought regrouped. */
  regrouped: number
}

/** The longest a stray may be, in sentences, and how many paragraphs back the thought it left may start. */
const MAX_STRAY = 2
const MAX_PARAGRAPH_SPAN = 2
/** "Ok." or "lol." is an interjection, not a stray thought. */
const MIN_STRAY_WORDS = 3

/**
 * Where the writing strayed and came back, or null when it did not. Deliberately narrow: one
 * or two sentences (B) between two parts of the same thread (A ... A), close together, where
 *
 *  - the stray is an aside about something else altogether, in one paragraph: it says nothing
 *    about the market and no feeling about the trading ("ugh my neighbor is drilling again");
 *  - the return is explicit ("anyway", "ok back to the trade") or names the same ICT term or
 *    price as the part it rejoins. With a cue, the stray may also lie a sentence or two
 *    before the return;
 *  - neither the stray nor the return starts by pointing back ("after that", "then", "it",
 *    "second entry"), and the stray does not say what it follows from ("felt better after
 *    that"): a story told in order (trade, reaction, trade, reaction) is not a stray.
 *
 * `paragraphs` gives each sentence's paragraph (by default all in one).
 */
export function regroupPlan(texts: readonly string[], paragraphs: readonly number[] = texts.map(() => 0)): RegroupPlan | null {
  const info = texts.map(describe)
  const smoothed = topicsOf(texts).map(threadOf)
  const moves: StrayMove[] = []
  let done = -1
  /** Is sentences[first..last] a stray that the writing comes back from at `k`? */
  const strayBefore = (k: number, first: number, last: number): boolean => {
    const back = info[k]!
    const anchor = first - 1
    if (anchor < 0 || first <= done) return false
    const thread = smoothed[anchor]
    // The thought it left: a sentence about something (one with no clear topic only when it
    // says something about the market, not a stray of its own).
    if (thread === null || (info[anchor]!.thread === null && info[anchor]!.offMarket)) return false
    if ((back.thread ?? (back.returns ? thread : null)) !== thread) return false
    if (paragraphs[k]! - paragraphs[anchor]! > MAX_PARAGRAPH_SPAN) return false
    // A stray is an aside about something else altogether, in one paragraph: a feeling about
    // the trading ("felt FOMO") or anything about the market is part of the story.
    const strays = info.slice(first, last + 1)
    if (paragraphs[first] !== paragraphs[last] || !strays.every((sentence) => sentence.offMarket && sentence.words >= MIN_STRAY_WORDS)) return false
    if (strays.some((sentence) => sentence.thread === thread || sentence.thread === 'lessons' || sentence.returns || sentence.refersBack) || strays[0]!.opensWithReference) return false
    // Sentences between the stray and the return carry on the thought it left, in the same paragraph.
    const between = info.slice(last + 1, k)
    if (between.some((sentence) => sentence.thread !== thread || sentence.returns) || between[0]?.opensWithReference) return false
    // ... and then the stray is clearly about something personal ("felt tired, didn't sleep").
    if (between.length > 0 && (paragraphs[first] !== paragraphs[k] || strays.some((sentence) => sentence.thread === null))) return false
    if (!back.returns) {
      if (between.length > 0 || thread !== 'market') return false
      // The stray is inside a paragraph of the thought it interrupts.
      if (paragraphs[first] !== paragraphs[anchor] && paragraphs[last] !== paragraphs[k]) return false
      const before = new Set<string>()
      for (let j = anchor; j >= 0 && j >= anchor - 2 && smoothed[j] === thread; j--) for (const key of info[j]!.keys) before.add(key)
      if (![...back.keys].some((key) => before.has(key))) return false
    }
    // The stray goes after the paragraph the return is in. The paragraph after that must not
    // point back at what was there, nor start by coming back from a stray (the stray would sit
    // right before a return again).
    const next = texts.findIndex((_, index) => index > k && paragraphs[index] !== paragraphs[k])
    return next === -1 || (!info[next]!.opensWithReference && !info[next]!.returns)
  }
  for (let k = 2; k < texts.length; k++) {
    const back = info[k]!
    if (!back.returns && back.opensWithReference) continue
    // With "anyway" the stray may lie a sentence or two before the return; without, right before it.
    const lastChoices = back.returns ? [k - 1, k - 2, k - 3] : [k - 1]
    search: for (const last of lastChoices) {
      for (let length = 1; length <= MAX_STRAY; length++) {
        const first = last - length + 1
        if (first < 1) break
        if (strayBefore(k, first, last)) {
          moves.push({ stray: Array.from({ length }, (_, i) => first + i), returnsAt: k, cued: back.returns })
          done = k
          break search
        }
      }
    }
  }
  return moves.length > 0 ? { moves, regrouped: moves.length } : null
}

// ---------------------------------------------------------------- regrouping

function trimCells(cells: Cell[]): Cell[] {
  let start = 0
  let end = cells.length
  while (start < end && !cells[start]!.atom && /\s/.test(cells[start]!.ch)) start++
  while (end > start && !cells[end - 1]!.atom && /\s/.test(cells[end - 1]!.ch)) end--
  return cells.slice(start, end)
}

interface RunSentence {
  cells: Cell[]
  /** Index of its paragraph in the run. */
  node: number
  /** Which written paragraph it is in, blank lines not counted. */
  paragraph: number
}

/** The sentences of some paragraphs (without line breaks), in order. */
function sentencesOf(paragraphs: readonly RichNode[]): RunSentence[] {
  const out: RunSentence[] = []
  let written = -1
  paragraphs.forEach((paragraph, node) => {
    const line = toCells(paragraph.content)
    const text = cellsText(line)
    if (!text.trim()) return
    written++
    const tokens = tokenize(text)
    let start = 0
    const push = (cells: Cell[]): void => {
      if (cells.length > 0) out.push({ cells, node, paragraph: written })
    }
    for (const token of tokens) {
      if (!token.sentenceStart || token === tokens[0]) continue
      let cut = token.from
      while (cut > start && !/\s/.test(text[cut - 1]!)) cut--
      push(trimCells(line.slice(start, cut)))
      start = cut
    }
    push(trimCells(line.slice(start)))
  })
  return out
}

/** A sentence that will be followed by another in its paragraph ends with a full stop. */
function endSentence(cells: Cell[], counter: Counter): Cell[] {
  if (/[.!?…]["'”’)\]]*$/.test(cellsText(cells))) return cells
  const last = cells[cells.length - 1]!
  counter.tidy++
  if (/[,;:]/.test(last.ch) && !isLockedCell(last)) return [...cells.slice(0, -1), { ch: '.', marks: last.marks }]
  const marks = last.marks?.filter((mark) => !LOCKED_MARKS.has(mark.type) && mark.type !== FIX_MARK)
  return [...cells, { ch: '.', marks: marks && marks.length > 0 ? marks : undefined }]
}

/** A paragraph like `like` (its attributes) holding these sentences. */
function paragraphOf(like: RichNode, sentences: RunSentence[], speller: Speller, counter: Counter): RichNode {
  const cells: Cell[] = []
  sentences.forEach((sentence, n) => {
    if (n > 0) cells.push({ ch: ' ', marks: undefined })
    cells.push(...endSentence(sentence.cells, counter))
  })
  const content = fromCells(pass(cells, (text, locked) => capitalEdits(tokenize(text), speller, locked), counter))
  const node: RichNode = { type: 'paragraph' }
  if (like.attrs) node.attrs = like.attrs
  if (content.length > 0) node.content = content
  return node
}

/**
 * Regroup one run of plain paragraphs: each stray goes, as a paragraph of its own, after the
 * paragraph the writing came back in; every other paragraph stays exactly as it was.
 */
function regroupRun(paragraphs: RichNode[], speller: Speller, counter: Counter): { nodes: RichNode[]; regrouped: number } {
  const local: Counter = { words: 0, tidy: 0 }
  let nodes = paragraphs
  let regrouped = 0
  // Moving a stray can leave another one plain to see (a sentence further back from the same
  // "anyway"): look again until nothing more moves, so Organize twice is Organize once.
  for (let pass = 0; pass < MAX_REGROUP_PASSES; pass++) {
    const sentences = sentencesOf(nodes)
    const plan = regroupPlan(
      sentences.map((sentence) => cellsText(sentence.cells)),
      sentences.map((sentence) => sentence.paragraph)
    )
    if (!plan) {
      counter.tidy += local.tidy
      return { nodes, regrouped }
    }
    nodes = moveStrays(nodes, sentences, plan.moves, speller, local)
    regrouped += plan.regrouped
  }
  return { nodes: paragraphs, regrouped: 0 }
}

const MAX_REGROUP_PASSES = 4

/** The paragraphs with these strays moved, each after the paragraph its thought came back in. */
function moveStrays(paragraphs: RichNode[], sentences: RunSentence[], moves: StrayMove[], speller: Speller, counter: Counter): RichNode[] {
  const moved = new Set(moves.flatMap((move) => move.stray))
  const after = new Map<number, number[][]>()
  for (const move of moves) {
    const node = sentences[move.returnsAt]!.node
    after.set(node, [...(after.get(node) ?? []), move.stray])
  }
  const nodes: RichNode[] = []
  paragraphs.forEach((paragraph, index) => {
    const own = sentences.filter((sentence) => sentence.node === index)
    const kept = own.filter((sentence) => !moved.has(sentences.indexOf(sentence)))
    if (kept.length === own.length) nodes.push(paragraph)
    else if (kept.length > 0) nodes.push(paragraphOf(paragraph, kept, speller, counter))
    for (const stray of after.get(index) ?? []) nodes.push(paragraphOf(paragraphs[sentences[stray[0]!]!.node]!, stray.map((i) => sentences[i]!), speller, counter))
  })
  return nodes
}

const isBlankParagraph = (node: RichNode): boolean => node.type === 'paragraph' && (node.content ?? []).every((child) => child.type === 'text' && !(child.text ?? '').trim())
/** A line that is only a label ("Lessons:"): it and the lines under it, up to a blank line, stay as they are. */
const LABEL_LINE = /^\s*(?:lessons?|rules?|reminders?|takeaways?|plan|bias|setups?|mindset|psychology|trades?|notes?)\s*[:—–-]?\s*$/i
/** A paragraph that starts a new day or session: "Monday ...", "Nov 24 ...", "11/24", "today ...". */
const DAY_START =
  /^(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b|\d{4}-\d{2}-\d{2}\b|(?:today|yesterday|tonight|this morning|this week|last week|week \d+|day \d+)\b)/i

/**
 * Regroup each run of plain paragraphs on its own. Anything else ends a run and stays where it
 * is: headings, lists, quotes, code, pictures, session log lines, label lines and their lines,
 * and lines broken with Shift+Enter. A paragraph that starts a new day starts a new run.
 */
function regroupDocument(nodes: RichNode[], speller: Speller, counter: Counter): { content: RichNode[]; regrouped: number } {
  const content: RichNode[] = []
  let run: RichNode[] = []
  let regrouped = 0
  let underLabel = false
  const flush = (): void => {
    const trailing: RichNode[] = []
    while (run.length > 0 && isBlankParagraph(run[run.length - 1]!)) trailing.unshift(run.pop()!)
    if (run.length > 0) {
      const result = regroupRun(run, speller, counter)
      content.push(...result.nodes)
      regrouped += result.regrouped
    }
    content.push(...trailing)
    run = []
  }
  for (const node of nodes) {
    if (node.type !== 'paragraph') {
      flush()
      underLabel = false
      content.push(node)
      continue
    }
    if (isBlankParagraph(node)) {
      underLabel = false
      if (run.length > 0) run.push(node)
      else content.push(node)
      continue
    }
    const lines = cellsText(toCells(node.content)).split('\n')
    if (LABEL_LINE.test(lines[0]!)) underLabel = true
    if (underLabel || lines.length > 1 || lines.some((line) => LOG_LINE.test(line))) {
      flush()
      content.push(node)
      continue
    }
    if (DAY_START.test(lines[0]!.trim())) flush()
    run.push(node)
  }
  flush()
  return { content, regrouped }
}

// ---------------------------------------------------------------- the whole note

/** Remove the temporary correction marks, noting where they were. */
function collectFlashes(nodes: RichNode[] | undefined, path: number[], flashes: Flash[]): RichNode[] | undefined {
  return nodes?.map((node, index) => {
    const here = [...path, index]
    if (TEXT_BLOCKS.has(node.type)) {
      let offset = 0
      const content = (node.content ?? []).map((child) => {
        const size = child.type === 'text' ? (child.text ?? '').length : 1
        const start = offset
        offset += size
        if (child.type !== 'text' || !child.marks?.some((mark) => mark.type === FIX_MARK)) return child
        const last = flashes[flashes.length - 1]
        if (last && last.to === start && sameArray(last.path, here)) last.to = start + size
        else flashes.push({ path: here, from: start, to: start + size })
        const marks = child.marks.filter((mark) => mark.type !== FIX_MARK)
        return marks.length > 0 ? { ...child, marks } : { type: 'text', text: child.text }
      })
      return withInline(node, fromCells(toCells(content)))
    }
    return node.content ? { ...node, content: collectFlashes(node.content, here, flashes) } : node
  })
}

const sameArray = (a: number[], b: number[]): boolean => a.length === b.length && a.every((value, i) => value === b[i])

/** A document in a canonical form, for comparing: adjacent text with the same marks joined. */
export function normalizeDoc(doc: RichDoc): RichDoc {
  const walk = (nodes: RichNode[] | undefined): RichNode[] | undefined =>
    nodes?.map((node) => {
      if (TEXT_BLOCKS.has(node.type) || node.type === 'codeBlock') return withInline(node, fromCells(toCells(node.content)))
      return node.content ? { ...node, content: walk(node.content) } : node
    })
  return { type: 'doc', content: walk(doc.content) ?? [] }
}

/** Fix a title: its words, and a capital first letter. */
export function organizeTitle(title: string | null, speller: Speller): { title: string | null; fixed: number; tidied: number } {
  if (!title || !title.trim()) return { title, fixed: 0, tidied: 0 }
  const correction = correctText(title, speller)
  let out = applyTextEdits(title, correction.edits)
  let tidied = 0
  const first = tokenize(out).find((token) => token.kind === 'word')
  if (first && first.sentenceStart && /^\p{Ll}/u.test(first.text) && !/\p{Lu}/u.test(first.text.slice(1)) && !speller.isUserWord(first.text)) {
    out = out.slice(0, first.from) + capitalise(first.text) + out.slice(first.to)
    tidied++
  }
  return { title: out, fixed: correction.fixed, tidied }
}

export function organizeNote(input: { doc: RichDoc; title: string | null }, speller: Speller, options: OrganizeOptions = {}): OrganizeResult {
  const before = normalizeDoc(input.doc)
  const counter: Counter = { words: 0, tidy: 0 }
  const title = organizeTitle(input.title, speller)
  counter.words += title.fixed
  counter.tidy += title.tidied
  let content = fixNodes(before.content, speller, false, counter) ?? []
  let regrouped = 0
  if (options.mode !== 'tidy') {
    const result = regroupDocument(content, speller, counter)
    content = result.content
    regrouped = result.regrouped
  }
  const flashes: Flash[] = []
  const finalContent = collectFlashes(content, [], flashes) ?? []
  const doc: RichDoc = { type: 'doc', content: finalContent.length > 0 ? finalContent : [{ type: 'paragraph' }] }
  const changed = JSON.stringify(doc) !== JSON.stringify(before) || title.title !== input.title
  return { doc, title: title.title, changed, wordsFixed: counter.words, fixes: counter.words + counter.tidy, regrouped, flashes }
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "Organized: 12 fixes, 2 thoughts regrouped", "Fixed 5 words", or "Already tidy". */
export function organizeSummary(result: Pick<OrganizeResult, 'changed' | 'wordsFixed' | 'fixes' | 'regrouped'>): string {
  if (!result.changed) return 'Already tidy'
  if (result.regrouped > 0) {
    const thoughts = `${count(result.regrouped, 'thought', 'thoughts')} regrouped`
    return result.fixes > 0 ? `Organized: ${count(result.fixes, 'fix', 'fixes')}, ${thoughts}` : `Organized: ${thoughts}`
  }
  if (result.wordsFixed > 0) return `Fixed ${count(result.wordsFixed, 'word', 'words')}`
  return 'Fixed capitals and punctuation'
}
