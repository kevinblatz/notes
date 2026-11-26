/**
 * Moves notes smoothly to their new places when the board layout changes ("make space").
 * Positions are captured just before a layout change and played back just after the DOM
 * updates. Only position is animated; text is never scaled.
 */
let board: HTMLElement | null = null
let before: Map<string, { left: number; top: number }> | null = null

const DURATION = 190
const EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)'
const FLIP_ID = 'tn-flip'

export function registerBoard(element: HTMLElement | null): void {
  board = element
  if (!element) before = null
}

export function motionReduced(): boolean {
  return document.documentElement.dataset.motion === 'reduce'
}

/** Remember where every on-screen note is drawn right now (including mid-animation). */
export function captureBoardPositions(): void {
  if (!board || motionReduced() || board.offsetParent === null) {
    before = null
    return
  }
  const origin = board.getBoundingClientRect()
  const positions = new Map<string, { left: number; top: number }>()
  for (const element of board.querySelectorAll<HTMLElement>(':scope > [data-note-id]')) {
    const rect = element.getBoundingClientRect()
    // Notes far outside the window do not need animating.
    if (rect.bottom < -800 || rect.top > window.innerHeight + 800) continue
    positions.set(element.dataset.noteId!, { left: rect.left - origin.left, top: rect.top - origin.top })
  }
  before = positions
}

/** Animate from the captured positions to the current layout. Call after the DOM has updated. */
export function playBoardAnimation(): void {
  const previous = before
  before = null
  if (!previous || !board || motionReduced()) return
  for (const element of board.querySelectorAll<HTMLElement>(':scope > [data-note-id]')) {
    const from = previous.get(element.dataset.noteId!)
    if (!from) continue
    for (const animation of element.getAnimations()) if (animation.id === FLIP_ID) animation.cancel()
    const dx = from.left - element.offsetLeft
    const dy = from.top - element.offsetTop
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
    if (Math.abs(dy) > 2400) continue
    const animation = element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: DURATION, easing: EASING })
    animation.id = FLIP_ID
  }
}
