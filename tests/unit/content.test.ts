import { describe, expect, it } from 'vitest'
import {
  collectAttachmentIds,
  ContentError,
  extractCaptions,
  extractPlainText,
  fontVar,
  highlightVar,
  inkVar,
  isContentEmpty,
  isOpenableExternalUrl,
  noteLabel,
  safeLinkHref,
  sanitizeDoc,
  sanitizeTags,
  sanitizeTitle,
  setTaskChecked
} from '@shared/content'
import { highlight, searchNotes, collectTags } from '@shared/search'
import { acceleratorFromEvent, formatAccelerator, isValidAccelerator } from '@shared/accelerator'
import { mergePreferences } from '@shared/preferences'
import { DEFAULT_PREFERENCES, type Note, type RichDoc } from '@shared/types'

const IMG = 'aaaaaaaa-1111-2222-3333-444444444444'
const p = (text: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>): object => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }]
})

describe('sanitizeDoc', () => {
  it('keeps supported formatting exactly', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Rules' }] },
        p('styled', [
          { type: 'bold' },
          { type: 'italic' },
          { type: 'underline' },
          { type: 'strike' },
          { type: 'highlight', attrs: { color: highlightVar('teal') } },
          { type: 'textStyle', attrs: { color: inkVar('red'), fontFamily: fontVar('serif'), fontSize: '22px' } },
          { type: 'link', attrs: { href: 'https://www.tradingview.com/chart/' } }
        ]),
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('done')] }] },
        { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p('third')] }] },
        { type: 'noteImage', attrs: { attachmentId: IMG, width: 60, caption: 'NQ sweep', naturalWidth: 1920, naturalHeight: 1080 } }
      ]
    }
    expect(sanitizeDoc(doc)).toEqual(doc)
  })

  it('drops scripts, unsafe links, foreign styles and unknown marks but keeps the words', () => {
    const cleaned = sanitizeDoc({
      type: 'doc',
      content: [
        { type: 'script', content: [p('alert(1)')] },
        p('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'evil' }]),
        p('file', [{ type: 'link', attrs: { href: 'file:///C:/Windows/system32' } }]),
        p('colour', [{ type: 'textStyle', attrs: { color: 'url(https://x/y)', fontFamily: 'Comic Sans', fontSize: '900px' } }]),
        p('hl', [{ type: 'highlight', attrs: { color: 'expression(1)' } }]),
        { type: 'noteImage', attrs: { attachmentId: '../../etc/passwd' } },
        { type: 'heading', attrs: { level: 9 }, content: [{ type: 'text', text: 'h' }] }
      ]
    })
    const json = JSON.stringify(cleaned)
    expect(json).not.toMatch(/javascript:|file:|url\(|Comic|900px|expression|passwd|script|evil/)
    expect(extractPlainText(cleaned)).toBe('alert(1)\nclick\nfile\ncolour\nhl\nh')
    expect(cleaned.content?.[4]).toEqual(p('hl', [{ type: 'highlight', attrs: { color: highlightVar('amber') } }]))
    expect(cleaned.content?.at(-1)?.attrs).toEqual({ level: 3 })
  })

  it('rejects non-documents and runaway nesting', () => {
    expect(() => sanitizeDoc(null)).toThrow(ContentError)
    expect(() => sanitizeDoc({ type: 'paragraph' })).toThrow(ContentError)
    let deep: object = p('x')
    for (let i = 0; i < 80; i++) deep = { type: 'blockquote', content: [deep] }
    expect(() => sanitizeDoc({ type: 'doc', content: [deep] })).toThrow(ContentError)
    expect(sanitizeDoc({ type: 'doc' })).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })
})

describe('derived text', () => {
  const doc = sanitizeDoc({
    type: 'doc',
    content: [
      p('First line'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('one')] }, { type: 'listItem', content: [p('two')] }] },
      { type: 'noteImage', attrs: { attachmentId: IMG, caption: 'London open' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }
    ]
  })

  it('extracts text, captions and attachment ids', () => {
    expect(extractPlainText(doc)).toBe('First line\none\ntwo\na\nb')
    expect(extractCaptions(doc)).toBe('London open')
    expect(collectAttachmentIds(doc)).toEqual([IMG])
  })

  it('treats an image-only note as not empty, and whitespace as empty', () => {
    const imageOnly: RichDoc = { type: 'doc', content: [{ type: 'noteImage', attrs: { attachmentId: IMG } }] }
    expect(isContentEmpty(null, imageOnly)).toBe(false)
    expect(isContentEmpty(null, { type: 'doc', content: [{ type: 'paragraph' }, p('   ') as never] })).toBe(true)
    expect(isContentEmpty('Title', { type: 'doc', content: [{ type: 'paragraph' }] })).toBe(false)
    expect(isContentEmpty('  ', { type: 'doc', content: [{ type: 'horizontalRule' }] })).toBe(true)
  })

  it('labels notes by title, then first line, then a neutral fallback', () => {
    const base = { content: doc, plainText: extractPlainText(doc), captions: extractCaptions(doc) }
    expect(noteLabel({ ...base, title: 'My title' })).toBe('My title')
    expect(noteLabel({ ...base, title: null })).toBe('First line')
    expect(noteLabel({ title: null, plainText: '', captions: '', content: { type: 'doc', content: [{ type: 'noteImage', attrs: { attachmentId: IMG } }] } })).toBe('Image note')
    expect(noteLabel({ title: null, plainText: '', captions: '', content: { type: 'doc' } })).toBe('Untitled note')
    expect(noteLabel({ ...base, title: 'x'.repeat(200) }).length).toBe(80)
  })

  it('toggles the right checklist item', () => {
    const list = sanitizeDoc({
      type: 'doc',
      content: [{ type: 'taskList', content: [0, 1, 2].map((i) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(`t${i}`)] })) }]
    })
    const toggled = setTaskChecked(list, 1, true)
    expect(toggled.content?.[0]?.content?.map((n) => n.attrs?.checked)).toEqual([false, true, false])
    expect(list.content?.[0]?.content?.map((n) => n.attrs?.checked)).toEqual([false, false, false])
  })
})

describe('links, titles, tags', () => {
  it('only allows http(s) and mailto links', () => {
    expect(safeLinkHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeLinkHref('mailto:me@example.com')).toBe('mailto:me@example.com')
    for (const bad of ['javascript:alert(1)', 'file:///c:/x', 'data:text/html,x', 'vbscript:x', 'not a url', '', 42]) expect(safeLinkHref(bad)).toBeNull()
    expect(isOpenableExternalUrl('https://example.com')).toBe(true)
    expect(isOpenableExternalUrl('mailto:me@example.com')).toBe(false)
    expect(isOpenableExternalUrl('file:///etc/passwd')).toBe(false)
  })

  it('cleans titles and tags', () => {
    expect(sanitizeTitle('  a\nb  ')).toBe('a b')
    expect(sanitizeTitle('   ')).toBeNull()
    expect(sanitizeTags(['Rules', 'rules', ' #Setups ', '', 7, 'x'.repeat(99)])).toEqual(['Rules', 'Setups', 'x'.repeat(32)])
  })
})

const note = (over: Partial<Note>): Note => ({
  id: over.id ?? 'id-00000001',
  kind: 'note',
  title: null,
  content: { type: 'doc' },
  plainText: '',
  captions: '',
  tags: [],
  collapsed: false,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  revision: 1,
  extra: {},
  ...over
})

describe('search', () => {
  const notes = [
    note({ id: 'n-000000001', title: 'Liquidity sweep rules', plainText: 'Wait for the sweep of the Asian high before entering.', updatedAt: 10 }),
    note({ id: 'n-000000002', plainText: 'Journal: took a long after the sweep. Felt rushed.', tags: ['Journal'], updatedAt: 30 }),
    note({ id: 'n-000000003', plainText: '', captions: 'NQ 5m sweep screenshot', updatedAt: 20 }),
    note({ id: 'n-000000004', plainText: 'Café entry model', updatedAt: 5 }),
    note({ id: 'n-000000005', plainText: 'sweep in trash', deletedAt: 99 })
  ]

  it('requires every word and ranks title matches first', () => {
    const results = searchNotes(notes, 'sweep')
    expect(results.map((r) => r.id)).toEqual(['n-000000001', 'n-000000002', 'n-000000003'])
    expect(searchNotes(notes, 'sweep rushed').map((r) => r.id)).toEqual(['n-000000002'])
    expect(searchNotes(notes, 'nothing-here')).toEqual([])
  })

  it('searches captions and tags, ignores case and accents, and never returns trashed notes', () => {
    expect(searchNotes(notes, 'screenshot')[0]).toMatchObject({ id: 'n-000000003', source: 'caption' })
    expect(searchNotes(notes, 'JOURNAL').map((r) => r.id)).toEqual(['n-000000002'])
    expect(searchNotes(notes, 'cafe').map((r) => r.id)).toEqual(['n-000000004'])
    expect(searchNotes(notes, 'trash')).toEqual([])
    expect(searchNotes(notes, '', { tag: 'journal' }).map((r) => r.id)).toEqual(['n-000000002'])
  })

  it('marks matches inside snippets', () => {
    const [first] = searchNotes(notes, 'asian')
    expect(first!.snippet.filter((s) => s.match).map((s) => s.text)).toEqual(['Asian'])
    expect(highlight('Sweep the sweep', ['sweep'])).toEqual([
      { text: 'Sweep', match: true },
      { text: ' the ', match: false },
      { text: 'sweep', match: true }
    ])
    const long = note({ plainText: `${'filler '.repeat(60)}needle ${'tail '.repeat(60)}` })
    const snippet = searchNotes([long], 'needle')[0]!.snippet.map((s) => s.text).join('')
    expect(snippet).toContain('needle')
    expect(snippet.length).toBeLessThan(170)
  })

  it('lists tags by use', () => {
    expect(collectTags([...notes, note({ tags: ['Rules', 'journal'] })])).toEqual(['Journal', 'Rules'])
  })
})

describe('accelerators', () => {
  const ev = (over: Partial<Parameters<typeof acceleratorFromEvent>[0]>): Parameters<typeof acceleratorFromEvent>[0] => ({
    key: ' ',
    code: 'Space',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over
  })

  it('builds Electron accelerators from key presses', () => {
    expect(acceleratorFromEvent(ev({ ctrlKey: true, shiftKey: true }))).toEqual({ ok: true, accelerator: 'Control+Shift+Space' })
    expect(acceleratorFromEvent(ev({ altKey: true, key: 'n', code: 'KeyN' }))).toEqual({ ok: true, accelerator: 'Alt+N' })
    expect(acceleratorFromEvent(ev({ key: 'F9', code: 'F9' }))).toEqual({ ok: true, accelerator: 'F9' })
    expect(acceleratorFromEvent(ev({ shiftKey: true, key: 'A', code: 'KeyA' }))).toEqual({ ok: false, reason: 'needs-modifier' })
    expect(acceleratorFromEvent(ev({ ctrlKey: true, key: 'Control', code: 'ControlLeft' }))).toEqual({ ok: false, reason: 'modifier-only' })
  })

  it('validates and formats', () => {
    for (const good of ['Control+Shift+Space', 'Alt+N', 'F9', 'Control+Alt+Shift+1', 'Super+`']) expect(isValidAccelerator(good)).toBe(true)
    for (const bad of ['', 'Space', 'Shift+A', 'Control+', 'Control+Control+A', 'Ctrl+A', 'Control+Shift', 'Control+AA', 5]) expect(isValidAccelerator(bad)).toBe(false)
    expect(formatAccelerator('Control+Shift+Space')).toBe('Ctrl + Shift + Space')
  })
})

describe('preferences', () => {
  it('ignores invalid values', () => {
    const merged = mergePreferences(DEFAULT_PREFERENCES, { dockSide: 'top', fontSize: 400, theme: 'neon', shortcut: 'A', alwaysOnTop: 'yes', extra: 1 })
    expect(merged).toEqual({ ...DEFAULT_PREFERENCES, fontSize: 64 })
    expect(mergePreferences(DEFAULT_PREFERENCES, { dockSide: 'left', theme: 'paper', shortcut: 'Alt+N' })).toMatchObject({ dockSide: 'left', theme: 'paper', shortcut: 'Alt+N' })
  })
})
