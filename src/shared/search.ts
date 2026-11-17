/**
 * Local word search over titles, body text, image captions and tags.
 * Pure and synchronous: results never touch the board order. Screenshot pixels are not
 * searched (there is no OCR), only the words typed into notes and captions.
 */
import { noteLabel } from './content'
import type { Note } from './types'

export interface Segment {
  text: string
  match: boolean
}

export interface SearchResult {
  id: string
  label: Segment[]
  snippet: Segment[]
  /** Where the snippet text came from. */
  source: 'body' | 'caption' | 'title' | 'tag'
  tags: string[]
  updatedAt: number
  score: number
}

const SNIPPET_BEFORE = 40
const SNIPPET_LENGTH = 150

/** Case- and accent-insensitive form used for matching. Same length as the input. */
export function fold(text: string): string {
  let out = ''
  for (const ch of text) {
    const stripped = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    if (stripped.length === ch.length) out += stripped
    else {
      // Keep offsets aligned with the original string so match ranges can be mapped back.
      const lower = ch.toLowerCase()
      out += lower.length === ch.length ? lower : ch
    }
  }
  return out
}

export function tokenize(query: string): string[] {
  return [...new Set(fold(query).split(/\s+/).filter((t) => t.length > 0))]
}

function ranges(haystackFolded: string, tokens: string[]): Array<[number, number]> {
  const found: Array<[number, number]> = []
  for (const token of tokens) {
    let from = 0
    for (;;) {
      const at = haystackFolded.indexOf(token, from)
      if (at === -1) break
      found.push([at, at + token.length])
      from = at + token.length
    }
  }
  found.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of found) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}

export function highlight(text: string, tokens: string[]): Segment[] {
  if (tokens.length === 0 || text.length === 0) return text ? [{ text, match: false }] : []
  const segments: Segment[] = []
  let cursor = 0
  for (const [start, end] of ranges(fold(text), tokens)) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}

function snippetAround(text: string, tokens: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= SNIPPET_LENGTH) return flat
  const folded = fold(flat)
  let first = -1
  for (const token of tokens) {
    const at = folded.indexOf(token)
    if (at !== -1 && (first === -1 || at < first)) first = at
  }
  if (first === -1) return `${flat.slice(0, SNIPPET_LENGTH).trimEnd()}…`
  let start = Math.max(0, first - SNIPPET_BEFORE)
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space !== -1 && space < first) start = space + 1
  }
  const end = Math.min(flat.length, start + SNIPPET_LENGTH)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

export interface SearchOptions {
  /** Restrict to notes carrying this tag (case-insensitive). */
  tag?: string | null
  limit?: number
}

/**
 * Every query word must appear somewhere in the note (title, body, captions or tags).
 * Title matches rank first, then tags, then body; ties go to the most recently edited note.
 */
export function searchNotes(notes: Iterable<Note>, query: string, options: SearchOptions = {}): SearchResult[] {
  const tokens = tokenize(query)
  const tagFilter = options.tag ? fold(options.tag) : null
  const results: SearchResult[] = []

  for (const note of notes) {
    if (note.deletedAt !== null) continue
    if (tagFilter && !note.tags.some((t) => fold(t) === tagFilter)) continue

    const title = note.title ?? ''
    const fTitle = fold(title)
    const fBody = fold(note.plainText)
    const fCaptions = fold(note.captions)
    const fTags = note.tags.map(fold)

    let score = 0
    let matchedAll = true
    for (const token of tokens) {
      const inTitle = fTitle.includes(token)
      const inTags = fTags.some((t) => t.includes(token))
      const inBody = fBody.includes(token)
      const inCaptions = fCaptions.includes(token)
      if (!inTitle && !inTags && !inBody && !inCaptions) {
        matchedAll = false
        break
      }
      score += (inTitle ? 8 : 0) + (inTags ? 4 : 0) + (inBody ? 2 : 0) + (inCaptions ? 1 : 0)
      if (inTitle && fTitle.startsWith(token)) score += 2
    }
    if (!matchedAll) continue

    let source: SearchResult['source'] = 'body'
    let snippetText = note.plainText
    if (tokens.length > 0) {
      if (tokens.some((t) => fBody.includes(t))) source = 'body'
      else if (tokens.some((t) => fCaptions.includes(t))) {
        source = 'caption'
        snippetText = note.captions
      } else if (tokens.some((t) => fTitle.includes(t))) source = 'title'
      else source = 'tag'
    }
    if (!snippetText.trim() && note.captions.trim()) snippetText = note.captions

    const label = noteLabel(note)
    // When the label is just the first body line, do not repeat it as the snippet.
    const snippet = snippetAround(snippetText, tokens)
    const snippetIsLabel = !note.title && snippet.replace(/…/g, '').trim() === label.replace(/…/g, '').trim()

    results.push({
      id: note.id,
      label: highlight(label, tokens),
      snippet: snippetIsLabel ? [] : highlight(snippet, tokens),
      source,
      tags: note.tags,
      updatedAt: note.updatedAt,
      score
    })
  }

  results.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
  return typeof options.limit === 'number' ? results.slice(0, options.limit) : results
}

/** All tags in use, most used first. */
export function collectTags(notes: Iterable<Note>): string[] {
  const counts = new Map<string, { tag: string; count: number }>()
  for (const note of notes) {
    if (note.deletedAt !== null) continue
    for (const tag of note.tags) {
      const key = fold(tag)
      const entry = counts.get(key)
      if (entry) entry.count++
      else counts.set(key, { tag, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).map((e) => e.tag)
}
