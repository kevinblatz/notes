/**
 * Feedback for starting a note on empty board space: a quick ink drop where the click
 * landed, and the new note's page growing out of that same point ("bloom"). Both are pure
 * CSS animations that end on their own; neither is shown when motion is reduced.
 */
import { useCallback, useState, type AnimationEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motionReduced } from './flip'

interface Drop {
  id: number
  x: number
  y: number
}

let nextDrop = 0

/**
 * Ink drops at viewport points. Returns the function that adds one and the layer to render;
 * the layer is a portal above everything else, ignores the pointer, and is only in the
 * document while a drop is animating. Each drop removes itself when its ring has spread.
 */
export function useInkDrops(): { splash: (x: number, y: number) => void; layer: ReactNode } {
  const [drops, setDrops] = useState<Drop[]>([])

  const splash = useCallback((x: number, y: number) => {
    if (motionReduced()) return
    const id = ++nextDrop
    // A burst of clicks never leaves more than a few drops around.
    setDrops((list) => [...list.slice(-2), { id, x, y }])
  }, [])

  const finish = (id: number) => (event: AnimationEvent<HTMLSpanElement>) => {
    if (event.animationName === 'ink-fade') setDrops((list) => list.filter((drop) => drop.id !== id))
  }

  const layer =
    drops.length > 0
      ? createPortal(
          <div className="ink-layer" aria-hidden data-testid="ink-layer">
            {drops.map((drop) => (
              <span key={drop.id} className="ink-drop" style={{ left: drop.x, top: drop.y }} onAnimationEnd={finish(drop.id)}>
                <span className="ink-drop-ring" />
                <span className="ink-drop-dot" />
              </span>
            ))}
          </div>,
          document.body
        )
      : null

  return { splash, layer }
}

/**
 * Make the next note view grow from a point (viewport coordinates) instead of the middle.
 * `stage` is the element the note view fills. Lasts until endBloom().
 */
export function bloomFrom(x: number, y: number, stage: HTMLElement | null): void {
  if (!stage || motionReduced()) return
  const root = document.documentElement
  const rect = stage.getBoundingClientRect()
  root.style.setProperty('--bloom-x', `${Math.round(x - rect.left)}px`)
  root.style.setProperty('--bloom-y', `${Math.round(y - rect.top)}px`)
  root.dataset.bloom = ''
}

/** Back to the ordinary opening for whatever opens next (a note card, Ctrl+N). */
export function endBloom(): void {
  delete document.documentElement.dataset.bloom
}
