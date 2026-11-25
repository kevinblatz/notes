/**
 * The app's own spelling checker (wavy underlines, right-click suggestions, Add to dictionary,
 * the Spelling settings) and the Organize button (Ctrl+Shift+O): one undoable step that
 * fixes every word and the punctuation, and puts thoughts that strayed back together.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { clickEmptySpace, collectConsoleErrors, copyImageToClipboard, editorBody, focusView, makePng, noteByText, storedNotes } from './helpers'
import { launch, removeDataDir, setWindowSize, type Launched } from './launch'

const SIZE = { width: 960, height: 1000 }

const DUMP =
  'nwog at 6120 was the draw, asia made eql at 6098 and london swept them then displacment up leaving a fvg on 5m. i was bullish bias from premarket bc pdh 6135 unswept. took long at 6104 in the ifvg stop 6096 tp 6130 got stopped out first time lol felt fomo and re entered to early. second entry worked +2r. lesson dont chase the first push wait for mss. felt calm after tho. ny am killzone was clean, silver bullet 10-11 gave the move'
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
    const input = field.querySelector('input')!
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

  await app.evaluate(() => (globalThis as unknown as { __tnTest: { shortcuts: { trigger: (id: string) => boolean } } }).__tnTest.shortcuts.trigger('quickNote'))
  const strip = page.locator('.quick-note-input')
  await expect(strip).toBeFocused()
  await page.keyboard.type('fvg filled, waitng for mss ')
  await expect.poll(() => page.locator('.quick-note-field .spell-miss').allTextContents()).toEqual(['waitng'])
  await page.keyboard.press('Escape')
})

// ---------------------------------------------------------------- Organize

const ORGANIZED_DUMP = [
  'NWOG at 6120 was the draw, Asia made EQL at 6098 and London swept them then displacement up leaving a FVG on 5m. I was bullish bias from premarket because PDH 6135 unswept. NY AM killzone was clean, silver bullet 10-11 gave the move.',
  'Took long at 6104 in the IFVG stop 6096 TP 6130 got stopped out first time lol felt FOMO and re-entered too early. Second entry worked +2R.',
  "Lesson: don't chase the first push wait for MSS.",
  'Felt calm after tho.'
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
        const count = root.querySelectorAll(':scope > p').length
        const observer = new MutationObserver(() => {
          // The thoughts are regrouped into a few paragraphs.
          if (root.querySelectorAll(':scope > p').length >= count) return
          observer.disconnect()
          requestAnimationFrame(() => resolve(performance.now() - started))
        })
        observer.observe(root, { childList: true, subtree: true })
        const started = performance.now()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true }))
      })
  )
  console.log(`[organize] ${words} words: ${Math.round(ms)} ms from the key press to the organized note on screen`)
  await expect(toast(page)).toContainText(/^Organized: \d+ fixes, \d+ thoughts regrouped/)
  expect(await editorBody(page).locator(':scope > p').count()).toBeLessThan(10)
  // Threshold: well under a second on these slow test machines (a typical run is far quicker).
  expect(ms).toBeLessThan(1000)
})
