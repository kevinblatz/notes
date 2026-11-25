/**
 * The word list behind the spelling checker: which words exist, how common each one is, and
 * which known words lie within a small edit distance of a misspelling.
 *
 * Words are kept twice: in a Map for instant "is this a word?" answers, and in a compact trie
 * (typed arrays, no object per letter) that the suggestion search walks while computing the
 * Damerau-Levenshtein distance one row per letter, abandoning every branch that can no longer
 * come within the limit. That finds all words within 2 edits of a misspelling among ~80,000 in
 * well under a millisecond, which is what lets Organize correct a long note at once.
 */

/** Commonness of a word: 10 is the most common, 60 the rarest the list holds. */
export type WordLevel = number

export interface NearWord {
  /** The word as it is normally written (lower case, or "London", "I'm"). */
  word: string
  /** Damerau-Levenshtein distance (optimal string alignment) from the word searched for. */
  distance: number
  level: WordLevel
}

const INITIAL_NODES = 1 << 18

export class Dictionary {
  /** Lower-case spelling -> commonness level. */
  private readonly levels = new Map<string, WordLevel>()
  /** Lower-case spelling -> how it is written, for words that are not all lower case ("london" -> "London"). */
  private readonly forms = new Map<string, string>()

  // The trie: node 0 is the root. Children form a linked list (first child, next sibling).
  private chars = new Uint16Array(INITIAL_NODES)
  private firstChild = new Int32Array(INITIAL_NODES).fill(-1)
  private nextSibling = new Int32Array(INITIAL_NODES).fill(-1)
  /** Level of the word ending at a node, 0 when no word ends there. */
  private ends = new Uint8Array(INITIAL_NODES)
  private nodeCount = 1

  get size(): number {
    return this.levels.size
  }

  /**
   * Add a word. Its lower-case spelling is what is looked up; `word` itself is how it is
   * written when suggested. A word already known keeps its more common level.
   */
  add(word: string, level: WordLevel): void {
    const key = word.toLowerCase()
    if (!key) return
    const known = this.levels.get(key)
    if (known !== undefined && known <= level) return
    this.levels.set(key, level)
    if (word !== key) this.forms.set(key, word)
    else this.forms.delete(key)
    this.insert(key, level)
  }

  /** Commonness level of a word in any letter case, or undefined when it is not a word. */
  level(word: string): WordLevel | undefined {
    return this.levels.get(word.toLowerCase())
  }

  /** How the word is normally written: "london" -> "London", "dont" -> undefined (not a word). */
  form(word: string): string | undefined {
    const key = word.toLowerCase()
    if (!this.levels.has(key)) return undefined
    return this.forms.get(key) ?? key
  }

  /**
   * Every known word within `maxDistance` edits of `word` (letter case ignored), closest
   * first. An edit is one inserted, deleted or replaced letter, or two neighbours swapped.
   */
  near(word: string, maxDistance: number): NearWord[] {
    const target = word.toLowerCase()
    const n = target.length
    if (n === 0) return []
    const out: NearWord[] = []
    const codes = new Uint16Array(n)
    for (let i = 0; i < n; i++) codes[i] = target.charCodeAt(i)
    // One row of the distance table per trie depth, reused across branches.
    const maxDepth = n + maxDistance + 1
    const rows: Int32Array[] = []
    for (let d = 0; d <= maxDepth; d++) rows.push(new Int32Array(n + 1))
    const first = rows[0]!
    for (let i = 0; i <= n; i++) first[i] = i
    const path = new Uint16Array(maxDepth + 1)

    const visit = (node: number, depth: number): void => {
      const row = rows[depth]!
      const prev = rows[depth - 1]!
      const before = depth >= 2 ? rows[depth - 2]! : null
      const ch = this.chars[node]!
      const prevCh = depth >= 2 ? path[depth - 2]! : -1
      path[depth - 1] = ch
      row[0] = depth
      let rowMin = row[0]!
      for (let i = 1; i <= n; i++) {
        const cost = codes[i - 1] === ch ? 0 : 1
        let value = Math.min(prev[i]! + 1, row[i - 1]! + 1, prev[i - 1]! + cost)
        if (before && i >= 2 && codes[i - 1] === prevCh && codes[i - 2] === ch) value = Math.min(value, before[i - 2]! + 1)
        row[i] = value
        if (value < rowMin) rowMin = value
      }
      const level = this.ends[node]!
      if (level > 0 && row[n]! <= maxDistance) {
        const key = String.fromCharCode(...path.subarray(0, depth))
        out.push({ word: this.forms.get(key) ?? key, distance: row[n]!, level })
      }
      // A swap can still reach back to the row before this one, so look at both.
      let prevMin = Infinity
      for (let i = 0; i <= n; i++) if (prev[i]! < prevMin) prevMin = prev[i]!
      if (depth >= maxDepth || (rowMin > maxDistance && prevMin + 1 > maxDistance)) return
      for (let child = this.firstChild[node]!; child !== -1; child = this.nextSibling[child]!) visit(child, depth + 1)
    }
    for (let child = this.firstChild[0]!; child !== -1; child = this.nextSibling[child]!) visit(child, 1)
    return out.sort((a, b) => a.distance - b.distance || a.level - b.level || (a.word < b.word ? -1 : 1))
  }

  private insert(key: string, level: WordLevel): void {
    let node = 0
    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i)
      let child = this.firstChild[node]!
      let last = -1
      while (child !== -1 && this.chars[child] !== code) {
        last = child
        child = this.nextSibling[child]!
      }
      if (child === -1) {
        child = this.newNode(code)
        if (last === -1) this.firstChild[node] = child
        else this.nextSibling[last] = child
      }
      node = child
    }
    this.ends[node] = Math.min(255, level)
  }

  private newNode(code: number): number {
    if (this.nodeCount === this.chars.length) this.grow()
    const id = this.nodeCount++
    this.chars[id] = code
    return id
  }

  private grow(): void {
    const size = this.chars.length * 2
    const chars = new Uint16Array(size)
    chars.set(this.chars)
    const firstChild = new Int32Array(size).fill(-1)
    firstChild.set(this.firstChild)
    const nextSibling = new Int32Array(size).fill(-1)
    nextSibling.set(this.nextSibling)
    const ends = new Uint8Array(size)
    ends.set(this.ends)
    this.chars = chars
    this.firstChild = firstChild
    this.nextSibling = nextSibling
    this.ends = ends
  }
}

/**
 * Read the bundled word list (src/shared/words/en-US.txt): "#" lines are comments, a line
 * "@NN" starts commonness level NN, every other line is one word.
 */
export function parseWordList(text: string, into: Dictionary = new Dictionary()): Dictionary {
  parseWordListPart(text, into, 60)
  return into
}

/**
 * Read part of the word list (whole lines) into `into`, starting at commonness `level`.
 * Returns the level in force at its end, for the next part. Lets the window read the list a
 * slice at a time without holding up typing.
 */
export function parseWordListPart(text: string, into: Dictionary, level: WordLevel): WordLevel {
  let current = level
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const line = text.slice(start, end).trim()
    start = end + 1
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('@')) {
      const value = Number(line.slice(1))
      if (Number.isFinite(value) && value > 0) current = value
      continue
    }
    into.add(line, current)
  }
  return current
}

/** Damerau-Levenshtein distance (optimal string alignment), letter case as given. */
export function editDistance(a: string, b: string): number {
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, d[i - 2]![j - 2]! + 1)
      d[i]![j] = value
    }
  }
  return d[n]![m]!
}
