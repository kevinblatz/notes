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
/** The same dump with a thought that strays off and comes back with "anyway". */
const EXAMPLE_STRAY =
  'nwog at 6120 was the draw, asia made eql at 6098 and london swept them then displacment up leaving a fvg on 5m. ugh my neighbor is drilling again cant focus. anyway i was bullish bias from premarket bc pdh 6135 unswept. took long at 6104 in the ifvg stop 6096 tp 6130 got stopped out first time lol felt fomo and re entered to early. second entry worked +2r. lesson dont chase the first push wait for mss. felt calm after tho. ny am killzone was clean, silver bullet 10-11 gave the move'
const ORGANIZED_EXAMPLE =
  "NWOG at 6120 was the draw, Asia made EQL at 6098 and London swept them then displacement up leaving a FVG on 5m. I was bullish bias from premarket because PDH 6135 unswept. Took long at 6104 in the IFVG, stop 6096, TP 6130, got stopped out first time lol. Felt FOMO and re-entered too early. Second entry worked +2R. Lesson: don't chase the first push, wait for MSS. Felt calm after tho. NY AM killzone was clean, silver bullet 10-11 gave the move."
const EXAMPLE_MINDSET =
  'today i felt imapatient from the open and i know thats when i make my worst trades. need to trust the process and let the setup come to me, the market will always be there tommorow'

describe('Organize on the examples', () => {
  it('fixes an erratic dump of the day: every word, the capitals and the punctuation, in the order it was written', () => {
    const result = organize(doc(p(EXAMPLE_DUMP)))
    // The run-on sentence is split after "lol" and the trade's levels set off with commas; the
    // story (trade, reaction, second entry, lesson) keeps its order: nothing strayed.
    expect(outline(result.doc)).toEqual([ORGANIZED_EXAMPLE])
    expect(result.doc.content!.map((node) => node.type)).toEqual(['paragraph'])
    expect(result.wordsFixed).toBe(19)
    expect(result.regrouped).toBe(0)
    expect(organizeSummary(result)).toBe('Fixed 19 words')
    expect(result.fixes).toBeGreaterThan(result.wordsFixed)
  })

  it('puts a thought that strayed off and came back ("anyway ...") back together, in plain paragraphs', () => {
    const result = organize(doc(p(EXAMPLE_STRAY)))
    expect(outline(result.doc)).toEqual([ORGANIZED_EXAMPLE.replace('I was bullish', 'Anyway I was bullish'), "Ugh my neighbor is drilling again can't focus."])
    // No headings, no bullets: only paragraphs.
    expect(result.doc.content!.map((node) => node.type)).toEqual(['paragraph', 'paragraph'])
    expect(result.regrouped).toBe(1)
    expect(organizeSummary(result)).toBe(`Organized: ${result.fixes} fixes, 1 thought regrouped`)
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

  it('keeps emoji and corrects the words after them in place', () => {
    const one = (value: string): string => outline(organize(doc(p(value))).doc).join(' | ')
    expect(one('great day 🔥 nwog held')).toBe('Great day 🔥 NWOG held.')
    expect(one('good day 😀😀 dont chase')).toBe("Good day 😀😀 don't chase.")
    expect(one('took long at 6104 💰 then i felt fomo and re entered to early')).toBe('Took long at 6104 💰 then I felt FOMO and re-entered too early.')
    expect(one('great day 🔥 +2r 💰 nwog -> fvg -> tp. 10/10 would do again')).toBe('Great day 🔥 +2R 💰 NWOG -> FVG -> TP. 10/10 would do again.')
    // The highlight is where the fixed word is (offsets count an emoji as two, as the editor does).
    const result = organize(doc(p('great day 🔥 nwog held')))
    const flash = result.flashes[0]!
    expect(((result.doc.content![0]!.content![0]!.text ?? '') as string).slice(flash.from, flash.to)).toBe('NWOG')
  })

  it('never loses or changes a number, a symbol or an emoji between words (property)', () => {
    const rand = random(99)
    const SYMBOLS = ['🔥', '💰', '😀', '😡', '🚀', '📉', '✅', '→', '👍🏽', '🇺🇸', '+2r', '6104', '9:30', '->', '10/10', '$450']
    const WORDS = ['nwog', 'held', 'dont', 'chase', 'teh', 'fvg', 'i', 'felt', 'fomo', 're', 'entered', 'to', 'early', 'displacment', 'and', 'the', 'took', 'long']
    for (let n = 0; n < 300; n++) {
      const parts: string[] = []
      const count = 3 + Math.floor(rand() * 12)
      for (let i = 0; i < count; i++) parts.push(rand() < 0.3 ? SYMBOLS[Math.floor(rand() * SYMBOLS.length)]! : WORDS[Math.floor(rand() * WORDS.length)]!)
      const value = parts.join(' ')
      const out = outline(organize(doc(p(value))).doc).join(' ')
      const symbols = (text: string): string[] => text.split(/\s+/).filter((chunk) => !/\p{L}/u.test(chunk) || /\d/.test(chunk)).map((chunk) => chunk.replace(/[.,]$/, '').replace(/r$/, 'R'))
      expect(symbols(out), value).toEqual(symbols(value))
      expect(out.split(/\s+/).length, value).toBeLessThanOrEqual(value.split(/\s+/).length)
    }
  })

  it('collapses a doubled comma, and writes a trading code that starts a sentence in its own capitals', () => {
    expect(outline(organize(doc(p('ok,, so that happened'))).doc)).toEqual(['Ok, so that happened.'])
    expect(outline(organize(doc(p('es was slow in the pm. ob held perfectly today. ce of the fvg held. poi was the h1 ob'))).doc)).toEqual([
      'ES was slow in the pm. OB held perfectly today. CE of the FVG held. POI was the h1 OB.'
    ])
    // Codes that are also everyday words are capitalised as words.
    expect(outline(organize(doc(p('spy was red today. am i too early for this'))).doc)).toEqual(['Spy was red today. Am I too early for this.'])
  })

  it('splits a run-on sentence only at strong cues, never after a preposition or inside "if ... then"', () => {
    const one = (value: string): string => outline(organize(doc(p(value))).doc).join(' | ')
    expect(one('the pdh at 6135 got swept at 11:15 like i planned so the bias was right and ny am killzone was clean after that')).toBe(
      'The PDH at 6135 got swept at 11:15 like I planned. So the bias was right and NY AM killzone was clean after that.'
    )
    expect(one('so price opened and went straight down into the ndog then i waited for a mss on the 1m and got it at 9:42 entered short at 6088 stop above the high at 6095 target was pdl 6060')).toBe(
      'So price opened and went straight down into the NDOG. Then I waited for a MSS on the 1m and got it at 9:42 entered short at 6088 stop above the high at 6095 target was PDL 6060.'
    )
    expect(one('price did nothing all morning and i waited patiently for the setup to form and then at 10:40 it finally swept the low')).toBe(
      'Price did nothing all morning and I waited patiently for the setup to form, and then at 10:40 it finally swept the low.'
    )
    expect(one('if price takes the pdh then i want to see a mss on the 5m and look for an entry in the fvg on the retrace')).toBe(
      'If price takes the PDH then I want to see a MSS on the 5m and look for an entry in the FVG on the retrace.'
    )
    expect(one('i was waiting for a pullback into the fvg and it never came so i chased it at the high and got stopped out because there was no retrace and then i revenge traded twice more')).toBe(
      'I was waiting for a pullback into the FVG and it never came. So I chased it at the high and got stopped out because there was no retrace, and then I revenge traded twice more.'
    )
    // "so" before an adjective, "then" or "also" before a verb: inside the clause.
    expect(one('the open was so choppy and i was so annoyed that i nearly quit and price then reversed hard and i also took a loss on the retest')).toBe(
      'The open was so choppy and I was so annoyed that I nearly quit and price then reversed hard and I also took a loss on the retest.'
    )
  })

  it('splits the run-on sentence of a punctuated paragraph too, and sets a trade’s levels off with commas', () => {
    expect(outline(organize(doc(p('bias was bullish. took long at 6104 in the ifvg stop 6096 tp 6130 got stopped out first time lol felt fomo and re entered to early. second entry worked'))).doc)).toEqual([
      'Bias was bullish. Took long at 6104 in the IFVG, stop 6096, TP 6130, got stopped out first time lol. Felt FOMO and re-entered too early. Second entry worked.'
    ])
    // A short sentence is left as typed.
    expect(outline(organize(doc(p('took long at 6104 stop 6096 tp 6130'))).doc)).toEqual(['Took long at 6104 stop 6096 TP 6130.'])
  })

  it('puts a comma before the second instruction after a label', () => {
    expect(outline(organize(doc(p('lesson dont chase the first push wait for mss'))).doc)).toEqual(["Lesson: don't chase the first push, wait for MSS."])
    expect(outline(organize(doc(p('lesson: dont size up after a loss take a break'))).doc)).toEqual(["Lesson: don't size up after a loss, take a break."])
    // Not when the second word is not an instruction, or is joined to the first.
    expect(outline(organize(doc(p('rule never move stop to be before tp1'))).doc)).toEqual(['Rule: never move stop to be before TP1.'])
    expect(outline(organize(doc(p('rule: always wait for the mss to take the trade'))).doc)).toEqual(['Rule: always wait for the MSS to take the trade.'])
  })

  it('fixes the words of a picture caption, and nothing else about the picture', () => {
    const input = doc(image('caption-01', { caption: 'sweep of teh low, ifvg at 6090 ' }), p('ok'))
    const result = organize(input)
    expect(result.doc.content![0]).toEqual(image('caption-01', { caption: 'sweep of the low, IFVG at 6090 ' }))
    expect(result.wordsFixed).toBe(2)
    expect(organizeSummary(result)).toBe('Fixed 2 words')
    expect(organize(result.doc).changed).toBe(false)
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

  it('moves a stray out from between the two parts of the thought it interrupted, as a paragraph of its own', () => {
    // Back with "anyway": the stray goes after the paragraph the writing came back in.
    const cued = organize(doc(p('price swept asia low at 6090 then displaced up through the fvg. ugh my neighbor is drilling again so annoying cant focus. anyway the displacement left a 5m fvg at 6098 and i entered long there stop 6088 tp 6130')))
    expect(outline(cued.doc)).toEqual([
      'Price swept Asia low at 6090 then displaced up through the FVG. Anyway the displacement left a 5m FVG at 6098 and I entered long there stop 6088 TP 6130.',
      "Ugh my neighbor is drilling again so annoying can't focus."
    ])
    expect(cued.regrouped).toBe(1)
    expect(organizeSummary(cued)).toBe(`Organized: ${cued.fixes} fixes, 1 thought regrouped`)
    expect(outline(organize(doc(p('the 15m ob at 6140 held. i forgot to journal yesterday, need to do that tonight. anyway price respected the ob and ran to the pdh at 6162'))).doc)).toEqual([
      'The 15m OB at 6140 held. Anyway price respected the OB and ran to the PDH at 6162.',
      'I forgot to journal yesterday, need to do that tonight.'
    ])
    // "ok back to the trade" after one more sentence of the market: the aside before it goes.
    expect(outline(organize(doc(p('bias was bearish from the daily fvg at 6150. felt kinda tired today didnt sleep good. price swept bsl at 6142 in london and displaced lower. ok back to the trade i shorted the retrace into the fvg at 6138 stop 6146 target 6110'))).doc)).toEqual([
      'Bias was bearish from the daily FVG at 6150. Price swept BSL at 6142 in London and displaced lower. Ok back to the trade I shorted the retrace into the FVG at 6138 stop 6146 target 6110.',
      "Felt kinda tired today didn't sleep good."
    ])
    // Without a cue: the return names the same level, and the stray says nothing about the market.
    expect(outline(organize(doc(p('the 15m ob at 6140 held. i forgot to journal yesterday, need to do that tonight. price respected the ob and ran to the pdh at 6162'))).doc)).toEqual([
      'The 15m OB at 6140 held. Price respected the OB and ran to the PDH at 6162.',
      'I forgot to journal yesterday, need to do that tonight.'
    ])
    // A stray that was a paragraph of its own goes after the paragraph the writing came back in.
    expect(outline(organize(doc(p('the 15m ob at 6140 held and price ran.'), p('need to call my mom tonight.'), p('anyway price respected the ob and ran to the pdh at 6162.'), p('felt good about the patience.'))).doc)).toEqual([
      'The 15m OB at 6140 held and price ran.',
      'Anyway price respected the OB and ran to the PDH at 6162.',
      'Need to call my mom tonight.',
      'Felt good about the patience.'
    ])
    // The reaction to the return stays with it.
    expect(outline(organize(doc(p('price swept asia low at 6090. ugh my neighbor is drilling again. anyway the displacement left a 5m fvg at 6098 and i went long. felt good about it'))).doc)).toEqual([
      'Price swept Asia low at 6090. Anyway the displacement left a 5m FVG at 6098 and I went long. Felt good about it.',
      'Ugh my neighbor is drilling again.'
    ])
  })

  it('never tears a story told in order apart: trade, reaction, trade, reaction stays as written', () => {
    const unchanged = (...paragraphs: string[]): void => {
      const input = doc(...paragraphs.map((text) => p(text)))
      const result = organize(input)
      expect(result.regrouped, paragraphs.join(' / ')).toBe(0)
      expect(result.doc, paragraphs.join(' / ')).toEqual(organize(input, null, 'tidy').doc)
    }
    unchanged('took long at 6104 in the ifvg stop 6096 tp 6130 got stopped out first time lol. felt fomo and re entered to early. second entry worked +2r. lesson dont chase the first push wait for mss. felt calm after tho')
    unchanged('took a short at 6140 and got stopped. felt angry. took another short at 6145 and it worked +2r. felt relieved after')
    unchanged('i felt nervous before the open. bias was bullish from the 1h fvg. i took a long at 6110 and it ran to 6130. i felt better after that')
    unchanged('woke up feeling great, confident going into the open. took a long at 6110 off the bisi and got stopped at 6102. after that i felt anxious and second guessed everything. took another long at 6105 and it worked to 6130 for +3r. proud i didnt quit')
    unchanged('premarket: bias bullish, pdh 6135 is the draw, nwog at 6120 below.', 'took long at 6104 in the ifvg, stop 6096, tp 6130. got stopped out.', 'felt fomo after that and re entered too early. second entry worked +2r.', 'pdh got taken at 11:15 like i planned, so the bias was right.')
    unchanged('idk man rn im just frustrated fr. ngl i shouldnt of took that trade lol. tbh the setup was there but i was impatient af')
    unchanged('took long at 6104 stop 6096', 'felt fomo after the first loss', 'london swept the high before that', 'second entry at 6110 worked +2r', 'felt calm after')
    // A feeling about the trade between two trades at the same price is part of the story.
    unchanged('took long at 6104 stop 6096. felt fomo. took long at 6104 again and it worked')
    // The stray says what it follows from, or the return points back at the stray.
    unchanged('took long at 6104. after that i made coffee. anyway price ran to 6130')
    unchanged('the 15m ob at 6140 held. need to call my mom tonight. anyway price respected the ob.', 'then it ran to the pdh at 6162.')
  })

  it('never moves a sentence far, or across a new day', () => {
    // A thought that comes back four paragraphs later stays where it was written.
    const far = doc(p('the ob at 6140 held.'), p('need to call my mom tonight.'), p('felt good.'), p('lesson: be patient.'), p('anyway price respected the ob at 6140.'))
    expect(organize(far).regrouped).toBe(0)
    // A paragraph that starts with a day (or a date) starts afresh.
    expect(organize(doc(p('the ob at 6140 held. need to call my mom tonight.'), p('price respected the ob at 6140.'))).regrouped).toBe(1)
    expect(organize(doc(p('the ob at 6140 held. need to call my mom tonight.'), p('tuesday price respected the ob at 6140.'))).regrouped).toBe(0)
    expect(organize(doc(p('the ob at 6140 held. need to call my mom tonight.'), p('nov 25 price respected the ob at 6140.'))).regrouped).toBe(0)
    // Three weeks of daily entries without headings keep every paragraph where it is.
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
    const paragraphs: RichNode[] = []
    for (let week = 0; week < 3; week++) {
      days.forEach((day, n) => {
        const at = 6100 + week * 15 + n * 3
        paragraphs.push(
          p(`${day} premarket bias was bullish from the daily fvg at ${at} and the nwog at ${at + 20} was the draw, asia was tight and london took the asia low at ${at - 10} then displaced up leaving a 5m fvg`),
          p(`took long at ${at + 4} in the ifvg stop ${at - 4} tp ${at + 30} got stopped out first time lol felt fomo and re entered to early. second entry worked +2r`),
          p('honestly i felt impatient most of the morning and i know thats when i make my worst trades, i need to trust the process and let the setup come to me'),
          p(`the pdh at ${at + 35} got swept at 11:15 like i planned so the bias was right, ny am killzone was clean and silver bullet 10-11 gave the move`),
          p('lesson dont chase the first push wait for mss. next time i will size down after a loss and walk away after 2 losers'),
          p('felt calm after tho, went to the gym and came back to review the replay on tradingview, marked up the 15m ob and the bpr for tomorrow')
        )
      })
    }
    const long = organize(doc(...paragraphs))
    expect(long.regrouped).toBe(0)
    expect(long.doc.content).toHaveLength(paragraphs.length)
    expect(long.doc).toEqual(organize(doc(...paragraphs), null, 'tidy').doc)
  })

  it('keeps lines broken with Shift+Enter as they are', () => {
    const input = doc(p('bias bearish from daily fvg at 6150', { type: 'hardBreak' }, 'felt tired today didnt sleep', { type: 'hardBreak' }, 'price swept bsl at 6142 in london', { type: 'hardBreak' }, 'shorted 6138 stop 6146 tp 6110 +2r'))
    const result = organize(input)
    expect(result.regrouped).toBe(0)
    expect(outline(result.doc)).toEqual(["Bias bearish from daily FVG at 6150.⏎Felt tired today didn't sleep.⏎Price swept BSL at 6142 in London.⏎Shorted 6138 stop 6146 TP 6110 +2R"])
    expect(nonText(result.doc, true)).toEqual(nonText(input, true))
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
    const input = doc(p('took long at 6104 stop 6096. ugh my coffee spilled everywhere. anyway the long ran to 6120 for +2r'), image('trade-chart-1'), p('london swept the high at 6140. need to call my mom tonight. the high at 6140 was the draw for the pm session'))
    const result = organize(input)
    expect(outline(result.doc)).toEqual([
      'Took long at 6104 stop 6096. Anyway the long ran to 6120 for +2R.',
      'Ugh my coffee spilled everywhere.',
      '[image trade-chart-1]',
      'London swept the high at 6140. The high at 6140 was the draw for the PM session.',
      'Need to call my mom tonight.'
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
      p('took long at 6104 stop 6096. my dog keeps barking at the mailman. ok back to the trade, second long at 6110 worked +2r'),
      { type: 'heading', attrs: { level: 2 }, content: [text('tuesday')] },
      p('no trades today')
    )
    expect(outline(organize(input).doc)).toEqual(['## Monday', 'Took long at 6104 stop 6096. Ok back to the trade, second long at 6110 worked +2R.', 'My dog keeps barking at the mailman.', '## Tuesday', 'No trades today'])
  })

  it('leaves a line written later where it is, and leaves an organized note as it is', () => {
    const first = organize(doc(p(EXAMPLE_STRAY))).doc
    const later = doc(...first.content!, p('pdh got taken at 11:30 then price reversed'), p())
    const result = organize(later)
    expect(outline(result.doc)).toEqual([...outline(first), 'PDH got taken at 11:30 then price reversed.', ''])
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

/** A thought that strays off and comes back: what it left, the stray, the return. */
const STRAYS: Array<[string, string, string]> = [
  ['london swept the asia low at 6090', 'ugh my neighbor is drilling again', 'anyway the displacement left a fvg at 6098'],
  ['the 15m ob at 6140 held', 'need to call my mom tonight', 'price respected the ob at 6140 and ran'],
  ['took long at 6104 stop 6096', 'my coffee spilled everywhere lol', 'ok back to the trade it ran to 6130 for +2r'],
  ['bias bearish below the nwog at 6120', 'felt tired today didnt sleep', 'anyway the nwog held as resistance']
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
      const sentence = rand() < 0.15 ? pick(STRAYS).join('. ') : pick(POOL)
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
      // Pictures, drawings and line breaks: all there, once each, in the same order.
      expect(nonText(result.doc, true), label).toEqual(nonText(note, true))
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
    for (let i = 0; i < sentences.length; i += 6) {
      // Every third paragraph has a thought in it that strays and comes back.
      const stray = paragraphs.length % 3 === 0 ? [...STRAYS[paragraphs.length % STRAYS.length]!] : []
      paragraphs.push(p([...sentences.slice(i, i + 6), ...stray].join('. ')))
    }
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
