/**
 * How the app feels under the pointer:
 *
 *  - No insertion line over empty board space (the old teal line is gone, nothing replaces it).
 *  - One custom cursor family: the pen nib over empty board space, and a matching pointing
 *    hand, I-beam, arrow and grab / grabbing hand, crisp at 1x and 2x, in every theme.
 *  - Clicking empty space drops a little ink where the click was and the new note grows out
 *    of that point; both clean up after themselves.
 *  - Press, tick and pin feedback never move what the pointer hits, never replay on their
 *    own, and everything comes back to rest (no running animation). Reduced motion turns
 *    all of it off.
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { board, collectConsoleErrors, dragNote, editorBody, focusView, noteByText, notes, writeNote } from './helpers'
import { launch, setWindowSize, type Launched } from './launch'

let ctx: Launched
let errors: string[]

test.beforeEach(async () => {
  ctx = await launch({ size: { width: 960, height: 1000 } })
  errors = await collectConsoleErrors(ctx.page)
})
test.afterEach(async () => {
  expect(errors, 'no console errors').toEqual([])
  await ctx.quit()
})

type Family = 'arrow' | 'pointer' | 'text' | 'write' | 'grab' | 'grabbing'
const FAMILY: Family[] = ['arrow', 'pointer', 'text', 'write', 'grab', 'grabbing']

/** The computed `cursor` value a family member resolves to in the current theme. */
async function familyCursor(page: Page, name: Family): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('div')
    probe.style.cursor = `var(--cursor-${n})`
    document.body.append(probe)
    const value = getComputedStyle(probe).cursor
    probe.remove()
    return value
  }, name)
}

/** The cursor shown at a viewport point: the computed cursor of the element hit there. */
async function cursorAt(page: Page, x: number, y: number): Promise<{ cursor: string; element: string }> {
  return page.evaluate(
    ({ x, y }) => {
      const element = document.elementFromPoint(x, y) as HTMLElement | null
      if (!element) return { cursor: '', element: '(none)' }
      return { cursor: getComputedStyle(element).cursor, element: `${element.tagName.toLowerCase()}.${String(element.className)}` }
    },
    { x, y }
  )
}

const runningAnimations = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id} on ${String(((a.effect as KeyframeEffect | null)?.target as Element | null)?.className ?? '?')}`)
  )

/** A point in the open board space under the last note, in viewport coordinates. */
async function openSpace(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="board"]')!
    const rect = element.getBoundingClientRect()
    const cards = Array.from(element.querySelectorAll<HTMLElement>(':scope > .note'))
    const bottom = cards.reduce((max, card) => Math.max(max, card.getBoundingClientRect().bottom), rect.top)
    return { x: Math.round(rect.left + rect.width * 0.6), y: Math.round(bottom + 120) }
  })
}

async function setMotion(page: Page, label: 'Reduced' | 'Normal'): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.getByRole('radiogroup', { name: 'Motion' }).getByRole('radio', { name: label }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.sheet')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-motion', label === 'Reduced' ? 'reduce' : 'normal')
}

async function setTheme(page: Page, label: 'Charcoal' | 'Midnight' | 'Paper'): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: label }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.sheet')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase())
}

test('no insertion line anywhere over empty board space, in either layout', async () => {
  const { page, app } = ctx
  await writeNote(page, ['Alpha note'])
  await writeNote(page, ['Bravo note'])
  // Watch the whole document for the old indicator (or anything new appearing on the board).
  await page.evaluate(() => {
    const seen: string[] = []
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) if (node instanceof Element && (node.matches('.insert-mark, [class*="insert"]') || node.querySelector('.insert-mark'))) seen.push(node.className)
    }).observe(document.body, { childList: true, subtree: true })
    ;(window as unknown as { __inserts: string[] }).__inserts = seen
  })
  for (const width of [960, 680]) {
    await setWindowSize(app, page, width, 1000)
    const a = (await noteByText(page, 'Alpha note').boundingBox())!
    const b = (await noteByText(page, 'Bravo note').boundingBox())!
    const points = [
      { x: a.x + a.width / 2, y: (a.y + a.height + b.y) / 2 }, // between the rows
      { x: a.x + a.width + 12, y: a.y + a.height / 2 }, // beside a note
      { x: a.x - 10, y: b.y + b.height / 2 }, // the left margin
      { x: a.x + a.width / 2, y: b.y + b.height + 160 } // the open space below
    ]
    for (const point of points) {
      await page.mouse.move(point.x, point.y, { steps: 4 })
      // Longer than any hover delay a ghost or marker could use.
      await page.waitForTimeout(350)
      await expect(page.locator('.insert-mark')).toHaveCount(0)
      // The board holds notes and nothing else.
      expect(await board(page).evaluate((element) => Array.from(element.children).filter((child) => !child.matches('.note, .board-hint')).length)).toBe(0)
      const at = await cursorAt(page, point.x, point.y)
      expect(at.element).toContain('board')
      expect(at.cursor).toBe(await familyCursor(page, 'write'))
    }
  }
  expect(await page.evaluate(() => (window as unknown as { __inserts: string[] }).__inserts)).toEqual([])
})

test('one cursor family: the nib on empty space, the hand on notes and buttons, the I-beam in text, in every theme', async () => {
  const { page } = ctx
  await writeNote(page, ['Wait for the sweep of the session low.', 'Then the retest of the level.'], { title: 'London open' })
  const card = notes(page).first()
  const nibs = new Set<string>()

  for (const theme of ['Charcoal', 'Midnight', 'Paper'] as const) {
    await setTheme(page, theme)
    const values = Object.fromEntries(await Promise.all(FAMILY.map(async (name) => [name, await familyCursor(page, name)] as const))) as Record<Family, string>

    for (const name of FAMILY) {
      const value = values[name]
      // Real cursors drawn as SVG at 1x and 2x, with a hotspot and a plain keyword fallback.
      expect(value, `${theme} ${name}`).toMatch(/^image-set\(url\("data:image\/svg\+xml,[^"]+"\) (1x|1dppx), url\("data:image\/svg\+xml,[^"]+"\) (2x|2dppx)\) \d+ \d+, [a-z-]+$/)
      const [one, two] = Array.from(value.matchAll(/url\("data:image\/svg\+xml,([^"]+)"\)/g), (match) => decodeURIComponent(match[1]!))
      const size = (svg: string): number[] => [Number(/width='(\d+)'/.exec(svg)![1]), Number(/height='(\d+)'/.exec(svg)![1])]
      const [w1, h1] = size(one!)
      const [w2, h2] = size(two!)
      expect(w1, `${name} at most 32 CSS px`).toBeLessThanOrEqual(32)
      expect(h1).toBeLessThanOrEqual(32)
      expect([w2, h2]).toEqual([w1! * 2, h1! * 2])
      const [hx, hy] = /\) (\d+) (\d+), [a-z-]+$/.exec(value)!.slice(1).map(Number)
      expect(hx!).toBeLessThan(w1!)
      expect(hy!).toBeLessThan(h1!)
    }
    // Six different cursors, drawn in this theme's own colours.
    expect(new Set(Object.values(values)).size).toBe(FAMILY.length)
    nibs.add(values.write)

    // Empty board space: the pen nib.
    const space = await openSpace(page)
    await page.mouse.move(space.x, space.y)
    expect((await cursorAt(page, space.x, space.y)).cursor).toBe(values.write)
    expect(values.write).toMatch(/, text$/)

    // A note card: the pointing hand on the sheet and its title, the I-beam over its text.
    const box = (await card.boundingBox())!
    await page.mouse.move(box.x + box.width - 40, box.y + box.height - 6)
    expect((await cursorAt(page, box.x + box.width - 40, box.y + box.height - 6)).cursor).toBe(values.pointer)
    const title = (await card.locator('.note-title').boundingBox())!
    expect((await cursorAt(page, title.x + 10, title.y + title.height / 2)).cursor).toBe(values.pointer)
    const words = (await card.locator('.prose p').first().boundingBox())!
    expect((await cursorAt(page, words.x + 30, words.y + words.height / 2)).cursor).toBe(values.text)

    // Its tools: the drag handle is the open hand, the buttons the pointing hand.
    await card.hover({ position: { x: 30, y: 12 } })
    const handle = (await card.locator('.note-handle').boundingBox())!
    expect((await cursorAt(page, handle.x + handle.width / 2, handle.y + handle.height / 2)).cursor).toBe(values.grab)
    const pin = (await card.getByRole('button', { name: 'Pin', exact: true }).boundingBox())!
    expect((await cursorAt(page, pin.x + pin.width / 2, pin.y + pin.height / 2)).cursor).toBe(values.pointer)
    const gear = (await page.getByTestId('gear').boundingBox())!
    expect((await cursorAt(page, gear.x + gear.width / 2, gear.y + gear.height / 2)).cursor).toBe(values.pointer)

    // The title bar's open space: the arrow.
    expect((await cursorAt(page, 200, 12)).cursor).toBe(values.arrow)
  }
  expect(nibs.size).toBe(3)

  // In the editor: the I-beam in the text and the title, the hand on buttons.
  await card.locator('.prose p').first().click()
  await expect(editorBody(page)).toBeFocused()
  const text = await familyCursor(page, 'text')
  const body = (await editorBody(page).boundingBox())!
  expect((await cursorAt(page, body.x + 40, body.y + 10)).cursor).toBe(text)
  const titleField = (await page.locator('.focus-title').boundingBox())!
  expect((await cursorAt(page, titleField.x + 40, titleField.y + titleField.height / 2)).cursor).toBe(text)
  const log = (await page.getByRole('button', { name: /Log note/ }).boundingBox())!
  expect((await cursorAt(page, log.x + 10, log.y + log.height / 2)).cursor).toBe(await familyCursor(page, 'pointer'))

  // Nothing on screen falls back to the system's version of a cursor the family draws.
  const strays = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => ['auto', 'default', 'pointer', 'text', 'grab', 'grabbing'].includes(getComputedStyle(element).cursor))
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className)}`)
  )
  expect(strays).toEqual([])
})

test('carrying a note shows the closed hand wherever the pointer goes', async () => {
  const { page } = ctx
  await writeNote(page, ['Alpha note'])
  await writeNote(page, ['Bravo note'])
  const grabbing = await familyCursor(page, 'grabbing')
  const source = noteByText(page, 'Bravo note')
  await source.hover({ position: { x: 30, y: 12 } })
  const handle = (await source.locator('.note-handle').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  // Pressing the handle already closes the hand.
  expect((await cursorAt(page, handle.x + handle.width / 2, handle.y + handle.height / 2)).cursor).toBe(grabbing)
  await page.mouse.move(handle.x - 20, handle.y - 30, { steps: 4 })
  await expect(page.locator('.board.is-dragging')).toBeVisible()
  const alpha = (await noteByText(page, 'Alpha note').locator('.prose p').boundingBox())!
  await page.mouse.move(alpha.x + 20, alpha.y + alpha.height / 2, { steps: 6 })
  for (const [x, y] of [
    [alpha.x + 20, alpha.y + alpha.height / 2],
    [200, 12],
    [480, 700]
  ] as const)
    expect((await cursorAt(page, x, y)).cursor, `at ${x},${y}`).toBe(grabbing)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.board.is-dragging')).toHaveCount(0)
  const space = await openSpace(page)
  expect((await cursorAt(page, space.x, space.y)).cursor).toBe(await familyCursor(page, 'write'))
})

test('clicking empty space drops ink where the click was; the draft grows from there; both clear away', async () => {
  const { page } = ctx
  await writeNote(page, ['Alpha note'])
  await expect.poll(() => runningAnimations(page)).toEqual([])
  const space = await openSpace(page)
  await page.mouse.click(space.x, space.y)

  // The drop: in a layer above everything, centred on the click, ignoring the pointer.
  const drop = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.ink-layer .ink-drop')
    if (!element) return null
    const layer = element.closest<HTMLElement>('.ink-layer')!
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top, layerZ: Number(getComputedStyle(layer).zIndex), pointerEvents: getComputedStyle(layer).pointerEvents, inBody: layer.parentElement === document.body }
  })
  expect(drop).not.toBeNull()
  expect(drop!.x).toBeCloseTo(space.x, 0)
  expect(drop!.y).toBeCloseTo(space.y, 0)
  expect(drop!.pointerEvents).toBe('none')
  expect(drop!.inBody).toBe(true)
  expect(drop!.layerZ).toBeGreaterThanOrEqual(200)

  // The new note's page grows from the click point.
  await expect(focusView(page)).toBeVisible()
  const bloom = await page.evaluate(() => {
    const view = document.querySelector<HTMLElement>('[data-testid="focus-view"]')!
    const stage = view.parentElement!.getBoundingClientRect()
    const style = getComputedStyle(view)
    return { name: style.animationName, origin: style.transformOrigin, stageLeft: stage.left, stageTop: stage.top }
  })
  expect(bloom.name).toBe('note-bloom')
  expect(bloom.origin).toBe(`${Math.round(space.x - bloom.stageLeft)}px ${Math.round(space.y - bloom.stageTop)}px`)
  // Writing starts at once, as before.
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.type('Drafted from the drop')

  // Both are gone within half a second and nothing is left animating.
  await expect(page.locator('.ink-layer')).toHaveCount(0, { timeout: 1500 })
  await expect.poll(() => runningAnimations(page), { timeout: 1500 }).toEqual([])
  await expect(editorBody(page)).toHaveText('Drafted from the drop')

  // Back on the board, opening an existing note uses the ordinary opening, not the bloom.
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await expect(page.locator('html')).not.toHaveAttribute('data-bloom')
  await noteByText(page, 'Alpha note').locator('.prose p').click()
  await expect(focusView(page)).toBeVisible()
  expect(await focusView(page).evaluate((element) => getComputedStyle(element).animationName)).toBe('focus-in')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  // Ctrl+N starts a draft without a click: no drop, ordinary opening.
  await page.keyboard.press('Control+n')
  await expect(focusView(page)).toBeVisible()
  await expect(page.locator('.ink-layer')).toHaveCount(0)
  expect(await focusView(page).evaluate((element) => getComputedStyle(element).animationName)).toBe('focus-in')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await expect.poll(() => runningAnimations(page)).toEqual([])
})

test('ticking, pinning and pressing give feedback without moving anything, and then everything rests', async () => {
  const { page } = ctx
  // A checklist note, made the way a person would.
  const space = await openSpace(page)
  await page.mouse.click(space.x, space.y)
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.type('[ ] Mark the overnight high')
  await page.keyboard.press('Enter')
  await page.keyboard.type('News at 8:30')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const card = notes(page).first()
  await expect(card.locator('input[type="checkbox"]')).toHaveCount(2)
  await expect.poll(() => runningAnimations(page)).toEqual([])

  // Tick: the box and the text animate, the layout does not move, and it settles.
  const size = (): Promise<{ height: number; width: number }> => card.evaluate((element) => ({ height: (element as HTMLElement).offsetHeight, width: (element as HTMLElement).offsetWidth }))
  const before = await size()
  const box = card.locator('input[type="checkbox"]').first()
  await box.click()
  await expect(box).toBeChecked()
  const ticking = await runningAnimations(page)
  expect(ticking.some((name) => name.includes('box-shadow'))).toBe(true)
  expect(await size()).toEqual(before)
  await expect(card.locator('li[data-checked="true"] > div')).toHaveCSS('text-decoration-line', 'line-through')
  await expect.poll(() => runningAnimations(page)).toEqual([])

  // Pin: one pop on the pin, and only for pinning.
  await card.hover({ position: { x: 30, y: 12 } })
  await card.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Unpin' })).toHaveClass(/is-popping/)
  await expect(card.locator('.is-popping')).toHaveCount(0, { timeout: 1500 })
  await card.getByRole('button', { name: 'Unpin' }).click()
  await expect(card.getByRole('button', { name: 'Pin', exact: true })).not.toHaveClass(/is-popping/)
  await card.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(card.locator('.is-popping')).toHaveCount(0, { timeout: 1500 })
  await expect.poll(() => runningAnimations(page)).toEqual([])

  // Leaving the board and coming back replays none of it (the board is hidden meanwhile).
  await card.locator('.prose li p').first().click()
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await page.waitForTimeout(100)
  const ours = /^(ink-|pin-|note-bloom|box-shadow|text-decoration-color)/
  expect((await runningAnimations(page)).filter((name) => ours.test(name))).toEqual([])

  // Press: a text button shrinks a touch but keeps its place and its full hit area, so a
  // press that starts right at its edge still counts.
  await card.locator('.prose li p').first().click()
  await expect(focusView(page)).toBeVisible()
  await expect.poll(() => runningAnimations(page)).toEqual([]) // the note view has finished opening
  const log = page.getByRole('button', { name: /Log note/ })
  const place = (): Promise<number[]> => log.evaluate((element) => [(element as HTMLElement).offsetLeft, (element as HTMLElement).offsetTop, (element as HTMLElement).offsetWidth, (element as HTMLElement).offsetHeight])
  const rest = await place()
  const edge = (await log.boundingBox())!
  const press = { x: edge.x + edge.width - 1.5, y: edge.y + edge.height / 2 }
  await page.mouse.move(press.x, press.y)
  await page.mouse.down()
  await page.waitForTimeout(150)
  expect(await log.evaluate((element) => getComputedStyle(element).transform)).not.toBe('none')
  expect((await log.boundingBox())!.width).toBeLessThan(edge.width - 2)
  expect(await place()).toEqual(rest)
  // The drawn button is now narrower than the press point, yet the press is still on it.
  expect(await log.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), press)).toBe(true)
  await page.mouse.up()
  await expect(focusView(page)).toBeHidden()
  // An icon button squeezes only its icon: the button itself does not change at all.
  const gear = page.getByTestId('gear')
  const gearBox = (await gear.boundingBox())!
  await page.mouse.move(gearBox.x + gearBox.width / 2, gearBox.y + gearBox.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(120)
  expect(await gear.evaluate((element) => getComputedStyle(element).transform)).toBe('none')
  expect(await gear.locator('svg').evaluate((element) => getComputedStyle(element).transform)).not.toBe('none')
  await page.mouse.up()
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(() => runningAnimations(page)).toEqual([])
})

test('with Reduced motion on there is no ink drop, no bloom and nothing animates', async () => {
  const { page } = ctx
  await writeNote(page, ['Alpha note'])
  await setMotion(page, 'Reduced')
  await page.evaluate(() => {
    const seen: string[] = []
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.matches('.ink-layer, .ink-drop')) seen.push(node.className)
    }).observe(document.body, { childList: true, subtree: true })
    ;(window as unknown as { __ink: string[] }).__ink = seen
  })
  const space = await openSpace(page)
  await page.mouse.click(space.x, space.y)
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { __ink: string[] }).__ink)).toEqual([])
  await expect(page.locator('html')).not.toHaveAttribute('data-bloom')
  // The note view's opening is instant.
  expect(await focusView(page).evaluate((element) => parseFloat(getComputedStyle(element).animationDuration))).toBeLessThan(0.01)
  await expect.poll(() => runningAnimations(page), { timeout: 300 }).toEqual([])
  await page.keyboard.type('[ ] Calm item')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  const card = noteByText(page, 'Calm item')
  await card.locator('input[type="checkbox"]').click()
  await card.hover({ position: { x: 30, y: 12 } })
  await card.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(card.locator('.is-popping')).toHaveCount(0)
  await expect.poll(() => runningAnimations(page), { timeout: 300 }).toEqual([])
  // Transitions are instant.
  expect(await card.locator('input[type="checkbox"]').evaluate((element) => getComputedStyle(element).transitionDuration.split(', ').every((d) => parseFloat(d) < 0.01))).toBe(true)

  // Turning motion back on brings the drop back.
  await setMotion(page, 'Normal')
  await page.mouse.click(space.x, space.y + 120)
  await expect(page.locator('.ink-layer .ink-drop')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await expect(page.locator('.ink-layer')).toHaveCount(0, { timeout: 1500 })
})

test('the cursors and the drop work the same at 680 px, and dragging a note still drops it in place', async () => {
  const { page, app } = ctx
  await setWindowSize(app, page, 680, 1000)
  await writeNote(page, ['Alpha note'])
  await writeNote(page, ['Bravo note'])
  const space = await openSpace(page)
  expect((await cursorAt(page, space.x, space.y)).cursor).toBe(await familyCursor(page, 'write'))
  await dragNote(page, 'Bravo note', 'Alpha note', 0.5, 0.15)
  expect(await notes(page).evaluateAll((cards) => cards.map((card) => card.textContent?.trim()))).toEqual(['Bravo note', 'Alpha note'])
  await expect.poll(() => runningAnimations(page)).toEqual([])
})
