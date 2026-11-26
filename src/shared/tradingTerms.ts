/**
 * The trading vocabulary the spelling checker knows on top of the English word list: ICT and
 * smart-money terms, sessions, instruments, news events and the everyday words of a trading
 * journal. None of these is ever underlined, and autocorrect (and Organize) writes them in
 * their usual form: fvg -> FVG, ifvgs -> IFVGs, nwog -> NWOG, choch -> CHoCH, asia -> Asia.
 *
 * Some short codes are also ordinary English (am, es, ob, bb, sb, vi, eth ...). They are never
 * underlined either, but they are only rewritten when the sentence is clearly about the
 * market (see `AMBIGUOUS_TERMS`), so "I am late" never becomes "I AM late".
 */

/**
 * Terms whose usual form is not all lower case. A lower-case or capitalised spelling of any of
 * them is rewritten to the form given here. Acronyms also get their plural (FVGs) and
 * possessive (FVG's) for free.
 */
export const CANONICAL_TERMS: readonly string[] = [
  // ICT / smart-money concepts
  'NWOG', 'NDOG', 'FVG', 'IFVG', 'BISI', 'SIBI', 'BPR', 'OTE', 'SMT', 'MSS', 'BOS', 'CHoCH', 'CISD',
  'PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML', 'PDA', 'EQH', 'EQL', 'ERL', 'IRL', 'DOL', 'HTF', 'LTF', 'SSL', 'BSL',
  'ADR', 'AMD', 'PO3', 'CBDR', 'IPDA', 'MMXM', 'MMBM', 'MMSM', 'SMC', 'ICT', 'LRLR', 'HRLR', 'NYOS',
  'ONH', 'ONL', 'IBH', 'IBL', 'HOD', 'LOD', 'ATH', 'ATL', 'POC', 'VAH', 'LVN', 'HVN',
  'CE', 'IDM', 'ITH', 'ITL', 'STH', 'STL', 'LTH', 'LTL', 'SFP', 'LV', 'RDRB', 'IDR', 'RTO', 'MSB', 'IOFED', 'LOKZ', 'NYKZ',
  'ORH', 'ORL', 'MTF',
  // news, indicators, sessions, exchanges
  'FOMC', 'CPI', 'NFP', 'PPI', 'GDP', 'PCE', 'VWAP', 'RTH', 'DXY', 'SPX', 'VIX', 'ATR', 'EMA', 'SMA', 'RSI', 'MACD',
  'NY', 'NYC', 'NYSE', 'CME', 'Globex', 'Nasdaq', 'Asia', 'Asian', 'London', 'Frankfurt', 'Judas',
  // instruments
  'NQ', 'MNQ', 'YM', 'MYM', 'RTY', 'M2K', 'MES', 'QQQ', 'IWM', 'MGC', 'MCL',
  // platforms and prop firms
  'TradingView', 'Tradovate', 'NinjaTrader', 'Topstep', 'Rithmic', 'Bookmap', 'Tradezella', 'Tradervue',
  // trade management
  'TP', 'TP1', 'TP2', 'TP3', 'SL', 'PnL', 'RR', 'FOMO'
]

/**
 * Codes that are also ordinary words or letters. Their canonical spelling is used only in a
 * sentence that is clearly about the market: one that has another trading term, a price, a
 * time or a timeframe in it. AM and PM go further and need "NY", a session or a killzone
 * right next to them ("ny am killzone" -> "NY AM killzone").
 */
export const AMBIGUOUS_TERMS: readonly string[] = ['ES', 'ETH', 'OB', 'BB', 'MB', 'RB', 'SB', 'VI', 'KZ', 'SPY', 'AM', 'PM', 'ORG', 'MT', 'DR', 'PD', 'PB', 'IB', 'POI', 'CL', 'GC']

/** Words next to which "am" / "pm" are the New York sessions rather than the verb or a clock. */
export const SESSION_NEIGHBOURS: ReadonlySet<string> = new Set(['ny', 'london', 'asia', 'session', 'sessions', 'killzone', 'killzones', 'kz', 'macro', 'macros', 'open', 'opening', 'range', 'high', 'low', 'trend', 'reversal', 'silver', 'bullet'])

/**
 * Everyday trading words. They are known even when the English list lacks them (premarket,
 * killzone), and they win close calls when a misspelling could be one of several words
 * ("displacment" is "displacement").
 */
export const TRADING_WORDS: readonly string[] = [
  'market', 'markets', 'liquidity', 'displacement', 'entry', 'entries', 'stop', 'stops', 'stopped', 'target', 'targets',
  'bias', 'bearish', 'bullish', 'session', 'sessions', 'premium', 'discount', 'equilibrium', 'imbalance', 'imbalances',
  'retracement', 'retracements', 'retrace', 'retraced', 'consolidation', 'consolidating', 'expansion', 'reversal', 'reversals',
  'sweep', 'sweeps', 'swept', 'sweeping', 'unswept', 'structure', 'mitigation', 'mitigated', 'unmitigated', 'rebalance',
  'rebalanced', 'rebalancing', 'premarket', 'postmarket', 'killzone', 'killzones', 'breakout', 'breakouts', 'breakdown',
  'pullback', 'pullbacks', 'retest', 'retested', 'retesting', 'wick', 'wicks', 'candle', 'candles', 'range', 'gap', 'gaps',
  'high', 'highs', 'low', 'lows', 'trend', 'chop', 'choppy', 'scalp', 'scalped', 'scalping', 'runner', 'runners', 'partial',
  'partials', 'breakeven', 'drawdown', 'setup', 'setups', 'trade', 'trades', 'traded', 'trading', 'long', 'longs', 'short',
  'shorts', 'contract', 'contracts', 'position', 'profit', 'profits', 'loss', 'losses', 'risk', 'reward', 'tick', 'ticks',
  'points', 'level', 'levels', 'order', 'block', 'blocks', 'breaker', 'breakers', 'inversion', 'inverted', 'accumulation',
  'manipulation', 'distribution', 'delivery', 'draw', 'raid', 'raided', 'purge', 'purged', 'invalidation', 'invalidated',
  'confluence', 'confirmation', 'momentum', 'volatility', 'volume', 'overnight', 'orderflow', 'untapped', 'unfilled',
  'filled', 'fill', 'macro', 'macros', 'unicorn', 'turtle', 'soup', 'silver', 'bullet', 'swing', 'rejection', 'respected',
  'journal', 'patience', 'discipline', 'overtrade', 'overtrades', 'overtrading', 'overtraded', 'revenge', 'tilt', 'tilted', 'impatient', 'reentry',
  'reentered', 'futures', 'narrative', 'algo', 'algos', 'backtest', 'backtests', 'backtested', 'backtesting', 'journaling', 'journaled',
  'fakeout', 'fakeouts', 'stopout', 'stopouts', 'rewatch', 'rewatched', 'rewatching', 'intraday', 'prop', 'rangebound', 'nonfarm',
  'payout', 'payouts', 'gappy', 'uptrend', 'downtrend', 'whipsaw', 'whipsawed', 'daytrade', 'daytrading', 'daytrader'
]

/**
 * Short words of trader's shorthand and texting that are left exactly as typed: never
 * underlined, never "corrected" (lol stays lol).
 */
export const CASUAL_WORDS: readonly string[] = [
  'lol', 'lmao', 'haha', 'hahaha', 'tho', 'thru', 'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'btw', 'imo', 'imho', 'tbh',
  'ngl', 'idk', 'ok', 'okay', 'yeah', 'yep', 'yup', 'nope', 'nah', 'omg', 'smh', 'rn', 'fr', 'af', 'pls', 'plz', 'ppl',
  'mins', 'min', 'hrs', 'hr', 'secs', 'pts', 'pt', 'yday', 'vs', 'etc', 'eg', 'ie', 'aka', 'ish'
]

/**
 * Trader's and texting shorthand, kept exactly as typed and never underlined like the casual
 * words, but never offered as a correction either (so a typo is never "fixed" into "mkt").
 */
export const SHORTHAND_WORDS: readonly string[] = [
  'acct', 'accts', 'acc', 'avg', 'max', 'vol', 'vols', 'prev', 'liq', 'cont', 'mkt', 'mkts', 'pos', 'qty', 'approx', 'sec', 'vid', 'vids',
  'lon', 'ldn', 'eod', 'eow', 'eom', 'wk', 'wks', 'yr', 'yrs', 'esp', 'bal', 'tf', 'tfs', 'eval', 'evals', 'fxreplay', 'bto', 'stc', 'wknd',
  'r:r', 'premkt', 'nite', 'overnite', 'fomoed', "fomo'd", 'bro', 'bruh', 'fam', 'rekt', 'sus', 'prolly', 'tryna', 'finna', 'lowkey',
  'cuz', 'coz', 'tbf', 'iirc', 'afaik', 'wtf', 'ffs', 'oof', 'welp', 'yolo', 'thx', 'ty', 'np', 'def', 'prob', 'probs', 'rly', 'pic',
  'pics', 'convo', 'u', 'ur'
]

export interface TermEntry {
  /** The usual spelling, e.g. "FVG", "CHoCH", "Asia". */
  canonical: string
  /** Also an ordinary word: rewritten only in a market sentence. */
  ambiguous: boolean
}

function buildTerms(): Map<string, TermEntry> {
  const map = new Map<string, TermEntry>()
  const add = (form: string, canonical: string, ambiguous: boolean): void => {
    const key = form.toLowerCase()
    if (!map.has(key)) map.set(key, { canonical: form === canonical ? canonical : form, ambiguous })
  }
  const withForms = (canonical: string, ambiguous: boolean): void => {
    add(canonical, canonical, ambiguous)
    // Plurals of acronyms: FVGs, OBs. Not for codes that already end in S (BOS, MSS) or a digit.
    const acronym = /^[A-Z][A-Za-z0-9+]*[A-Z]$/.test(canonical) && canonical.length >= 2
    if (acronym && !/S$/.test(canonical)) add(`${canonical}s`, `${canonical}s`, ambiguous)
  }
  for (const term of CANONICAL_TERMS) withForms(term, false)
  for (const term of AMBIGUOUS_TERMS) withForms(term, true)
  return map
}

/** Every trading term by its lower-case spelling. */
export const TERMS: ReadonlyMap<string, TermEntry> = buildTerms()

/** Trading words and casual shorthand, lower case. */
export const TRADING_WORD_SET: ReadonlySet<string> = new Set(TRADING_WORDS)
export const CASUAL_WORD_SET: ReadonlySet<string> = new Set([...CASUAL_WORDS, ...SHORTHAND_WORDS])

/** The term a word (any case, with or without 's) stands for, or null. */
export function lookupTerm(word: string): TermEntry | null {
  return TERMS.get(word.toLowerCase()) ?? null
}

/**
 * ICT terms written out in words, with the code each one stands for: "new week opening gap" is
 * the NWOG, "buy side liquidity" the BSL. Organize links two sentences that name the same thing
 * however it is written. Longer names come first ("inverse fair value gap" before "fair value
 * gap"); a hyphen or no space at all between parts is fine ("buy-side", "buyside").
 */
const SPELLED_OUT: ReadonlyArray<[string, string]> = [
  ['new week(?:ly)? opening gaps?', 'NWOG'],
  ['new day opening gaps?|new daily opening gaps?', 'NDOG'],
  ['(?:inverse|inversion|inverted) (?:fair value gaps?|fvgs?)', 'IFVG'],
  ['fair value gaps?', 'FVG'],
  ['balanced price ranges?', 'BPR'],
  ['buy ?side imbalance,? sell ?side inefficiency', 'BISI'],
  ['sell ?side imbalance,? buy ?side inefficiency', 'SIBI'],
  ['optimal trade entry|optimal trade entries', 'OTE'],
  ['market structure shifts?|shifts? in market structure', 'MSS'],
  ['breaks? of (?:market )?structure', 'BOS'],
  ['changes? of character', 'CHoCH'],
  ['changes? in (?:the )?state of delivery', 'CISD'],
  ["(?:previous|prior) day(?:'?s)? highs?|yesterday(?:'?s)? highs?", 'PDH'],
  ["(?:previous|prior) day(?:'?s)? lows?|yesterday(?:'?s)? lows?", 'PDL'],
  ["(?:previous|prior|last) week(?:'?s)? highs?", 'PWH'],
  ["(?:previous|prior|last) week(?:'?s)? lows?", 'PWL'],
  ['buy ?side liquidity', 'BSL'],
  ['sell ?side liquidity', 'SSL'],
  ['equal highs', 'EQH'],
  ['equal lows', 'EQL'],
  ['external range liquidity', 'ERL'],
  ['internal range liquidity', 'IRL'],
  ['draws? on liquidity', 'DOL'],
  ['premium (?:and|or|/) discount arrays?', 'PDA'],
  ['order blocks?', 'OB'],
  ['breaker blocks?', 'BB'],
  ['mitigation blocks?', 'MB'],
  ['rejection blocks?', 'RB'],
  ['volume imbalances?', 'VI'],
  ['overnight highs?', 'ONH'],
  ['overnight lows?', 'ONL'],
  ['initial balance highs?', 'IBH'],
  ['initial balance lows?', 'IBL'],
  ['highs? of (?:the )?day', 'HOD'],
  ['lows? of (?:the )?day', 'LOD'],
  ['points? of control', 'POC'],
  ['value area highs?', 'VAH'],
  ['low volume nodes?', 'LVN'],
  ['high volume nodes?', 'HVN']
]

/** Each name as a pattern: one or more spaces or a hyphen between words, an optional one where written " ?". */
const namePattern = (words: string): string => words.replace(/ \?/g, '\u0001').replace(/ /g, '[ -]+').replace(/\u0001/g, '[ -]?').replace(/'/g, "['’]")
const SPELLED_OUT_RE = new RegExp(SPELLED_OUT.map(([words], index) => `(?<t${index}>${namePattern(words)})`).join('|'), 'giu')

export interface SpelledOutTerm {
  from: number
  to: number
  /** The code it stands for, as written in CANONICAL_TERMS or AMBIGUOUS_TERMS ("NWOG", "OB"). */
  code: string
}

/** The ICT terms written out in words in a text: "missing that new week opening gap" -> NWOG. */
export function spelledOutTerms(text: string): SpelledOutTerm[] {
  const found: SpelledOutTerm[] = []
  for (const match of text.matchAll(SPELLED_OUT_RE)) {
    const from = match.index
    const to = from + match[0].length
    // Whole words only: not "unequal highs" or "fair value gapping".
    if (/[\p{L}\p{N}]/u.test(text[from - 1] ?? '') || /[\p{L}\p{N}]/u.test(text[to] ?? '')) continue
    const group = Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined)
    if (group) found.push({ from, to, code: SPELLED_OUT[Number(group[0].slice(1))]![1] })
  }
  return found
}
