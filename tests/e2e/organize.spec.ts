/**
 * Pins, the pinned index, Find, tags, Trash, collapse, and the things that stay live on the
 * board (checklists and links). Requirement sections 7 and 8 (Trash), acceptance checks 9 and 10a.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import {
  boardLabels,
  clickEmptySpace,
  collectConsoleErrors,
  copyHtmlToClipboard,
  editorBody,
  focusView,
  makePng,
  noteByText,
  notes,
  storedLayout,
  storedNotes,
  windowCount,
  writeNote,
  type TestHandle
} from './helpers'
import { launch, removeDataDir, type Launched } from './launch'

type Page = Launched['page']
type App = Launched['app']
type Locator = ReturnType<Page['locator']>

const SIZE = { width: 960, height: 1000 }
const RED = makePng(640, 360, [220, 70, 60])
const BLUE = makePng(2000, 1125, [60, 110, 220])
const NATO = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel']

let ctx: Launched
let errors: string[]

test.beforeEach(async () => {
  ctx = await launch({ size: SIZE })
  errors = await collectConsoleErrors(ctx.page)
})
test.afterEach(async () => {
  expect(errors, 'no console errors').toEqual([])
  await ctx.quit()
  removeDataDir(ctx.dataDir)
})

/** Quit through the normal shutdown path and start again on the same data. */
async function restart(): Promise<void> {
  expect(errors, 'no console errors before restart').toEqual([])
  const { dataDir } = ctx
  await ctx.quit()
  ctx = await launch({ dataDir, size: SIZE })
  errors = await collectConsoleErrors(ctx.page)
}

// ---------------------------------------------------------------- helpers (this spec only)

async function seed(page: Page, names: string[]): Promise<void> {
  for (const name of names) await writeNote(page, [`${name} note`, `Details for ${name.toLowerCase()}.`])
}

/** Notes tall enough that eight of them need scrolling in a 1000 px window. */
async function seedTall(page: Page, names: string[]): Promise<void> {
  for (const name of names) await writeNote(page, [`${name} note`, 'Entry rule', 'Stop rule', 'Target rule', 'Review rule', `Last line of ${name.toLowerCase()}`])
}

/** Put the second note beside the first with the keyboard (Alt+Right joins the row above). */
async function pairWithRowAbove(page: Page, noteText: string): Promise<void> {
  await noteByText(page, noteText).focus()
  await page.keyboard.press('Alt+ArrowRight')
}

const palette = (page: Page): Locator => page.getByTestId('palette')
const findInput = (page: Page): Locator => page.getByRole('combobox', { name: 'Find notes' })
const results = (page: Page): Locator => palette(page).getByRole('option')
const resultLabels = (page: Page): Locator => palette(page).locator('.result .result-label')
const activeResult = (page: Page): Locator => palette(page).locator('.result.is-active .result-label')
const pinEntries = (page: Page): Locator => palette(page).locator('.pin-row .pin-open .result-label')
const pinHandle = (page: Page, label: string): Locator => palette(page).getByRole('button', { name: `Reorder ${label}`, exact: true })
const scroller = (page: Page): Locator => page.getByTestId('board-scroll')
const trashToast = (page: Page): Locator => page.locator('.toast').filter({ hasText: 'Note moved to Trash' })
const formatBar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Formatting', exact: true })

async function gearItem(page: Page, name: RegExp): Promise<void> {
  await page.getByTestId('gear').click()
  await page.getByRole('menuitem', { name }).click()
}

/** Hover a note the way a person would to bring up its controls. */
async function hoverNote(page: Page, noteText: string): Promise<Locator> {
  const note = noteByText(page, noteText)
  await note.hover({ position: { x: 30, y: 12 } })
  return note
}

async function noteMenuItem(page: Page, noteText: string, item: string | RegExp): Promise<void> {
  const note = await hoverNote(page, noteText)
  await note.getByRole('button', { name: 'Note actions' }).click()
  await page.getByRole('menuitem', typeof item === 'string' ? { name: item, exact: true } : { name: item }).click()
}

async function pinFromHover(page: Page, noteText: string): Promise<void> {
  const note = await hoverNote(page, noteText)
  await note.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(note).toHaveClass(/is-pinned/)
}

/** Replace the query in the Find field and type a new one. */
async function typeQuery(page: Page, query: string): Promise<void> {
  await expect(findInput(page)).toBeFocused()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type(query)
}

/** Pinned notes as stored, in pin order, by first line. */
async function pinLabels(app: App): Promise<string[]> {
  return app.evaluate(() => {
    const { library } = (globalThis as unknown as { __tnTest: TestHandle }).__tnTest
    const label = new Map(library.listLive().map((note) => [note.id, (note.title ?? note.plainText.split('\n')[0] ?? '').trim()]))
    return library.db.getPins().map((id) => label.get(id) ?? `?${id}`)
  })
}

async function trashCount(app: App): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __tnTest: TestHandle }).__tnTest.library.db.countTrash())
}

/** First lines of the notes stored as collapsed. */
async function collapsedLabels(app: App): Promise<string[]> {
  return app.evaluate(() => {
    const { library } = (globalThis as unknown as { __tnTest: TestHandle }).__tnTest
    const live = library.listLive() as unknown as Array<{ title: string | null; plainText: string; collapsed: boolean }>
    return live.filter((note) => note.collapsed).map((note) => (note.title ?? note.plainText.split('\n')[0] ?? '').trim()).sort()
  })
}

async function attachmentRecordCount(app: App): Promise<number> {
  return app.evaluate(() => {
    const { library } = (globalThis as unknown as { __tnTest: TestHandle }).__tnTest
    return (library.db as unknown as { listAttachments: () => unknown[] }).listAttachments().length
  })
}

interface DocNode {
  type?: string
  attrs?: Record<string, unknown>
  content?: DocNode[]
}

function walkDoc(node: DocNode, visit: (node: DocNode) => void): void {
  visit(node)
  for (const child of node.content ?? []) walkDoc(child, visit)
}

/** Stored content of the note whose text starts with `firstLine`. */
async function storedContent(app: App, firstLine: string): Promise<DocNode> {
  const note = (await storedNotes(app)).find((n) => (n.title ?? n.plainText).startsWith(firstLine))
  expect(note, `stored note "${firstLine}"`).toBeTruthy()
  return note!.content as DocNode
}

function taskStates(doc: DocNode): boolean[] {
  const out: boolean[] = []
  walkDoc(doc, (node) => {
    if (node.type === 'taskItem') out.push(node.attrs?.checked === true)
  })
  return out
}

function attachmentIds(doc: DocNode): string[] {
  const out: string[] = []
  walkDoc(doc, (node) => {
    if (node.type === 'noteImage') out.push(String(node.attrs?.attachmentId))
  })
  return out
}

/** The notes on the board, top to bottom, by ID (works for collapsed notes too). */
async function boardIds(page: Page): Promise<Array<string | null>> {
  return notes(page).evaluateAll((cards) => cards.map((card) => card.getAttribute('data-note-id')))
}

type Boxes = Record<string, { x: number; y: number; width: number; height: number }>

async function boxes(page: Page): Promise<Boxes> {
  return notes(page).evaluateAll((cards) =>
    Object.fromEntries(
      cards.map((card) => {
        const rect = card.getBoundingClientRect()
        return [card.getAttribute('data-note-id') ?? '', { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }]
      })
    )
  )
}

/** Where every note is drawn once the "make space" animation has finished. */
async function settledBoxes(page: Page): Promise<Boxes> {
  let last = await boxes(page)
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(90)
    const next = await boxes(page)
    if (JSON.stringify(next) === JSON.stringify(last)) return next
    last = next
  }
  return last
}

const scrollTop = (page: Page): Promise<number> => scroller(page).evaluate((element) => element.scrollTop)

async function settledScrollTop(page: Page): Promise<number> {
  let last = await scrollTop(page)
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(90)
    const next = await scrollTop(page)
    if (next === last) return next
    last = next
  }
  return last
}

/** Scroll the board with the mouse wheel and wait for it to come to rest. */
async function wheelBoard(page: Page, deltaY: number): Promise<number> {
  const box = (await scroller(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, deltaY)
  return settledScrollTop(page)
}

/** Move the pointer to the window edge so it is not resting on a search result. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(3, 720)
}

async function expectRevealed(page: Page, noteText: string): Promise<void> {
  const note = noteByText(page, noteText)
  await expect(note).toHaveClass(/is-spotlit/)
  await expect(note).toBeInViewport()
}

// ---------------------------------------------------------------- pins

test('pin and unpin from the hover controls, the note menu and the keyboard; the note never moves', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie', 'Delta'])
  await pairWithRowAbove(page, 'Charlie note')
  const layout = [['Alpha note'], ['Bravo note', 'Charlie note'], ['Delta note']]
  await expect.poll(() => storedLayout(app)).toEqual(layout)
  const order = await boardLabels(page)
  const before = await settledBoxes(page)

  // Hover controls.
  const alpha = await hoverNote(page, 'Alpha note')
  await alpha.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(alpha).toHaveClass(/is-pinned/)
  await expect(alpha).toHaveAttribute('aria-label', 'Note: Alpha note, pinned')
  await expect(alpha.getByRole('button', { name: 'Unpin', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => pinLabels(app)).toEqual(['Alpha note'])
  await expect(focusView(page)).toBeHidden()

  // The note's menu, on the right half of a pair.
  await noteMenuItem(page, 'Charlie note', 'Pin')
  await expect(noteByText(page, 'Charlie note')).toHaveClass(/is-pinned/)
  await expect.poll(() => pinLabels(app)).toEqual(['Alpha note', 'Charlie note'])

  // Keyboard: Tab from a focused note reaches its Pin control.
  const delta = noteByText(page, 'Delta note')
  await delta.focus()
  await page.keyboard.press('Tab')
  await expect(delta.getByRole('button', { name: 'Pin', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(delta).toHaveClass(/is-pinned/)
  await expect.poll(() => pinLabels(app)).toEqual(['Alpha note', 'Charlie note', 'Delta note'])
  await expect(focusView(page)).toBeHidden()

  // Pinning added references; nothing on the board moved.
  expect(await storedLayout(app)).toEqual(layout)
  expect(await boardLabels(page)).toEqual(order)
  expect(await settledBoxes(page)).toEqual(before)
  await page.getByTestId('gear').click()
  await expect(page.getByRole('menuitem', { name: 'Pinned notes (3)' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Unpin: menu, hover control.
  await noteMenuItem(page, 'Alpha note', 'Unpin')
  await expect(noteByText(page, 'Alpha note')).not.toHaveClass(/is-pinned/)
  await expect.poll(() => pinLabels(app)).toEqual(['Charlie note', 'Delta note'])
  const charlie = await hoverNote(page, 'Charlie note')
  await charlie.getByRole('button', { name: 'Unpin', exact: true }).click()
  await expect(charlie).not.toHaveClass(/is-pinned/)
  await expect(charlie.getByRole('button', { name: 'Pin', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => pinLabels(app)).toEqual(['Delta note'])

  expect(await storedLayout(app)).toEqual(layout)
  expect(await boardLabels(page)).toEqual(order)
  expect(await settledBoxes(page)).toEqual(before)
  expect((await storedNotes(app)).map((n) => n.plainText).sort()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta'].map((n) => `${n} note\nDetails for ${n.toLowerCase()}.`))
})

test('pinned index: pin order, reveal with a brief outline, reorder by keyboard and mouse, order survives a restart', async () => {
  let { page, app } = ctx
  await seedTall(page, NATO)
  const layout = await storedLayout(app)
  const order = await boardLabels(page)
  expect(order).toEqual(NATO.map((n) => `${n} note`))

  for (const name of ['Golf', 'Bravo', 'Echo']) await pinFromHover(page, `${name} note`)
  await expect.poll(() => pinLabels(app)).toEqual(['Golf note', 'Bravo note', 'Echo note'])

  // From the top of the board, Golf is out of sight.
  expect(await wheelBoard(page, -20000)).toBe(0)
  const golf = noteByText(page, 'Golf note')
  await expect(golf).not.toBeInViewport()

  // Gear -> Pinned notes: entries in the order they were pinned (not board order).
  await gearItem(page, /Pinned notes \(3\)/)
  const pal = palette(page)
  await expect(pal).toBeVisible()
  await expect(pal).toHaveAttribute('aria-label', 'Pinned notes')
  await expect(pinEntries(page)).toHaveText(['Golf note', 'Bravo note', 'Echo note'])

  // Choosing one closes the index, scrolls to the note and outlines it for a moment.
  await pal.getByRole('button', { name: 'Golf note', exact: true }).click()
  await expect(pal).toBeHidden()
  await expectRevealed(page, 'Golf note')
  await expect(golf).not.toHaveClass(/is-spotlit/, { timeout: 5000 })
  await expect(focusView(page)).toBeHidden()
  expect(await boardLabels(page)).toEqual(order)
  expect(await storedLayout(app)).toEqual(layout)

  // The same index is one tab away inside Find.
  await page.keyboard.press('Control+k')
  await expect(pal).toBeVisible()
  await pal.getByRole('tab', { name: /Pinned/ }).click()
  await expect(pinEntries(page)).toHaveText(['Golf note', 'Bravo note', 'Echo note'])

  // Keyboard reorder: Tab to the first row's handle, Space, arrow, Space.
  await page.keyboard.press('Tab')
  await expect(pinHandle(page, 'Golf note')).toBeFocused()
  await page.keyboard.press('Space')
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
  await page.keyboard.press('Space')
  await expect(pinEntries(page)).toHaveText(['Bravo note', 'Golf note', 'Echo note'])
  await expect.poll(() => pinLabels(app)).toEqual(['Bravo note', 'Golf note', 'Echo note'])

  await pinHandle(page, 'Echo note').focus()
  await page.keyboard.press('Space')
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(300)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(300)
  await page.keyboard.press('Space')
  await expect(pinEntries(page)).toHaveText(['Echo note', 'Bravo note', 'Golf note'])
  await expect.poll(() => pinLabels(app)).toEqual(['Echo note', 'Bravo note', 'Golf note'])

  // Mouse reorder: drag the last row's handle above the first.
  const from = (await pinHandle(page, 'Golf note').boundingBox())!
  const to = (await pinHandle(page, 'Echo note').boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 8, { steps: 3 })
  await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 12 })
  await page.waitForTimeout(250)
  await page.mouse.up()
  await expect(pinEntries(page)).toHaveText(['Golf note', 'Echo note', 'Bravo note'])
  await expect.poll(() => pinLabels(app)).toEqual(['Golf note', 'Echo note', 'Bravo note'])
  // The drag did not dismiss the index.
  await expect(pal).toBeVisible()

  // An entry can be unpinned from the index. (A person needs a moment to get from the handle to
  // the button; the drag library ignores clicks in the first instant after a drop.)
  await page.waitForTimeout(350)
  await pal.locator('.pin-row').filter({ hasText: 'Echo note' }).getByRole('button', { name: 'Unpin' }).click()
  await expect(pinEntries(page)).toHaveText(['Golf note', 'Bravo note'])
  await expect.poll(() => pinLabels(app)).toEqual(['Golf note', 'Bravo note'])

  // Reordering the index never touched the board.
  await page.keyboard.press('Escape')
  await expect(pal).toBeHidden()
  await expect(noteByText(page, 'Echo note')).not.toHaveClass(/is-pinned/)
  expect(await boardLabels(page)).toEqual(order)
  expect(await storedLayout(app)).toEqual(layout)

  await restart()
  ;({ page, app } = ctx)
  expect(await pinLabels(app)).toEqual(['Golf note', 'Bravo note'])
  expect(await storedLayout(app)).toEqual(layout)
  expect(await boardLabels(page)).toEqual(order)
  await expect(noteByText(page, 'Golf note')).toHaveClass(/is-pinned/)
  await expect(noteByText(page, 'Bravo note')).toHaveClass(/is-pinned/)
  await gearItem(page, /Pinned notes \(2\)/)
  await expect(pinEntries(page)).toHaveText(['Golf note', 'Bravo note'])
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
  // Find's own "Pinned" section lists them in the same order.
  await parkPointer(page)
  await page.keyboard.press('Control+k')
  await expect(palette(page).locator('.palette-section').first().locator('.result-label')).toHaveText(['Golf note', 'Bravo note'])
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
})

test('menus take keyboard focus when they open, so Trash can be reached and used without a mouse', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo'])
  await noteByText(page, 'Bravo note').focus()
  await page.keyboard.press('Delete')
  await expect(notes(page)).toHaveCount(1)

  // Trash is offered only in the gear menu. Open it from the keyboard.
  await page.getByTestId('gear').focus()
  await page.keyboard.press('Enter')
  const settings = page.getByRole('menuitem', { name: 'Settings' })
  await expect(settings).toBeVisible()
  // An open menu owns the keyboard: its first item has focus and the arrow keys walk through it.
  await expect(settings, 'the first item of the opened gear menu has keyboard focus').toBeFocused({ timeout: 2500 })
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Trash (1)' })).toBeFocused()
  await page.keyboard.press('Enter')
  const sheet = page.getByTestId('trash')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.trash-row .result-label')).toHaveText(['Bravo note'])

  // Restore without the mouse: Tab from Close to Restore, Enter.
  await page.keyboard.press('Tab')
  await expect(sheet.getByRole('button', { name: 'Restore' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(notes(page)).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Bravo note']])
})

test('the pinned index keeps the keyboard inside itself while it is open', async () => {
  const { page } = ctx
  await seed(page, ['Alpha', 'Bravo'])
  await pinFromHover(page, 'Alpha note')
  await gearItem(page, /Pinned notes \(1\)/)
  const pal = palette(page)
  await expect(pal).toBeVisible()
  await expect(pal).toHaveAttribute('aria-modal', 'true')
  await expect(pinEntries(page)).toHaveText(['Alpha note'])

  // The index is a modal layer over the board: the first Tab has to land on something in it,
  // not on a control hidden behind it.
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => {
    const element = document.activeElement
    const name = element ? (element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30) ?? '') : ''
    return { insidePalette: !!element?.closest('[data-testid="palette"]'), element: element ? `${element.tagName.toLowerCase()} "${name}"` : 'nothing' }
  })
  expect(focused, 'where the first Tab lands after opening the pinned index').toMatchObject({ insidePalette: true })

  // From there an entry is chosen with Enter.
  await pal.getByRole('button', { name: 'Alpha note', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(pal).toBeHidden()
  await expectRevealed(page, 'Alpha note')
})

// ---------------------------------------------------------------- find

test('find: empty query lists pinned and recent notes; titles, text, captions and tags are searched; trashed notes are not', async () => {
  const { page, app } = ctx

  // One note per place a word can live.
  await writeNote(page, ['Wait for the sweep before entering.'], { title: 'Zanzibar plan' })
  await writeNote(page, ['Opening range', 'Fade the kumquat breakout after ten.'])

  await clickEmptySpace(page)
  await page.keyboard.type('Chart study')
  await page.keyboard.press('Enter')
  await page.getByTestId('image-input').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: RED })
  await expect(page.locator('.image-node img')).toHaveCount(1)
  // The caption field appears once the image is selected.
  await page.locator('.image-node img').click()
  await page.locator('.image-node .image-caption').fill('Quetzal wick rejection')
  await editorBody(page).locator('p').last().click()
  await page.keyboard.type('Nothing else to say.')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  await clickEmptySpace(page)
  await page.keyboard.type('Risk checklist')
  await page.locator('.tag-row').getByRole('button', { name: 'Add tag' }).click()
  await page.keyboard.type('Scalping')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tag-row .tag-chip')).toHaveText(['Scalping'])
  await page.getByRole('button', { name: /Log note/ }).click()
  await expect(focusView(page)).toBeHidden()

  await writeNote(page, ['Xylophone appears only in this note'])
  await expect(notes(page)).toHaveCount(5)
  const layout = await storedLayout(app)
  const order = await boardLabels(page)

  await pinFromHover(page, 'Zanzibar plan')
  await parkPointer(page)

  // Ctrl+K from the board. Empty query: pinned, then recently edited (newest first).
  await page.keyboard.press('Control+k')
  const pal = palette(page)
  await expect(pal).toBeVisible()
  await expect(pal).toHaveAttribute('aria-label', 'Find notes')
  await expect(findInput(page)).toBeFocused()
  await expect(findInput(page)).toHaveValue('')
  await expect(pal.locator('.palette-heading')).toHaveText(['Pinned', 'Recently edited'])
  const sections = pal.locator('.palette-section')
  await expect(sections.nth(0).locator('.result-label')).toHaveText(['Zanzibar plan'])
  await expect(sections.nth(1).locator('.result-label')).toHaveText(['Xylophone appears only in this note', 'Risk checklist', 'Chart study', 'Opening range', 'Zanzibar plan'])

  // Typing filters as you go.
  await page.keyboard.type('k')
  await expect(results(page)).toHaveCount(3)
  await page.keyboard.type('umquat')
  await expect(results(page)).toHaveCount(1)
  // Body text: the label is the first line, the snippet shows the match in context, marked.
  await expect(resultLabels(page)).toHaveText(['Opening range'])
  await expect(results(page).first().locator('.result-snippet')).toContainText('Fade the kumquat breakout after ten.')
  await expect(results(page).first().locator('.result-snippet mark')).toHaveText(['kumquat'])

  // Title (and case does not matter).
  await typeQuery(page, 'ZANZIBAR')
  await expect(resultLabels(page)).toHaveText(['Zanzibar plan'])
  await expect(results(page).first().locator('.result-label mark')).toHaveText(['Zanzibar'])
  await expect(results(page).first().locator('.result-snippet')).toContainText('Wait for the sweep before entering.')

  // Image caption.
  await typeQuery(page, 'quetzal')
  await expect(resultLabels(page)).toHaveText(['Chart study'])
  await expect(results(page).first().locator('.result-snippet')).toContainText('Quetzal wick rejection')
  await expect(results(page).first().locator('.result-snippet mark')).toHaveText(['Quetzal'])

  // Tag.
  await typeQuery(page, 'scalping')
  await expect(resultLabels(page)).toHaveText(['Risk checklist'])
  await expect(results(page).first().locator('.result-tag')).toHaveText(['Scalping'])

  // Every word of the query has to be somewhere in the note.
  await typeQuery(page, 'sweep zanzibar')
  await expect(resultLabels(page)).toHaveText(['Zanzibar plan'])
  await typeQuery(page, 'sweep kumquat')
  await expect(results(page)).toHaveCount(0)

  // A live note is found...
  await typeQuery(page, 'xylophone')
  await expect(resultLabels(page)).toHaveText(['Xylophone appears only in this note'])
  await page.keyboard.press('Escape')
  await expect(pal).toBeHidden()

  // ...and no longer once it is in Trash.
  await noteMenuItem(page, 'Xylophone appears', /Move to Trash/)
  await expect(notes(page)).toHaveCount(4)
  await parkPointer(page)
  await page.keyboard.press('Control+k')
  await expect(sections.nth(1).locator('.result-label')).toHaveText(['Risk checklist', 'Chart study', 'Opening range', 'Zanzibar plan'])
  await typeQuery(page, 'xylophone')
  await expect(results(page)).toHaveCount(0)
  const empty = pal.locator('.palette-empty')
  await expect(empty).toBeVisible()

  // Nonsense: an honest empty message. Screenshots are not read; it must say so, not hint otherwise.
  await typeQuery(page, 'qqzzxxjj')
  await expect(results(page)).toHaveCount(0)
  await expect(empty).toBeVisible()
  const message = (await empty.innerText()).toLowerCase()
  expect(message).toMatch(/(screenshots?|images?|pictures?)[^.]*\b(not|never|cannot|can't|isn't|aren't)\b[^.]*search/)
  await page.keyboard.press('Escape')
  await expect(pal).toBeHidden()

  // Searching changed nothing on the board.
  await trashToast(page).getByRole('button', { name: 'Undo' }).click()
  await expect(notes(page)).toHaveCount(5)
  await expect.poll(() => storedLayout(app)).toEqual(layout)
  expect(await boardLabels(page)).toEqual(order)

  // "Recently edited" follows edits: touch the oldest body note and it moves to the top.
  await noteByText(page, 'Opening range').locator('.prose p').nth(1).click()
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('End')
  await page.keyboard.type(' Edited.')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await parkPointer(page)
  await page.keyboard.press('Control+k')
  await expect(sections.nth(1).locator('.result-label').first()).toHaveText('Opening range')
  await page.keyboard.press('Escape')
  expect(await storedLayout(app)).toEqual(layout)
})

test('find: typing faster than the window can catch up never loses a character', async () => {
  const { page } = ctx
  await writeNote(page, ['Opening range: fade the first push after ten.'])
  await page.keyboard.press('Control+k')
  await expect(findInput(page)).toBeFocused()
  // Sixty keystrokes in one go, with no pause between them for the page to catch up: each one
  // must be taken in on its own. (A highlight reset done in an effect queued a second render
  // per keystroke; after about fifty React stopped with error #185 and dropped a character.)
  const typed = 'opening range fade the first push after ten and then a little'.slice(0, 60)
  const value = await findInput(page).evaluate((input, text) => {
    const element = input as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const character of text) {
      setValue.call(element, element.value + character)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return element.value
  }, typed)
  expect(value).toBe(typed)
  await expect(findInput(page)).toHaveValue(typed)
  await expect(palette(page).locator('.palette-empty')).toBeVisible()
  // Back to a query that matches: the highlight is on the first result.
  await typeQuery(page, 'fade')
  await expect(palette(page).locator('.result').first()).toHaveAttribute('aria-selected', 'true')
})

test('find: arrows and Enter reveal, Ctrl+Enter opens, Esc leaves the board exactly as it was', async () => {
  const { page, app } = ctx
  await seedTall(page, NATO)
  const layout = await storedLayout(app)
  const order = await boardLabels(page)

  // Somewhere in the middle of the board.
  await wheelBoard(page, -20000)
  const before = await wheelBoard(page, 380)
  expect(before).toBeGreaterThan(200)
  const boxesBefore = await settledBoxes(page)
  await parkPointer(page)

  await page.keyboard.press('Control+k')
  const pal = palette(page)
  await expect(pal).toBeVisible()
  await expect(findInput(page)).toBeFocused()
  await page.keyboard.type('note')
  await expect(resultLabels(page)).toHaveText([...NATO].reverse().map((n) => `${n} note`))
  await expect(activeResult(page)).toHaveText('Hotel note')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await expect(activeResult(page)).toHaveText('Echo note')
  await page.keyboard.press('ArrowUp')
  await expect(activeResult(page)).toHaveText('Foxtrot note')
  await expect(pal.getByRole('option', { selected: true })).toHaveCount(1)
  // The query stays in the field; arrow keys did not move the board.
  await expect(findInput(page)).toHaveValue('note')
  expect(await boardLabels(page)).toEqual(order)

  // Esc: palette gone, board untouched.
  await page.keyboard.press('Escape')
  await expect(pal).toBeHidden()
  await expect(pal).toHaveCount(0)
  await expect(focusView(page)).toBeHidden()
  expect(Math.abs((await settledScrollTop(page)) - before)).toBeLessThanOrEqual(3)
  expect(await boardLabels(page)).toEqual(order)
  expect(await settledBoxes(page)).toEqual(boxesBefore)
  expect(await storedLayout(app)).toEqual(layout)
  await expect(page.locator('.note.is-spotlit')).toHaveCount(0)

  // Enter shows the chosen note on the board.
  const alpha = noteByText(page, 'Alpha note')
  await expect(alpha).not.toBeInViewport()
  await page.keyboard.press('Control+k')
  await page.keyboard.type('note')
  await expect(results(page)).toHaveCount(8)
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowDown')
  await expect(activeResult(page)).toHaveText('Alpha note')
  // The list stops at its ends.
  await page.keyboard.press('ArrowDown')
  await expect(activeResult(page)).toHaveText('Alpha note')
  await page.keyboard.press('Enter')
  await expect(pal).toBeHidden()
  await expectRevealed(page, 'Alpha note')
  await expect(focusView(page)).toBeHidden()
  await expect(alpha).not.toHaveClass(/is-spotlit/, { timeout: 5000 })
  expect(await boardLabels(page)).toEqual(order)
  expect(await storedLayout(app)).toEqual(layout)

  // Ctrl+Enter opens the chosen note in the editor.
  await page.keyboard.press('Control+k')
  await page.keyboard.type('golf')
  await expect(resultLabels(page)).toHaveText(['Golf note'])
  await page.keyboard.press('Control+Enter')
  await expect(pal).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page).locator('p').first()).toHaveText('Golf note')
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await expect(noteByText(page, 'Golf note')).toBeInViewport()

  // Clicking a result reveals it too.
  await page.keyboard.press('Control+k')
  await page.keyboard.type('delta')
  await results(page).first().click()
  await expect(pal).toBeHidden()
  await expectRevealed(page, 'Delta note')
  await expect(focusView(page)).toBeHidden()

  // Gear -> Find notes opens the same palette; a click beside it puts it away again.
  await gearItem(page, /Find notes/)
  await expect(pal).toBeVisible()
  await expect(findInput(page)).toBeFocused()
  await page.mouse.click(40, 600)
  await expect(pal).toBeHidden()
  await expect(focusView(page)).toBeHidden()

  // After all that looking around: same notes, same order, same words.
  expect(await boardLabels(page)).toEqual(order)
  expect(await storedLayout(app)).toEqual(layout)
  expect(await storedNotes(app)).toHaveLength(8)
})

test('find from inside the editor: Ctrl+K opens over the draft, Esc returns to it, Enter goes to the chosen note', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie'])

  await clickEmptySpace(page)
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.type('Draft in progress')
  await page.keyboard.press('Control+k')
  const pal = palette(page)
  await expect(pal).toBeVisible()
  await expect(findInput(page)).toBeFocused()
  // The draft is still open underneath.
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('bravo')
  await expect(resultLabels(page)).toHaveText(['Bravo note'])

  // Esc closes only the palette, and writing continues where it stopped.
  await page.keyboard.press('Escape')
  await expect(pal).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toBeFocused()
  // Nobody types within a few milliseconds of pressing Esc; the editor needs about 20 ms to
  // put its caret back after focus returns to it.
  await page.waitForTimeout(150)
  await page.keyboard.type(' continues')
  await expect(editorBody(page).locator('p')).toHaveText(['Draft in progress continues'])

  // Enter on a result: the draft is kept as a note and the board shows the chosen one.
  await page.keyboard.press('Control+k')
  await page.keyboard.type('bravo')
  await expect(resultLabels(page)).toHaveText(['Bravo note'])
  await page.keyboard.press('Enter')
  await expect(pal).toBeHidden()
  await expect(focusView(page)).toBeHidden()
  await expectRevealed(page, 'Bravo note')
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Bravo note'], ['Charlie note'], ['Draft in progress continues']])

  // Ctrl+Enter on a result while another note is open: that note is saved, the chosen one opens.
  await noteByText(page, 'Alpha note').locator('.prose p').first().click()
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('End')
  await page.keyboard.type(' amended')
  await page.keyboard.press('Control+k')
  await page.keyboard.type('charlie')
  await expect(resultLabels(page)).toHaveText(['Charlie note'])
  await page.keyboard.press('Control+Enter')
  await expect(pal).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page).locator('p').first()).toHaveText('Charlie note')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  expect((await storedNotes(app)).map((n) => n.plainText.split('\n')[0])).toEqual(['Alpha note amended', 'Bravo note', 'Charlie note', 'Draft in progress continues'])
  expect(await storedLayout(app)).toEqual([['Alpha note amended'], ['Bravo note'], ['Charlie note'], ['Draft in progress continues']])
})

// ---------------------------------------------------------------- tags

test('tags: add by typing and from the suggested labels, remove, see them on the board, filter Find by tag', async () => {
  const { page, app } = ctx
  const tagRow = page.locator('.tag-row')
  const chips = tagRow.locator('.tag-chip')
  const suggestions = tagRow.locator('.tag-suggestion')
  const newTag = page.getByRole('textbox', { name: 'New tag' })
  const logNote = page.getByRole('button', { name: /Log note/ })

  await clickEmptySpace(page)
  await page.keyboard.type('Opening drive rules')
  // No tag field in the way until it is asked for.
  await expect(newTag).toHaveCount(0)
  await tagRow.getByRole('button', { name: 'Add tag' }).click()
  await expect(newTag).toBeFocused()
  await expect(suggestions).toHaveText(['Rules', 'Setups', 'Journal'])

  // Type a name and press Enter.
  await page.keyboard.type('Breakouts')
  await page.keyboard.press('Enter')
  await expect(chips).toHaveText(['Breakouts'])
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page).locator('p')).toHaveText(['Opening drive rules'])
  // The field stays ready for another.
  await expect(newTag).toBeFocused()
  await expect(newTag).toHaveValue('')

  // Click a suggested label.
  await tagRow.getByRole('button', { name: 'Rules', exact: true }).click()
  await expect(chips).toHaveText(['Breakouts', 'Rules'])
  await expect(suggestions).toHaveText(['Setups', 'Journal'])

  // Add one by mistake and take it off again.
  await page.keyboard.type('Mistake')
  await page.keyboard.press('Enter')
  await expect(chips).toHaveText(['Breakouts', 'Rules', 'Mistake'])
  await tagRow.getByRole('button', { name: 'Remove tag Mistake' }).click()
  await expect(chips).toHaveText(['Breakouts', 'Rules'])

  await logNote.click()
  await expect(focusView(page)).toBeHidden()
  const first = noteByText(page, 'Opening drive rules')
  await expect(first.locator('.note-tags span')).toHaveText(['Breakouts', 'Rules'])

  // Second note: a suggestion only. Labels already in use are offered after the three defaults.
  await clickEmptySpace(page)
  await page.keyboard.type('Asia range plan')
  await tagRow.getByRole('button', { name: 'Add tag' }).click()
  await expect(suggestions).toHaveText(['Rules', 'Setups', 'Journal', 'Breakouts'])
  await tagRow.getByRole('button', { name: 'Journal', exact: true }).click()
  await expect(chips).toHaveText(['Journal'])
  await logNote.click()
  await expect(focusView(page)).toBeHidden()
  await expect(noteByText(page, 'Asia range plan').locator('.note-tags span')).toHaveText(['Journal'])

  // Third note: no tag at all. Nothing asks for one.
  await writeNote(page, ['No labels on this one'])
  await expect(noteByText(page, 'No labels on this one').locator('.note-tags')).toHaveCount(0)

  const tagsOf = async (): Promise<Record<string, string[]>> => Object.fromEntries((await storedNotes(app)).map((n) => [n.plainText, n.tags]))
  expect(await tagsOf()).toEqual({ 'Opening drive rules': ['Breakouts', 'Rules'], 'Asia range plan': ['Journal'], 'No labels on this one': [] })
  const layout = await storedLayout(app)

  // Find offers the tags in use as filters.
  await parkPointer(page)
  await page.keyboard.press('Control+k')
  const pal = palette(page)
  const filters = pal.locator('.palette-tags .tag-filter')
  await expect(filters).toHaveText(['Breakouts', 'Journal', 'Rules'])
  await filters.filter({ hasText: 'Journal' }).click()
  await expect(filters.filter({ hasText: 'Journal' })).toHaveAttribute('aria-pressed', 'true')
  await expect(resultLabels(page)).toHaveText(['Asia range plan'])
  await filters.filter({ hasText: 'Rules' }).click()
  await expect(filters.filter({ hasText: 'Journal' })).toHaveAttribute('aria-pressed', 'false')
  await expect(resultLabels(page)).toHaveText(['Opening drive rules'])
  // A tag filter and a word together.
  await findInput(page).click()
  await page.keyboard.type('plan')
  await expect(results(page)).toHaveCount(0)
  await expect(pal.locator('.palette-empty')).toBeVisible()
  await filters.filter({ hasText: 'Rules' }).click()
  await expect(filters.filter({ hasText: 'Rules' })).toHaveAttribute('aria-pressed', 'false')
  await expect(resultLabels(page)).toHaveText(['Asia range plan'])
  await page.keyboard.press('Escape')
  await expect(pal).toBeHidden()

  // Remove a tag from an existing note.
  await first.locator('.prose p').first().click()
  await expect(focusView(page)).toBeVisible()
  await expect(chips).toHaveText(['Breakouts', 'Rules'])
  await tagRow.getByRole('button', { name: 'Remove tag Rules' }).click()
  await expect(chips).toHaveText(['Breakouts'])
  await logNote.click()
  await expect(focusView(page)).toBeHidden()
  await expect(first.locator('.note-tags span')).toHaveText(['Breakouts'])
  expect((await tagsOf())['Opening drive rules']).toEqual(['Breakouts'])
  await page.keyboard.press('Control+k')
  await expect(filters).toHaveText(['Breakouts', 'Journal'])
  await page.keyboard.press('Escape')
  expect(await storedLayout(app)).toEqual(layout)
})

test('the tag row does not trap the keyboard: Esc only cancels a half-typed tag, Ctrl+Enter still logs the note', async () => {
  const { page, app } = ctx
  const tagRow = page.locator('.tag-row')
  const chips = tagRow.locator('.tag-chip')
  const newTag = page.getByRole('textbox', { name: 'New tag' })
  const logNote = page.getByRole('button', { name: /Log note/ })

  await clickEmptySpace(page)
  await page.keyboard.type('Keyboard only note')

  // Esc while naming a tag closes the tag field, not the note, and adds nothing.
  await tagRow.getByRole('button', { name: 'Add tag' }).click()
  await expect(newTag).toBeFocused()
  await page.keyboard.type('Halfway')
  await page.keyboard.press('Escape')
  await expect(newTag).toHaveCount(0)
  await expect(focusView(page)).toBeVisible()
  await expect(chips).toHaveCount(0)

  // Add a tag with Enter, then log the note with Ctrl+Enter straight from the tag field.
  await tagRow.getByRole('button', { name: 'Add tag' }).click()
  await page.keyboard.type('Rules')
  await page.keyboard.press('Enter')
  await expect(chips).toHaveText(['Rules'])
  await page.keyboard.press('Control+Enter')
  await expect.soft(focusView(page), 'Ctrl+Enter pressed in the tag field returns to the board').toBeHidden({ timeout: 2500 })
  // (If it did not, carry on with the button so the next case is still checked.)
  if (await focusView(page).isVisible()) await logNote.click()
  await expect(focusView(page)).toBeHidden()
  const note = noteByText(page, 'Keyboard only note')
  await expect(note.locator('.note-tags span')).toHaveText(['Rules'])
  expect((await storedNotes(app)).map((n) => n.tags)).toEqual([['Rules']])

  // Take the tag off with the mouse, then Ctrl+Enter.
  await note.locator('.prose p').first().click()
  await expect(focusView(page)).toBeVisible()
  await tagRow.getByRole('button', { name: 'Remove tag Rules' }).click()
  await expect(chips).toHaveCount(0)
  await page.keyboard.press('Control+Enter')
  await expect.soft(focusView(page), 'Ctrl+Enter right after removing a tag returns to the board').toBeHidden({ timeout: 2500 })
  if (await focusView(page).isVisible()) await logNote.click()
  await expect(focusView(page)).toBeHidden()
  await expect(note.locator('.note-tags')).toHaveCount(0)
  expect((await storedNotes(app)).map((n) => n.tags)).toEqual([[]])
})

test('a note found through one of several tags shows which tag matched', async () => {
  const { page } = ctx
  const tagRow = page.locator('.tag-row')
  const tags = ['Rules', 'Setups', 'Journal', 'Earnings']

  await clickEmptySpace(page)
  await page.keyboard.type('Weekly review')
  await tagRow.getByRole('button', { name: 'Add tag' }).click()
  for (const tag of tags) {
    await page.keyboard.type(tag)
    await page.keyboard.press('Enter')
  }
  await expect(tagRow.locator('.tag-chip')).toHaveText(tags)
  await page.getByRole('button', { name: /Log note/ }).click()
  await expect(focusView(page)).toBeHidden()
  await expect(noteByText(page, 'Weekly review').locator('.note-tags span')).toHaveText(tags)

  await parkPointer(page)
  await page.keyboard.press('Control+k')
  await page.keyboard.type('earnings')
  // Found through its fourth tag (the word is nowhere else in the note)...
  await expect(resultLabels(page)).toHaveText(['Weekly review'])
  // ...so the result has to show that tag, or there is no telling why the note is listed.
  await expect(results(page).first(), 'the result row shows the tag that matched').toContainText('Earnings', { timeout: 2500 })
})

// ---------------------------------------------------------------- trash

test('delete from the note menu and with the Delete key; the toast Undo and Ctrl+Z put the note back where it was', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie', 'Delta'])
  await pairWithRowAbove(page, 'Charlie note')
  const original = [['Alpha note'], ['Bravo note', 'Charlie note'], ['Delta note']]
  await expect.poll(() => storedLayout(app)).toEqual(original)
  await pinFromHover(page, 'Alpha note')
  await expect.poll(() => pinLabels(app)).toEqual(['Alpha note'])
  const words = (await storedNotes(app)).map((n) => n.plainText).sort()
  const originalBoxes = await settledBoxes(page)

  // Menu -> Move to Trash on the right half of the pair; Undo in the toast.
  await noteMenuItem(page, 'Charlie note', /Move to Trash/)
  await expect(notes(page)).toHaveCount(3)
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Bravo note'], ['Delta note']])
  expect(await trashCount(app)).toBe(1)
  await expect(trashToast(page)).toHaveCount(1)
  await trashToast(page).getByRole('button', { name: 'Undo' }).click()
  await expect(notes(page)).toHaveCount(4)
  await expect.poll(() => storedLayout(app)).toEqual(original)
  expect(await trashCount(app)).toBe(0)
  await expect(trashToast(page)).toHaveCount(0)
  // Back beside its partner, on the same side, drawn exactly where it was.
  expect(await settledBoxes(page)).toEqual(originalBoxes)
  await expect(noteByText(page, 'Charlie note').locator('.prose p')).toHaveText(['Charlie note', 'Details for charlie.'])

  // Delete key on the focused left half; Ctrl+Z on the board.
  await noteByText(page, 'Bravo note').focus()
  await page.keyboard.press('Delete')
  await expect(notes(page)).toHaveCount(3)
  expect(await storedLayout(app)).toEqual([['Alpha note'], ['Charlie note'], ['Delta note']])
  await expect(trashToast(page).getByRole('button', { name: 'Undo' })).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(notes(page)).toHaveCount(4)
  await expect.poll(() => storedLayout(app)).toEqual(original)
  expect(await settledBoxes(page)).toEqual(originalBoxes)

  // Two deletions (one of them pinned), undone one after the other.
  await noteByText(page, 'Alpha note').focus()
  await page.keyboard.press('Delete')
  await expect(notes(page)).toHaveCount(3)
  await noteMenuItem(page, 'Delta note', /Move to Trash/)
  await expect(notes(page)).toHaveCount(2)
  expect(await storedLayout(app)).toEqual([['Bravo note', 'Charlie note']])
  expect(await pinLabels(app)).toEqual([])
  expect(await trashCount(app)).toBe(2)
  await page.keyboard.press('Control+z')
  await expect(notes(page)).toHaveCount(3)
  await expect.poll(() => storedLayout(app)).toEqual([['Bravo note', 'Charlie note'], ['Delta note']])
  await page.keyboard.press('Control+z')
  await expect(notes(page)).toHaveCount(4)
  await expect.poll(() => storedLayout(app)).toEqual(original)
  expect(await settledBoxes(page)).toEqual(originalBoxes)
  expect(await trashCount(app)).toBe(0)

  // The recovered notes are whole: same words, and Alpha is still pinned.
  expect((await storedNotes(app)).map((n) => n.plainText).sort()).toEqual(words)
  expect(await pinLabels(app)).toEqual(['Alpha note'])
  await expect(noteByText(page, 'Alpha note')).toHaveClass(/is-pinned/)
  await expect(focusView(page)).toBeHidden()
})

test('undoing a move does not displace a note that was recovered or written since that move', async () => {
  const { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie', 'Delta'])
  const rowOf = (layout: string[][], label: string): number => layout.findIndex((row) => row.includes(label))

  // Delete Bravo, then rearrange something else.
  await noteByText(page, 'Bravo note').focus()
  await page.keyboard.press('Delete')
  await expect(notes(page)).toHaveCount(3)
  await noteByText(page, 'Delta note').focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(() => storedLayout(app)).toEqual([['Alpha note'], ['Delta note'], ['Charlie note']])

  // Second thoughts about the deletion: Undo in the toast puts Bravo back under Alpha.
  await trashToast(page).getByRole('button', { name: 'Undo' }).click()
  await expect(notes(page)).toHaveCount(4)
  await expect.poll(() => storedLayout(app)).toEqual([['Alpha note'], ['Bravo note'], ['Delta note'], ['Charlie note']])

  // Ctrl+Z now takes back the move of Delta. Bravo was no part of that move and stays where it is.
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(700)
  let layout = await storedLayout(app)
  expect(layout.flat().sort()).toEqual(['Alpha note', 'Bravo note', 'Charlie note', 'Delta note'])
  expect(await boardLabels(page)).toEqual(layout.flat())
  expect.soft(rowOf(layout, 'Bravo note'), `the recovered note is still in the second row (board is now ${JSON.stringify(layout)})`).toBe(1)

  // The same for a note written after a move: move Alpha down, write a note into the gap under
  // the first row, then Ctrl+Z.
  await noteByText(page, 'Alpha note').focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(async () => rowOf(await storedLayout(app), 'Alpha note')).toBe(1)
  await settledBoxes(page)
  const first = (await notes(page).nth(0).boundingBox())!
  const second = (await notes(page).nth(1).boundingBox())!
  await page.mouse.click(first.x + 300, (first.y + first.height + second.y) / 2)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Inserted note')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  expect(rowOf(await storedLayout(app), 'Inserted note')).toBe(1)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(700)
  layout = await storedLayout(app)
  expect(layout.flat().sort()).toEqual(['Alpha note', 'Bravo note', 'Charlie note', 'Delta note', 'Inserted note'])
  expect(await boardLabels(page)).toEqual(layout.flat())
  expect.soft(rowOf(layout, 'Inserted note'), `the new note is not sent to the bottom of the board (board is now ${JSON.stringify(layout)})`).toBeLessThan(layout.length - 1)
})

test('trash panel: restore, delete forever and empty trash each ask first; purging removes only image files no other note uses', async () => {
  let { page, app } = ctx
  const attachmentDir = join(ctx.dataDir, 'library', 'attachments')
  const files = (): string[] => readdirSync(attachmentDir).sort()
  const imagesLoaded = async (locator: Locator, count: number): Promise<void> => {
    await expect(locator).toHaveCount(count)
    await expect.poll(() => locator.evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
  }

  // A note that stays, with a screenshot.
  await clickEmptySpace(page)
  await page.keyboard.type('Keeper chart')
  await page.keyboard.press('Enter')
  await page.getByTestId('image-input').setInputFiles({ name: 'keeper.png', mimeType: 'image/png', buffer: RED })
  await imagesLoaded(page.locator('.image-node img'), 1)
  // Copy that screenshot out of the note, to reuse it in the next one.
  await page.locator('.image-node img').click()
  await expect(page.locator('.image-node.is-selected')).toHaveCount(1)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  // A note that will be purged: the same screenshot pasted in, plus one of its own.
  await clickEmptySpace(page)
  await page.keyboard.type('Doomed chart')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+v')
  await imagesLoaded(page.locator('.image-node img'), 1)
  await page.getByTestId('image-input').setInputFiles({ name: 'doomed.png', mimeType: 'image/png', buffer: BLUE })
  await imagesLoaded(page.locator('.image-node img'), 2)
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  await writeNote(page, ['An idea that did not age well.'], { title: 'Old idea' })
  await writeNote(page, ['Comeback note', 'Deleted by mistake.'])
  await writeNote(page, ['Bystander note'])
  expect(await storedLayout(app)).toEqual([['Keeper chart'], ['Doomed chart'], ['Old idea'], ['Comeback note'], ['Bystander note']])

  // Both notes point at the one stored copy of the shared screenshot.
  const keeperImages = attachmentIds(await storedContent(app, 'Keeper chart'))
  const doomedImages = attachmentIds(await storedContent(app, 'Doomed chart'))
  expect(keeperImages).toHaveLength(1)
  expect(doomedImages).toHaveLength(2)
  expect(doomedImages).toContain(keeperImages[0])
  const allFiles = files()
  const redFile = allFiles.find((name) => readFileSync(join(attachmentDir, name)).equals(RED))
  const blueFile = allFiles.find((name) => readFileSync(join(attachmentDir, name)).equals(BLUE))
  expect(redFile, 'shared screenshot on disk').toBeTruthy()
  expect(blueFile, 'second screenshot on disk').toBeTruthy()
  // Two originals and the preview of the large one.
  expect(allFiles).toHaveLength(3)
  expect(await attachmentRecordCount(app)).toBe(2)

  // Three notes go to Trash.
  await noteMenuItem(page, 'Doomed chart', /Move to Trash/)
  await expect(notes(page)).toHaveCount(4)
  await noteByText(page, 'Old idea').focus()
  await page.keyboard.press('Delete')
  await expect(notes(page)).toHaveCount(3)
  await noteMenuItem(page, 'Comeback note', /Move to Trash/)
  await expect(notes(page)).toHaveCount(2)
  expect(await storedLayout(app)).toEqual([['Keeper chart'], ['Bystander note']])
  expect(await trashCount(app)).toBe(3)
  // Trash keeps the screenshots.
  expect(files()).toEqual(allFiles)

  // Gear -> Trash: what was deleted, and when.
  await gearItem(page, /^Trash \(3\)/)
  const sheet = page.getByTestId('trash')
  await expect(sheet).toBeVisible()
  const rows = sheet.locator('.trash-row')
  const row = (label: string): Locator => rows.filter({ hasText: label })
  await expect(rows.locator('.result-label')).toHaveText(['Comeback note', 'Old idea', 'Doomed chart'])
  const year = String(new Date().getFullYear())
  for (const label of ['Comeback note', 'Old idea', 'Doomed chart']) {
    await expect(row(label).locator('.trash-meta')).toContainText(/^Deleted .*\d/)
    await expect(row(label).locator('.trash-meta')).toContainText(year)
  }
  await expect(row('Doomed chart').locator('.trash-meta')).toContainText('2 images')
  await expect(row('Old idea')).toContainText('An idea that did not age well.')

  // Restore puts a note back on the board where it was.
  await row('Comeback note').getByRole('button', { name: 'Restore' }).click()
  await expect(rows).toHaveCount(2)
  await expect(notes(page)).toHaveCount(3)
  await expect.poll(() => storedLayout(app)).toEqual([['Keeper chart'], ['Comeback note'], ['Bystander note']])
  await expect(noteByText(page, 'Comeback note').locator('.prose p')).toHaveText(['Comeback note', 'Deleted by mistake.'])
  expect(await trashCount(app)).toBe(2)

  // Delete forever asks first, and "Keep" backs out.
  await row('Old idea').getByRole('button', { name: 'Delete forever' }).click()
  await expect(row('Old idea').getByRole('button', { name: 'Keep' })).toBeVisible()
  await expect(row('Old idea').getByRole('button', { name: 'Restore' })).toHaveCount(0)
  expect(await trashCount(app)).toBe(2)
  await row('Old idea').getByRole('button', { name: 'Keep' }).click()
  await expect(row('Old idea').getByRole('button', { name: 'Restore' })).toBeVisible()
  await expect(rows).toHaveCount(2)
  expect(await trashCount(app)).toBe(2)
  await row('Old idea').getByRole('button', { name: 'Delete forever' }).click()
  await expect(row('Old idea').getByRole('button', { name: 'Keep' })).toBeVisible()
  await row('Old idea').getByRole('button', { name: 'Delete forever' }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.locator('.result-label')).toHaveText(['Doomed chart'])
  expect(await trashCount(app)).toBe(1)
  expect(files()).toEqual(allFiles)

  // Empty Trash asks first, and "Cancel" backs out.
  await sheet.getByRole('button', { name: 'Empty Trash…', exact: true }).click()
  await expect(sheet.locator('.setting-warning')).toContainText('Delete 1 note for good? This cannot be undone.')
  expect(await trashCount(app)).toBe(1)
  expect(files()).toEqual(allFiles)
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet.locator('.setting-warning')).toHaveCount(0)
  await expect(rows).toHaveCount(1)
  expect(await trashCount(app)).toBe(1)
  await sheet.getByRole('button', { name: 'Empty Trash…', exact: true }).click()
  await sheet.getByRole('button', { name: 'Empty Trash', exact: true }).click()
  await expect(sheet).toContainText('Trash is empty')
  await expect(rows).toHaveCount(0)
  expect(await trashCount(app)).toBe(0)

  // The purged note's own screenshot (and its preview) are gone from disk; the shared one stays.
  expect(files()).toEqual([redFile])
  expect(readFileSync(join(attachmentDir, redFile!)).equals(RED)).toBe(true)
  expect(await attachmentRecordCount(app)).toBe(1)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await page.getByTestId('gear').click()
  await expect(page.getByRole('menuitem', { name: 'Trash', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await storedLayout(app)).toEqual([['Keeper chart'], ['Comeback note'], ['Bystander note']])
  await imagesLoaded(noteByText(page, 'Keeper chart').locator('.note-image img'), 1)

  // Still true after a restart (startup housekeeping must not take the kept screenshot).
  await restart()
  ;({ page, app } = ctx)
  expect(await storedLayout(app)).toEqual([['Keeper chart'], ['Comeback note'], ['Bystander note']])
  expect(await trashCount(app)).toBe(0)
  expect(files()).toEqual([redFile])
  await imagesLoaded(noteByText(page, 'Keeper chart').locator('.note-image img'), 1)
})

// ---------------------------------------------------------------- collapse

test('collapse and expand from the note menu keep the note in place and survive a restart', async () => {
  let { page, app } = ctx
  await seed(page, ['Alpha', 'Bravo', 'Charlie'])
  await pairWithRowAbove(page, 'Charlie note')
  const layout = [['Alpha note'], ['Bravo note', 'Charlie note']]
  await expect.poll(() => storedLayout(app)).toEqual(layout)
  const ids = await boardIds(page)
  const before = await settledBoxes(page)
  const [alphaId, , charlieId] = ids as [string, string, string]

  await noteMenuItem(page, 'Alpha note', 'Collapse')
  let alpha = noteByText(page, 'Alpha note')
  await expect(alpha.locator('.note-collapsed')).toContainText('Alpha note')
  await expect(alpha.locator('.prose')).toHaveCount(0)
  await expect(alpha).not.toContainText('Details for alpha.')
  await expect(focusView(page)).toBeHidden()
  await expect.poll(() => collapsedLabels(app)).toEqual(['Alpha note'])

  // Same place on the board: same row, same left edge, top and width; only shorter.
  expect(await storedLayout(app)).toEqual(layout)
  expect(await boardIds(page)).toEqual(ids)
  const collapsed = await settledBoxes(page)
  expect({ x: collapsed[alphaId]!.x, y: collapsed[alphaId]!.y, width: collapsed[alphaId]!.width }).toEqual({ x: before[alphaId]!.x, y: before[alphaId]!.y, width: before[alphaId]!.width })
  expect(collapsed[alphaId]!.height).toBeLessThan(before[alphaId]!.height)

  // The menu now offers the opposite action.
  await hoverNote(page, 'Alpha note')
  await alpha.getByRole('button', { name: 'Note actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Expand', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Collapse', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // The right half of a pair collapses in place as well.
  await noteMenuItem(page, 'Charlie note', 'Collapse')
  await expect(noteByText(page, 'Charlie note').locator('.note-collapsed')).toBeVisible()
  await expect.poll(() => collapsedLabels(app)).toEqual(['Alpha note', 'Charlie note'])
  const both = await settledBoxes(page)
  expect(both[charlieId]!.x).toBe(before[charlieId]!.x)
  expect(both[charlieId]!.width).toBe(before[charlieId]!.width)
  expect(await storedLayout(app)).toEqual(layout)

  await restart()
  ;({ page, app } = ctx)
  alpha = noteByText(page, 'Alpha note')
  const charlie = noteByText(page, 'Charlie note')
  await expect(alpha.locator('.note-collapsed')).toContainText('Alpha note')
  await expect(charlie.locator('.note-collapsed')).toContainText('Charlie note')
  await expect(noteByText(page, 'Bravo note').locator('.prose p')).toHaveText(['Bravo note', 'Details for bravo.'])
  expect(await collapsedLabels(app)).toEqual(['Alpha note', 'Charlie note'])
  expect(await storedLayout(app)).toEqual(layout)
  expect(await boardIds(page)).toEqual(ids)

  // Expand from the menu: the words are all still there.
  await noteMenuItem(page, 'Alpha note', 'Expand')
  await expect(alpha.locator('.prose p')).toHaveText(['Alpha note', 'Details for alpha.'])
  await expect(alpha.locator('.note-collapsed')).toHaveCount(0)
  // The small Expand link inside a collapsed note does the same and does not open the editor.
  await charlie.getByRole('button', { name: 'Expand' }).click()
  await expect(charlie.locator('.prose p')).toHaveText(['Charlie note', 'Details for charlie.'])
  await expect(focusView(page)).toBeHidden()
  await expect.poll(() => collapsedLabels(app)).toEqual([])
  expect(await storedLayout(app)).toEqual(layout)
  expect(await boardIds(page)).toEqual(ids)
  expect(await settledBoxes(page)).toEqual(before)

  await restart()
  ;({ page, app } = ctx)
  expect(await collapsedLabels(app)).toEqual([])
  await expect(page.locator('.note-collapsed')).toHaveCount(0)
  expect(await storedLayout(app)).toEqual(layout)
})

// ---------------------------------------------------------------- live content on the board

test('checklist items tick on the board; a link opens through the main process; unsafe addresses never do', async () => {
  const { page, app } = ctx
  const ADDRESS = 'https://example.com/setups/london-open?id=42'

  // Stand in for the operating system's "open in browser".
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as unknown as { __opened: string[] }).__opened = opened
    shell.openExternal = async (url: string): Promise<void> => {
      opened.push(url)
    }
  })
  const opened = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

  // A checklist.
  await clickEmptySpace(page)
  await page.keyboard.type('Pre-market routine')
  await page.keyboard.press('Enter')
  await formatBar(page).getByRole('button', { name: 'Checklist' }).click()
  await page.keyboard.type('Mark the levels')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Check the calendar')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Set the alerts')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  const routine = noteByText(page, 'Pre-market routine')
  const ticks = routine.locator('li[data-type="taskItem"] input[type="checkbox"]')
  await expect(ticks).toHaveCount(3)
  const states = async (): Promise<boolean[]> => taskStates(await storedContent(app, 'Pre-market routine'))
  expect(await states()).toEqual([false, false, false])

  // Tick with the mouse: the note does not open, the tick is stored.
  await ticks.nth(1).click()
  await expect(ticks.nth(1)).toBeChecked()
  await expect(routine.locator('li[data-type="taskItem"]').nth(1)).toHaveAttribute('data-checked', 'true')
  await expect.poll(states).toEqual([false, true, false])
  await expect(focusView(page)).toBeHidden()
  // With the keyboard.
  await ticks.nth(2).focus()
  await page.keyboard.press('Space')
  await expect(ticks.nth(2)).toBeChecked()
  await expect.poll(states).toEqual([false, true, true])
  // And off again.
  await ticks.nth(1).click()
  await expect(ticks.nth(1)).not.toBeChecked()
  await expect.poll(states).toEqual([false, false, true])
  await expect(focusView(page)).toBeHidden()
  await expect(routine.locator('li[data-type="taskItem"] > div')).toHaveText(['Mark the levels', 'Check the calendar', 'Set the alerts'])
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['Pre-market routine\nMark the levels\nCheck the calendar\nSet the alerts'])

  // A link. The link field refuses addresses that are not web addresses.
  await clickEmptySpace(page)
  await page.keyboard.type('Broker status page')
  await page.keyboard.press('Enter')
  await formatBar(page).getByRole('button', { name: 'Link', exact: true }).click()
  const address = page.getByRole('textbox', { name: 'Link address' })
  for (const unsafe of ['javascript:alert(1)', 'file:///etc/passwd']) {
    await address.fill(unsafe)
    await page.keyboard.press('Enter')
    await expect(page.locator('.form-error')).toBeVisible()
    await expect(editorBody(page).locator('a')).toHaveCount(0)
  }
  await address.fill(ADDRESS)
  await page.keyboard.press('Enter')
  await expect(editorBody(page).locator('a')).toHaveAttribute('href', ADDRESS)
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  const link = noteByText(page, 'Broker status page').locator('a')
  await expect(link).toHaveAttribute('href', ADDRESS)
  const location = page.url()
  expect(await opened()).toEqual([])
  await link.click()
  await expect.poll(opened).toEqual([ADDRESS])
  // Once, and the app itself went nowhere: no editor, no navigation, no second window.
  await page.waitForTimeout(400)
  expect(await opened()).toEqual([ADDRESS])
  await expect(focusView(page)).toBeHidden()
  expect(page.url()).toBe(location)
  expect(await windowCount(app)).toBe(1)
  // The keyboard works as well: Enter on the focused link.
  await link.focus()
  await page.keyboard.press('Enter')
  await expect.poll(opened).toEqual([ADDRESS, ADDRESS])
  await expect(focusView(page)).toBeHidden()

  // Pasted links with script or file addresses arrive as plain words.
  await clickEmptySpace(page)
  await copyHtmlToClipboard(
    app,
    '<p>Unsafe <a href="javascript:window.__pwned=1">script link</a> and <a href="file:///etc/passwd">file link</a></p>',
    'Unsafe script link and file link'
  )
  await page.keyboard.press('Control+v')
  await expect(editorBody(page)).toContainText('Unsafe script link and file link')
  await expect(editorBody(page).locator('a')).toHaveCount(0)
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const unsafeNote = noteByText(page, 'Unsafe script link')
  await expect(unsafeNote.locator('a')).toHaveCount(0)
  expect(JSON.stringify(await storedContent(app, 'Unsafe script link'))).not.toMatch(/javascript:|file:|"link"/)

  // Even a direct request from the window cannot hand such an address to the system.
  const answers = await page.evaluate(
    (urls) => Promise.all(urls.map((url) => window.tn.openExternal(url))),
    ['javascript:alert(1)', ' JavaScript:alert(1)', 'file:///etc/passwd', 'FILE:///C:/Windows/System32/calc.exe', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', '\\\\server\\share\\run.exe', 'C:\\Windows\\System32\\calc.exe']
  )
  expect(answers).toEqual(answers.map(() => false))
  expect(await opened()).toEqual([ADDRESS, ADDRESS])
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()

  // The checklist words are searchable like any other text.
  await parkPointer(page)
  await page.keyboard.press('Control+k')
  await page.keyboard.type('calendar')
  await expect(resultLabels(page)).toHaveText(['Pre-market routine'])
  await page.keyboard.press('Escape')
})
