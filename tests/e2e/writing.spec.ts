import { expect, test } from '@playwright/test'
import { board, boardLabels, clickEmptySpace, collectConsoleErrors, editorBody, focusView, notes, storedNotes, writeNote } from './helpers'
import { launch, type Launched } from './launch'

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

test('click empty space, write paragraphs, log, reopen and edit', async () => {
  const { page, app } = ctx
  await expect(page.getByText('Click anywhere to write')).toBeVisible()

  await board(page).click({ position: { x: 420, y: 480 } })
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toBeFocused()
  // The other notes and the hint are hidden while one note has focus.
  await expect(page.getByTestId('board-scroll')).toBeHidden()

  await page.keyboard.type('Wait for the sweep')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Then the retesX')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('t')
  // Enter made a new paragraph, Backspace removed one character: still in the editor.
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page).locator('p')).toHaveText(['Wait for the sweep', 'Then the retest'])

  await page.getByRole('button', { name: /Log note/ }).click()
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page)).toHaveCount(1)
  await expect(notes(page).first().locator('.prose p')).toHaveText(['Wait for the sweep', 'Then the retest'])
  await expect(page.getByText('Click anywhere to write')).toBeHidden()

  // Reopen by clicking the note; the caret lands where the click was, and editing continues.
  await notes(page).first().locator('.prose p').nth(1).click()
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('End')
  await page.keyboard.type(' of the level.')
  await page.keyboard.press('Control+Enter')
  await expect(notes(page).first().locator('.prose p')).toHaveText(['Wait for the sweep', 'Then the retest of the level.'])
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['Wait for the sweep\nThen the retest of the level.'])
})

test('opening a note puts the caret at the clicked word', async () => {
  const { page } = ctx
  await writeNote(page, ['alpha beta gamma', 'second paragraph here'])
  const paragraph = notes(page).first().locator('.prose p').nth(1)
  const box = (await paragraph.boundingBox())!
  // Click at the very start of the second paragraph and type there.
  await page.mouse.click(box.x + 1, box.y + box.height / 2)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('>> ')
  await expect(editorBody(page).locator('p').nth(1)).toHaveText('>> second paragraph here')
  await page.keyboard.press('Escape')
})

test('autosaves while typing; Esc and Back keep the draft; an empty draft leaves nothing behind', async () => {
  const { page, app } = ctx
  // Empty draft: Esc returns to the board and nothing is stored.
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page)).toHaveCount(0)
  expect(await storedNotes(app)).toEqual([])

  // Whitespace only is still empty.
  await clickEmptySpace(page)
  await page.keyboard.type('   ')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(notes(page)).toHaveCount(0)
  expect(await storedNotes(app)).toEqual([])

  // Typing is written without logging: the save status reaches "Saved" on its own.
  await clickEmptySpace(page)
  await page.keyboard.type('unlogged draft text')
  await expect(page.locator('.save-status')).toHaveText('Saved')
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['unlogged draft text'])

  // Esc returns to the board and keeps the draft as a note.
  await page.keyboard.type(' plus more')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page)).toHaveCount(1)
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['unlogged draft text plus more'])

  // A note that is emptied again is removed rather than left as a blank sheet.
  await notes(page).first().click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Control+Enter')
  await expect(notes(page)).toHaveCount(0)
  expect(await storedNotes(app)).toEqual([])
})

test('title is optional and Esc closes the top-most thing first', async () => {
  const { page } = ctx
  await clickEmptySpace(page)
  await page.locator('.focus-title').fill('London session rules')
  await page.keyboard.press('Enter')
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.type('No trades in the first five minutes.')

  // Open a formatting menu, then Esc: only the menu closes.
  await page.getByRole('button', { name: 'Paragraph style' }).click()
  await expect(page.getByRole('menuitemcheckbox', { name: 'Heading 1' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitemcheckbox', { name: 'Heading 1' })).toBeHidden()
  await expect(focusView(page)).toBeVisible()

  // Open Find over the editor, Esc closes Find only.
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('palette')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toBeHidden()
  await expect(focusView(page)).toBeVisible()

  // Esc from the editor returns to the board with the note kept.
  await editorBody(page).click()
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page).first().locator('.note-title')).toHaveText('London session rules')
  expect(await boardLabels(page)).toEqual(['London session rules'])
})

test('controls, selecting text, dragging and scrolling never create a note', async () => {
  const { page, app } = ctx
  for (let i = 1; i <= 6; i++) await writeNote(page, [`Note number ${i}`, 'Some more words to select and scroll past. '.repeat(6)])
  await expect(notes(page)).toHaveCount(6)
  const count = async (): Promise<number> => (await storedNotes(app)).length

  // Clicking controls: gear, its menu items, note tools.
  await page.getByTestId('gear').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('gear').click()
  // Clicking away from an open menu onto empty space only closes the menu.
  const below = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="board"]')!
    const rect = element.getBoundingClientRect()
    return { x: rect.left + 8, y: rect.top + 3 }
  })
  await page.mouse.click(below.x, below.y)
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeHidden()
  await expect(focusView(page)).toBeHidden()

  const first = notes(page).first()
  await first.hover()
  await first.getByRole('button', { name: 'Pin', exact: true }).click()
  await first.getByRole('button', { name: 'Note actions' }).click()
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()

  // Selecting text inside a note, releasing over empty space.
  const paragraph = first.locator('.prose p').nth(1)
  const box = (await paragraph.boundingBox())!
  await page.mouse.move(box.x + 4, box.y + 8)
  await page.mouse.down()
  await page.mouse.move(box.x + 260, box.y + 8, { steps: 8 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(5)
  await expect(focusView(page)).toBeHidden()
  // The click that clears a selection is not a request for a new note either.
  await page.mouse.click(below.x, below.y)
  await expect(focusView(page)).toBeHidden()

  // A drag that starts and ends on empty space.
  const scrollBox = (await page.getByTestId('board-scroll').boundingBox())!
  await page.mouse.move(below.x, below.y)
  await page.mouse.down()
  await page.mouse.move(below.x + 80, below.y + 1, { steps: 5 })
  await page.mouse.up()
  await expect(focusView(page)).toBeHidden()

  // Scrolling with the wheel and by dragging the scrollbar.
  await page.mouse.move(scrollBox.x + 300, scrollBox.y + 300)
  await page.mouse.wheel(0, 500)
  await page.mouse.move(scrollBox.x + scrollBox.width - 4, scrollBox.y + 60)
  await page.mouse.down()
  await page.mouse.move(scrollBox.x + scrollBox.width - 4, scrollBox.y + 200, { steps: 5 })
  await page.mouse.up()
  await page.mouse.click(scrollBox.x + scrollBox.width - 4, scrollBox.y + scrollBox.height - 30)
  await expect(focusView(page)).toBeHidden()

  // Right-click and modified clicks on empty space.
  await page.getByTestId('board-scroll').evaluate((element) => (element.scrollTop = element.scrollHeight))
  const point = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="board"]')!
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: Math.min(window.innerHeight - 40, rect.bottom - 60) }
  })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await page.keyboard.down('Control')
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Control')
  await page.keyboard.down('Shift')
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Shift')
  await expect(focusView(page)).toBeHidden()

  expect(await count()).toBe(6)
  await expect(notes(page)).toHaveCount(6)

  // ...while a plain click on that same empty space does start a draft.
  await page.mouse.click(point.x, point.y)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await count()).toBe(6)
})
