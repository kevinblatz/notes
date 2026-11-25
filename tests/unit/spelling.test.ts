import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyTextEdits, correctText } from '@shared/autocorrect'
import { Dictionary, editDistance, parseWordList } from '@shared/dictionary'
import { MAX_USER_WORDS, sanitizeUserWords } from '@shared/preferences'
import { buildDictionary, findMisses, isInflectionOf, matchCase, slipCost, Speller, tokenize, wordAt } from '@shared/spelling'
import { TERMS } from '@shared/tradingTerms'

const WORD_LIST = readFileSync(resolve(__dirname, '../../src/shared/words/en-US.txt'), 'utf8')
const dictionary = buildDictionary(WORD_LIST)
const speller = new Speller(dictionary)

/** The text after autocorrect. */
const corrected = (text: string, by: Speller = speller): string => applyTextEdits(text, correctText(text, by).edits)
/** The words that would be underlined. */
const misses = (text: string, by: Speller = speller): string[] => findMisses(text, by).map((range) => text.slice(range.from, range.to))

describe('the word list', () => {
  it('is the SCOWL list up to level 60, with commonness levels', () => {
    const plain = parseWordList(WORD_LIST)
    expect(plain.size).toBeGreaterThan(70_000)
    expect(plain.level('the')).toBe(10)
    expect(plain.level('impatient')).toBe(35)
    expect(plain.level('liquidity')).toBe(50)
    // Rare words above level 60 are left out so they cannot hide typos.
    expect(plain.level('aecium')).toBeUndefined()
    // It has no names, capitals or apostrophes: the checker adds those itself.
    expect(plain.level("don't")).toBeUndefined()
    expect(dictionary.form("don't")).toBe("don't")
    expect(dictionary.form('london')).toBe('London')
    expect(dictionary.form('monday')).toBe('Monday')
    expect(dictionary.form('premarket')).toBe('premarket')
  })

  it('finds every word within one or two edits, swaps included, exactly as a brute-force search does', () => {
    const small = new Dictionary()
    const words = ['stop', 'stops', 'step', 'steps', 'top', 'tops', 'spot', 'post', 'pots', 'opts', 'stoop', 'stomp', 'strop', 'sweep', 'swept', 'the', 'then', 'than', 'that']
    words.forEach((word, i) => small.add(word, 10 + (i % 5) * 10))
    for (const probe of ['stpo', 'sotp', 'stop', 'tsop', 'swpet', 'teh', 'thn', 'st', 'stopss', 'spto']) {
      for (const limit of [1, 2]) {
        const expected = words.filter((word) => editDistance(probe, word) <= limit).sort()
        expect(small.near(probe, limit).map((near) => near.word).sort(), `${probe} within ${limit}`).toEqual(expected)
        for (const near of small.near(probe, limit)) expect(near.distance).toBe(editDistance(probe, near.word))
      }
    }
  })

  it('counts a swap of neighbours as one edit', () => {
    expect(editDistance('teh', 'the')).toBe(1)
    expect(editDistance('recieve', 'receive')).toBe(1)
    expect(editDistance('displacment', 'displacement')).toBe(1)
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })

  it('searches the whole list quickly', () => {
    const started = performance.now()
    for (const word of ['displacment', 'consolodation', 'manipulaton', 'liquidty', 'retracment', 'patiance', 'imapatient', 'discipine']) dictionary.near(word, 2)
    expect(performance.now() - started).toBeLessThan(400)
  })
})

describe('trading terms', () => {
  it('are never underlined, in any case, with plurals and possessives', () => {
    const text = 'nwog ndog fvg Fvg FVG ifvg ifvgs IFVG’s IFVG\'s bisi sibi bpr ote smt mss bos choch cisd pdh pdl pwh pwl pda eqh eql erl irl dol htf ltf ssl bsl adr amd po3 cbdr ipda mmxm mmbm mmsm fomc cpi nfp ppi vwap rth dxy spx nq mnq mes yym rty killzone killzones premarket unswept rebalance retracement Judas judas'
    expect(misses(text).filter((word) => word !== 'yym')).toEqual([])
  })

  it('are written in their usual form', () => {
    expect(corrected('fvg ifvgs nwog choch Fvg ifvg\'s po3 vwap fomc')).toBe("FVG IFVGs NWOG CHoCH FVG IFVG's PO3 VWAP FOMC")
    expect(corrected('asia and london then ny')).toBe('Asia and London then NY')
  })

  it('leave ALL-CAPS spellings alone', () => {
    expect(corrected('CHOCH and IFVGS')).toBe('CHOCH and IFVGS')
  })

  it('rewrite short codes that are also words only in a market sentence', () => {
    expect(corrected('I am late and es is nice')).toBe('I am late and es is nice')
    expect(corrected('ny am killzone, then the pm session')).toBe('NY AM killzone, then the PM session')
    expect(corrected('i am in the ny session')).toBe('I am in the NY session')
    expect(corrected('long es at 6100 and the ob held')).toBe('long ES at 6100 and the OB held')
    expect(corrected('the spy was caught')).toBe('the spy was caught')
    expect(corrected('spy broke the pdh')).toBe('SPY broke the PDH')
    // Never underlined, either way.
    expect(misses('I am late. es ob bb sb vi eth kz')).toEqual([])
  })

  it('do not collide with English words, apart from a few rare ones', () => {
    const english = parseWordList(WORD_LIST)
    const collisions = [...TERMS].filter(([key, term]) => !term.ambiguous && english.level(key) !== undefined).map(([key]) => key)
    expect(collisions.sort()).toEqual(['hod', 'hods', 'mes'])
  })
})

describe('never underlined or changed', () => {
  it('numbers, prices, times, percentages, timeframes, tickers, addresses', () => {
    const text = 'at 6123.25 and 6,123.25 for $500 or -$120 at 9:30 09:31:05 9:30am 10am up 12% on 1m 5m 15m 4H H1 M15 with 2R +2R -1R on ES1! NQ1! see https://tradingview.com/x www.example.com tradingview.com me@example.com 10-11 1:2 1st'
    expect(misses(text)).toEqual([])
    expect(corrected(text)).toBe(text)
  })

  it('but r multiples get their capital R', () => {
    expect(corrected('second entry worked +2r and -1r')).toBe('second entry worked +2R and -1R')
    expect(misses('+2r')).toEqual([])
  })

  it('acronyms of two to six capitals, words with a capital inside, and names mid-sentence', () => {
    const text = 'the ABC and XYZQ levels on TradingView and iPhone, Powell and Kenzie said'
    expect(misses(text)).toEqual([])
    expect(corrected(text)).toBe(text)
  })

  it('the user’s own words, in any case', () => {
    const mine = new Speller(dictionary, ['kenzie', 'Smoove'])
    expect(misses('kenzie and smoove and SMOOVE', mine)).toEqual([])
    expect(corrected('kenzie and smoove', mine)).toBe('kenzie and smoove')
    // ... and they are suggested for close misspellings.
    expect(mine.suggest('smoovee')).toContain('Smoove')
  })

  it('text the caller locks (links, code)', () => {
    const text = 'teh dont teh'
    const locked = (from: number, to: number): boolean => from < 3 && to > 0
    expect(applyTextEdits(text, correctText(text, speller, locked).edits)).toBe("teh don't the")
    expect(findMisses(text, speller, locked).map((r) => text.slice(r.from, r.to))).toEqual(['dont', 'teh'])
  })

  it('casual words and trader shorthand', () => {
    expect(misses('lol tho gonna btw imo tbh ok yeah')).toEqual([])
    expect(corrected('lol tho gonna')).toBe('lol tho gonna')
  })
})

describe('autocorrect', () => {
  it('puts back the apostrophes of contractions', () => {
    expect(corrected('dont didnt doesnt cant wont isnt wasnt werent arent couldnt shouldnt wouldnt havent hasnt')).toBe("don't didn't doesn't can't won't isn't wasn't weren't aren't couldn't shouldn't wouldn't haven't hasn't")
    expect(corrected('im ive youre theyre thats whats theres')).toBe("I'm I've you're they're that's what's there's")
    // "lets" and "its" are words of their own and stay ("its" only becomes "it's" where it
    // cannot be the possessive: see the grammar slips below).
    expect(corrected('it lets me and its range held')).toBe('it lets me and its range held')
  })

  it('makes a standalone i a capital I', () => {
    expect(corrected("i think i was early, i'm sure, i’m sure")).toBe("I think I was early, I'm sure, I’m sure")
    expect(misses('i')).toEqual(['i'])
  })

  it('fixes common slips and a few safe shorthands', () => {
    expect(corrected('teh adn taht recieve seperate definately alot')).toBe('the and that receive separate definitely a lot')
    expect(corrected('bc b/c w/ w/o tmrw tmr b4')).toBe('because because with without tomorrow tomorrow before')
  })

  it('keeps the capitals the word was typed with', () => {
    expect(corrected('Dont Teh DISPLACMENT')).toBe("Don't The DISPLACEMENT")
    expect(matchCase('london', 'London')).toBe('London')
    expect(matchCase('Im', "I'm")).toBe("I'm")
  })

  it('corrects misspellings to the closest, most likely word', () => {
    const cases: Record<string, string> = {
      displacment: 'displacement', imapatient: 'impatient', tommorrow: 'tomorrow', enterd: 'entered', stoped: 'stopped', liek: 'like',
      wiat: 'wait', retracment: 'retracement', consolodation: 'consolidation', bullsih: 'bullish', beraish: 'bearish', liquidty: 'liquidity',
      patiance: 'patience', discipine: 'discipline', killzon: 'killzone', premarkt: 'premarket', manipulaton: 'manipulation', shoud: 'should'
    }
    for (const [typo, word] of Object.entries(cases)) expect(speller.fix(typo), typo).toBe(word)
  })

  it('leaves a word alone when no candidate clearly wins, but still underlines it', () => {
    // "swep" is one letter from both "sweep" and "swept".
    expect(speller.fix('swep')).toBeNull()
    expect(misses('the swep')).toEqual(['swep'])
    expect(speller.suggest('swep').slice(0, 2).sort()).toEqual(['sweep', 'swept'])
    // Two letters replaced in a five-letter word is too far to guess.
    expect(speller.fix('becuz')).toBeNull()
  })

  it('leaves a word alone when it is a known word with an ending added or taken away', () => {
    expect(isInflectionOf('overtrade', 'overtraded')).toBe(true)
    expect(isInflectionOf('setups', 'setup')).toBe(true)
    expect(isInflectionOf('scalps', 'scalped')).toBe(true)
    // Real slips are still corrected.
    expect(isInflectionOf('stoped', 'stopped')).toBe(false)
    expect(isInflectionOf('enterd', 'entered')).toBe(false)
    const small = new Dictionary()
    small.add('scalped', 10)
    expect(new Speller(small).fix('scalps')).toBeNull()
    expect(new Speller(small).fix('scalpe')).toBeNull()
    expect(new Speller(small).fix('scalpde')).toBe('scalped')
    expect(corrected('didnt overtrade')).toBe("didn't overtrade")
  })

  it('changes words of one or two letters only through the fixed lists', () => {
    expect(corrected('ot is ti')).toBe('ot is ti')
    expect(corrected('im')).toBe("I'm")
  })

  it('ranks by distance, then trading words, then commonness, then the likelier slip', () => {
    expect(slipCost('teh', 'the')).toBe(1)
    expect(slipCost('enterd', 'entered')).toBe(1)
    expect(slipCost('enterd', 'enters')).toBe(2)
    expect(slipCost('stoped', 'stopped')).toBe(1)
    expect(slipCost('tje', 'the')).toBe(2)
    expect(slipCost('tqe', 'the')).toBe(3)
  })

  it('flags a capitalised word at the start of a sentence only when it is clearly a misspelling', () => {
    expect(misses('Imapatient again. Kenzie said hi. Teh end.')).toEqual(['Imapatient', 'Teh'])
    expect(corrected('Imapatient again. Kenzie said hi.')).toBe('Impatient again. Kenzie said hi.')
  })

  it('fixes "to" before too-words, joins "re" to its word and drops doubled words', () => {
    expect(corrected('re entered to early.')).toBe('re-entered too early.')
    expect(corrected('i took to many trades and it was to much')).toBe('I took too many trades and it was too much')
    expect(corrected('the the market')).toBe('the market')
    // English that must stay as it is.
    expect(corrected('this applies to many traders')).toBe('this applies to many traders')
    expect(corrected('i want to close it and to slow down')).toBe('I want to close it and to slow down')
    expect(corrected('he had had enough, that that was it')).toBe('he had had enough, that that was it')
    expect(corrected('re the trade')).toBe('re the trade')
  })

  it('is stable: correcting corrected text changes nothing', () => {
    const once = corrected("nwog at 6120 was the draw, i was bullish bc pdh unswept. took long at 6104 stop 6096 re entered to early. dont chase, wait for mss")
    expect(corrected(once)).toBe(once)
  })
})

describe('trader words', () => {
  it('leaves shorthand and trading words as typed: never underlined, never "corrected" into another word', () => {
    const words =
      'journaling backtest backtesting fakeout stopout rewatched intraday prop rangebound nonfarm eval evals topstep acct acc avg max vol prev liq cont mkt pos qty approx sec vid lon ldn eod wk yr esp bal fxreplay wifi intro admin config tech breathwork bro rekt prolly r:r'
    expect(misses(words)).toEqual([])
    expect(corrected(words)).toBe(words.replace('topstep', 'Topstep'))
    const sentences: Record<string, string> = {
      'need to keep journaling every day and backtest more on fxreplay': 'need to keep journaling every day and backtest more on fxreplay',
      'Topstep eval failed': 'Topstep eval failed',
      'waited 30 sec after the candle closed then entered, max 2 contracts': 'waited 30 sec after the candle closed then entered, max 2 contracts',
      'avg entry 6104, acct up 3% this week': 'avg entry 6104, acct up 3% this week',
      'lon high at 6131 got taken, then ny reversed': 'lon high at 6131 got taken, then NY reversed',
      'that was a fakeout, classic stopout then it ran': 'that was a fakeout, classic stopout then it ran',
      'watched a vid on the silver bullet, intro was long': 'watched a vid on the silver bullet, intro was long',
      'my wifi dropped at the open': 'my wifi dropped at the open',
      'did some breathwork before the open': 'did some breathwork before the open',
      'prev day high at 6140, vol was low': 'prev day high at 6140, vol was low',
      'liq above the highs, cont higher expected': 'liq above the highs, cont higher expected',
      'bro this market is rekt lol': 'bro this market is rekt lol',
      'took it on my topstep eval through tradovate and charted on tradingview': 'took it on my Topstep eval through Tradovate and charted on TradingView',
      'the new york session was rangebound and r:r was 1:3': 'the New York session was rangebound and r:r was 1:3'
    }
    for (const [typed, expected] of Object.entries(sentences)) expect(corrected(typed), typed).toBe(expected)
  })

  it('changes a word of four letters or fewer only when two neighbouring letters were swapped', () => {
    expect(speller.fix('lnog')).toBe('long')
    expect(speller.fix('liek')).toBe('like')
    // Anything else is underlined and suggested, never changed.
    expect(speller.fix('thw')).toBeNull()
    expect(misses('thw open')).toEqual(['thw'])
    expect(speller.suggest('thw')).toContain('the')
    for (const word of ['iwm', 'pos', 'qty', 'bal', 'yrs', 'wks', 'esp', 'tech', 'atl']) expect(speller.fix(word) ?? word, word).not.toMatch(/^(?:I'm|post|RTY|ball|yes|was|Sep|teach|at)$/)
  })

  it('keeps a word made of known parts as typed, unless only its ending is wrong', () => {
    for (const word of ['retraded', 'flatlined', 'mispriced', 'recentered', 'chartbook', 'forwardtest', 'macbooks']) expect(speller.fix(word), word).toBeNull()
    const slips: Record<string, string> = { enterring: 'entering', stoped: 'stopped', transfering: 'transferring', opend: 'opened', tradeing: 'trading', begining: 'beginning', runing: 'running' }
    for (const [typo, word] of Object.entries(slips)) expect(speller.fix(typo), typo).toBe(word)
  })

  it('accepts British spellings as they are', () => {
    const british = 'realised behaviour analysed colour organised favourite centre travelled grey practise defence catalogue'
    expect(misses(british)).toEqual([])
    expect(corrected(british)).toBe(british)
    expect(misses('I realised my behaviour after a loss is the problem. I analysed the colour of the candles')).toEqual([])
    // Not a misspelling that only looks British.
    expect(speller.fix('fourty')).toBe('forty')
    expect(misses('the sise of it')).toEqual(['sise'])
  })

  it('know the ICT codes in lower case: never underlined, written in capitals', () => {
    const codes = 'ce poi idm ith itl sth stl lth ltl sfp lv rdrb idr rto msb iofed lokz nykz orh orl org mt dr pd pb ib cl gc atl mtf'
    expect(misses(codes)).toEqual([])
    expect(misses('two fvgs and three ifvgs, the fvg’s ce held')).toEqual([])
    expect(corrected('ce of the fvg held, idm got swept at 9:35 and the sfp at the ith was the poi')).toBe('CE of the FVG held, IDM got swept at 9:35 and the SFP at the ITH was the POI')
    expect(corrected('the org filled at 9:35, mt of the ob held at 6100, the stl and lokz high')).toBe('the ORG filled at 9:35, MT of the OB held at 6100, the STL and LOKZ high')
    expect(corrected('the pd array was clean')).toBe('the PD array was clean')
    // Codes that are also words or abbreviations change only in a market sentence.
    expect(corrected('the org meeting at work and mt everest, dr said rest')).toBe('the org meeting at work and mt everest, dr said rest')
  })

  it('fixes the grammar slips a hurried journal makes, only where there is no doubt', () => {
    expect(corrected('should of waited, could of been +3r, i shouldnt of took it, would of just waited')).toBe("should have waited, could have been +3R, I shouldn't have took it, would have just waited")
    expect(corrected('i was to nervous to take it and to tired to care, to scared to enter')).toBe('I was too nervous to take it and too tired to care, too scared to enter')
    expect(corrected('my stop was to high. i was to slow')).toBe('my stop was too high. I was too slow')
    expect(corrected('its not the setup, its been a week, its a good day, its fine')).toBe("it's not the setup, it's been a week, it's a good day, it's fine")
    expect(corrected('i dont want to loose more than 1r. if i loose 2 trades i stop. stop loosing')).toBe("I don't want to lose more than 1R. if I lose 2 trades I stop. stop losing")
    expect(corrected('a ifvg, a ob, a ote and a ny open. A IFVG. TOOK A IFVG')).toBe('an IFVG, an OB, an OTE and a NY open. An IFVG. TOOK AN IFVG')
    // English that must stay as it is.
    expect(corrected('could of course, the market and its range, cut loose, price went to high of day, need to slow down')).toBe(
      'could of course, the market and its range, cut loose, price went to high of day, need to slow down'
    )
    expect(corrected('a fvg and a mss')).toBe('a FVG and a MSS')
  })

  it('writes "it\u2019s" for "its" only before words that cannot follow "its" as an owner', () => {
    expect(corrected("its just the god candles. its very hard to wait. its all good. its ok, its over, its about time, its really not, its too much, its so slow")).toBe(
      "it's just the god candles. it's very hard to wait. it's all good. it's ok, it's over, it's about time, it's really not, it's too much, it's so slow"
    )
    expect(corrected('its going to run, its gonna run, its the open, its an IFVG, its hard to sit, its crazy how fast, its done.')).toBe(
      "it's going to run, it's gonna run, it's the open, it's an IFVG, it's hard to sit, it's crazy how fast, it's done."
    )
    // Where "its" owns what follows, it stays.
    expect(corrected('its range, its high, its own range, its going rate, its all-time high, its all time high, its very own range, its very first candle')).toBe(
      'its range, its high, its own range, its going rate, its all-time high, its all time high, its very own range, its very first candle'
    )
    expect(corrected('its hard edge, its wild swings, its crazy volatility, its weird wick, its really long wick, its like count, its done deal')).toBe(
      'its hard edge, its wild swings, its crazy volatility, its weird wick, its really long wick, its like count, its done deal'
    )
  })

  it('capitalises day and month names; the ones that are also words only as dates', () => {
    expect(corrected('monday tuesday wednesday thursday friday saturday sunday, fridays')).toBe('Monday Tuesday Wednesday Thursday Friday Saturday Sunday, Fridays')
    expect(corrected('january february april june july august september october november december')).toBe('January February April June July August September October November December')
    expect(corrected('jan feb apr jun jul aug sep sept oct nov dec, mon tue thu fri')).toBe('Jan Feb Apr Jun Jul Aug Sep Sept Oct Nov Dec, Mon Tue Thu Fri')
    expect(corrected('on may 5th and march 20, 2026. in march it ran. the 5th of may. since may the range held. 3rd march')).toBe(
      'on May 5th and March 20, 2026. in March it ran. the 5th of May. since May the range held. 3rd March'
    )
    expect(corrected('sat 11/22 was slow, wed nov 25 too')).toBe('Sat 11/22 was slow, Wed Nov 25 too')
    // The words stay words.
    expect(corrected('price may march on. we sat in the sun. the sun may rise. we may 2 more contracts. march 20 was the low')).toBe(
      'price may march on. we sat in the sun. the sun may rise. we may 2 more contracts. march 20 was the low'
    )
  })
})

describe('reading text', () => {
  it('splits words from punctuation and knows where sentences start', () => {
    const tokens = tokenize('ok. then "this" — 09:31:05 — fvg, re-entered')
    expect(tokens.map((t) => [t.text, t.kind, t.sentenceStart])).toEqual([
      ['ok', 'word', true],
      ['then', 'word', true],
      ['this', 'word', false],
      ['09:31:05', 'protected', false],
      ['fvg', 'word', false],
      ['re', 'word', false],
      ['entered', 'word', false]
    ])
    const log = tokenize('09:31:05 — london high taken')
    expect(log.map((t) => t.sentenceStart)).toEqual([true, true, false, false])
    expect(tokenize('e.g. this').map((t) => t.sentenceStart)).toEqual([true, false])
  })

  it('finds the word under the pointer for the right-click menu', () => {
    const text = 'the displacment was clean'
    expect(wordAt(text, 7, speller)?.token.text).toBe('displacment')
    expect(wordAt(text, 3, speller)?.token.text).toBe('the')
    expect(wordAt(text, 100, speller)).toBeNull()
  })

  it('underlines nothing before the word list has loaded', () => {
    const waiting = new Speller(null)
    expect(waiting.ready).toBe(false)
    expect(findMisses('teh displacment dont', waiting)).toEqual([])
  })
})

describe('the user’s words', () => {
  it('are trimmed single words, without duplicates, capped', () => {
    expect(sanitizeUserWords(['  Kenzie ', 'kenzie', 'two words', '', 42, 'x'.repeat(60), '123', 'Smoove'])).toEqual(['Kenzie', 'Smoove'])
    expect(sanitizeUserWords('nope')).toEqual([])
    expect(sanitizeUserWords(Array.from({ length: MAX_USER_WORDS + 50 }, (_, i) => `word${i}`))).toHaveLength(MAX_USER_WORDS)
  })

  it('never hold control or invisible characters', () => {
    expect(sanitizeUserWords(['bad\u0000word', 'zero\u200bwidth', 'join\u200dme', 'bom\ufeffword', 'word\u2060joiner', 'tab\tword', 'Kenzie'])).toEqual(['Kenzie'])
  })
})
