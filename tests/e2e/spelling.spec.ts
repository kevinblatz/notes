/**
 * The app's own spelling checker (wavy underlines, right-click suggestions, Add to dictionary,
 * the Spelling settings) and the Organize button (Ctrl+Shift+O): one undoable step that
 * fixes every word and the punctuation, and puts thoughts that strayed back together.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { clickEmptySpace, collectConsoleErrors, copyImageToClipboard, editorBody, focusView, makePng, noteByText, notes, storedNotes } from './helpers'
import { freshDataDir, launch, removeDataDir, setWindowSize, type Launched } from './launch'

const SIZE = { width: 960, height: 1000 }

/** A dump of the day typed in a hurry, with a thought that strays off and comes back ("anyway"). */
const DUMP =
  'nwog at 6120 was the draw, asia made eql at 6098 and london swept them then displacment up leaving a fvg on 5m. ugh my neighbor is drilling again cant focus. anyway i was bullish bias from premarket bc pdh 6135 unswept. took long at 6104 in the ifvg stop 6096 tp 6130 got stopped out first time lol felt fomo and re entered to early. second entry worked +2r. lesson dont chase the first push wait for mss. felt calm after tho. ny am killzone was clean, silver bullet 10-11 gave the move'
const MINDSET =
  'today i felt imapatient from the open and i know thats when i make my worst trades. need to trust the process and let the setup come to me, the market will always be there tommorow'

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

async function restart(): Promise<void> {
  expect(errors, 'no console errors before restart').toEqual([])
  const { dataDir } = ctx
  await ctx.quit()
  ctx = await launch({ dataDir, size: SIZE })
  errors = await collectConsoleErrors(ctx.page)
}

// ---------------------------------------------------------------- helpers (this spec only)

const formatBar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Formatting', exact: true })
const organizeButton = (page: Page): Locator => formatBar(page).getByRole('button', { name: 'Organize' })
const underlined = (page: Page): Promise<string[]> => page.locator('.focus-editor .spell-miss').allTextContents()
const editMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Edit' })
const toast = (page: Page): Locator => page.locator('.toast').last()

/** The open note as Tiptap JSON, read from the editor itself. */
const editorJson = (page: Page): Promise<unknown> =>
  page.evaluate(() => (document.querySelector('.focus-editor .ProseMirror') as unknown as { editor: { getJSON: () => unknown } }).editor.getJSON())

/** Open a new note and wait until the word list is in (a known misspelling gets underlined). */
async function newNote(page: Page): Promise<void> {
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('teh ')
  await expect.poll(() => underlined(page), { message: 'the word list has loaded' }).toEqual(['teh'])
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await expect.poll(() => underlined(page)).toEqual([])
}

/** Section headings, then each bullet, as text. */
const outline = (page: Page): Promise<string[]> =>
  editorBody(page).evaluate((root) =>
    Array.from(root.querySelectorAll(':scope > h3, :scope > ul > li, :scope > p, :scope > .react-renderer, :scope > [data-node-view-wrapper]')).map((element) =>
      element.matches('h3') ? `## ${element.textContent}` : element.matches('li') ? `- ${element.textContent}` : element.querySelector('img') ? '[image]' : (element.textContent ?? '')
    )
  ).then((lines) => {
    // The editor keeps an empty line at the end to go on writing in.
    while (lines[lines.length - 1] === '') lines.pop()
    return lines
  })

async function setMotion(page: Page, label: 'Reduced' | 'Normal'): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.getByRole('radiogroup', { name: 'Motion' }).getByRole('radio', { name: label }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).toBeHidden()
}

// ---------------------------------------------------------------- spelling

test('the app’s own checker: Chromium’s is off, trading terms are known, a misspelling is underlined once the caret leaves it', async () => {
  const { page } = ctx
  await newNote(page)
  await expect(editorBody(page)).toHaveAttribute('spellcheck', 'false')
  await expect(page.locator('.focus-title')).toHaveAttribute('spellcheck', 'false')

  await page.keyboard.type('nwog fvg ifvgs IFVG’s choch pdh eql mss killzone premarket at 6,123.25 on 5m for +2r at 9:30am, ES1! see tradingview.com and Powell said Kenzie ')
  await page.keyboard.type('displacment')
  // The word being typed is left alone ...
  await page.waitForTimeout(150)
  expect(await underlined(page)).toEqual([])
  // ... until the caret leaves it.
  await page.keyboard.type(' and teh end ')
  await expect.poll(() => underlined(page)).toEqual(['displacment', 'teh'])
  const line = await page.locator('.focus-editor .spell-miss').first().evaluate((element) => {
    const style = getComputedStyle(element)
    return { style: style.textDecorationStyle, line: style.textDecorationLine, color: style.textDecorationColor }
  })
  expect(line).toMatchObject({ style: 'wavy', line: 'underline' })
  expect(line.color).not.toBe('rgba(0, 0, 0, 0)')

  // The title has the same checker, drawn over the field.
  await page.locator('.focus-title').fill('londn sesion recap')
  await expect.poll(() => page.locator('.focus-title-field .spell-miss').allTextContents()).toEqual(['londn', 'sesion'])
  // Each underline sits under its own word in the field.
  const geometry = await page.locator('.focus-title-field').evaluate((field) => {
    const input = field.querySelector<HTMLElement>('.focus-title')!
    const miss = field.querySelector('.spell-miss')!.getBoundingClientRect()
    const box = input.getBoundingClientRect()
    const canvas = document.createElement('canvas').getContext('2d')!
    canvas.font = getComputedStyle(input).font
    return { left: miss.left - box.left, width: miss.width, expected: canvas.measureText('londn').width }
  })
  expect(geometry.left).toBeLessThan(3)
  expect(Math.abs(geometry.width - geometry.expected)).toBeLessThan(3)
})

test('right-click a misspelled word: suggestions first, one undo step; Add to dictionary lasts; Settings lists, removes and switches off', async () => {
  let { page } = ctx
  await newNote(page)
  await page.keyboard.type('the displacment was clean and kenzie said so ')
  await expect.poll(() => underlined(page)).toEqual(['displacment', 'kenzie'])

  await page.locator('.focus-editor .spell-miss', { hasText: 'displacment' }).click({ button: 'right' })
  const menu = editMenu(page)
  await expect(menu).toBeVisible()
  const items = await menu.locator('.menu-item .menu-text').allTextContents()
  expect(items[0]).toBe('displacement')
  expect(items).toContain('Add to dictionary')
  expect(items.slice(-5)).toEqual(['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all'])
  await menu.getByRole('menuitem', { name: 'displacement', exact: true }).click()
  await expect(editorBody(page)).toHaveText('the displacement was clean and kenzie said so ')
  await expect.poll(() => underlined(page)).toEqual(['kenzie'])
  // One undo step puts the misspelling back, one redo the correction.
  await page.keyboard.press('Control+z')
  await expect(editorBody(page)).toHaveText('the displacment was clean and kenzie said so ')
  await page.keyboard.press('Control+y')
  await expect(editorBody(page)).toHaveText('the displacement was clean and kenzie said so ')

  // Add to dictionary: never underlined again, also after a restart.
  await page.locator('.focus-editor .spell-miss', { hasText: 'kenzie' }).click({ button: 'right' })
  await editMenu(page).getByRole('menuitem', { name: 'Add to dictionary' }).click()
  await expect.poll(() => underlined(page)).toEqual([])
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await restart()
  page = ctx.page
  await noteByText(page, 'kenzie said so').locator('.prose p').first().click()
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' teh ')
  await expect.poll(() => underlined(page)).toEqual(['teh'])

  // Settings: the word is listed and can be removed; underlines can be switched off.
  await page.keyboard.press('Control+,')
  const settings = page.getByTestId('settings')
  const dictionary = settings.getByRole('list', { name: 'Your dictionary' })
  await expect(dictionary.getByRole('listitem')).toHaveText(['kenzie'])
  await settings.getByRole('button', { name: 'Remove kenzie from your dictionary' }).click()
  await expect(dictionary).toHaveCount(0)
  await expect(settings).toContainText('Right-click an underlined word')
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect.poll(() => underlined(page)).toEqual(['kenzie', 'teh'])
  await page.keyboard.press('Control+,')
  await settings.getByRole('switch', { name: 'Underline misspelled words' }).click()
  await page.keyboard.press('Escape')
  await expect.poll(() => underlined(page)).toEqual([])
  const stored = await ctx.app.evaluate(() => (globalThis as unknown as { __tnTest: { library: { getPreferences: () => { spellcheck: boolean; spellingWords: string[] } } } }).__tnTest.library.getPreferences())
  expect(stored).toMatchObject({ spellcheck: false, spellingWords: [] })
})

test('a misspelled title word can be corrected from the right-click menu', async () => {
  const { page } = ctx
  await newNote(page)
  await page.locator('.focus-title').fill('london sesion')
  // The last word typed is underlined once the caret leaves the title.
  await page.waitForTimeout(150)
  await expect(page.locator('.focus-title-field .spell-miss')).toHaveCount(0)
  await editorBody(page).click()
  await expect.poll(() => page.locator('.focus-title-field .spell-miss').allTextContents()).toEqual(['sesion'])
  const box = (await page.locator('.focus-title-field .spell-miss').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await expect(editMenu(page).locator('.menu-item .menu-text').first()).toHaveText('session')
  await editMenu(page).getByRole('menuitem', { name: 'session', exact: true }).click()
  await expect(page.locator('.focus-title')).toHaveValue('london session')
  await expect(page.locator('.focus-title-field .spell-miss')).toHaveCount(0)
})

test('the quick note strip and image captions are checked too', async () => {
  const { page, app } = ctx
  await newNote(page)
  await copyImageToClipboard(app, makePng(320, 180, [40, 160, 150]))
  await page.keyboard.press('Control+v')
  await expect(page.locator('.focus-editor .image-node img')).toBeVisible()
  await page.locator('.focus-editor .image-node img').click()
  await page.locator('.focus-editor .image-caption').fill('sweep of teh low ')
  await expect.poll(() => page.locator('.image-caption-field .spell-miss').allTextContents()).toEqual(['teh'])

  // Right-click the caption's underlined word: its suggestions, and the fix is the caption's.
  await rightClickMiss(page, '.image-caption-field', 'teh')
  await expect(editMenu(page).locator('.menu-item .menu-text').first()).toHaveText('the')
  expect((await editMenu(page).locator('.menu-item .menu-text').allTextContents()).slice(-6)).toEqual(['Add to dictionary', 'Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all'])
  await editMenu(page).getByRole('menuitem', { name: 'the', exact: true }).click()
  await expect(page.locator('.focus-editor .image-caption')).toHaveValue('sweep of the low ')
  await expect(page.locator('.image-caption-field .spell-miss')).toHaveCount(0)
  await expect.poll(async () => JSON.stringify(await editorJson(page))).toContain('"caption":"sweep of the low "')

  // The tag field too.
  await page.getByRole('button', { name: 'Add tag' }).click()
  await page.keyboard.type('scalpng x')
  await expect.poll(() => page.locator('.tag-input-field .spell-miss').allTextContents()).toEqual(['scalpng'])
  await rightClickMiss(page, '.tag-input-field', 'scalpng')
  await editMenu(page).getByRole('menuitem', { name: 'scalping', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'New tag' })).toHaveValue('scalping x')
  await page.keyboard.press('Escape')

  await app.evaluate(() => (globalThis as unknown as { __tnTest: { shortcuts: { trigger: (id: string) => boolean } } }).__tnTest.shortcuts.trigger('quickNote'))
  const strip = page.locator('.quick-note-input')
  await expect(strip).toBeFocused()
  await page.keyboard.type('fvg filled, waitng for mss ')
  await expect.poll(() => page.locator('.quick-note-field .spell-miss').allTextContents()).toEqual(['waitng'])
  await rightClickMiss(page, '.quick-note-field', 'waitng')
  await editMenu(page).getByRole('menuitem', { name: 'waiting', exact: true }).click()
  await expect(strip).toHaveValue('fvg filled, waiting for mss ')
  await expect(strip).toBeFocused()
  await page.keyboard.press('Escape')
})

/** Right-click the underlined `word` of a one-line field. */
async function rightClickMiss(page: Page, field: string, word: string): Promise<void> {
  const box = (await page.locator(`${field} .spell-miss`, { hasText: word }).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await expect(editMenu(page)).toBeVisible()
}

// ---------------------------------------------------------------- Organize

const ORGANIZED_DUMP = [
  "NWOG at 6120 was the draw, Asia made EQL at 6098 and London swept them then displacement up leaving a FVG on 5m. Anyway I was bullish bias from premarket because PDH 6135 unswept. Took long at 6104 in the IFVG, stop 6096, TP 6130, got stopped out first time lol. Felt FOMO and re-entered too early. Second entry worked +2R. Lesson: don't chase the first push, wait for MSS. Felt calm after tho. NY AM killzone was clean, silver bullet 10-11 gave the move.",
  "Ugh my neighbor is drilling again can't focus."
]
const ORGANIZED_TOAST = /^Organized: \d+ fixes, 1 thought regrouped/

test('Organize fixes a dump of the day and puts a stray thought back, in plain paragraphs; one Ctrl+Z restores the note and its title exactly', async () => {
  const { page, app } = ctx
  await newNote(page)
  await page.locator('.focus-title').fill('londn sesion recap')
  await editorBody(page).click()
  await page.keyboard.type(DUMP)
  // Next to Draw, with its shortcut in the tooltip.
  const buttons = await formatBar(page).locator('.bar-group').first().getByRole('button').evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))
  expect(buttons.slice(-2)).toEqual(['Draw', 'Organize'])
  await expect(organizeButton(page)).toHaveAttribute('title', 'Organize (Ctrl+Shift+O)')
  // At half-screen width the bar still fits on one line with the extra button.
  const rows = (): Promise<number> => formatBar(page).evaluate((bar) => new Set(Array.from(bar.querySelectorAll('button')).map((button) => Math.round(button.getBoundingClientRect().top))).size)
  await setWindowSize(app, page, 680, SIZE.height)
  expect(await rows()).toBe(1)
  await setWindowSize(app, page, SIZE.width, SIZE.height)
  const before = await editorJson(page)

  await organizeButton(page).click()
  await expect(editorBody(page).locator(':scope > p')).toHaveText(ORGANIZED_DUMP)
  // Only paragraphs: no headings, no bullets.
  await expect(editorBody(page).locator('h1, h2, h3, ul, ol')).toHaveCount(0)
  await expect(page.locator('.focus-title')).toHaveValue('London session recap')
  await expect(toast(page)).toContainText(ORGANIZED_TOAST)
  await expect(toast(page).getByRole('button', { name: 'Undo' })).toBeVisible()
  // Nothing is underlined any more.
  await expect.poll(() => underlined(page)).toEqual([])
  const organized = await editorJson(page)

  // One Ctrl+Z: the note exactly as it was, title included.
  await page.keyboard.press('Control+z')
  expect(await editorJson(page)).toEqual(before)
  await expect(page.locator('.focus-title')).toHaveValue('londn sesion recap')
  // Redo brings the organized note (and title) back.
  await page.keyboard.press('Control+y')
  expect(await editorJson(page)).toEqual(organized)
  await expect(page.locator('.focus-title')).toHaveValue('London session recap')
  // The message's Undo does the same as Ctrl+Z.
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+Shift+O')
  await expect(toast(page)).toContainText(ORGANIZED_TOAST)
  await toast(page).getByRole('button', { name: 'Undo' }).click()
  expect(await editorJson(page)).toEqual(before)
  await expect(page.locator('.focus-title')).toHaveValue('londn sesion recap')

  // Organized again and logged: that is what is stored. Organizing it once more changes nothing.
  await organizeButton(page).click()
  await expect(editorBody(page).locator(':scope > p').first()).toHaveText(ORGANIZED_DUMP[0]!)
  await organizeButton(page).click()
  await expect(toast(page)).toHaveText(/Already tidy/)
  expect(await editorJson(page)).toEqual(organized)
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const [note] = await storedNotes(app)
  expect(note!.title).toBe('London session recap')
  expect(note!.plainText.split('\n').filter(Boolean)).toEqual(ORGANIZED_DUMP)
})

test('Organize pressed straight after the first note opens still fixes every word', async () => {
  const { page } = ctx
  // No waiting for the word list: it is read in idle moments, and Organize asks for it at once.
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('teh displacment was clean')
  await page.keyboard.press('Control+Shift+O')
  await expect(editorBody(page).locator('p')).toHaveText(['The displacement was clean.'])
  await expect(toast(page)).toContainText('Fixed 2 words')
})

test('Ctrl+Shift+O with the formatting bar folded away: a mindset paragraph is only corrected; the highlight fades and nothing keeps running', async () => {
  const { page } = ctx
  await newNote(page)
  await page.getByRole('button', { name: 'Hide formatting' }).click()
  await expect(formatBar(page)).toBeHidden()
  await page.keyboard.type(MINDSET)
  await page.keyboard.press('Control+Shift+O')
  await expect(editorBody(page).locator('p')).toHaveText([
    "Today I felt impatient from the open and I know that's when I make my worst trades. Need to trust the process and let the setup come to me, the market will always be there tomorrow."
  ])
  await expect(toast(page)).toContainText('Fixed 6 words')
  // The changed words glow briefly ...
  expect(await page.locator('.focus-editor .organize-flash').allTextContents()).toEqual(['I', 'impatient', 'I', "that's", 'I', 'tomorrow'])
  // ... and within a second the highlight is gone and no animation is left running.
  await expect(page.locator('.focus-editor .organize-flash')).toHaveCount(0, { timeout: 1500 })
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running' && (animation.effect as KeyframeEffect | null)?.target instanceof Element && ((animation.effect as KeyframeEffect).target as Element).closest('.focus-editor')).length)).toBe(0)

  // With Reduced motion nothing glows at all.
  await setMotion(page, 'Reduced')
  await editorBody(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('i was to early agian')
  const seen = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let flashes = 0
        const observer = new MutationObserver(() => {
          flashes = Math.max(flashes, document.querySelectorAll('.focus-editor .organize-flash').length)
        })
        observer.observe(document.querySelector('.focus-editor')!, { subtree: true, childList: true, attributes: true })
        setTimeout(() => {
          observer.disconnect()
          resolve(flashes)
        }, 800)
      })
  )
  await page.keyboard.press('Control+Shift+O')
  await expect(editorBody(page).locator('p').last()).toHaveText('I was too early again.')
  expect(await seen).toBe(0)
})

test('the session log made by the hotkeys stays one line per entry in time order, the chart snapshot in its place, only corrected', async () => {
  const { page, app } = ctx
  type Handle = { shortcuts: { trigger: (id: string) => boolean }; setNow: (ms: number) => void; testHooks: { desktopSources: unknown } }
  const pressAt = (id: string, ms: number): Promise<boolean> =>
    app.evaluate(
      (_electron, input) => {
        const h = (globalThis as unknown as { __tnTest: Handle }).__tnTest
        h.setNow(input.ms)
        return h.shortcuts.trigger(input.id)
      },
      { id, ms }
    )
  const at = (h: number, m: number, s: number): number => new Date(2026, 10, 25, h, m, s).getTime()
  const quickNote = async (ms: number, text: string): Promise<void> => {
    await pressAt('quickNote', ms)
    await expect(page.locator('.quick-note-input')).toBeFocused()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    await expect(page.locator('.quick-note-input')).toBeHidden()
  }
  await quickNote(at(9, 31, 5), 'London high taken')
  await app.evaluate(
    (_electron, png) => {
      ;(globalThis as unknown as { __tnTest: Handle }).__tnTest.testHooks.desktopSources = [{ id: 'window:42:0', name: 'ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome', png }]
    },
    makePng(800, 450, [40, 160, 150]).toString('base64')
  )
  await pressAt('snapshot', at(9, 31, 40))
  await expect(page.locator('.board > .note img')).toBeVisible()
  await quickNote(at(9, 42, 10), 'fvg filled waiting for displacment')
  await quickNote(at(10, 5, 44), 'entered short 6128 stop 6134')

  await pressAt('openLog', at(10, 6, 0))
  await expect(focusView(page)).toBeVisible()
  await expect(page.locator('.focus-title')).toHaveValue(/^Session log · /)
  const title = await page.locator('.focus-title').inputValue()
  await page.keyboard.press('Control+Shift+O')
  await expect(toast(page)).toContainText('Fixed 2 words')
  expect(await outline(page)).toEqual(['09:31:05 — London high taken', '[image]', '09:42:10 — FVG filled waiting for displacement', '10:05:44 — Entered short 6128 stop 6134'])
  await expect(page.locator('.focus-title')).toHaveValue(title)
  await expect(editorBody(page).locator('.image-caption')).toHaveValue('09:31:40 · ES1! 6,123.25')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const stored = (await storedNotes(app)).find((note) => note.title === title)!
  expect(JSON.stringify(stored.content).match(/"noteImage"/g)).toHaveLength(1)
})

test('Organize on a 2,000-word dump feels instant', async () => {
  const { page } = ctx
  await newNote(page)
  const sentences = DUMP.split('. ')
  const paragraphs: string[] = []
  let words = 0
  while (words < 2000) {
    const paragraph = sentences.slice(paragraphs.length % 3, (paragraphs.length % 3) + 4).join('. ')
    paragraphs.push(paragraph)
    words += paragraph.split(' ').length
  }
  await page.evaluate((lines) => {
    const editor = (document.querySelector('.focus-editor .ProseMirror') as unknown as { editor: { commands: { setContent: (content: unknown) => void } } }).editor
    editor.commands.setContent({ type: 'doc', content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) })
  }, paragraphs)
  await expect(editorBody(page).locator('p')).toHaveCount(paragraphs.length)
  // From the key press to the organized note on screen.
  const ms = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const root = document.querySelector('.focus-editor .ProseMirror')!
        const observer = new MutationObserver(() => {
          // The whole organized note goes in at once, in one change of the page.
          if (!root.textContent?.startsWith('NWOG at 6120')) return
          observer.disconnect()
          requestAnimationFrame(() => resolve(performance.now() - started))
        })
        observer.observe(root, { childList: true, subtree: true, characterData: true })
        const started = performance.now()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true }))
      })
  )
  console.log(`[organize] ${words} words: ${Math.round(ms)} ms from the key press to the organized note on screen`)
  await expect(toast(page)).toContainText(/^Organized: \d+ fixes, \d+ thoughts regrouped/)
  // Every paragraph is still there; each stray became a paragraph of its own.
  expect(await editorBody(page).locator(':scope > p').count()).toBeGreaterThan(paragraphs.length)
  // Threshold: well under a second on these slow test machines (a typical run is far quicker).
  expect(ms).toBeLessThan(1000)
})

// ---------------------------------------------------------------- undo, menus and underlines

test('undoing typing done after Organize leaves the title Organize corrected; undoing Organize itself brings the old title back', async () => {
  const { page } = ctx
  await newNote(page)
  await page.keyboard.type('The open was clean.')
  await page.locator('.focus-title').fill('londn sesion recap')
  await organizeButton(page).click()
  await expect(toast(page)).toContainText('Fixed 2 words')
  await expect(page.locator('.focus-title')).toHaveValue('London session recap')
  await expect(editorBody(page)).toHaveText('The open was clean.')
  await page.keyboard.type(' More.')
  await page.waitForTimeout(700)
  await page.keyboard.press('Control+z')
  await expect(editorBody(page)).toHaveText('The open was clean.')
  await expect(page.locator('.focus-title')).toHaveValue('London session recap')
  await page.keyboard.press('Control+y')
  await expect(editorBody(page)).toHaveText('The open was clean. More.')
  await expect(page.locator('.focus-title')).toHaveValue('London session recap')
  // Undo the typing, then Organize itself: now the title goes back; redo brings it again.
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(page.locator('.focus-title')).toHaveValue('londn sesion recap')
  await page.keyboard.press('Control+y')
  await expect(page.locator('.focus-title')).toHaveValue('London session recap')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  // An empty note: the same.
  await newNote(page)
  await page.locator('.focus-title').fill('londn sesion recap')
  await page.keyboard.press('Control+Shift+O')
  await expect(page.locator('.focus-title')).toHaveValue('London session recap')
  await editorBody(page).click()
  await page.keyboard.type('hello there')
  await page.keyboard.press('Control+z')
  await expect(editorBody(page)).toHaveText('')
  await expect(page.locator('.focus-title')).toHaveValue('London session recap')
})

test('the message’s Undo is offered only while it can work: it goes once the note is edited or logged', async () => {
  const { page } = ctx
  await newNote(page)
  await page.keyboard.type('teh displacment was clean')
  await page.keyboard.press('Control+Shift+O')
  await expect(toast(page)).toContainText('Fixed 2 words')
  await expect(toast(page).getByRole('button', { name: 'Undo' })).toBeVisible()
  await page.keyboard.type(' ok')
  await expect(page.locator('.toast', { hasText: 'Fixed 2 words' })).toHaveCount(0)
  await expect(editorBody(page)).toHaveText('The displacement was clean. ok')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  await newNote(page)
  await page.keyboard.type('teh displacment was clean')
  await page.keyboard.press('Control+Shift+O')
  await expect(toast(page).getByRole('button', { name: 'Undo' })).toBeVisible()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await expect(page.locator('.toast', { hasText: 'Fixed 2 words' })).toHaveCount(0)
})

test('Add to dictionary with a full dictionary says so, and the word stays underlined', async () => {
  let { page } = ctx
  await page.evaluate((count) => window.tn.setPreferences({ spellingWords: Array.from({ length: count }, (_, i) => `word${i}x`) }), 500)
  await restart()
  page = ctx.page
  await newNote(page)
  await page.keyboard.type('the kenzie said so ')
  await expect.poll(() => underlined(page)).toEqual(['kenzie'])
  await page.locator('.focus-editor .spell-miss', { hasText: 'kenzie' }).click({ button: 'right' })
  await editMenu(page).getByRole('menuitem', { name: 'Add to dictionary' }).click()
  await expect(toast(page)).toContainText('Your dictionary is full (500 words)')
  await expect.poll(() => underlined(page)).toEqual(['kenzie'])
  const stored = await ctx.app.evaluate(() => (globalThis as unknown as { __tnTest: { library: { getPreferences: () => { spellingWords: string[] } } } }).__tnTest.library.getPreferences().spellingWords)
  expect(stored).toHaveLength(500)
  expect(stored).not.toContain('kenzie')
})

test('the menu key opens the Edit menu at the caret with the keyboard in it: arrows and Enter choose, Escape gives the text back', async () => {
  const { page } = ctx
  await newNote(page)
  await page.keyboard.type('the displacment was clean')
  await page.keyboard.press('Home')
  await page.keyboard.press('Control+ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+F10')
  const menu = editMenu(page)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'displacement', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(menu.getByRole('menuitem', { name: 'displacement', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(editorBody(page).locator('p')).toHaveText(['the displacement was clean'])
  await expect(editorBody(page)).toBeFocused()
  // In the title, the same.
  await page.locator('.focus-title').fill('londn open')
  await page.keyboard.press('Home')
  await page.keyboard.press('ContextMenu')
  await expect(menu.getByRole('menuitem', { name: 'London', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.focus-title')).toHaveValue('London open')
  await expect(page.locator('.focus-title')).toBeFocused()
})

test('a misspelled last word is underlined once the keyboard leaves the note text', async () => {
  const { page } = ctx
  await newNote(page)
  await page.keyboard.type('the displacment')
  await page.waitForTimeout(150)
  expect(await underlined(page)).toEqual([])
  await page.locator('.focus-title').click()
  await page.keyboard.type('x')
  await expect.poll(() => underlined(page), { timeout: 1000 }).toEqual(['displacment'])
})

test('title underlines stay under their words when the default font changes, and the wavy line is drawn whole', async () => {
  const { page } = ctx
  await newNote(page)
  await page.locator('.focus-title').fill('a long title about the london session and the ny open with teh sweep of the lows and the displacment ')
  await editorBody(page).click()
  await expect.poll(() => page.locator('.focus-title-field .spell-miss').allTextContents()).toEqual(['teh', 'displacment'])
  /** The copy over the field is laid out exactly as the field: same box, same font. */
  const layout = (): Promise<string[]> =>
    page.locator('.focus-title-field').evaluate((field) => {
      const input = field.querySelector<HTMLElement>('.focus-title')!
      const mirror = field.querySelector<HTMLElement>('.spell-mirror')!
      const a = getComputedStyle(input)
      const b = getComputedStyle(mirror)
      const box = (element: HTMLElement): string => {
        const r = element.getBoundingClientRect()
        return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
      }
      const differ: string[] = (['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'paddingLeft'] as const).filter((key) => a[key] !== b[key])
      return box(input) === box(mirror) ? differ : [...differ, 'box']
    })
  expect(await layout()).toEqual([])
  for (const font of ['Literata', 'JetBrains Mono', 'Hyperlegible']) {
    await page.keyboard.press('Control+,')
    await page.getByRole('combobox', { name: 'Default font' }).selectOption({ label: font })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings')).toBeHidden()
    await expect.poll(layout, { message: font }).toEqual([])
    await expect(page.locator('.focus-title')).toHaveCSS('font-family', new RegExp(font === 'Hyperlegible' ? 'Hyperlegible' : font))
  }
  // The field's copy is clipped at its sides only, so the wave below the words is whole.
  const overflow = await page.locator('.focus-title-field .spell-mirror').evaluate((mirror) => ({ x: getComputedStyle(mirror).overflowX, y: getComputedStyle(mirror).overflowY }))
  expect(overflow).toEqual({ x: 'clip', y: 'visible' })
})

// ---------------------------------------------------------------- titles and captions in a narrow window

const LONG_TITLE = 'Wednesday 11/25 "Continuation Scalping to a planned level off the NWOG after the overnight dump, waitng for displacment"'
const LONG_CAPTION = 'NQ 5 min: the unmitigated FVG under price, it kept moving upward towards nothingness before the dump into the new week opening gap, teh sweep'

/** How a wrapping field sits: its lines, whether anything scrolls or is cut off, and its text. */
const fieldFit = (field: Locator) =>
  field.evaluate((element) => {
    const area = element as HTMLTextAreaElement
    const box = area.getBoundingClientRect()
    const scroller = document.querySelector('.focus-scroll')!
    return {
      tag: area.tagName.toLowerCase(),
      lines: Math.round(area.clientHeight / parseFloat(getComputedStyle(area).lineHeight)),
      scrollsSideways: area.scrollWidth > area.clientWidth,
      scrollsDown: area.scrollHeight > area.clientHeight + 1,
      inWindow: box.left >= 0 && box.right <= window.innerWidth,
      pageCutOff: document.documentElement.scrollWidth > window.innerWidth || scroller.scrollWidth > scroller.clientWidth,
      value: area.value
    }
  })

/**
 * Click the middle of an underlined word of a field: where the caret lands in the field itself,
 * the word's range, and whether the word is on a line after the field's first.
 */
async function clickUnderlined(page: Page, fieldClass: string, word: string): Promise<{ caret: number; from: number; to: number; laterLine: boolean }> {
  const miss = page.locator(`${fieldClass} .spell-miss`, { hasText: word })
  const box = (await miss.boundingBox())!
  const field = (await page.locator(`${fieldClass} textarea`).boundingBox())!
  const lineHeight = await page.locator(`${fieldClass} textarea`).evaluate((area) => parseFloat(getComputedStyle(area).lineHeight))
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4)
  return {
    caret: await page.locator(`${fieldClass} textarea`).evaluate((area) => (area as HTMLTextAreaElement).selectionStart),
    from: Number(await miss.getAttribute('data-miss-from')),
    to: Number(await miss.getAttribute('data-miss-to')),
    laterLine: box.y + box.height / 2 > field.y + lineHeight
  }
}

test('at 680 px the title and a caption wrap onto as many lines as they need: all of them in view, Enter still leaves them, underlines under their words on every line', async () => {
  const { page, app } = ctx
  await setWindowSize(app, page, 680, SIZE.height)
  await newNote(page)
  await page.keyboard.type('Missed dump to NWOG, took 4-5 trades in the hour of 845-930.')
  await copyImageToClipboard(app, makePng(640, 300, [60, 110, 220]))
  await page.keyboard.press('Control+v')
  await expect(page.locator('.focus-editor .image-node img')).toBeVisible()
  await page.locator('.focus-editor .image-node img').click()
  await page.locator('.focus-editor .image-caption').fill(LONG_CAPTION)
  const title = page.locator('.focus-title')
  await title.fill(LONG_TITLE)
  await editorBody(page).click()

  // The whole title is there to read, on three lines, and nothing scrolls or is cut off.
  expect(await fieldFit(title)).toEqual({ tag: 'textarea', lines: 3, scrollsSideways: false, scrollsDown: false, inWindow: true, pageCutOff: false, value: LONG_TITLE })
  const caption = page.locator('.focus-editor .image-caption')
  expect(await fieldFit(caption)).toEqual({ tag: 'textarea', lines: 2, scrollsSideways: false, scrollsDown: false, inWindow: true, pageCutOff: false, value: LONG_CAPTION })

  // The misspelled words on a wrapped line are underlined right under themselves: clicking the
  // middle of an underline puts the caret inside that very word.
  await expect.poll(() => page.locator('.focus-title-field .spell-miss').allTextContents()).toEqual(['waitng', 'displacment'])
  for (const word of ['waitng', 'displacment']) {
    const hit = await clickUnderlined(page, '.focus-title-field', word)
    expect(hit.laterLine, word).toBe(true)
    expect(hit.caret, word).toBeGreaterThan(hit.from)
    expect(hit.caret, word).toBeLessThan(hit.to)
  }
  await expect.poll(() => page.locator('.image-caption-field .spell-miss').allTextContents()).toEqual(['teh'])
  const inCaption = await clickUnderlined(page, '.image-caption-field', 'teh')
  expect(inCaption.laterLine).toBe(true)
  expect(inCaption.caret).toBeGreaterThan(inCaption.from)
  expect(inCaption.caret).toBeLessThan(inCaption.to)
  // ... and right-clicking it offers that word's suggestions.
  await rightClickMiss(page, '.image-caption-field', 'teh')
  await editMenu(page).getByRole('menuitem', { name: 'the', exact: true }).click()
  await expect(caption).toHaveValue(LONG_CAPTION.replace('teh', 'the'))

  // Enter in a caption still goes back to the note text; no line break is ever added.
  await caption.click()
  await page.keyboard.press('Enter')
  await expect(editorBody(page)).toBeFocused()
  await expect(caption).toHaveValue(LONG_CAPTION.replace('teh', 'the'))

  // In the title, Enter and Shift+Enter go on into the note text; the down arrow does on the
  // title's last line only.
  for (const key of ['Enter', 'Shift+Enter']) {
    await title.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press(key)
    await expect(editorBody(page), key).toBeFocused()
    await expect(title).toHaveValue(LONG_TITLE)
  }
  await title.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await expect(title).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(title).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(editorBody(page)).toBeFocused()
  // Pasted line breaks become spaces.
  await app.evaluate(({ clipboard }) => clipboard.writeText('Wednesday 11/25\nContinuation scalping\r\nto a planned level'))
  await title.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+v')
  await expect(title).toHaveValue('Wednesday 11/25 Continuation scalping to a planned level')
  await title.fill(LONG_TITLE)

  // A wider font wraps onto more lines: the underlines follow, still under their words.
  await editorBody(page).click()
  await page.keyboard.press('Control+,')
  await page.getByRole('combobox', { name: 'Default font' }).selectOption({ label: 'JetBrains Mono' })
  await page.getByRole('combobox', { name: 'Default text size' }).selectOption({ label: '20 px' })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).toBeHidden()
  await expect(title).toHaveCSS('font-family', /JetBrains Mono/)
  await expect.poll(async () => (await fieldFit(title)).lines).toBeGreaterThan(3)
  expect(await fieldFit(title)).toMatchObject({ scrollsSideways: false, scrollsDown: false, inWindow: true, pageCutOff: false })
  const mono = await clickUnderlined(page, '.focus-title-field', 'displacment')
  expect(mono.laterLine).toBe(true)
  expect(mono.caret).toBeGreaterThan(mono.from)
  expect(mono.caret).toBeLessThan(mono.to)

  // On the board the card shows the whole title and caption too, and the note's controls,
  // shown on hover, never cover a word of the title.
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const card = notes(page).first()
  await expect(card.locator('.note-title')).toHaveText(LONG_TITLE)
  await expect(card.locator('figcaption')).toHaveText(LONG_CAPTION.replace('teh', 'the'))
  await card.locator('.note-title').hover()
  await expect(card.locator('.note-tools')).toBeVisible()
  const covered = await card.evaluate((element) => {
    const tools = element.querySelector('.note-tools')!.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(element.querySelector('.note-title')!)
    const words = Array.from(range.getClientRects())
    const overlaps = words.filter((r) => r.right > tools.left && r.left < tools.right && r.bottom > tools.top && r.top < tools.bottom)
    const cut = Array.from(element.querySelectorAll<HTMLElement>('.note-title, figcaption')).filter((part) => part.scrollWidth > part.clientWidth || part.scrollHeight > part.clientHeight + 1)
    return { lines: words.length, overlaps: overlaps.length, cut: cut.length, inCard: words.every((r) => r.right <= element.getBoundingClientRect().right) }
  })
  expect(covered.lines).toBeGreaterThan(1)
  expect(covered).toMatchObject({ overlaps: 0, cut: 0, inCard: true })
})

/** A real note from the user, typed after a session ("umitigated" in italics), with the chart under it. */
const REAL_ONE_BEFORE =
  'Missed dump to NWOG taking shit, got back and took 4-5 trades in the hour of 845-930. All scalps. 10 contracts a pull. Hit a few lost a few, im understanding the market a little more on the micros, its just the god candles fuck me sometimes. Also unmiitigated 5 min fvg kept edging that it was gonna go touch it but price kept moving upward tpwards nothingness, i knew price would wanna sweep and mitigate that 5 min fvg, so instead of waiting for it to do that and wait for an entry, my entry IS the way down to that 5 min fvg '
const REAL_ONE_AFTER = '. BIG HELP. Not the greatest feeling day but up 1400 pnl across 3 accounts. All evals so hopefully friday or next week can get these funded.'
const REAL_TWO =
  'Biggest headache today is missing that new week opening gap while shitting, i know my rule is not to trade first 15 min but granted the conditions of overnight dump.'
const REAL_ORGANIZED = [
  "Missed dump to NWOG taking shit, got back and took 4-5 trades in the hour of 845-930. All scalps. 10 contracts a pull. Hit a few lost a few, I'm understanding the market a little more on the micros, it's just the god candles fuck me sometimes. Also unmitigated 5 min FVG kept edging that it was gonna go touch it but price kept moving upward towards nothingness, I knew price would wanna sweep and mitigate that 5 min FVG, so instead of waiting for it to do that and wait for an entry, my entry IS the way down to that 5 min FVG unmitigated. BIG HELP. Not the greatest feeling day but up 1400 PnL across 3 accounts. All evals so hopefully Friday or next week can get these funded.",
  'Biggest headache today is missing that new week opening gap while shitting, I know my rule is not to trade first 15 min but granted the conditions of overnight dump.'
]

test('Organize on a real note: only the slips are fixed; the trader’s own words, both paragraphs, the italics and the chart stay', async () => {
  const { page, app } = ctx
  await newNote(page)
  const title = 'Wednesday 11/25 "Continuation Scalping to a planned level"'
  await page.locator('.focus-title').fill(title)
  await editorBody(page).click()
  await page.keyboard.type(REAL_ONE_BEFORE)
  await page.keyboard.press('Control+i')
  await page.keyboard.type('umitigated')
  await page.keyboard.press('Control+i')
  await page.keyboard.type(REAL_ONE_AFTER)
  await page.keyboard.press('Enter')
  await page.keyboard.type(REAL_TWO)
  await page.keyboard.press('Enter')
  await copyImageToClipboard(app, makePng(1280, 720, [30, 34, 40]))
  await page.keyboard.press('Control+v')
  await expect(page.locator('.focus-editor .image-node img')).toBeVisible()
  await expect.poll(() => underlined(page)).toEqual(['im', 'unmiitigated', 'tpwards', 'i', 'umitigated', 'friday', 'i'])

  await page.keyboard.press('Control+Shift+O')
  await expect(toast(page)).toContainText('Fixed 12 words')
  expect(await outline(page)).toEqual([...REAL_ORGANIZED, '[image]'])
  await expect(editorBody(page).locator(':scope > p').first().locator('em')).toHaveText(['unmitigated'])
  await expect(page.locator('.focus-title')).toHaveValue(title)
  await expect.poll(() => underlined(page)).toEqual([])
  // Organizing it again changes nothing.
  await page.keyboard.press('Control+Shift+O')
  await expect(toast(page)).toHaveText(/Already tidy/)
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const [note] = await storedNotes(app)
  expect(note!.plainText.split('\n').filter(Boolean)).toEqual(REAL_ORGANIZED)
  expect(JSON.stringify(note!.content)).toContain('"noteImage"')
})

test('the app makes no network requests: Chromium’s own spelling checker downloads no dictionary', async () => {
  await ctx.quit()
  removeDataDir(ctx.dataDir)
  const dataDir = freshDataDir()
  const netLog = join(dataDir, 'net-log.json')
  ctx = await launch({ dataDir, args: [`--log-net-log=${netLog}`], size: SIZE })
  errors = await collectConsoleErrors(ctx.page)
  const { page, app } = ctx
  expect(await app.evaluate(({ session }) => ({ enabled: session.defaultSession.isSpellCheckerEnabled(), languages: session.defaultSession.getSpellCheckerLanguages() }))).toEqual({
    enabled: false,
    languages: []
  })
  await newNote(page)
  await page.keyboard.type('teh displacment was clean')
  await page.keyboard.press('Control+Shift+O')
  await expect(toast(page)).toContainText('Fixed 2 words')
  await page.waitForTimeout(2000)
  await ctx.quit()
  const requests = [...new Set(readFileSync(netLog, 'utf8').match(/https?:\/\/[^"\\\s]+/g) ?? [])]
  expect(requests).toEqual([])
  const dictionaries = join(dataDir, 'Dictionaries')
  expect(existsSync(dictionaries) ? readdirSync(dictionaries) : []).toEqual([])
  ctx = await launch({ dataDir, size: SIZE })
  errors = await collectConsoleErrors(ctx.page)
})
