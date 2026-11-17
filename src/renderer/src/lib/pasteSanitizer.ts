/**
 * Cleans HTML pasted from websites and other apps before the editor parses it.
 * Structure that makes sense in a note is kept (paragraphs, headings, lists, bold, italic,
 * underline, strikethrough, links). Scripts, event handlers, remote images, embedded
 * objects and foreign styling (site colours, fonts, sizes) are removed, so pasted text
 * takes on the note's own look and cannot run code or load anything from the network.
 */
import DOMPurify from 'dompurify'
import { FONT_KEYS, fontVar, HIGHLIGHT_COLORS, highlightVar, INK_COLORS, inkVar, isValidId, normalizeFontSize, safeLinkHref } from '@shared/content'

const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'mark', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'blockquote', 'hr', 'figure', 'label', 'input'
]
const ALLOWED_ATTR = [
  'href', 'style', 'start', 'type', 'checked', 'data-type', 'data-checked', 'data-color', 'data-pm-slice',
  'data-note-image', 'data-attachment-id', 'data-width', 'data-caption', 'data-natural-width', 'data-natural-height'
]

const INK = new Set<string>(INK_COLORS.map(inkVar))
const HIGHLIGHT = new Set<string>(HIGHLIGHT_COLORS.map(highlightVar))
const FONTS = new Set<string>(FONT_KEYS.map(fontVar))

function cleanStyle(element: HTMLElement, fromEditor: boolean): void {
  const kept: string[] = []
  const color = element.style.color.trim()
  const background = element.style.backgroundColor.trim()
  const family = element.style.fontFamily.trim()
  const size = normalizeFontSize(element.style.fontSize)
  if (INK.has(color)) kept.push(`color: ${color}`)
  if (HIGHLIGHT.has(background)) kept.push(`background-color: ${background}`)
  if (FONTS.has(family)) kept.push(`font-family: ${family}`)
  // Text sizes are kept only for content copied out of a note; a website's sizes are dropped.
  if (size && fromEditor) kept.push(`font-size: ${size}`)
  if (kept.length > 0) element.setAttribute('style', kept.join('; '))
  else element.removeAttribute('style')
}

export function sanitizePastedHtml(html: string): string {
  // The editor marks what it copies; anything else is treated as foreign.
  const fromEditor = html.includes('data-pm-slice')
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM_FRAGMENT: true
  })
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT)
  const remove: Element[] = []
  const unwrap: Element[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node as HTMLElement
    const tag = element.tagName
    if (element.hasAttribute('style')) cleanStyle(element, fromEditor)
    if (tag === 'A') {
      const href = safeLinkHref(element.getAttribute('href'))
      if (href) element.setAttribute('href', href)
      else unwrap.push(element)
    } else if (tag === 'FIGURE') {
      if (!element.hasAttribute('data-note-image') || !isValidId(element.getAttribute('data-attachment-id'))) remove.push(element)
    } else if (tag === 'INPUT') {
      if (element.getAttribute('type') !== 'checkbox') remove.push(element)
    } else if (tag === 'MARK') {
      const color = element.getAttribute('data-color')
      if (color && !HIGHLIGHT.has(color)) element.removeAttribute('data-color')
    }
  }
  for (const element of remove) element.remove()
  for (const element of unwrap) element.replaceWith(...Array.from(element.childNodes))
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
