import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyStatement, normalizeDoc, organizeNote, organizeSummary, organizeTitle, regroupPlan, sharedKeys, topicsOf, type OrganizeResult } from '@shared/organize'
import { quickNoteLine, logImage } from '@shared/sessionLog'
import { buildDictionary, Speller, tokenize } from '@shared/spelling'
import type { RichDoc, RichMark, RichNode } from '@shared/types'

const speller = new Speller(buildDictionary(readFileSync(resolve(__dirname, '../../src/shared/words/en-US.txt'), 'utf8')))

const text = (value: string, marks?: RichMark[]): RichNode => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value })
const p = (...parts: Array<string | RichNode>): RichNode => {
  const content = parts.map((part) => (typeof part === 'string' ? text(part) : part)).filter((node) => node.type !== 'text' || node.text)
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
}
const doc = (...content: RichNode[]): RichDoc => ({ type: 'doc', content })
const image = (id: string, extra: Record<string, unknown> = {}): RichNode => ({ type: 'noteImage', attrs: { attachmentId: id, width: 100, caption: '', naturalWidth: 1280, naturalHeight: 720, ...extra } })
const organize = (input: RichDoc, title: string | null = null, mode?: 'tidy'): OrganizeResult => organizeNote({ doc: input, title }, speller, mode ? { mode } : {})

/** The note as lines of text: "## Heading", "- bullet", "[image id]", paragraphs as they are. */
function outline(input: RichDoc): string[] {
  const lines: string[] = []
  const inline = (node: RichNode): string => (node.content ?? []).map((child) => (child.type === 'text' ? child.text : child.type === 'hardBreak' ? '⏎' : `[${child.type}]`)).join('')
  const walk = (nodes: RichNode[] | undefined, prefix: string): void => {
    for (const node of nodes ?? []) {
      if (node.type === 'heading') lines.push(`## ${inline(node)}`)
      else if (node.type === 'codeBlock') lines.push(`\`${inline(node)}\``)
      else if (node.type === 'paragraph') lines.push(prefix + inline(node))
      else if (node.type === 'noteImage') lines.push(`[image ${String(node.attrs?.attachmentId)}]`)
      else if (node.type === 'listItem' || node.type === 'taskItem') walk(node.content, node.type === 'taskItem' ? `[${node.attrs?.checked ? 'x' : ' '}] ` : '- ')
      else walk(node.content, prefix)
    }
  }
  walk(input.content, '')
  return lines
}

/** Every word in some blocks, lower case, sorted. */
function words(nodes: RichNode[] | undefined): string[] {
  const out: string[] = []
  const walk = (list: RichNode[] | undefined): void => {
    for (const node of list ?? []) {
      if (node.type === 'paragraph' || node.type === 'heading') {
        const value = (node.content ?? []).map((child) => (child.type === 'text' ? child.text : ' ')).join('')
        for (const token of tokenize(value)) out.push(token.text.toLowerCase())
      } else walk(node.content)
    }
  }
  walk(nodes)
  return out.sort()
}

/** The words between pictures: one sorted list per stretch of the note between two pictures. */
function wordsBetweenPictures(input: RichDoc): string[][] {
  const stretches: RichNode[][] = [[]]
  for (const node of input.content ?? []) {
    if (node.type === 'noteImage') stretches.push([])
    else stretches[stretches.length - 1]!.push(node)
  }
  return stretches.map((stretch) => words(stretch))
}

/** Every node that is not text, in document order, as JSON. */
function nonText(input: RichDoc, includeBreaks: boolean): string[] {
  const out: string[] = []
  const walk = (nodes: RichNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (node.type === 'noteImage' || (includeBreaks && node.type === 'hardBreak') || node.type === 'horizontalRule') out.push(JSON.stringify(node))
      walk(node.content)
    }
  }
  walk(input.content)
  return out
}

const EXAMPLE_DUMP =
  'nwog at 6120 was the draw, asia made eql at 6098 and london swept them then displacment up leaving a fvg on 5m. i was bullish bias from premarket bc pdh 6135 unswept. took long at 6104 in the ifvg stop 6096 tp 6130 got stopped out first time lol felt fomo and re entered to early. second entry worked +2r. lesson dont chase the first push wait for mss. felt calm after tho. ny am killzone was clean, silver bullet 10-11 gave the move'
const EXAMPLE_MINDSET =
  'today i felt imapatient from the open and i know thats when i make my worst trades. need to trust the process and let the setup come to me, the market will always be there tommorow'

describe('Organize on the examples', () => {
  it('fixes an erratic dump of the day and puts the thoughts that strayed back together, in plain paragraphs', () => {
    const result = organize(doc(p(EXAMPLE_DUMP)))
    expect(outline(result.doc)).toEqual([
      // The setup and the plan; the killzone sentence that came at the very end joins them.
      'NWOG at 6120 was the draw, Asia made EQL at 6098 and London swept them then displacement up leaving a FVG on 5m. I was bullish bias from premarket because PDH 6135 unswept. NY AM killzone was clean, silver bullet 10-11 gave the move.',
      'Took long at 6104 in the IFVG stop 6096 TP 6130 got stopped out first time lol felt FOMO and re-entered too early. Second entry worked +2R.',
      "Lesson: don't chase the first push wait for MSS.",
      'Felt calm after tho.'
    ])
    // No headings, no bullets: only paragraphs.
    expect(result.doc.content!.map((node) => node.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph'])
    expect(result.wordsFixed).toBe(19)
    expect(result.regrouped).toBe(1)
    expect(organizeSummary(result)).toBe(`Organized: ${result.fixes} fixes, 1 thought regrouped`)
    expect(result.fixes).toBeGreaterThan(result.wordsFixed)
  })

  it('only corrects a paragraph about one thing', () => {
    const result = organize(doc(p(EXAMPLE_MINDSET)))
    expect(result.regrouped).toBe(0)
    expect(outline(result.doc)).toEqual([
      "Today I felt impatient from the open and I know that's when I make my worst trades. Need to trust the process and let the setup come to me, the market will always be there tomorrow."
    ])
    expect(organizeSummary(result)).toBe('Fixed 6 words')
  })

  it('keeps a session log one line per entry in time order, the chart snapshot where it was, only corrected', () => {
    const at = (h: number, m: number, s: number): number => new Date(2026, 10, 25, h, m, s).getTime()
    const log = doc(
      p(quickNoteLine(at(9, 31, 5), 'London high taken')),
      logImage({ attachmentId: 'snapshot-0931', caption: '09:31:40 · ES1! 6,123.25', width: 1920, height: 1080 }),
      p(quickNoteLine(at(9, 42, 10), 'fvg filled waiting for displacment')),
      p(quickNoteLine(at(10, 5, 44), 'entered short 6128 stop 6134')),
      p(quickNoteLine(at(10, 7, 2), 'felt calm, asia high still the draw')),
      p()
    )
    const result = organize(log, 'Session log · Wed 25 Nov')
    expect(outline(result.doc)).toEqual([
      '09:31:05 — London high taken',
      '[image snapshot-0931]',
      '09:42:10 — FVG filled waiting for displacement',
      '10:05:44 — Entered short 6128 stop 6134',
      '10:07:02 — Felt calm, Asia high still the draw',
      ''
    ])
    expect(result.regrouped).toBe(0)
    expect(result.title).toBe('Session log · Wed 25 Nov')
    expect(organizeSummary(result)).toBe('Fixed 3 words')
    // The snapshot is exactly as it was, caption and all.
    expect(nonText(result.doc, true)).toEqual(nonText(log, true))
  })
})

describe('Fixing', () => {
  it('fixes spacing around punctuation and collapses stray spaces', () => {
    const result = organize(doc(p('  waited for   the sweep ,then took it .  it worked')))
    expect(outline(result.doc)).toEqual(['Waited for the sweep, then took it. It worked.'])
  })

  it('adds a full stop to sentence-like lines only, not to short labels, headings or list items', () => {
    const result = organize(doc({ type: 'heading', attrs: { level: 2 }, content: [text('london open plan')] }, p('entry rule'), p('wait for the sweep of the low'), p('Wait For The London Open Session')))
    expect(outline(result.doc)).toEqual(['## London open plan', 'Entry rule', 'Wait for the sweep of the low.', 'Wait For The London Open Session'])
  })

  it('splits a long run-on line without punctuation into sentences, at strong cues only', () => {
    const result = organize(doc(p('asia made the high at 6110 and london ran it into the 15m fvg then i waited for the mss and took the long at 6098 with stop under the low lol felt good about the patience today')))
    expect(outline(result.doc)).toEqual(['Asia made the high at 6110 and London ran it into the 15m FVG. Then I waited for the MSS and took the long at 6098 with stop under the low lol. Felt good about the patience today.'])
    // A punctuated line, or a short one, is not split.
    expect(outline(organize(doc(p('took long then stopped out lol felt bad'))).doc)).toEqual(['Took long then stopped out lol felt bad.'])
  })

  it('puts a colon after a bare label before an instruction', () => {
    expect(outline(organize(doc(p('lesson dont chase the first push'))).doc)).toEqual(["Lesson: don't chase the first push."])
    expect(outline(organize(doc(p('rule no trades before 9:45'))).doc)).toEqual(['Rule: no trades before 9:45.'])
    expect(outline(organize(doc(p('lesson learned the hard way today'))).doc)).toEqual(['Lesson learned the hard way today.'])
  })

  it('keeps the user’s own headings, lists, checklists, quotes and code where they are, only corrected', () => {
    const input = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('my rules')] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('dont chase the first push')] }, { type: 'listItem', content: [p('wait for displacment')] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('check the news calender for cpi today')] }] },
      { type: 'blockquote', content: [p('patiance pays')] },
      { type: 'codeBlock', attrs: { language: null }, content: [text('teh  code stays')] },
      image('rules-chart-01')
    )
    const result = organize(input)
    expect(outline(result.doc)).toEqual(['## My rules', "- Don't chase the first push", '- Wait for displacement', '[x] Check the news calendar for CPI today', 'Patience pays', '`teh  code stays`', '[image rules-chart-01]'])
    expect(result.doc.content!.map((node) => node.type)).toEqual(input.content!.map((node) => node.type))
  })

  it('keeps bold, highlights, colours and links, and never touches link or code text', () => {
    const bold: RichMark[] = [{ type: 'bold' }]
    const link: RichMark[] = [{ type: 'link', attrs: { href: 'https://example.com/teh' } }]
    const hl: RichMark[] = [{ type: 'highlight', attrs: { color: 'var(--hl-amber)' } }]
    const result = organize(doc(p(text('dont', bold), ' chase, see ', text('teh guide', link), ' and ', text('displacment', hl), ' then ', text('teh', [{ type: 'code' }]))))
    expect(result.doc.content![0]!.content).toEqual([
      text("Don't", bold),
      text(' chase, see '),
      text('teh guide', link),
      text(' and '),
      text('displacement', hl),
      text(' then '),
      text('teh', [{ type: 'code' }])
    ])
  })

  it('corrects the title too', () => {
    expect(organizeTitle('london sesion recap', speller)).toEqual({ title: 'London session recap', fixed: 2, tidied: 0 })
    expect(organizeTitle('sesion recap', speller)).toEqual({ title: 'Session recap', fixed: 1, tidied: 1 })
    expect(organizeTitle(null, speller)).toEqual({ title: null, fixed: 0, tidied: 0 })
  })

  it('says "Already tidy" when nothing changes, and names what it did otherwise', () => {
    const result = organize(doc(p('Waited for the sweep of the low, then took the trade.')))
    expect(result.changed).toBe(false)
    expect(organizeSummary(result)).toBe('Already tidy')
    expect(organizeSummary(organize(doc(p('waited for the sweep of the low'))))).toBe('Fixed capitals and punctuation')
    expect(organizeSummary(organize(doc(p('teh sweep'))))).toBe('Fixed 1 word')
    expect(organizeSummary({ changed: true, wordsFixed: 0, fixes: 0, regrouped: 2 })).toBe('Organized: 2 thoughts regrouped')
    expect(organizeSummary({ changed: true, wordsFixed: 1, fixes: 1, regrouped: 1 })).toBe('Organized: 1 fix, 1 thought regrouped')
  })

  it('reports where the corrected words are, for the highlight', () => {
    const result = organize(doc(p('today i felt imapatient')))
    expect(outline(result.doc)).toEqual(['Today I felt impatient.'])
    expect(result.flashes).toEqual([
      { path: [0], from: 6, to: 7 },
      { path: [0], from: 13, to: 22 }
    ])
  })
})

describe('Regrouping', () => {
  it('knows what a sentence is about, and says so only when it is clear', () => {
    expect(classifyStatement('took long at 6104 stop 6096').topic).toBe('trades')
    expect(classifyStatement('felt fomo after the loss').topic).toBe('mindset')
    expect(classifyStatement('london swept the asia high').topic).toBe('setup')
    expect(classifyStatement('bias bearish below the nwog').topic).toBe('setup')
    expect(classifyStatement("don't chase the first push").topic).toBe('lessons')
    expect(classifyStatement('Lesson: size down').topic).toBe('lessons')
    expect(classifyStatement('ok').topic).toBeNull()
    expect(classifyStatement('it was fine').topic).toBeNull()
  })

  it('keeps a sentence with no clear topic, or one naming the same ICT term or price, with the one before it', () => {
    expect(topicsOf(['took long at 6104 stop 6096', 'it was fine', 'felt calm'])).toEqual(['trades', 'trades', 'mindset'])
    // "the fvg was from london" is about the setup, but it is about the FVG the trade was in.
    expect(sharedKeys('took long in the FVG at 6104')).toEqual(new Set(['fvg', 'price:6104']))
    expect(topicsOf(['took long in the FVG at 6104 stop 6096', 'the FVG was from the London session sweep', 'felt calm after'])).toEqual(['trades', 'trades', 'mindset'])
    // Leading sentences with no clear topic go with the first one that has one.
    expect(topicsOf(['ok so', 'took long at 6104 stop 6096', 'felt calm'])).toEqual(['trades', 'trades', 'mindset'])
  })

  it('moves a stray thought back to its topic: one paragraph per topic, in the order they first appear', () => {
    const result = organize(doc(p('took long at 6104 stop 6096'), p('felt fomo after the first loss'), p('london swept the high before that'), p('second entry at 6110 worked +2r'), p('felt calm after')))
    expect(outline(result.doc)).toEqual(['Took long at 6104 stop 6096. Second entry at 6110 worked +2R.', 'Felt FOMO after the first loss. Felt calm after.', 'London swept the high before that.'])
    expect(result.regrouped).toBe(2)
    expect(organizeSummary(result)).toBe(`Organized: ${result.fixes} fixes, 2 thoughts regrouped`)
  })

  it('leaves the order and the paragraphs alone when no thought strayed', () => {
    const lines = organize(doc(p('plan for today: wait for london to sweep asia high then look for shorts into the 4h fvg'), p('market opend with a gap down, nq lead es'), p('took 2 trades, first one stoped out for -1r second one +3r'), p('i got impatiant after the first loss and almost revenge traded'), p('remember to wait for the 5m mss before entering')))
    expect(outline(lines.doc)).toEqual([
      'Plan for today: wait for London to sweep Asia high then look for shorts into the 4h FVG.',
      'Market opened with a gap down, NQ lead ES.',
      'Took 2 trades, first one stopped out for -1R second one +3R.',
      'I got impatient after the first loss and almost revenge traded.',
      'Remember to wait for the 5m MSS before entering.'
    ])
    expect(lines.regrouped).toBe(0)
    const prose = organize(doc(p('asia was choppy. london took the asia low at 6080 then reversed. waited for the 9:30 open. took short at 6112 stop 6120 target 6090, hit target +2.5r. felt good, didnt overtrade. rule: no trades after 11am')))
    expect(outline(prose.doc)).toEqual(["Asia was choppy. London took the Asia low at 6080 then reversed. Waited for the 9:30 open. Took short at 6112 stop 6120 target 6090, hit target +2.5R. Felt good, didn't overtrade. Rule: no trades after 11am."])
    const plan = organize(doc(p('Bias bearish. Want to see ssl taken at the open then short the bisi on 1m. If we take pdh i am out. News at 10am so careful.')))
    expect(outline(plan.doc)).toEqual(['Bias bearish. Want to see SSL taken at the open then short the BISI on 1m. If we take PDH I am out. News at 10am so careful.'])
    const reflection = organize(doc(p('i felt calm today. i was patient and did not chase. my emotions were in check and i trusted the process. i felt confident in my entries.')))
    expect(reflection.regrouped).toBe(0)
    expect(regroupPlan(['ok', 'fine'])).toBeNull()
  })

  it('regroups each stretch between pictures on its own, so every picture keeps its place', () => {
    const input = doc(p('took long at 6104 stop 6096. felt fomo. took another long at 6110 stop 6100'), image('trade-chart-1'), p('london swept the high. felt calm. asia was the draw for the pm session'))
    const result = organize(input)
    expect(outline(result.doc)).toEqual([
      'Took long at 6104 stop 6096. Took another long at 6110 stop 6100.',
      'Felt FOMO.',
      '[image trade-chart-1]',
      'London swept the high. Asia was the draw for the PM session.',
      'Felt calm.'
    ])
    expect(result.regrouped).toBe(2)
  })

  it('keeps a label line ("Lessons:") and the lines under it as they are, and regroups around them', () => {
    const result = organize(doc(p('took long 6104 stop 6096'), p('lessons:'), p('size down on news days'), p('felt fomo'), p(), p('london swept the asia low'), p('felt calm after')))
    expect(outline(result.doc)).toEqual(['Took long 6104 stop 6096', 'Lessons:', 'Size down on news days.', 'Felt FOMO', '', 'London swept the Asia low.', 'Felt calm after'])
    expect(result.regrouped).toBe(0)
  })

  it('regroups the paragraphs between the user’s own headings, and keeps the headings where they are', () => {
    const input = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('monday')] },
      p('took long at 6104 stop 6096. felt fomo after. second long at 6110 stop 6100 worked +2r'),
      { type: 'heading', attrs: { level: 2 }, content: [text('tuesday')] },
      p('no trades today')
    )
    expect(outline(organize(input).doc)).toEqual(['## Monday', 'Took long at 6104 stop 6096. Second long at 6110 stop 6100 worked +2R.', 'Felt FOMO after.', '## Tuesday', 'No trades today'])
  })

  it('brings a line written later back to its topic, and leaves an organized note as it is', () => {
    const first = organize(doc(p(EXAMPLE_DUMP))).doc
    const later = doc(...first.content!, p('pdh got taken at 11:30 then price reversed'), p())
    const result = organize(later)
    expect(outline(result.doc)[0]).toBe(
      'NWOG at 6120 was the draw, Asia made EQL at 6098 and London swept them then displacement up leaving a FVG on 5m. I was bullish bias from premarket because PDH 6135 unswept. NY AM killzone was clean, silver bullet 10-11 gave the move. PDH got taken at 11:30 then price reversed.'
    )
    expect(outline(result.doc)).toHaveLength(5)
    expect(organize(result.doc).changed).toBe(false)
    expect(organize(first).changed).toBe(false)
  })
})

// ---------------------------------------------------------------- property test

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const POOL = [
  'nwog at 6120 was the draw', 'asia made eql at 6098', 'london swept the highs then displacment up', 'left a fvg on the 5m',
  'i was bullish bias from premarket bc pdh unswept', 'took long at 6104 in the ifvg stop 6096 tp 6130', 'got stopped out lol',
  'felt fomo and re entered to early', 'second entry worked +2r', 'lesson dont chase the first push', 'wait for mss',
  'felt calm after tho', 'ny am killzone was clean', 'silver bullet 10-11 gave the move', 'the the market was choppy',
  'need to trust the process', 'rule: no trades before 9:45', 'i felt imapatient', 'thats when i make my worst trades',
  'size was to big on the first one', 'cpi at 8:30 so i sat out', 'bearish below the ob', 'chart in tradingview looked clean',
  'mindset: stay patient', 'exited at 6130 for +$450', 'bought the dip w/ the trend', 'plan for tomorow is the same', 'ok'
]

function generateNote(rand: () => number): RichDoc {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
  const blocks: RichNode[] = []
  const count = 1 + Math.floor(rand() * 9)
  let imageId = 0
  for (let b = 0; b < count; b++) {
    const roll = rand()
    if (roll < 0.15) {
      blocks.push(image(`gen-image-${String(imageId++).padStart(3, '0')}`, rand() < 0.3 ? { drawing: 2 } : {}))
      continue
    }
    if (roll < 0.2) {
      blocks.push(p())
      continue
    }
    const parts: RichNode[] = []
    const sentences = 1 + Math.floor(rand() * 4)
    for (let s = 0; s < sentences; s++) {
      const sentence = pick(POOL)
      const end = rand() < 0.6 ? '. ' : rand() < 0.5 ? ', ' : ' '
      if (rand() < 0.15) parts.push(text(sentence, [{ type: 'bold' }]))
      else if (rand() < 0.1) parts.push(text(sentence, [{ type: 'highlight', attrs: { color: 'var(--hl-teal)' } }]))
      else parts.push(text(sentence))
      if (rand() < 0.15) parts.push({ type: 'hardBreak' })
      else parts.push(text(end))
    }
    if (rand() < 0.1) parts.push(text('see link', [{ type: 'link', attrs: { href: 'https://example.com/' } }]))
    blocks.push({ type: 'paragraph', content: parts })
  }
  if (rand() < 0.2) blocks.push({ type: 'bulletList', content: [{ type: 'listItem', content: [p(pick(POOL))] }] })
  if (rand() < 0.1) blocks.push({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: rand() < 0.5 }, content: [p(pick(POOL))] }] })
  return normalizeDoc(doc(...blocks))
}

const HAND_WRITTEN: RichDoc[] = [
  doc(p(EXAMPLE_DUMP)),
  doc(p(EXAMPLE_MINDSET)),
  doc(...organizeNote({ doc: doc(p(EXAMPLE_DUMP)), title: null }, speller).doc.content!, p('lesson: size down after a loss'), image('after-org-01'), p('nq made a new high, es lagged = smt')),
  doc(p('09:31:05 — London high taken'), image('snap-000001'), p('09:42:10 — fvg filled waiting for displacment'), p('10:05:44 — entered short 6128 stop 6134')),
  doc(p('lessons:'), p('dont chase'), p('wait for mss'), p(), p('took long 6100'), p('london swept asia')),
  doc(image('only-image-1')),
  doc(p()),
  doc(p('a', { type: 'hardBreak' }, 'b', { type: 'hardBreak' }, 'took long at 6104 stop 6096 felt fomo, london swept the high')),
  doc(p('took long at 6104 stop 6096', { type: 'hardBreak' }, 'felt fomo', { type: 'hardBreak' }, 'second long at 6110 worked +2r', { type: 'hardBreak' }, 'felt calm'))
]

describe('Organize never loses, duplicates or misplaces anything', () => {
  const notes = [...HAND_WRITTEN, ...Array.from({ length: 300 }, (_, i) => generateNote(random(1000 + i)))]

  it('keeps every corrected word between the same pictures, every picture in order, and is the same when applied twice', () => {
    let regrouped = 0
    for (const [index, note] of notes.entries()) {
      const label = `note ${index}: ${JSON.stringify(note).slice(0, 300)}`
      const result = organize(note)
      const fixedOnly = organize(note, null, 'tidy')
      regrouped += result.regrouped > 0 ? 1 : 0
      // The same corrected words as fixing alone gives, between the same pictures.
      expect(wordsBetweenPictures(result.doc), label).toEqual(wordsBetweenPictures(fixedOnly.doc))
      // Pictures and drawings: all there, once each, in the same order. Where nothing was
      // regrouped, the line breaks are all kept too (in a regrouped stretch they only separated sentences).
      expect(nonText(result.doc, result.regrouped === 0), label).toEqual(nonText(note, result.regrouped === 0))
      if (result.regrouped === 0) expect(result.doc, label).toEqual(fixedOnly.doc)
      // Idempotent.
      const again = organize(result.doc, result.title)
      expect(again.changed, label).toBe(false)
      expect(again.doc, label).toEqual(result.doc)
    }
    // The generated notes do exercise regrouping.
    expect(regrouped).toBeGreaterThan(30)
  })
})

describe('speed', () => {
  it('organizes a 2,000-word dump at once', () => {
    const rand = random(7)
    const sentences: string[] = []
    let count = 0
    while (count < 2000) {
      const sentence = POOL[Math.floor(rand() * POOL.length)]!
      sentences.push(sentence)
      count += sentence.split(' ').length
    }
    const paragraphs: RichNode[] = []
    for (let i = 0; i < sentences.length; i += 6) paragraphs.push(p(sentences.slice(i, i + 6).join('. ')))
    const input = doc(...paragraphs)
    organize(input)
    const started = performance.now()
    const result = organize(input)
    const ms = performance.now() - started
    console.log(`[organize] 2,000-word dump: ${ms.toFixed(1)} ms, ${result.wordsFixed} words fixed, ${result.regrouped} thoughts regrouped`)
    expect(result.regrouped).toBeGreaterThan(0)
    expect(ms).toBeLessThan(1500)
  })
})
