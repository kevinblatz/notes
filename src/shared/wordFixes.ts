/**
 * The fixed lists behind autocorrect: the slips it always fixes the same way, and the words the
 * English list leaves out (it holds no names, no capitals and no apostrophes). Everything here
 * is deliberately conservative: a word that has two plausible meanings is not on these lists.
 */

/**
 * Apostrophes left out of contractions. Not here, on purpose, because each is also a word of
 * its own: lets (it lets me), its, ill, id, wed, well, were, hell, shell, whos (kept: "whose"
 * is likelier to be meant). "cant" and "wont" are words too, but in a trading journal they are
 * nearly always can't and won't.
 */
export const CONTRACTIONS: Readonly<Record<string, string>> = {
  dont: "don't", didnt: "didn't", doesnt: "doesn't", dosent: "doesn't", cant: "can't", wont: "won't", isnt: "isn't",
  wasnt: "wasn't", werent: "weren't", arent: "aren't", couldnt: "couldn't", shouldnt: "shouldn't", wouldnt: "wouldn't",
  havent: "haven't", hasnt: "hasn't", hadnt: "hadn't", mustnt: "mustn't", neednt: "needn't", aint: "ain't",
  im: "I'm", ive: "I've", youre: "you're", youve: "you've", youll: "you'll", youd: "you'd",
  theyre: "they're", theyve: "they've", theyll: "they'll", theyd: "they'd", weve: "we've",
  thats: "that's", whats: "what's", theres: "there's", heres: "here's", wheres: "where's", hows: "how's",
  shes: "she's", hes: "he's", itll: "it'll", thatll: "that'll",
  wouldve: "would've", couldve: "could've", shouldve: "should've", mightve: "might've", mustve: "must've", yall: "y'all"
}

/** Common misspellings with exactly one intended word. */
export const SLIPS: Readonly<Record<string, string>> = {
  teh: 'the', hte: 'the', adn: 'and', nad: 'and', taht: 'that', thta: 'that', wiht: 'with', jsut: 'just', waht: 'what',
  yuo: 'you', knwo: 'know', konw: 'know', recieve: 'receive', recieved: 'received', recieving: 'receiving',
  seperate: 'separate', seperately: 'separately', definately: 'definitely', definatly: 'definitely', defintely: 'definitely',
  alot: 'a lot', wich: 'which', becuase: 'because', beacuse: 'because', becasue: 'because', untill: 'until',
  occured: 'occurred', occuring: 'occurring', thier: 'their', freind: 'friend', beleive: 'believe', wierd: 'weird',
  acheive: 'achieve', tommorow: 'tomorrow', tommorrow: 'tomorrow', tomorow: 'tomorrow', accross: 'across',
  probaly: 'probably', realy: 'really', finaly: 'finally', basicly: 'basically', begining: 'beginning', comming: 'coming',
  completly: 'completely', enviroment: 'environment', existance: 'existence', foward: 'forward', goverment: 'government',
  happend: 'happened', immediatly: 'immediately', independant: 'independent', neccessary: 'necessary', noticable: 'noticeable',
  occassion: 'occasion', persistant: 'persistent', posession: 'possession', prefered: 'preferred', recomend: 'recommend',
  refered: 'referred', relevent: 'relevant', succesful: 'successful', suprise: 'surprise', truely: 'truly', writting: 'writing',
  fourty: 'forty', loosing: 'losing', carefull: 'careful', successfull: 'successful', helpfull: 'helpful', thankfull: 'thankful',
  stressfull: 'stressful', gratefull: 'grateful', mindfull: 'mindful', hopefull: 'hopeful', fearfull: 'fearful', painfull: 'painful',
  wonderfull: 'wonderful', beautifull: 'beautiful', powerfull: 'powerful', peacefull: 'peaceful', forcefull: 'forceful'
}

/** A few shorthands with only one meaning in a trading journal. "u", "ur", "rn" and the like stay as typed. */
export const SHORTHAND: Readonly<Record<string, string>> = {
  bc: 'because', 'b/c': 'because', 'w/': 'with', 'w/o': 'without', tmrw: 'tomorrow', tmr: 'tomorrow', tmrow: 'tomorrow', b4: 'before'
}

/** Every fixed rewrite, by lower-case spelling. */
export const WORD_FIXES: ReadonlyMap<string, string> = new Map(Object.entries({ ...SLIPS, ...SHORTHAND, ...CONTRACTIONS }))

/**
 * Words the English list leaves out: names of days, months, places and people a trader writes
 * about, the contractions, and a few modern words. Written as they should appear, so
 * "monday" is corrected to "Monday", while "Monday" and "MONDAY" are fine as they are.
 */
export const ENGLISH_EXTRAS: readonly string[] = [
  'I', "I'm", "I've", "I'll", "I'd",
  "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't", "wasn't", "weren't", "couldn't", "shouldn't", "wouldn't",
  "haven't", "hasn't", "hadn't", "mustn't", "needn't", "ain't", "you're", "you've", "you'll", "you'd", "they're", "they've",
  "they'll", "they'd", "we're", "we've", "we'll", "we'd", "he's", "he'll", "he'd", "she's", "she'll", "she'd", "it's", "it'll",
  "it'd", "that's", "that'll", "that'd", "there's", "there'll", "here's", "what's", "what'll", "where's", "who's", "who'll",
  "who'd", "how's", "let's", "would've", "could've", "should've", "might've", "must've", "y'all", "o'clock", "ma'am",
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Mondays', 'Tuesdays', 'Wednesdays',
  'Thursdays', 'Fridays', 'Saturdays', 'Sundays', 'Mon', 'Tue', 'Tues', 'Wed', 'Thu', 'Thur', 'Thurs', 'Fri', 'Sat', 'Sun',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
  'Christmas', 'Easter', 'Thanksgiving', 'Halloween',
  'America', 'American', 'Americans', 'Europe', 'European', 'Tokyo', 'Sydney', 'Chicago', 'England', 'English', 'Britain',
  'British', 'Japan', 'Japanese', 'China', 'Chinese', 'Germany', 'German', 'Canada', 'Australia', 'York', 'US', 'USA',
  'UK', 'EU', 'Fed', 'Powell', 'Yellen', 'Discord', 'YouTube', 'TikTok', 'Reddit', 'Instagram', 'MacBook', 'iPhone', 'iPad',
  'Twitter', 'Google', 'Windows', 'Chrome', 'Excel', 'Dow', 'Jones', 'Russell', 'Bitcoin', 'Ethereum', 'God',
  'timeframe', 'timeframes', 'offline', 'app', 'apps', 'pre', 'un', 'co', 'intro', 'intros', 'wifi', 'admin', 'config', 'tech',
  'breathwork', 'email', 'emails', 'online', 'login', 'podcast', 'podcasts', 'livestream', 'screenshot', 'screenshots', 'smartphone'
]

/** "the the" -> "the". Only words that are never doubled on purpose ("had had", "that that" are fine English). */
export const NEVER_DOUBLED: ReadonlySet<string> = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'and', 'for', 'with', 'is', 'was', 'my', 'i'])

/**
 * "to early" -> "too early". Only words that cannot follow "to" as a verb ("to close", "to
 * slow down" and "to high" are left alone).
 */
export const TOO_WORDS: ReadonlySet<string> = new Set([
  'early', 'late', 'soon', 'fast', 'quick', 'quickly', 'much', 'big', 'tight', 'wide', 'risky', 'greedy', 'aggressive', 'aggressively',
  'impatient', 'eager', 'small', 'many', 'far', 'scared', 'nervous', 'tired', 'emotional', 'confident', 'anxious', 'afraid', 'excited',
  'stressed', 'frustrated', 'distracted', 'hesitant', 'cautious', 'careful', 'lazy', 'bored', 'worried', 'fearful', 'overconfident',
  'slow', 'high', 'low'
])

/**
 * "to many" is "too many" only after words like these ("I took to many trades"); otherwise
 * it is left alone ("this applies to many traders"). The same goes for "far", "small" and "big".
 */
export const TOO_AFTER: ReadonlySet<string> = new Set([
  'was', 'were', 'is', 'are', 'am', 'be', 'been', 'being', 'way', 'took', 'take', 'taking', 'takes', 'made', 'make', 'had', 'have',
  'has', 'got', 'get', 'entered', 're-entered', 'reentered', 'exited', 'sold', 'bought', 'went', 'risked', 'sized', 'moved', 'left',
  'closed', 'cut', 'jumped', 'chased', 'pulled', 'came', 'in', 'out', 'traded', 'size', 'risk', 'stop', "it's", 'its', 'far'
])
/** Of the TOO_WORDS, the ones that need a word from TOO_AFTER before "to" (or a full stop after them). */
export const TOO_NEEDS_CONTEXT: ReadonlySet<string> = new Set(['many', 'far', 'small', 'big'])

/**
 * Of the TOO_WORDS, the ones that are also verbs or places to go ("to slow down", "went to
 * high of day"): only after "was", "is", "got" and the like, and "high" and "low" only at the
 * end of a clause too ("my stop was to high." -> "too high").
 */
export const TOO_AFTER_BE: ReadonlySet<string> = new Set(['was', 'were', 'is', 'are', 'am', 'be', 'been', 'being', "it's", "i'm", 'got', 'get', 'gets', 'getting', 'way', 'felt', 'feel', 'feeling', 'seemed', 'looked'])
export const TOO_NEEDS_BE: ReadonlySet<string> = new Set(['slow', 'high', 'low'])
export const TOO_NEEDS_CLAUSE_END: ReadonlySet<string> = new Set(['high', 'low'])

/** "should of waited" -> "should have waited": the modals "of" is a slip for "have" after. */
export const MODALS: ReadonlySet<string> = new Set(['should', 'could', 'would', 'must', 'might', "shouldn't", "couldn't", "wouldn't", "mustn't"])
/** Words that may stand between "should of" and the verb: "should of just waited". */
export const MODAL_ADVERBS: ReadonlySet<string> = new Set(['just', 'really', 'probably', 'definitely', 'never', 'not', 'easily', 'simply', 'actually', 'already', 'totally', 'honestly'])
/** Past forms that do not end in -ed or -en: "could of been", "should of took". */
export const IRREGULAR_PAST: ReadonlySet<string> = new Set([
  'been', 'had', 'done', 'gone', 'got', 'took', 'made', 'held', 'run', 'ran', 'sat', 'let', 'put', 'cut', 'hit', 'set', 'kept', 'left',
  'lost', 'won', 'sold', 'bought', 'thought', 'felt', 'told', 'said', 'went', 'came', 'come', 'seen', 'saw', 'known', 'knew', 'did',
  'caught', 'brought', 'stood', 'sent', 'spent', 'built', 'meant', 'paid', 'slept', 'stuck', 'struck', 'sold', 'quit', 'shut', 'read'
])

/** "loose" is "lose" after these: "don't want to loose", "if I loose 2 trades". */
export const LOSE_AFTER: ReadonlySet<string> = new Set([
  'to', 'i', 'you', 'we', 'they', 'will', 'might', 'could', 'would', 'should', 'can', 'may', 'must', 'gonna', 'wanna', "don't", 'dont',
  "didn't", 'didnt', "won't", 'wont', "can't", 'cant', 'not', 'never', "i'll", 'ill', "we'll", "you'll", 'always', 'often', 'usually'
])

/**
 * "its" is "it's" before these: words that can never follow the possessive "its" ("its not the
 * setup", "its been a week", "its just the god candles", "its a good day").
 */
export const ITS_BEFORE: ReadonlySet<string> = new Set([
  'not', 'been', 'gonna', 'going', 'a', 'an', 'the', 'ok', 'okay', 'fine', 'just', 'over', 'so', 'too', 'really', 'very', 'still', 'always',
  'never', 'what', 'because', 'bc', 'about', 'getting', 'all', 'literally', 'actually', 'basically', 'probably', 'definitely', 'kinda',
  'such', 'no', 'my', 'your', 'our', 'their', 'this', 'that', 'like'
])
/**
 * ... except where they start what "its" owns: "its going rate", "its all-time high", "its very
 * own range", "its like count". After "very" and "really" the next word must also be one of
 * these or a description that ends there ("its very hard to", "its really not"), never one that
 * goes on to a thing ("its really long wick").
 */
export const ITS_NOT_BEFORE: Readonly<Record<string, ReadonlySet<string>>> = {
  going: new Set(['rate', 'rates', 'price']),
  all: new Set(['time']),
  very: new Set(['own', 'first', 'last', 'best', 'worst', 'next', 'same', 'beginning', 'end', 'top', 'bottom', 'start', 'edge', 'nature']),
  like: new Set(['count', 'counts', 'button'])
}
/**
 * After "its", these describe something: "it's" only when nothing it could own follows ("its
 * hard to wait", "its crazy how", "its done."), never in "its wild swings" or "its hard edge".
 */
export const ITS_BEFORE_ADJECTIVE: ReadonlySet<string> = new Set(['hard', 'easy', 'crazy', 'funny', 'weird', 'insane', 'wild', 'done', 'normal', 'true', 'obvious', 'tough', 'brutal', 'annoying', 'frustrating', 'good', 'bad'])
/** Words after such a description that show it ends there: "its hard to", "its crazy how". */
export const ITS_ADJECTIVE_FOLLOWERS: ReadonlySet<string> = new Set(['to', 'how', 'when', 'that', 'af', 'asf', 'tbh', 'ngl', 'rn', 'now', 'today', 'sometimes', 'man', 'bro', 'lol', 'lmao'])

/**
 * Day and month names that are also English words ("may", "march", "wed", "sat", "sun") are
 * capitalised only where they are clearly dates: "may 5th", "march 20", "in march", "the 5th of
 * may", "sat 11/22", "wed nov 25". The other names are always capitalised (friday -> Friday).
 */
export const DATE_WORDS: Readonly<Record<string, string>> = { may: 'May', march: 'March', wed: 'Wed', sat: 'Sat', sun: 'Sun' }
/** Before a month name that is also a word, these make it the month: "in may", "early march". */
export const MONTH_AFTER: ReadonlySet<string> = new Set(['in', 'of', 'since', 'until', 'till', 'through', 'early', 'mid', 'late', 'during'])
/**
 * ... and "may" only when what follows could not follow "may" the verb: "in may I sized up",
 * "since may the range held" (not "the trade I'm in may run", "the 2nd may be better").
 */
export const MONTH_FOLLOWERS: ReadonlySet<string> = new Set([
  'i', 'we', 'he', 'she', 'they', 'it', "i'm", 'im', 'the', 'a', 'an', 'my', 'our', 'this', 'last', 'next', 'and', 'or', 'but', 'when', 'if',
  'while', 'after', 'before', 'until', 'at', 'for', 'on', 'in', 'of', 'with', 'during', 'is', 'was', 'were', 'has', 'had'
])
export const MONTH_NAMES: ReadonlySet<string> = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'
])

/** Words that end a sentence-like chunk without ending a sentence: "e.g. this", "vs. that". */
export const ABBREVIATIONS: ReadonlySet<string> = new Set(['e.g', 'i.e', 'eg', 'ie', 'vs', 'approx', 'mr', 'mrs', 'ms', 'dr', 'st', 'cf', 'etc'])
