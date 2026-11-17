import { expect, test } from './fixtures'
import { boardLabels, clickEmptySpace, collectConsoleErrors, dragNote, focusView, layoutBoxes, noteByText, notes, storedLayout, storedNotes, writeNote } from './helpers'
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

const LETTERS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']

async function seed(page: Launched['page'], names = LETTERS): Promise<void> {
  for (const name of names) await writeNote(page, [`${name} note`, `Details for ${name.toLowerCase()}.`])
}

const flat = (layout: string[][]): string[] => layout.flat().sort()
const ALL = LETTERS.map((name) => `${name} note`).sort()

test('new notes land where the click was: between rows, beside a note, or at the end', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo'])
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Bravo note']])

  // The gap between the two notes.
  const a = (await noteByText(page, 'Alpha note').boundingBox())!
  const b = (await noteByText(page, 'Bravo note').boundingBox())!
  await page.mouse.click(a.x + 300, (a.y + a.height + b.y) / 2)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Between note')
  await page.keyboard.press('Control+Enter')
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Between note'], ['Bravo note']])

  // The margin to the right of Bravo: side by side with it.
  const b2 = (await noteByText(page, 'Bravo note').boundingBox())!
  await page.mouse.click(b2.x + b2.width + 14, b2.y + b2.height / 2)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Beside note')
  await page.keyboard.press('Control+Enter')
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Between note'], ['Bravo note', 'Beside note']])
  const pair = await layoutBoxes(page, ['Bravo note', 'Beside note'])
  expect(pair['Beside note']!.y).toBe(pair['Bravo note']!.y)
  expect(pair['Beside note']!.x).toBeGreaterThan(pair['Bravo note']!.x + pair['Bravo note']!.width)

  // The open space below everything: appended at the end.
  await clickEmptySpace(page)
  await page.keyboard.type('Last note')
  await page.keyboard.press('Control+Enter')
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Between note'], ['Bravo note', 'Beside note'], ['Last note']])
})

test('drag notes above, below, left and right, including around a full pair, without losing any', async () => {
  const { page, app } = ctx
  await seed(page)
  expect(await storedLayout(app)).toEqual(LETTERS.map((n) => [`${n} note`]))

  // Above: Echo to the top.
  await dragNote(page, 'Echo note', 'Alpha note', 0.5, 0.15)
  expect(await storedLayout(app)).toEqual([['Echo note'], ['Alpha note'], ['Bravo note'], ['Charlie note'], ['Delta note']])

  // Below: Echo back under Charlie.
  await dragNote(page, 'Echo note', 'Charlie note', 0.5, 0.85)
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Bravo note'], ['Charlie note'], ['Echo note'], ['Delta note']])

  // Right: Bravo beside Alpha.
  await dragNote(page, 'Bravo note', 'Alpha note', 0.93, 0.5)
  expect(await storedLayout(app)).toEqual([['Alpha note', 'Bravo note'], ['Charlie note'], ['Echo note'], ['Delta note']])

  // Left of a full pair: Charlie takes the left slot, Bravo is displaced into its own row below.
  await dragNote(page, 'Charlie note', 'Alpha note', 0.06, 0.5)
  expect(await storedLayout(app)).toEqual([['Charlie note', 'Alpha note'], ['Bravo note'], ['Echo note'], ['Delta note']])

  // Right of a full pair: Delta takes the right slot, Charlie is displaced into its own row above.
  await dragNote(page, 'Delta note', 'Alpha note', 0.97, 0.5)
  expect(await storedLayout(app)).toEqual([['Charlie note'], ['Alpha note', 'Delta note'], ['Bravo note'], ['Echo note']])

  // Swap sides inside the pair.
  await dragNote(page, 'Alpha note', 'Delta note', 0.97, 0.5)
  expect(await storedLayout(app)).toEqual([['Charlie note'], ['Delta note', 'Alpha note'], ['Bravo note'], ['Echo note']])

  // Out of the pair to a row of its own, by dragging into the open space below the last note.
  await dragNote(page, 'Alpha note', 'Echo note', 0.5, 3.2)
  expect(await storedLayout(app)).toEqual([['Charlie note'], ['Delta note'], ['Bravo note'], ['Echo note'], ['Alpha note']])

  // Every note is still there, with its words intact.
  expect(flat(await storedLayout(app))).toEqual(ALL)
  const stored = await storedNotes(app)
  expect(stored).toHaveLength(5)
  for (const name of LETTERS) expect(stored.some((n) => n.plainText === `${name} note\nDetails for ${name.toLowerCase()}.`)).toBe(true)
  await expect(notes(page)).toHaveCount(5)

  // Undo restores the previous arrangement (Ctrl+Z on the board, or the toast's Undo).
  await page.keyboard.press('Control+z')
  expect(await storedLayout(app)).toEqual([['Charlie note'], ['Delta note', 'Alpha note'], ['Bravo note'], ['Echo note']])
  await page.keyboard.press('Control+z')
  expect(await storedLayout(app)).toEqual([['Charlie note'], ['Alpha note', 'Delta note'], ['Bravo note'], ['Echo note']])
})

test('the board shows the landing place while dragging and Esc cancels the move', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie'])
  const before = await storedLayout(app)
  const source = noteByText(page, 'Charlie note')
  await source.hover({ position: { x: 30, y: 12 } })
  const handle = (await source.locator('.note-handle').boundingBox())!
  await page.mouse.move(handle.x + 8, handle.y + 8)
  await page.mouse.down()
  await page.mouse.move(handle.x, handle.y + 20, { steps: 3 })
  const target = (await noteByText(page, 'Alpha note').boundingBox())!
  await page.mouse.move(target.x + target.width * 0.5, target.y + 6, { steps: 8 })
  await page.waitForTimeout(250)
  // Live preview: the placeholder is now first, the others have moved down, nothing is hidden or merged.
  expect(await boardLabels(page)).toEqual(['Charlie note', 'Alpha note', 'Bravo note'])
  await expect(page.locator('.note.is-placeholder')).toHaveCount(1)
  await expect(page.locator('.drag-chip')).toHaveText('Charlie note')
  await page.screenshot({ path: 'tests/e2e/shots/drag-preview.png' })
  // The stored layout does not change until the drop.
  expect(await storedLayout(app)).toEqual(before)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.note.is-placeholder')).toHaveCount(0)
  expect(await boardLabels(page)).toEqual(['Alpha note', 'Bravo note', 'Charlie note'])
  expect(await storedLayout(app)).toEqual(before)
})

test('rearranging with the keyboard, and through the note menu', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie'])
  await noteByText(page, 'Charlie note').focus()
  await page.keyboard.press('Alt+ArrowUp')
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Charlie note'], ['Bravo note']])
  // Focus stays on the moved note, so it can keep moving.
  await expect(noteByText(page, 'Charlie note')).toBeFocused()
  await page.keyboard.press('Alt+ArrowRight')
  expect(await storedLayout(app)).toEqual([['Alpha note', 'Charlie note'], ['Bravo note']])
  await page.keyboard.press('Alt+ArrowLeft')
  expect(await storedLayout(app)).toEqual([['Charlie note', 'Alpha note'], ['Bravo note']])
  await page.keyboard.press('Alt+ArrowDown')
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Charlie note'], ['Bravo note']])
  await expect(page.locator('.sr-only')).toContainText('row 2 of 3')

  // The same moves are in the note's menu.
  await noteByText(page, 'Bravo note').hover()
  await noteByText(page, 'Bravo note').getByRole('button', { name: 'Note actions' }).click()
  await page.getByRole('menuitem', { name: 'Move up' }).click()
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Bravo note'], ['Charlie note']])

  // Enter opens the focused note; Delete moves it to Trash.
  await noteByText(page, 'Alpha note').focus()
  await page.keyboard.press('Enter')
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await noteByText(page, 'Alpha note').focus()
  await page.keyboard.press('Delete')
  await expect(notes(page)).toHaveCount(2)
  // Ctrl+N starts a note at the end without the mouse.
  await page.keyboard.press('Control+n')
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Keyboard note')
  await page.keyboard.press('Control+Enter')
  expect(await storedLayout(app)).toEqual([['Bravo note'], ['Charlie note'], ['Keyboard note']])
})

test('one- and two-column layouts: pairs stack when narrow and return side by side when wide', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie'])
  await dragNote(page, 'Bravo note', 'Alpha note', 0.93, 0.5)
  expect(await storedLayout(app)).toEqual([['Alpha note', 'Bravo note'], ['Charlie note']])

  const geometry = async (): Promise<Record<string, { x: number; y: number; width: number }>> => {
    const boxes = await layoutBoxes(page, ['Alpha note', 'Bravo note', 'Charlie note'])
    return { Alpha: boxes['Alpha note']!, Bravo: boxes['Bravo note']!, Charlie: boxes['Charlie note']! }
  }

  // 960 px: two columns.
  let g = await geometry()
  expect(g.Alpha!.y).toBe(g.Bravo!.y)
  expect(g.Bravo!.x).toBeGreaterThan(g.Alpha!.x + g.Alpha!.width)
  expect(g.Alpha!.width).toBeGreaterThan(380)
  await page.screenshot({ path: 'tests/e2e/shots/width-960.png' })

  // 680 px: the pair stacks (Alpha above Bravo), full width, still before Charlie.
  await setWindowSize(app, page, 680, 1000)
  await expect(page.locator('.board.is-stacked')).toBeVisible()
  g = await geometry()
  expect(g.Bravo!.y).toBeGreaterThan(g.Alpha!.y)
  expect(g.Charlie!.y).toBeGreaterThan(g.Bravo!.y)
  expect(g.Alpha!.x).toBe(g.Bravo!.x)
  expect(g.Alpha!.width).toBeGreaterThan(560)
  // No horizontal scrolling and text is not squeezed.
  expect(await page.getByTestId('board-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'tests/e2e/shots/width-680.png' })
  // The stored grouping is untouched by the narrow view.
  expect(await storedLayout(app)).toEqual([['Alpha note', 'Bravo note'], ['Charlie note']])

  // Widen again: the same pair, same left-to-right order.
  await setWindowSize(app, page, 960, 1000)
  await expect(page.locator('.board.is-wide')).toBeVisible()
  g = await geometry()
  expect(g.Alpha!.y).toBe(g.Bravo!.y)
  expect(g.Bravo!.x).toBeGreaterThan(g.Alpha!.x)

  // Minimum window width stays usable.
  await setWindowSize(app, page, 420, 700)
  expect(await page.getByTestId('board-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'tests/e2e/shots/width-420.png' })
})

test('arrangement survives editing, adding notes and a restart', async () => {
  const { page, app, dataDir } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie'])
  await dragNote(page, 'Charlie note', 'Alpha note', 0.06, 0.5)
  const arranged = [['Charlie note', 'Alpha note'], ['Bravo note']]
  expect(await storedLayout(app)).toEqual(arranged)

  // Edit a note in the pair.
  await noteByText(page, 'Alpha note').locator('.prose p').nth(1).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Edited.')
  await page.keyboard.press('Control+Enter')
  expect(await storedLayout(app)).toEqual(arranged)
  // Returning to the board reveals the edited note and does not jump to the top.
  await expect(noteByText(page, 'Alpha note')).toBeInViewport()

  await writeNote(page, ['Delta note'])
  expect(await storedLayout(app)).toEqual([...arranged, ['Delta note']])

  await ctx.quit()
  ctx = await launch({ dataDir, size: { width: 960, height: 1000 } })
  errors = await collectConsoleErrors(ctx.page)
  expect(await storedLayout(ctx.app)).toEqual([...arranged, ['Delta note']])
  expect(await boardLabels(ctx.page)).toEqual(['Charlie note', 'Alpha note', 'Bravo note', 'Delta note'])
})
