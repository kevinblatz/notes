/**
 * Escape closes exactly one thing: whatever is on top. Open menus, panels and the image
 * preview register here while they are open; the focused-note view registers "return to
 * the board" underneath them. The most recently opened entry receives the key.
 */
import { useEffect, useRef } from 'react'

const stack: Array<{ run: () => void }> = []
let installed = false
let openAtPointerDown = false

// Registered at load, so it runs before any menu's own "click outside" handler: it records
// whether something was open at the moment the pointer went down. A press that closes a
// menu must not also be treated as a click on the board underneath.
window.addEventListener(
  'pointerdown',
  () => {
    openAtPointerDown = stack.length > 0
  },
  true
)

/** True when a menu, panel or preview was open at the start of the current press. */
export function overlayWasOpenAtPointerDown(): boolean {
  return openAtPointerDown
}

function install(): void {
  if (installed) return
  installed = true
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      const top = stack[stack.length - 1]
      if (!top) return
      event.preventDefault()
      event.stopPropagation()
      top.run()
    },
    true
  )
}

export function useEscape(active: boolean, handler: () => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!active) return
    install()
    const entry = { run: () => latest.current() }
    stack.push(entry)
    return () => {
      const index = stack.indexOf(entry)
      if (index !== -1) stack.splice(index, 1)
    }
  }, [active])
}

/** True while any menu, panel or preview is open above the base view. */
export function overlayDepth(): number {
  return stack.length
}
