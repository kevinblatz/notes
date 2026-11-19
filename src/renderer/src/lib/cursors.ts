/**
 * The app's own cursors: a pen nib over empty board space ("click here to write"), and a
 * matching arrow, pointing hand, text I-beam, open / closed hand for dragging and a
 * magnifier for images. Window-edge resizing keeps the system cursors.
 *
 * Every cursor is a small SVG drawn for each theme at 1x and 2x (crisp at 100-200 %
 * display scaling), with an exact hotspot and a plain keyword fallback. They are built once
 * at start-up into a single <style> element that sets --cursor-* custom properties per
 * [data-theme]; the stylesheets only ever say `cursor: var(--cursor-…)`. Nothing here runs
 * after start-up, and nothing follows the pointer: these are real cursors, drawn by the OS.
 */
import type { ThemeKey } from '@shared/types'

export type CursorName = 'arrow' | 'pointer' | 'text' | 'write' | 'writeDown' | 'grab' | 'grabbing' | 'zoomIn' | 'zoomOut'

/** Colours for one theme. Light cursors with a dark rim on the dark themes, the reverse on Paper. */
interface Ink {
  fill: string
  rim: string
  /** The nib's metal, and the lines cut into it. */
  nib: string
  nibLine: string
  shine: string
  /** The drop of ink under the nib while it is pressed to the page. */
  blot: string
  shadow: string
  shadowOpacity: number
}

const INKS: Record<ThemeKey, Ink> = {
  charcoal: { fill: '#f3eee4', rim: '#141516', nib: '#7cc3bc', nibLine: '#0d1c1b', shine: '#e9fbf8', blot: '#5aa8a1', shadow: '#000000', shadowOpacity: 0.4 },
  midnight: { fill: '#f3eee4', rim: '#0a0b0c', nib: '#7cc3bc', nibLine: '#08100f', shine: '#e9fbf8', blot: '#5aa8a1', shadow: '#000000', shadowOpacity: 0.45 },
  paper: { fill: '#24262a', rim: '#fdfcf9', nib: '#237069', nibLine: '#f3fbfa', shine: '#8fd0c9', blot: '#1b5d57', shadow: '#2b2820', shadowOpacity: 0.3 }
}

interface Shape {
  /** Markup drawn in the rim colour, one unit wider on every side. */
  rim: string
  /** The same shape drawn in the fill colour on top. */
  fill: string
}

const rect = (x: number, y: number, w: number, h: number, r: number): Shape => {
  const base = `x='${x}' y='${y}' width='${w}' height='${h}' rx='${r}'`
  return { rim: `<rect ${base} stroke-width='2'/>`, fill: `<rect ${base} stroke='none'/>` }
}

const ring = (cx: number, cy: number, r: number, width: number): Shape => ({
  rim: `<circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke-width='${width + 2}'/>`,
  fill: `<circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke-width='${width}'/>`
})

const stroke = (d: string, width: number): Shape => ({
  rim: `<path d='${d}' fill='none' stroke-width='${width + 2}'/>`,
  fill: `<path d='${d}' fill='none' stroke-width='${width}'/>`
})

/** A rimmed silhouette made of several overlapping shapes, plus details drawn on top. */
function figure(ink: Ink, shapes: Shape[], details = ''): string {
  const rim = shapes.map((s) => s.rim).join('')
  const fill = shapes.map((s) => s.fill).join('')
  return (
    shadowOf(ink, rim) +
    `<g fill='${ink.rim}' stroke='${ink.rim}' stroke-linecap='round' stroke-linejoin='round'>${rim}</g>` +
    `<g fill='${ink.fill}' stroke='${ink.fill}' stroke-linecap='round' stroke-linejoin='round'>${fill}</g>` +
    details
  )
}

/** A soft drop shadow under the rim: invisible on the dark themes, a little lift on Paper. */
function shadowOf(ink: Ink, rimMarkup: string): string {
  return (
    `<filter id='s' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='0.8'/></filter>` +
    `<g filter='url(#s)' opacity='${ink.shadowOpacity}' transform='translate(0 0.9)' fill='${ink.shadow}' stroke='${ink.shadow}' stroke-linecap='round' stroke-linejoin='round'>${rimMarkup}</g>`
  )
}

interface CursorDef {
  /** Box size in CSS pixels (the 2x image is twice this in device pixels). */
  size: number
  hotspot: [number, number]
  fallback: string
  draw: (ink: Ink) => string
}

// ------------------------------------------------------------------ the drawings
// Coordinates are CSS pixels. Straight edges sit on pixel boundaries so the 1x image is crisp.

/** The classic arrow at the system's size, tip on the hotspot. */
const ARROW_PATH = 'M2.5 2.5 L13.5 13.5 L9.3 13.5 L12 19.8 L9.3 21 L6.6 14.7 L2.5 18.7 Z'
function drawArrow(ink: Ink): string {
  const path = `<path d='${ARROW_PATH}'/>`
  return (
    shadowOf(ink, `<path d='${ARROW_PATH}' stroke-width='1'/>`) +
    `<g fill='${ink.fill}' stroke='${ink.rim}' stroke-width='1' stroke-linejoin='round'>${path}</g>`
  )
}

/** A thin I-beam whose serifs curve into the stem like a pen stroke. */
const BEAM_PATH = 'M8.5 3.5 C10.3 3.5 11.5 3.9 11.5 5.6 L11.5 18.4 C11.5 20.1 10.3 20.5 8.5 20.5 M14.5 3.5 C12.7 3.5 11.5 3.9 11.5 5.6 M14.5 20.5 C12.7 20.5 11.5 20.1 11.5 18.4'
function drawText(ink: Ink): string {
  return figure(ink, [stroke(BEAM_PATH, 1)])
}

/** A pointing hand: one finger up, three folded, thumb out to the side. */
function drawPointer(ink: Ink): string {
  const shapes = [
    rect(7, 2, 3, 12, 1.5), // index finger
    rect(10, 8, 3, 7, 1.5),
    rect(13, 9, 3, 6, 1.5),
    rect(16, 10, 2.8, 6, 1.4),
    rect(7, 10.5, 11.8, 10.5, 3.2), // palm
    stroke('M4.4 12.5 L7.6 17.5', 2.7) // thumb
  ]
  const crease = `<g stroke='${ink.rim}' stroke-width='1' stroke-linecap='round' fill='none'><path d='M10.5 9.6 V12.4 M13.5 10.6 V13 M16.5 11.4 V13.4'/></g>`
  return figure(ink, shapes, crease)
}

/** An open hand, ready to pick a note up. */
function drawGrab(ink: Ink): string {
  const shapes = [
    stroke('M7.9 6.8 V13', 2.4),
    stroke('M11.2 4.8 V12.5', 2.4),
    stroke('M14.5 5.3 V12.5', 2.4),
    stroke('M17.6 7.6 V13.5', 2.3),
    rect(6.6, 10.6, 12.4, 10, 4), // palm
    stroke('M4.5 11.8 L7.4 16.6', 2.4) // thumb
  ]
  return figure(ink, shapes)
}

/** A closed hand, holding the note. */
function drawGrabbing(ink: Ink): string {
  const shapes = [
    stroke('M7.9 10.2 V13', 2.4),
    stroke('M11.2 9.4 V12.5', 2.4),
    stroke('M14.5 9.6 V12.5', 2.4),
    stroke('M17.6 10.6 V13.5', 2.3),
    rect(6.6, 10.6, 12.4, 10, 4),
    stroke('M5.6 13.4 L7.6 16.2', 2.4)
  ]
  const knuckles = `<g stroke='${ink.rim}' stroke-width='0.9' stroke-linecap='round' fill='none'><path d='M9.55 10.6 V12.2 M12.85 10.4 V12 M16.05 10.8 V12.4'/></g>`
  return figure(ink, shapes, knuckles)
}

function drawMagnifier(ink: Ink, plus: boolean): string {
  const sign = plus ? 'M7 9.5 H12 M9.5 7 V12' : 'M7 9.5 H12'
  const lens = `<circle cx='9.5' cy='9.5' r='5.2' fill='${ink.fill}' fill-opacity='0.16' stroke='none'/>`
  const shapes = [ring(9.5, 9.5, 5.2, 1.8), stroke('M13.4 13.4 L19.5 19.5', 2.8)]
  const signMarkup = `<path d='${sign}' fill='none' stroke='${ink.rim}' stroke-width='3.4' stroke-linecap='round'/><path d='${sign}' fill='none' stroke='${ink.fill}' stroke-width='1.5' stroke-linecap='round'/>`
  return lens + figure(ink, shapes, signMarkup)
}

/**
 * The signature: a fountain-pen nib, tip on the hotspot, angled the way a pen is held.
 * Drawn upright (tip at the origin, pointing down) and turned 45 degrees. While the mouse
 * button is down on the page (`down`), the nib presses in a little and leaves a drop of ink.
 */
const NIB_TIP: [number, number] = [3.5, 20.5]
function drawNib(ink: Ink, down = false): string {
  const outline = 'M0 0 C-1 -3 -4.6 -7 -4.6 -10.8 L-4.6 -14.6 Q0 -16.3 4.6 -14.6 L4.6 -10.8 C4.6 -7 1 -3 0 0 Z'
  const section = 'M-4 -15.1 Q0 -16.7 4 -15.1 L3.8 -19 Q0 -20.1 -3.8 -19 Z'
  const turn = `translate(${NIB_TIP[0]} ${NIB_TIP[1]}) rotate(45)`
  // The drop lies flat on the page under the tip, so it is drawn before the nib is turned.
  const blot = down ? `<ellipse cx='${NIB_TIP[0] + 0.4}' cy='${NIB_TIP[1] + 0.4}' rx='3.1' ry='1.8' fill='${ink.blot}' stroke='${ink.nibLine}' stroke-width='0.7'/>` : ''
  const body =
    blot +
    `<g transform='${turn}' stroke-linejoin='round'>` +
    `<g transform='translate(0 ${down ? 0.8 : 0})'>` +
    `<path d='${section}' fill='${ink.fill}' stroke='${ink.rim}' stroke-width='1'/>` +
    `<path d='${outline}' fill='${ink.nib}' stroke='${ink.nibLine}' stroke-width='1'/>` +
    `<path d='M-3 -12.9 C-3 -9.6 -1.8 -6.7 -0.85 -4.7' fill='none' stroke='${ink.shine}' stroke-opacity='0.7' stroke-width='0.8' stroke-linecap='round'/>` +
    `<path d='M0 -1.5 V-8.5' stroke='${ink.nibLine}' stroke-width='0.9' stroke-linecap='round'/>` +
    `<circle cx='0' cy='-9.9' r='1.3' fill='${ink.nibLine}'/>` +
    `</g></g>`
  const shadow = `<g transform='${turn}'><path d='${outline} ${section}' stroke-width='1'/></g>`
  return shadowOf(ink, shadow) + body
}

export const CURSORS: Record<CursorName, CursorDef> = {
  arrow: { size: 24, hotspot: [2, 2], fallback: 'default', draw: drawArrow },
  pointer: { size: 24, hotspot: [8, 2], fallback: 'pointer', draw: drawPointer },
  text: { size: 24, hotspot: [11, 12], fallback: 'text', draw: drawText },
  write: { size: 24, hotspot: [3, 20], fallback: 'text', draw: (ink) => drawNib(ink) },
  writeDown: { size: 24, hotspot: [3, 20], fallback: 'text', draw: (ink) => drawNib(ink, true) },
  grab: { size: 24, hotspot: [12, 12], fallback: 'grab', draw: drawGrab },
  grabbing: { size: 24, hotspot: [12, 13], fallback: 'grabbing', draw: drawGrabbing },
  zoomIn: { size: 24, hotspot: [9, 9], fallback: 'zoom-in', draw: (ink) => drawMagnifier(ink, true) },
  zoomOut: { size: 24, hotspot: [9, 9], fallback: 'zoom-out', draw: (ink) => drawMagnifier(ink, false) }
}

const PROPERTY: Record<CursorName, string> = {
  arrow: '--cursor-arrow',
  pointer: '--cursor-pointer',
  text: '--cursor-text',
  write: '--cursor-write',
  writeDown: '--cursor-write-down',
  grab: '--cursor-grab',
  grabbing: '--cursor-grabbing',
  zoomIn: '--cursor-zoom-in',
  zoomOut: '--cursor-zoom-out'
}

export function cursorSvg(name: CursorName, theme: ThemeKey, scale: 1 | 2): string {
  const def = CURSORS[name]
  const px = def.size * scale
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${px}' height='${px}' viewBox='0 0 ${def.size} ${def.size}'>${def.draw(INKS[theme])}</svg>`
}

const dataUri = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`

/** The full `cursor` value for one cursor in one theme. */
export function cursorValue(name: CursorName, theme: ThemeKey): string {
  const def = CURSORS[name]
  const one = dataUri(cursorSvg(name, theme, 1))
  const two = dataUri(cursorSvg(name, theme, 2))
  return `image-set(url("${one}") 1x, url("${two}") 2x) ${def.hotspot[0]} ${def.hotspot[1]}, ${def.fallback}`
}

const THEME_KEYS: ThemeKey[] = ['charcoal', 'midnight', 'paper']

export function cursorStylesheet(): string {
  return THEME_KEYS.map((theme) => {
    const declarations = (Object.keys(CURSORS) as CursorName[]).map((name) => `  ${PROPERTY[name]}: ${cursorValue(name, theme)};`).join('\n')
    return `:root[data-theme='${theme}'] {\n${declarations}\n}`
  }).join('\n')
}

/** Write the cursor rules into the document once, at start-up. */
export function installCursors(doc: Document = document): void {
  if (doc.getElementById('tn-cursors')) return
  const style = doc.createElement('style')
  style.id = 'tn-cursors'
  style.textContent = cursorStylesheet()
  doc.head.appendChild(style)
}
