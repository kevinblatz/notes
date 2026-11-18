/**
 * Rich-text document helpers that work without a DOM: validation/sanitising of structured
 * content, and the derived text used for search, snippets and labels.
 *
 * `sanitizeDoc` is an allowlist. It runs in the main process on every save and on every
 * imported note, so nothing the renderer or a backup file sends can introduce an unknown
 * node, an unsafe link, or a style value outside the app's own palette.
 */
import { drawingScaleAttr } from './drawing'
import type { FontKey, Note, RichDoc, RichMark, RichNode } from './types'

export const INK_COLORS = ['muted', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'] as const
export const HIGHLIGHT_COLORS = ['amber', 'green', 'teal', 'blue', 'rose', 'violet', 'gray'] as const
export const FONT_KEYS: readonly FontKey[] = ['sans', 'serif', 'mono', 'system']
export const FONT_SIZES = [13, 15, 17, 19, 22, 26, 32] as const
export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 64
export const IMAGE_NODE = 'noteImage'
export const SUGGESTED_TAGS = ['Rules', 'Setups', 'Journal'] as const

export const FONT_LABELS: Record<FontKey, string> = {
  sans: 'Hyperlegible',
  serif: 'Literata',
  mono: 'JetBrains Mono',
  system: 'System'
}

export const inkVar = (name: string): string => `var(--ink-${name})`
export const highlightVar = (name: string): string => `var(--hl-${name})`
export const fontVar = (key: string): string => `var(--font-${key})`

const INK_VALUES = new Set<string>(INK_COLORS.map(inkVar))
const HIGHLIGHT_VALUES = new Set<string>(HIGHLIGHT_COLORS.map(highlightVar))
const FONT_VALUES = new Set<string>(FONT_KEYS.map(fontVar))

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const MAX_DEPTH = 60
const MAX_NODES = 200_000
const MAX_TITLE = 200
const MAX_TAG = 32
const MAX_TAGS = 12
const MAX_CAPTION = 2000

export class ContentError extends Error {}

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

export function emptyDoc(): RichDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/** Only http(s) and mailto links are kept; anything else (javascript:, file:, data:, ...) is dropped. */
export function safeLinkHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
  return url.href
}

/** Stricter check used before handing a URL to the operating system. */
export function isOpenableExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeFontSize(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}(?:\.\d)?)px$/.exec(value.trim())
  if (!match) return null
  const size = Number(match[1])
  if (size < MIN_FONT_SIZE || size > MAX_FONT_SIZE) return null
  return `${size}px`
}

export function sanitizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const single = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TITLE)
  return single.length > 0 ? single : null
}

export function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').slice(0, MAX_TAG)
    const key = tag.toLowerCase()
    if (tag.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

type AttrSanitizer = (attrs: Record<string, unknown>) => Record<string, unknown> | null | undefined

interface NodeSpec {
  /** Return undefined for "no attrs", null to drop the node. */
  attrs?: AttrSanitizer
  leaf?: boolean
}

const intIn = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const NODE_SPECS: Record<string, NodeSpec> = {
  paragraph: {},
  heading: { attrs: (a) => ({ level: intIn(a.level, 1, 3, 2) }) },
  bulletList: {},
  orderedList: { attrs: (a) => ({ start: intIn(a.start, 1, 100000, 1) }) },
  listItem: {},
  taskList: {},
  taskItem: { attrs: (a) => ({ checked: a.checked === true }) },
  blockquote: {},
  codeBlock: {
    attrs: (a) => ({ language: typeof a.language === 'string' && /^[\w+#.-]{1,40}$/.test(a.language) ? a.language : null })
  },
  horizontalRule: { leaf: true },
  hardBreak: { leaf: true },
  [IMAGE_NODE]: {
    leaf: true,
    attrs: (a) => {
      if (!isValidId(a.attachmentId)) return null
      const dim = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100000 ? Math.round(v) : null)
      return {
        attachmentId: a.attachmentId,
        width: intIn(a.width, 10, 100, 100),
        caption: typeof a.caption === 'string' ? a.caption.slice(0, MAX_CAPTION) : '',
        naturalWidth: dim(a.naturalWidth),
        naturalHeight: dim(a.naturalHeight),
        // Made in the drawing space, which can reopen it: the pixel density it was saved at
        // (or `true`). Ordinary images carry no such key at all.
        ...(drawingScaleAttr(a.drawing) !== null ? { drawing: drawingScaleAttr(a.drawing) } : {})
      }
    }
  }
}

const SIMPLE_MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code'])

function sanitizeMark(raw: unknown): RichMark | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null
  const attrs = isRecord(raw.attrs) ? raw.attrs : {}
  if (SIMPLE_MARKS.has(raw.type)) return { type: raw.type }
  if (raw.type === 'link') {
    const href = safeLinkHref(attrs.href)
    return href ? { type: 'link', attrs: { href } } : null
  }
  if (raw.type === 'highlight') {
    const color = typeof attrs.color === 'string' && HIGHLIGHT_VALUES.has(attrs.color) ? attrs.color : highlightVar('amber')
    return { type: 'highlight', attrs: { color } }
  }
  if (raw.type === 'textStyle') {
    const color = typeof attrs.color === 'string' && INK_VALUES.has(attrs.color) ? attrs.color : null
    const fontFamily = typeof attrs.fontFamily === 'string' && FONT_VALUES.has(attrs.fontFamily) ? attrs.fontFamily : null
    const fontSize = normalizeFontSize(attrs.fontSize)
    if (!color && !fontFamily && !fontSize) return null
    return { type: 'textStyle', attrs: { color, fontFamily, fontSize } }
  }
  return null
}

/**
 * Validate and normalise a structured document. Unknown node types are unwrapped (their
 * children are kept) so words written with a newer version of the app are not dropped;
 * unknown marks and unsafe attribute values are removed.
 */
export function sanitizeDoc(input: unknown): RichDoc {
  if (!isRecord(input) || input.type !== 'doc') throw new ContentError('Note content is not a document.')
  const budget = { nodes: 0 }
  const content = sanitizeChildren(input.content, 1, budget)
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] }
}

function sanitizeChildren(raw: unknown, depth: number, budget: { nodes: number }): RichNode[] {
  if (!Array.isArray(raw)) return []
  if (depth > MAX_DEPTH) throw new ContentError('Note content is nested too deeply.')
  const out: RichNode[] = []
  for (const child of raw) {
    if (!isRecord(child) || typeof child.type !== 'string') continue
    if (++budget.nodes > MAX_NODES) throw new ContentError('Note content is too large.')

    if (child.type === 'text') {
      if (typeof child.text !== 'string' || child.text.length === 0) continue
      const node: RichNode = { type: 'text', text: child.text }
      if (Array.isArray(child.marks)) {
        const marks = child.marks.map(sanitizeMark).filter((m): m is RichMark => m !== null)
        if (marks.length > 0) node.marks = marks
      }
      out.push(node)
      continue
    }

    const spec = NODE_SPECS[child.type]
    if (!spec) {
      out.push(...sanitizeChildren(child.content, depth + 1, budget))
      continue
    }
    const node: RichNode = { type: child.type }
    if (spec.attrs) {
      const attrs = spec.attrs(isRecord(child.attrs) ? child.attrs : {})
      if (attrs === null) continue
      if (attrs !== undefined) node.attrs = attrs
    }
    if (!spec.leaf) {
      const content = sanitizeChildren(child.content, depth + 1, budget)
      if (content.length > 0) node.content = content
    }
    out.push(node)
  }
  return out
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock'])

/** Body text, one line per block, with image captions left out. */
export function extractPlainText(doc: RichDoc): string {
  const lines: string[] = []
  const walk = (nodes: RichNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (TEXT_BLOCKS.has(node.type)) lines.push(inlineText(node))
      else walk(node.content)
    }
  }
  walk(doc.content)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function inlineText(node: RichNode): string {
  let text = ''
  for (const child of node.content ?? []) {
    if (child.type === 'text') text += child.text ?? ''
    else if (child.type === 'hardBreak') text += '\n'
    else text += inlineText(child)
  }
  return text
}

export function extractCaptions(doc: RichDoc): string {
  const captions: string[] = []
  visit(doc.content, (node) => {
    if (node.type === IMAGE_NODE && typeof node.attrs?.caption === 'string' && node.attrs.caption.trim()) {
      captions.push(node.attrs.caption.trim())
    }
  })
  return captions.join('\n')
}

export function collectAttachmentIds(doc: RichDoc): string[] {
  const ids = new Set<string>()
  visit(doc.content, (node) => {
    if (node.type === IMAGE_NODE && isValidId(node.attrs?.attachmentId)) ids.add(node.attrs.attachmentId)
  })
  return [...ids]
}

export function countImages(doc: RichDoc): number {
  let count = 0
  visit(doc.content, (node) => {
    if (node.type === IMAGE_NODE) count++
  })
  return count
}

/** A note is empty only when it has no title, no visible text and no image. */
export function isContentEmpty(title: string | null | undefined, doc: RichDoc): boolean {
  if (title && title.trim().length > 0) return false
  if (countImages(doc) > 0) return false
  return extractPlainText(doc).trim().length === 0
}

export function isNoteEmpty(note: Pick<Note, 'title' | 'content'>): boolean {
  return isContentEmpty(note.title, note.content)
}

/** Title, or the first line of the note, or a neutral fallback. Never invents wording. */
export function noteLabel(note: Pick<Note, 'title' | 'plainText' | 'captions' | 'content'>, max = 80): string {
  const title = note.title?.trim()
  if (title) return truncate(title, max)
  const firstLine = note.plainText.split('\n').find((line) => line.trim().length > 0)
  if (firstLine) return truncate(firstLine.trim(), max)
  const caption = note.captions.split('\n').find((line) => line.trim().length > 0)
  if (caption) return truncate(caption.trim(), max)
  return countImages(note.content) > 0 ? 'Image note' : 'Untitled note'
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** Replace the task item at `index` (document order) with the given checked state. */
export function setTaskChecked(doc: RichDoc, index: number, checked: boolean): RichDoc {
  let seen = -1
  const map = (nodes: RichNode[] | undefined): RichNode[] | undefined =>
    nodes?.map((node) => {
      if (node.type === 'taskItem') {
        seen++
        const next: RichNode = { ...node, content: map(node.content) }
        if (seen === index) next.attrs = { ...node.attrs, checked }
        return next
      }
      return node.content ? { ...node, content: map(node.content) } : node
    })
  return { type: 'doc', content: map(doc.content) }
}

function visit(nodes: RichNode[] | undefined, fn: (node: RichNode) => void): void {
  for (const node of nodes ?? []) {
    fn(node)
    visit(node.content, fn)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
