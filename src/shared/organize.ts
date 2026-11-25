/**
 * Organize: turn a note typed in a hurry into a tidy one, as a pure function on the note's
 * Tiptap JSON (the editor applies the result as one undoable step). It is deliberately light:
 * the note keeps its own shape and wording, it is only fixed and, where a thought wandered off
 * and came back, put back together.
 *
 *  1. Fix words (see autocorrect.ts), keeping bold, links, highlights and colours.
 *  2. Fix punctuation: a capital at the start of each sentence, single spaces, no space before a
 *     comma or full stop and one after it, a full stop at the end of a sentence-like line of a
 *     paragraph, a long run-on line without any punctuation split into sentences at a few
 *     strong cues ("... into the FVG then I waited ..." -> "... into the FVG. Then I waited ..."),
 *     and a colon after a bare label ("lesson dont chase" -> "Lesson: don't chase"). Headings,
 *     list items, session log lines and code get none of the sentence fixes.
 *  3. Regroup thoughts: within a run of plain paragraphs, every sentence is given a topic (the
 *     setup: plan, bias and what the market did; trades; mindset; lessons and rules). When the
 *     writing strays to another topic and later comes back, the sentences about the same topic
 *     are put back together: one paragraph per topic, topics in the order they first appear,
 *     sentences in their original order within a topic. A sentence with no clear topic, or one
 *     that shares an ICT term or a price with the sentence before it, stays with that sentence.
 *     When nothing strayed, the paragraphs stay exactly as they were.
 *  4. Never moved, never merged: headings, lists, checklists, quotes, code, pictures and drawings,
 *     session log lines ("09:31:05 — text"), and a label line ("Lessons:") with the lines under
 *     it. Each of them ends a run of paragraphs, so everything keeps its place around them.
 *
 * Nothing is ever lost or duplicated, and organizing an organized note changes nothing: a
 * regrouping is only made when a second look at the result would leave it as it is.
 */
import { applyTextEdits, correctText, type TextEdit } from './autocorrect'
import { capitalise, isAllCaps, isCapitalised, letterCount, TIME_RE, tokenize, type Speller, type Token } from './spelling'
import { lookupTerm } from './tradingTerms'
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

function toCells(nodes: RichNode[] | undefined): Cell[] {
  const cells: Cell[] = []
  for (const node of nodes ?? []) {
    if (node.type === 'text') {
      for (const ch of node.text ?? '') cells.push({ ch, marks: node.marks })
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
    for (const ch of edit.insert) out.push({ ch, marks })
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
 * , . ; : ! ? and one after a comma or semicolon that runs into the next word.
 */
function tidySpacing(cells: Cell[], counter: Counter): Cell[] {
  cells = pass(cells, (text, locked) => [...matchEdits(text, /(?<=^|\n)[ \t]+/g, '', locked), ...matchEdits(text, /[ \t]+(?=\n|$)/g, '', locked)].sort((a, b) => a.from - b.from), counter)
  cells = pass(cells, (text, locked) => matchEdits(text, /[ \t]{2,}|\t/g, ' ', locked), counter)
  cells = pass(cells, (text, locked) => matchEdits(text, /(?<=\p{L}) +(?=[,;]|[.:!?](?:\s|$))/gu, '', locked), counter)
  cells = pass(cells, (text, locked) => matchEdits(text, /(?<=\p{L}[,;])(?=\p{L})/gu, ' ', locked), counter)
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

/** A capital at the start of each sentence (and each log line after its time). */
function capitalEdits(tokens: Token[], speller: Speller, locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (const token of tokens) {
    if (!token.sentenceStart || token.kind !== 'word') continue
    const first = token.text.charAt(0)
    if (first === first.toUpperCase() || locked(token.from, token.to)) continue
    // Words with their own capitals (iPhone) and the user's own words stay as typed.
    if (/\p{Lu}/u.test(token.text.slice(1)) || speller.isUserWord(token.text)) continue
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

/** Words a run-on line may be split before ("... first push then wait ..."). */
const RUN_ON_BEFORE = new Set(['then', 'but', 'also', 'anyway', 'btw', 'so'])
const RUN_ON_AFTER = new Set(['lol', 'lmao', 'haha'])
const RUN_ON_MIN_WORDS = 20
const RUN_ON_MIN_PART = 5

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

/**
 * A long line written without any sentence punctuation is split into sentences, conservatively:
 * only at "then", "but", "also", "so", "anyway", "btw" or a clock time, or after "lol", and only
 * where both parts are at least five words long.
 */
function runOnEdits(text: string, tokens: Token[], locked: (from: number, to: number) => boolean): TextEdit[] {
  const edits: TextEdit[] = []
  for (const { start, line } of linesOf(text)) {
    if (LOG_LINE.test(line) || /[.!?;]/.test(line.replace(/[.!?]+\s*$/, ''))) continue
    const end = start + line.length
    const inside = tokens.filter((token) => token.from >= start && token.to <= end)
    const total = inside.filter((token) => token.kind === 'word').length
    if (total < RUN_ON_MIN_WORDS) continue
    let wordsBefore = 0
    let seen = 0
    inside.forEach((token, index) => {
      const lower = token.text.toLowerCase()
      const remaining = total - seen
      const cueBefore = (token.kind === 'word' && RUN_ON_BEFORE.has(lower)) || (token.kind === 'protected' && TIME_RE.test(token.text))
      if (cueBefore && wordsBefore >= RUN_ON_MIN_PART && remaining >= RUN_ON_MIN_PART) {
        const edit = sentenceBreakEdit(text, token.from, locked)
        if (edit) edits.push(edit)
        wordsBefore = 0
      }
      if (token.kind === 'word') {
        wordsBefore++
        seen++
      }
      const next = inside[index + 1]
      if (token.kind === 'word' && RUN_ON_AFTER.has(lower) && next && wordsBefore >= RUN_ON_MIN_PART && total - seen >= RUN_ON_MIN_PART) {
        const edit = sentenceBreakEdit(text, next.from, locked)
        if (edit) edits.push(edit)
        wordsBefore = 0
      }
    })
  }
  return edits.sort((a, b) => a.from - b.from)
}

/** A statement that starts like an instruction to oneself is a rule. */
const IMPERATIVE_STARTS = new Set(["don't", 'dont', 'never', 'always', 'wait', 'only', 'stop', 'avoid', 'trust', 'remember', 'stay', 'keep', 'no', 'do', 'be', 'let'])
/** Labels written without a colon before an instruction: "lesson dont chase" -> "Lesson: don't chase". */
const BARE_LABELS = new Set(['lesson', 'lessons', 'rule', 'rules', 'reminder', 'takeaway'])

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
  }
  cells = pass(cells, (text, locked) => capitalEdits(tokenize(text), speller, locked), counter)
  if (sentences) cells = pass(cells, (text, locked) => fullStopEdits(text, tokenize(text), locked), counter)
  return cells
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading'])

/** Fix every text block. Code is left exactly as it is. */
function fixNodes(nodes: RichNode[] | undefined, speller: Speller, inList: boolean, counter: Counter): RichNode[] | undefined {
  return nodes?.map((node) => {
    if (node.type === 'codeBlock') return node
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

export interface RegroupPlan {
  /** Sentence indexes, one list per paragraph to write, in order. */
  groups: number[][]
  /** Runs of sentences moved back to an earlier run on the same topic. */
  regrouped: number
}

/** How to regroup sentences by topic, or null when nothing strayed (the order stays). */
export function regroupPlan(texts: readonly string[]): RegroupPlan | null {
  const topics = topicsOf(texts)
  if (topics.length < 3 || topics[0] === null) return null
  const order: TopicKey[] = []
  for (const topic of topics) if (!order.includes(topic!)) order.push(topic!)
  let runs = 0
  topics.forEach((topic, index) => {
    if (index === 0 || topic !== topics[index - 1]) runs++
  })
  if (runs === order.length) return null
  const groups = order.map((topic) => topics.flatMap((t, index) => (t === topic ? [index] : [])))
  return { groups, regrouped: runs - order.length }
}

// ---------------------------------------------------------------- regrouping

function trimCells(cells: Cell[]): Cell[] {
  let start = 0
  let end = cells.length
  while (start < end && !cells[start]!.atom && /\s/.test(cells[start]!.ch)) start++
  while (end > start && !cells[end - 1]!.atom && /\s/.test(cells[end - 1]!.ch)) end--
  return cells.slice(start, end)
}

/** The sentences of some paragraphs, in order. Line breaks end a sentence too. */
function sentencesOf(paragraphs: readonly RichNode[]): Cell[][] {
  const out: Cell[][] = []
  for (const paragraph of paragraphs) {
    const lines: Cell[][] = [[]]
    for (const cell of toCells(paragraph.content)) {
      if (cell.atom) lines.push([])
      else lines[lines.length - 1]!.push(cell)
    }
    for (const line of lines) {
      const text = cellsText(line)
      const tokens = tokenize(text)
      let start = 0
      for (const token of tokens) {
        if (!token.sentenceStart || token === tokens[0]) continue
        let cut = token.from
        while (cut > start && !/\s/.test(text[cut - 1]!)) cut--
        out.push(trimCells(line.slice(start, cut)))
        start = cut
      }
      out.push(trimCells(line.slice(start)))
    }
  }
  return out.filter((sentence) => sentence.length > 0)
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

const paragraph = (content: RichNode[]): RichNode => (content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' })

/** Regroup one run of plain paragraphs: one paragraph per topic, or the run as it was. */
function regroupRun(paragraphs: RichNode[], speller: Speller, counter: Counter): { nodes: RichNode[]; regrouped: number } {
  const unchanged = { nodes: paragraphs, regrouped: 0 }
  const sentences = sentencesOf(paragraphs)
  const plan = regroupPlan(sentences.map(cellsText))
  if (!plan) return unchanged
  const local: Counter = { words: 0, tidy: 0 }
  const nodes = plan.groups.map((group) => {
    const cells: Cell[] = []
    group.forEach((index, n) => {
      if (n > 0) cells.push({ ch: ' ', marks: undefined })
      cells.push(...endSentence(sentences[index]!, local))
    })
    return paragraph(fromCells(pass(cells, (text, locked) => capitalEdits(tokenize(text), speller, locked), local)))
  })
  // Only a regrouping that a second look would leave as it is: Organize twice is Organize once.
  const again = sentencesOf(nodes)
  if (again.length !== sentences.length || regroupPlan(again.map(cellsText)) !== null) return unchanged
  counter.tidy += local.tidy
  return { nodes, regrouped: plan.regrouped }
}

const isBlankParagraph = (node: RichNode): boolean => node.type === 'paragraph' && (node.content ?? []).every((child) => child.type === 'text' && !(child.text ?? '').trim())
/** A line that is only a label ("Lessons:"): it and the lines under it, up to a blank line, stay as they are. */
const LABEL_LINE = /^\s*(?:lessons?|rules?|reminders?|takeaways?|plan|bias|setups?|mindset|psychology|trades?|notes?)\s*[:—–-]?\s*$/i

/**
 * Regroup each run of plain paragraphs on its own. Anything else ends a run and stays where it
 * is: headings, lists, quotes, code, pictures, session log lines, label lines and their lines.
 * Blank lines inside a run that is regrouped go; blank lines around it stay.
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
    if (underLabel || lines.some((line) => LOG_LINE.test(line))) {
      flush()
      content.push(node)
      continue
    }
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
