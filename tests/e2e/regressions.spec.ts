/**
 * Regression tests for four fixes in the window's interface, each driven the way a person
 * would use the app:
 *
 *  R1  The colour / highlight / link row of the selection bar goes away with the bar. Before,
 *      the row outlived the hidden bar and kept its claim on the keyboard: Ctrl+Enter did
 *      nothing and one Esc was swallowed. While the bar is in use the row must stay: with the
 *      word still selected, while its link field is typed in, and while another window (the
 *      chart) has the keyboard for a moment.
 *  R2  The pinned index opens with the keyboard on its first entry (on the Pinned tab only
 *      when nothing is pinned).
 *  R3  The editor's right-click menu closes when the note scrolls. Other menus still stay
 *      open while something unrelated scrolls underneath them.
 *  R4  Backup export and import refuse to run while the open note cannot be saved.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { boardLabels, clickEmptySpace, collectConsoleErrors, editorBody, focusView, noteByText, notes, storedNotes, writeNote, type TestHandle } from './helpers'
import { launch, removeDataDir, type Launched, type LaunchOptions } from './launch'

const SIZE = { width: 960, height: 1000 }

// ------------------------------------------------------------------ app instances and temp files

const live: Launched[] = []
const dataDirs = new Set<string>()
const tempDirs: string[] = []
const consoleErrors: string[][] = []

async function start(options: LaunchOptions = {}): Promise<Launched> {
  const ctx = await launch({ size: SIZE, ...options })
  live.push(ctx)
  dataDirs.add(ctx.dataDir)
  consoleErrors.push(await collectConsoleErrors(ctx.page))
  return ctx
}

/**
 * Quit through the app's own shutdown path. A test that failed half-way may have left saving
 * switched off; with that the app would stop to ask before quitting, and nothing here can
 * answer a native dialog, so the test switches are reset first.
 */
async function stop(ctx: Launched): Promise<void> {
  const index = live.indexOf(ctx)
  if (index >= 0) live.splice(index, 1)
  await ctx.app
    .evaluate(() => {
      Object.assign((globalThis as unknown as { __tnTest: TestHandle }).__tnTest.testHooks, { failSaves: false, quitChoice: 'quit' })
    })
    .catch(() => undefined)
  await ctx.quit()
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

test.afterEach(async () => {
  for (const ctx of [...live]) await stop(ctx)
  for (const dir of dataDirs) removeDataDir(dir)
  dataDirs.clear()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  expect(consoleErrors.splice(0).flat(), 'no console errors').toEqual([])
})

// ------------------------------------------------------------------ shared helpers

async function typeLines(page: Page, lines: string[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press('Enter')
    await page.keyboard.type(line)
  }
}

/** Open the gear menu and choose an entry. */
async function openGearItem(page: Page, name: RegExp): Promise<void> {
  const item = page.getByRole('menuitem', { name })
  // Opened again if something closed it in between, as a person would.
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByTestId('gear').click()
    await item.click({ timeout: 2000 })
  }).toPass({ timeout: 15_000 })
}

/** Where a scrolling area comes to rest. */
async function settledScrollTop(area: Locator): Promise<number> {
  const read = (): Promise<number> => area.evaluate((element) => element.scrollTop)
  let last = await read()
  for (let i = 0; i < 30; i++) {
    await area.page().waitForTimeout(90)
    const next = await read()
    if (next === last) return next
    last = next
  }
  return last
}

const setFailSaves = (app: ElectronApplication, flag: boolean): Promise<void> =>
  app.evaluate((_electron, value) => {
    ;(globalThis as unknown as { __tnTest: TestHandle }).__tnTest.testHooks.failSaves = value
  }, flag)

/** The text of every stored note, sorted (the order notes are listed in is not what is being tested). */
const storedTexts = async (app: ElectronApplication): Promise<string[]> => (await storedNotes(app)).map((note) => note.plainText).sort()
const sorted = (texts: string[]): string[] => [...texts].sort()

// ------------------------------------------------------------------ R1: the selection bar's rows

const LINES = [
  'Wait for the sweep of the overnight low',
  'Then take the retest',
  'Stop goes under the wick',
  'Target is the prior high',
  'Size down after two losses',
  'No trades in the first five minutes',
  'Check the calendar before the open',
  'Write the result down afterwards'
]
/** Last word of its paragraph, so a double-click selects exactly this on every platform. */
const WORD = 'retest'
/** A word far away from the selection bar, to click on when the selection should be dropped. */
const ELSEWHERE = 'afterwards'

const selectionBar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Selection formatting' })
const inkRow = (page: Page): Locator => selectionBar(page).getByRole('group', { name: 'Text color' })
const highlightRow = (page: Page): Locator => selectionBar(page).getByRole('group', { name: 'Highlight color' })
const linkField = (page: Page): Locator => selectionBar(page).getByRole('textbox', { name: 'Link address' })
const titleField = (page: Page): Locator => page.locator('.focus-title')

/** Middle of a word in the open note's text, in window coordinates. */
async function wordPoint(page: Page, word: string): Promise<{ x: number; y: number }> {
  return editorBody(page).evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(wanted)
      if (at === -1) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + wanted.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    throw new Error(`The note does not contain "${wanted}"`)
  }, word)
}

/** A point on a word, after checking that a press there really lands on the note's text. */
async function reachableWordPoint(page: Page, word: string): Promise<{ x: number; y: number }> {
  const point = await wordPoint(page, word)
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return element?.closest('.ProseMirror') ? 'text' : (element?.className ?? 'nothing')
  }, point)
  expect(hit, `what is under the pointer at "${word}"`).toBe('text')
  return point
}

const selectedText = (page: Page): Promise<string> => page.evaluate(() => (window.getSelection()?.toString() ?? '').trim())

/** Select a word by double-clicking it. */
async function selectWord(page: Page, word: string): Promise<void> {
  const point = await reachableWordPoint(page, word)
  await page.mouse.dblclick(point.x, point.y)
  await expect.poll(() => selectedText(page), { message: `"${word}" is selected` }).toBe(word)
}

/** A single click on a word: puts the caret there, which drops any selection. */
async function clickWord(page: Page, word: string): Promise<void> {
  const point = await reachableWordPoint(page, word)
  await page.mouse.click(point.x, point.y)
}

/** Click the title field near its right end, clear of the selection bar, so the keyboard moves there. */
async function clickTitle(page: Page): Promise<void> {
  const box = (await titleField(page).boundingBox())!
  await titleField(page).click({ position: { x: box.width - 30, y: box.height / 2 } })
  await expect(titleField(page)).toBeFocused()
}

/** Start a note, type the practice lines and select one word: the selection bar is showing. */
async function noteWithSelectedWord(page: Page): Promise<Locator> {
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await typeLines(page, LINES)
  await selectWord(page, WORD)
  await expect(selectionBar(page)).toBeVisible()
  return selectionBar(page)
}

/** The note was logged with exactly these lines and the window is back on the board. */
async function expectLogged(ctx: Launched, lines: string[]): Promise<void> {
  await expect(focusView(ctx.page)).toBeHidden()
  await expect(notes(ctx.page)).toHaveCount(1)
  await expect(notes(ctx.page).first().locator('.prose p')).toHaveText(lines)
  expect(await storedTexts(ctx.app)).toEqual([lines.join('\n')])
}

interface DocNode {
  type?: string
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
  content?: DocNode[]
}

/** Every run of text in a stored note, with its formatting. */
function textRuns(node: DocNode, out: DocNode[] = []): DocNode[] {
  if (node.type === 'text') out.push(node)
  for (const child of node.content ?? []) textRuns(child, out)
  return out
}

test('R1a: after the colour row was opened and the selection dropped by a click, Ctrl+Enter logs the note', async () => {
  const ctx = await start()
  const { page } = ctx
  const bar = await noteWithSelectedWord(page)
  await bar.getByRole('button', { name: 'Text color' }).click()
  await expect(inkRow(page)).toBeVisible()

  // Click somewhere else in the text: the selection is gone and the bar with it.
  await clickWord(page, ELSEWHERE)
  await expect(bar).toBeHidden()
  expect(await selectedText(page)).toBe('')
  await expect(editorBody(page)).toBeFocused()

  // Nothing is open any more, so Ctrl+Enter belongs to the note.
  await page.keyboard.press('Control+Enter')
  await expectLogged(ctx, LINES)
})

test('R1b: after the highlight row was opened and the selection dropped with an arrow key, one Esc returns to the board', async () => {
  const ctx = await start()
  const { page } = ctx
  const bar = await noteWithSelectedWord(page)
  await bar.getByRole('button', { name: 'Highlight' }).click()
  await expect(highlightRow(page)).toBeVisible()
  // Pressing a control in the bar leaves the keyboard in the text.
  await expect(editorBody(page)).toBeFocused()

  await page.keyboard.press('ArrowRight')
  await expect(bar).toBeHidden()
  expect(await selectedText(page)).toBe('')
  await expect(focusView(page)).toBeVisible()

  // One press, not two: there is no hidden row left to close first.
  await page.keyboard.press('Escape')
  await expectLogged(ctx, LINES)
})

test('R1c: after the link row was opened and the selection typed over, Ctrl+Enter logs the note with the typed text', async () => {
  const ctx = await start()
  const { page } = ctx
  const bar = await noteWithSelectedWord(page)
  await bar.getByRole('button', { name: 'Link' }).click()
  await expect(linkField(page)).toBeVisible()
  await expect(editorBody(page)).toBeFocused()

  // Typing replaces the selected word; with the selection gone the bar goes too.
  await page.keyboard.type('pullback')
  const lines = LINES.map((line) => line.replace(WORD, 'pullback'))
  await expect(editorBody(page).locator('p')).toHaveText(lines)
  await expect(bar).toBeHidden()

  await page.keyboard.press('Control+Enter')
  await expectLogged(ctx, lines)
  // The half-started link left nothing behind in the note.
  expect(JSON.stringify((await storedNotes(ctx.app))[0]!.content)).not.toContain('"link"')
})

test('R1d: a row left open when the title is clicked does not swallow Esc back in the text', async () => {
  const ctx = await start()
  const { page } = ctx
  const bar = await noteWithSelectedWord(page)
  await bar.getByRole('button', { name: 'Text color' }).click()
  await expect(inkRow(page)).toBeVisible()

  // The keyboard leaves the text for the title while the word is still selected: the row
  // closes, whether or not the bar itself stays.
  await clickTitle(page)
  await expect(inkRow(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()

  // Back into the text, then Esc once.
  await clickWord(page, ELSEWHERE)
  await expect(editorBody(page)).toBeFocused()
  await expect(bar).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expectLogged(ctx, LINES)
})

test('R1d: a row left open when the title is clicked does not swallow Esc pressed in the title either', async () => {
  const ctx = await start()
  const { page } = ctx
  const bar = await noteWithSelectedWord(page)
  await bar.getByRole('button', { name: 'Highlight' }).click()
  await expect(highlightRow(page)).toBeVisible()

  await clickTitle(page)
  await expect(highlightRow(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()

  // The row is closed and nothing else is open: Esc is "back to the board", in one press.
  await page.keyboard.press('Escape')
  await expectLogged(ctx, LINES)
})

test('R1e: while the word is still selected Esc closes only the row, a swatch colours the word, and the link field can be typed in', async () => {
  const ctx = await start()
  const { page, app } = ctx
  const bar = await noteWithSelectedWord(page)

  // Choosing a swatch colours the selected word and closes the row.
  await bar.getByRole('button', { name: 'Text color' }).click()
  await inkRow(page).getByRole('button', { name: 'red', exact: true }).click()
  await expect(inkRow(page)).toBeHidden()
  await expect(editorBody(page).locator('span[style*="--ink-red"]')).toHaveText(WORD)
  await expect(bar).toBeVisible()
  expect(await selectedText(page)).toBe(WORD)

  // Clicking into the link field moves the keyboard out of the text and into the bar. That
  // must not close the row: the address is typed there.
  await bar.getByRole('button', { name: 'Link' }).click()
  await linkField(page).click()
  await expect(linkField(page)).toBeFocused()
  await page.keyboard.type('example.com/plan')
  await expect(linkField(page)).toHaveValue('example.com/plan')
  await page.keyboard.press('Enter')
  await expect(linkField(page)).toBeHidden()
  await expect(editorBody(page).locator('a[href="https://example.com/plan"]')).toHaveText(WORD)

  // A row is open and the word is still selected: Esc closes the row and nothing else.
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: 'Highlight' }).click()
  await expect(highlightRow(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(highlightRow(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(bar).toBeVisible()
  expect(await selectedText(page)).toBe(WORD)
  await expect(editorBody(page)).toBeFocused()

  // The second Esc returns to the board.
  await page.keyboard.press('Escape')
  await expectLogged(ctx, LINES)

  // What was stored: the word, red and linked, and no highlight (that row was only opened).
  const runs = textRuns((await storedNotes(app))[0]!.content as DocNode)
  const word = runs.find((run) => run.text?.trim() === WORD)
  expect(word, `a separate run of text for "${WORD}"`).toBeTruthy()
  expect(word!.marks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'textStyle', attrs: expect.objectContaining({ color: 'var(--ink-red)' }) }),
      expect.objectContaining({ type: 'link', attrs: expect.objectContaining({ href: 'https://example.com/plan' }) })
    ])
  )
  expect(runs.some((run) => run.marks?.some((mark) => mark.type === 'highlight'))).toBe(false)
  // Only that word was touched.
  expect(runs.filter((run) => (run.marks ?? []).length > 0)).toHaveLength(1)
})

test('R1e: an open row is still open after another window took the keyboard and gave it back', async () => {
  const ctx = await start()
  const { app, page } = ctx
  const bar = await noteWithSelectedWord(page)
  await bar.getByRole('button', { name: 'Text color' }).click()
  await expect(inkRow(page)).toBeVisible()

  // The test driver normally tells the page that it has the keyboard whatever the desktop
  // says. Switch that off, so the page sees its window lose focus as it does for a person.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  const pageHasFocus = (): Promise<boolean> => page.evaluate(() => document.hasFocus())
  const closeOther = (): Promise<void> =>
    app.evaluate(() => {
      const scope = globalThis as unknown as { __otherWindow?: { isDestroyed: () => boolean; destroy: () => void } }
      if (scope.__otherWindow && !scope.__otherWindow.isDestroyed()) scope.__otherWindow.destroy()
      delete scope.__otherWindow
    })

  try {
    // Another window is brought forward: stands in for clicking the chart beside the notes.
    const notesWindowId = await app.evaluate(({ BrowserWindow }) => {
      const notesId = BrowserWindow.getAllWindows()[0]!.id
      const other = new BrowserWindow({ x: 1000, y: 40, width: 500, height: 400 })
      ;(globalThis as unknown as { __otherWindow?: unknown }).__otherWindow = other
      other.show()
      other.focus()
      return notesId
    })
    const lostFocus = await expect
      .poll(pageHasFocus, { timeout: 6000 })
      .toBe(false)
      .then(
        () => true,
        () => false
      )
    test.skip(!lostFocus, 'This desktop did not take keyboard focus away from the notes window, so the case cannot be exercised here.')

    // The notes window is exactly as it was left: the bar and its row are still open.
    await page.waitForTimeout(400)
    await expect(focusView(page)).toBeVisible()
    await expect(bar).toBeVisible()
    await expect(inkRow(page), 'the colour row while another window has the keyboard').toBeVisible()

    // Back to the notes.
    await closeOther()
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.focus(), notesWindowId)
    const backInFocus = await expect
      .poll(pageHasFocus, { timeout: 6000 })
      .toBe(true)
      .then(
        () => true,
        () => false
      )
    // Where the desktop does not hand the keyboard back by itself, carry on as the driver usually does.
    if (!backInFocus) await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await expect(inkRow(page), 'the colour row after coming back').toBeVisible()

    // The row still does its job: a swatch colours the word that was selected all along.
    await inkRow(page).getByRole('button', { name: 'red', exact: true }).click()
    await expect(editorBody(page).locator('span[style*="--ink-red"]')).toHaveText(WORD)
    await expect(inkRow(page)).toBeHidden()
  } finally {
    await closeOther().catch(() => undefined)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
  }

  // Nothing is left open: Ctrl+Enter logs the note.
  await clickWord(page, ELSEWHERE)
  await expect(bar).toBeHidden()
  await page.keyboard.press('Control+Enter')
  await expectLogged(ctx, LINES)
})

// ------------------------------------------------------------------ R2: pinned index

const palette = (page: Page): Locator => page.getByTestId('palette')

/** A note tall enough that four of them do not fit in the window. */
async function writeTallNote(page: Page, name: string): Promise<void> {
  await writeNote(page, [`${name} note`, ...Array.from({ length: 11 }, (_, index) => `${name} rule ${index + 1}`)])
}

async function pinFromHover(page: Page, text: string): Promise<void> {
  const note = noteByText(page, text)
  await note.hover({ position: { x: 30, y: 12 } })
  await note.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(note).toHaveClass(/is-pinned/)
}

/** What has keyboard focus, in words, so that a failure says where the keyboard went instead. */
const focusedElement = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const element = document.activeElement
    if (!element || element === document.body) return 'nothing'
    const text = (element.textContent ?? '').trim()
    if (element.matches('[data-testid="palette"] .pin-open')) return `pinned entry "${element.querySelector('.result-label')?.textContent ?? text}"`
    if (element.matches('[data-testid="palette"] [role="tab"]')) return `tab "${text}"`
    return `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') ?? text).slice(0, 40)}"`
  })

test('R2: the pinned index opens with the keyboard on its first entry, and Enter shows that note; with nothing pinned it is on the Pinned tab', async () => {
  const { page } = await start()
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) await writeTallNote(page, name)
  const order = await boardLabels(page)
  expect(order).toEqual(['Alpha note', 'Bravo note', 'Charlie note', 'Delta note'])
  const pal = palette(page)

  // Nothing pinned yet: there is no entry to land on, so the keyboard is on the Pinned tab.
  await openGearItem(page, /^Pinned notes$/)
  await expect(pal).toBeVisible()
  await expect(pal).toHaveAttribute('aria-label', 'Pinned notes')
  await expect(pal.locator('.pin-open')).toHaveCount(0)
  await expect(pal.getByText(/Nothing pinned yet/)).toBeVisible()
  await expect.poll(() => focusedElement(page), { message: 'what has keyboard focus when the empty pinned index opens' }).toBe('tab "Pinned"')
  await expect(pal.getByRole('tab', { name: 'Pinned', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(pal).toBeHidden()

  // Pin two notes; the one pinned first is the last note on the board.
  await pinFromHover(page, 'Delta note')
  await pinFromHover(page, 'Alpha note')
  const scroller = page.getByTestId('board-scroll')
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -20000)
  expect(await settledScrollTop(scroller)).toBe(0)
  const delta = noteByText(page, 'Delta note')
  await expect(delta).not.toBeInViewport()

  // Gear -> Pinned notes: the keyboard is on the first entry, not on the tab above it.
  await openGearItem(page, /^Pinned notes \(2\)$/)
  await expect(pal).toBeVisible()
  const entries = pal.locator('.pin-open')
  await expect(entries.locator('.result-label')).toHaveText(['Delta note', 'Alpha note'])
  await expect.poll(() => focusedElement(page), { message: 'what has keyboard focus when the pinned index opens' }).toBe('pinned entry "Delta note"')
  await expect(entries.first()).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === document.querySelector('[data-testid="palette"] .pin-open'))).toBe(true)

  // Enter, with no other key first: the index closes and the board shows that note.
  await page.keyboard.press('Enter')
  await expect(pal).toBeHidden()
  await expect(delta).toHaveClass(/is-spotlit/)
  await expect(delta).toBeInViewport()
  await expect(focusView(page)).toBeHidden()
  expect(await boardLabels(page)).toEqual(order)
})

// ------------------------------------------------------------------ R3: menus and scrolling

const editMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Edit' })
const LONG_NOTE = Array.from({ length: 50 }, (_, index) => `Rule ${String(index + 1).padStart(2, '0')}: wait for the retest`)

/** The "Rule NN" that starts the line nearest the middle of the note's scrolling area right now. */
async function ruleNearMiddle(page: Page): Promise<string> {
  return page.locator('.focus-scroll').evaluate((scroll) => {
    const area = scroll.getBoundingClientRect()
    const middle = area.top + area.height / 2
    let best = ''
    let distance = Infinity
    for (const line of scroll.querySelectorAll('.ProseMirror p')) {
      const rect = line.getBoundingClientRect()
      const away = Math.abs(rect.top + rect.height / 2 - middle)
      if (away < distance) {
        distance = away
        best = line.textContent ?? ''
      }
    }
    return best.slice(0, 'Rule 00'.length)
  })
}

test('R3: the right-click menu in a note closes when the note is scrolled with the wheel', async () => {
  const { page } = await start()
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await typeLines(page, LONG_NOTE)
  await expect(editorBody(page).locator('p')).toHaveCount(LONG_NOTE.length)

  // The note is longer than the window: it scrolls, and typing has carried it down.
  const scroller = page.locator('.focus-scroll')
  const extent = await scroller.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))
  expect(extent.scrollHeight, 'the note is taller than its scrolling area').toBeGreaterThan(extent.clientHeight + 300)
  const before = await settledScrollTop(scroller)

  // Right-click a word: Cut, Copy and Paste are offered at the pointer.
  const point = await reachableWordPoint(page, await ruleNearMiddle(page))
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const menu = editMenu(page)
  await expect(menu).toBeVisible()
  await expect(menu.locator('.menu-item .menu-text')).toHaveText(['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all'])
  for (const label of ['Cut', 'Copy', 'Paste']) await expect(menu.locator('.menu-item').filter({ has: page.getByText(label, { exact: true }) })).toBeVisible()
  await expect(focusView(page)).toBeVisible()

  // It stays while nothing happens (it is not about to close by itself).
  await page.waitForTimeout(300)
  await expect(menu).toBeVisible()

  // Roll the wheel with the pointer where it is, beside the menu: the text moves, so the
  // menu, which belonged to a place in that text, goes away.
  await page.mouse.wheel(0, before >= 300 ? -300 : 300)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop), { message: 'the note scrolled' }).not.toBe(before)
  await expect(menu).toBeHidden()
  await expect(focusView(page)).toBeVisible()

  // The menu can be asked for again at the new position.
  const again = await reachableWordPoint(page, await ruleNearMiddle(page))
  await page.mouse.click(again.x, again.y, { button: 'right' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(focusView(page)).toBeVisible()
})

test('R3: the gear menu stays open while the board scrolls underneath it', async () => {
  const { page } = await start()
  await writeNote(page, LONG_NOTE)
  await expect(notes(page)).toHaveCount(1)
  const scroller = page.getByTestId('board-scroll')
  const extent = await scroller.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))
  expect(extent.scrollHeight, 'the board is taller than the window').toBeGreaterThan(extent.clientHeight + 300)
  // Let the board finish bringing the new note into view.
  const before = await settledScrollTop(scroller)

  await page.getByTestId('gear').click()
  const settings = page.getByRole('menuitem', { name: 'Settings' })
  await expect(settings).toBeVisible()

  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + 200, box.y + box.height * 0.6)
  await page.mouse.wheel(0, before >= 300 ? -300 : 300)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop), { message: 'the board scrolled' }).not.toBe(before)
  await settledScrollTop(scroller)

  // The menu hangs from the title bar, which did not move: it is still there and still works.
  await expect(settings).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^Backup and import/ })).toBeVisible()
  await settings.click()
  await expect(page.getByTestId('settings')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).toBeHidden()
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page)).toHaveCount(1)
})

// ------------------------------------------------------------------ R4: backup while the note cannot be saved

interface DialogLog {
  save: unknown[]
  open: unknown[]
}

/** Answer the native Save dialog with a path (nothing can click the real one here). */
async function answerSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    const scope = globalThis as unknown as { __tnDialogs?: DialogLog }
    const log = (scope.__tnDialogs ??= { save: [], open: [] })
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      log.save.push(args[args.length - 1])
      return { canceled: false, filePath: target }
    }) as unknown as typeof dialog.showSaveDialog
  }, filePath)
}

/** Answer the native Open dialog with a path. */
async function answerOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    const scope = globalThis as unknown as { __tnDialogs?: DialogLog }
    const log = (scope.__tnDialogs ??= { save: [], open: [] })
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      log.open.push(args[args.length - 1])
      return { canceled: false, filePaths: [target] }
    }) as unknown as typeof dialog.showOpenDialog
  }, filePath)
}

/** How often each native file dialog was asked for. */
async function dialogsShown(app: ElectronApplication): Promise<{ save: number; open: number }> {
  return app.evaluate(() => {
    const log = (globalThis as unknown as { __tnDialogs?: DialogLog }).__tnDialogs
    return { save: log?.save.length ?? 0, open: log?.open.length ?? 0 }
  })
}

const backupSheet = (page: Page): Locator => page.getByTestId('backup')
const backupError = (page: Page): Locator => backupSheet(page).getByRole('alert')
const exportDone = (page: Page): Locator => backupSheet(page).locator('.setting-success').filter({ hasText: /Saved \d+ notes?/ })
const importPreview = (page: Page): Locator => page.getByTestId('import-preview')
const importResult = (page: Page): Locator => page.getByTestId('import-result')
const savedStatus = (page: Page): Locator => page.locator('.save-status[data-state="saved"]')
const notSaved = (page: Page): Locator => page.locator('.save-status.is-error')

async function openBackupPanel(page: Page): Promise<void> {
  await openGearItem(page, /^Backup and import/)
  await expect(backupSheet(page)).toBeVisible()
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.sheet')).toHaveCount(0)
}

const STORED = 'Stored before the disk failed.'
const UNSTORED = ' Typed after it failed.'

/** Open a draft, let its first words be saved, then make saving fail and type more. */
async function draftThatCannotBeSaved(ctx: Launched): Promise<void> {
  const { app, page } = ctx
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type(STORED)
  await expect(savedStatus(page)).toBeVisible()
  expect(await storedTexts(app)).toContain(STORED)

  await setFailSaves(app, true)
  await page.keyboard.type(UNSTORED)
  await expect(notSaved(page)).toBeVisible()
  await expect(notSaved(page)).toContainText('Not saved')
  await expect(editorBody(page)).toHaveText(STORED + UNSTORED)
  expect(await storedTexts(app)).not.toContain(STORED + UNSTORED)
}

/** Saving works again: "Try again" in the editor stores everything that was typed. */
async function recoverWithTryAgain(ctx: Launched): Promise<void> {
  const { app, page } = ctx
  // The pointer is on the button before saving is switched back on, so that it is this press
  // that stores the note and not one of the app's own, widely spaced, retries.
  const tryAgain = notSaved(page).getByRole('button', { name: 'Try again' })
  await tryAgain.hover()
  await setFailSaves(app, false)
  await tryAgain.click()
  await expect(savedStatus(page)).toBeVisible()
  await expect(notSaved(page)).toHaveCount(0)
  expect(await storedTexts(app)).toContain(STORED + UNSTORED)
}

test('R4: Export refuses to run while the open note cannot be saved, writes nothing, and leaves the note open', async () => {
  const ctx = await start()
  const { app, page } = ctx
  const dir = tempDir('tn-regress-export-')
  const file = join(dir, 'notes.tnbackup')
  await draftThatCannotBeSaved(ctx)

  await answerSaveDialog(app, file)
  await openBackupPanel(page)
  await page.getByTestId('export-backup').click()

  // Refused, with the reason; a backup made now would be missing the newest text.
  await expect(backupError(page)).toContainText('could not be saved yet')
  await expect(page.getByTestId('export-backup')).toBeEnabled()
  await expect(exportDone(page)).toHaveCount(0)
  await expect(backupSheet(page).locator('.setting-success')).toHaveCount(0)
  expect(readdirSync(dir), 'no backup file was written').toEqual([])
  expect(existsSync(file)).toBe(false)
  // It did not even get as far as asking where to save.
  expect((await dialogsShown(app)).save).toBe(0)

  // Asking again changes nothing while saving still fails.
  await page.getByTestId('export-backup').click()
  await expect(backupError(page)).toContainText('could not be saved yet')
  await expect(page.getByTestId('export-backup')).toBeEnabled()
  await expect(exportDone(page)).toHaveCount(0)
  expect(readdirSync(dir)).toEqual([])
  expect((await dialogsShown(app)).save).toBe(0)

  // The note is still open behind the panel, with every word, and still says it is not saved.
  await closePanel(page)
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText(STORED + UNSTORED)
  await expect(notSaved(page)).toBeVisible()
  expect(await storedTexts(app)).toEqual([STORED])

  // Once the note can be saved, the export goes through and holds the whole note.
  await recoverWithTryAgain(ctx)
  await openBackupPanel(page)
  await page.getByTestId('export-backup').click()
  await expect(exportDone(page)).toContainText('Saved 1 note and 0 images')
  await expect(backupError(page)).toHaveCount(0)
  expect(readdirSync(dir)).toEqual(['notes.tnbackup'])
  await closePanel(page)
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText(STORED + UNSTORED)
})

test('R4: Import refuses to run while the open note cannot be saved, imports nothing, and keeps the editor and its text', async () => {
  // A backup made on another profile, so that importing it would really add something.
  const file = join(tempDir('tn-regress-import-'), 'other-profile.tnbackup')
  const other = await start()
  await writeNote(other.page, ['Arrives by import', 'Written on another computer.'])
  await answerSaveDialog(other.app, file)
  await openBackupPanel(other.page)
  await other.page.getByTestId('export-backup').click()
  await expect(exportDone(other.page)).toContainText('Saved 1 note and 0 images')
  expect(existsSync(file)).toBe(true)
  await stop(other)

  const ctx = await start()
  const { app, page } = ctx
  await writeNote(page, ['Already here'])
  await draftThatCannotBeSaved(ctx)
  expect(await storedTexts(app)).toEqual(sorted(['Already here', STORED]))

  // Choose the backup: looking at what it holds needs nothing saved, so the preview shows.
  await openBackupPanel(page)
  await answerOpenDialog(app, file)
  await page.getByTestId('choose-backup').click()
  await expect(importPreview(page)).toContainText('Contains 1 note, 0 images and 0 pins.')
  await expect(importPreview(page).getByRole('radio', { name: /^Add to my notes/ })).toBeChecked()

  // Import: refused. Importing puts the window back on the board, which would drop the text
  // that could not be stored.
  await page.getByTestId('run-import').click()
  await expect(backupError(page)).toContainText('could not be saved yet')
  await expect(importResult(page)).toHaveCount(0)
  await expect(backupSheet(page).locator('.setting-success')).toHaveCount(0)
  expect(await storedTexts(app), 'nothing was imported').toEqual(sorted(['Already here', STORED]))
  await expect(focusView(page)).toBeVisible()

  // Behind the panel the note is still open with every word.
  await closePanel(page)
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText(STORED + UNSTORED)
  await expect(notSaved(page)).toBeVisible()
  expect(await storedTexts(app)).toEqual(sorted(['Already here', STORED]))

  // Saving works again and "Try again" stores the note.
  await recoverWithTryAgain(ctx)
  expect(await storedTexts(app)).toEqual(sorted(['Already here', STORED + UNSTORED]))

  // Now the same import goes through, and the note keeps everything that was typed.
  await openBackupPanel(page)
  await page.getByTestId('choose-backup').click()
  await expect(importPreview(page)).toContainText('Contains 1 note, 0 images and 0 pins.')
  await page.getByTestId('run-import').click()
  await expect(importResult(page)).toContainText('Added 1 note, with 0 new images.')
  await expect(backupError(page)).toHaveCount(0)
  await closePanel(page)
  await expect(focusView(page)).toBeHidden()
  expect(await boardLabels(page)).toEqual(['Already here', STORED + UNSTORED, 'Arrives by import'])
  expect(await storedTexts(app)).toEqual(sorted(['Already here', STORED + UNSTORED, 'Arrives by import\nWritten on another computer.']))
})
