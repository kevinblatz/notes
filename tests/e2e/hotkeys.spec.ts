/**
 * The trading hotkeys: quick note, chart snapshot, risk calculator, candle timer, see-through
 * and today's log, plus their Settings rows.
 *
 * Real OS-level global hotkeys cannot be pressed under a virtual display, so these tests use
 * __tnTest.shortcuts.trigger(id), which runs exactly the function a real press runs. Real key
 * presses, the hand-back of the keyboard to Chrome and real screen capture are checked on
 * Windows by scripts/windows-native-check.ps1.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { clickEmptySpace, collectConsoleErrors, editorBody, focusView, makePaintedPng, makePng, readPng, windowCount } from './helpers'
import { launch, removeDataDir, type Launched, type LaunchOptions } from './launch'

type HotkeyId = 'toggle' | 'quickNote' | 'snapshot' | 'risk' | 'candleTimer' | 'seeThrough' | 'openLog'
interface Status { id: HotkeyId; accelerator: string; enabled: boolean; registered: boolean; error: string | null }
interface Box { x: number; y: number; width: number; height: number }
interface Size { width: number; height: number }
interface CropReport {
  method: 'page' | 'none'
  reason: string | null
  rect: Box | null
  picture: Size
  requested: Size | null
  pictured: Box | null
  frame: Box | null
  gdiRegion: Box | null
  pages: Box[]
  dpi: number | null
}
interface StoredNote { id: string; title: string | null; plainText: string; content: { content?: Array<{ type: string; attrs?: Record<string, unknown> }> }; extra: Record<string, unknown>; revision: number }
interface Handle {
  library: {
    listLive: () => StoredNote[]
    db: { getLayout: () => { rows: Array<{ notes: string[] }> } }
    getPreferences: () => Record<string, unknown> & { windowOpacity: number; seeThroughOpacity: number; candleTimer: boolean; candleMinutes: number; hotkeys: Record<string, { accelerator: string; enabled: boolean }> }
    trashNote: (id: string) => unknown
  }
  windows: { hide: () => void; isShown: () => boolean }
  shortcuts: { trigger: (id: HotkeyId) => boolean; statuses: () => Record<HotkeyId, Status> }
  hotkeys: { record: { lastHandBack: string | null; lastCapture: { from: string; title: string | null } | null; lastCrop: CropReport | null; snapshots: number } }
  candles: { state: () => { on: boolean; minutes: number; nextCloseAt: number | null; closes: number; lastCloseAt: number | null } }
  tray: { testMenu: () => Array<{ label: string }>; testChoose: (...labels: string[]) => boolean; testTooltip: () => string } | null
  testHooks: {
    desktopSources: Array<{ id: string; name: string; display_id?: string; png: string }> | null
    captureError: string | null
    windowGeometry: Record<string, { frame: Box; gdiRegion?: Box; pages: Box[]; dpi?: number | null }> | null
    lastWindowThumbnailSize: Size | null
  }
  setNow: (ms: number) => void
}
const handle = (): Handle => (globalThis as unknown as { __tnTest: Handle }).__tnTest

const SIZE = { width: 960, height: 1000 }
const live: Launched[] = []
const dirs = new Set<string>()

async function start(options: LaunchOptions = {}): Promise<Launched> {
  const ctx = await launch({ size: SIZE, ...options })
  live.push(ctx)
  dirs.add(ctx.dataDir)
  return ctx
}

async function stop(ctx: Launched): Promise<void> {
  const index = live.indexOf(ctx)
  if (index >= 0) live.splice(index, 1)
  await ctx.quit()
}

test.afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.quit()
  for (const dir of dirs) removeDataDir(dir)
  dirs.clear()
})

/** A local time today (2026-11-25 is a Wednesday), as the app's clock will read it. */
const at = (day: number, hours: number, minutes: number, seconds: number): number => new Date(2026, 10, day, hours, minutes, seconds).getTime()

/** Set the app's clock and press a hotkey in the same moment, so the time the press carries is known. */
const pressAt = (app: ElectronApplication, id: HotkeyId, ms: number | null = null): Promise<boolean> =>
  app.evaluate(
    (_electron, input) => {
      const h = (globalThis as unknown as { __tnTest: Handle }).__tnTest
      if (input.ms !== null) h.setNow(input.ms)
      return h.shortcuts.trigger(input.id)
    },
    { id, ms }
  )
const press = (app: ElectronApplication, id: HotkeyId): Promise<boolean> => pressAt(app, id)

const sessionLogs = (app: ElectronApplication): Promise<StoredNote[]> =>
  app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.library.listLive().filter((note) => typeof note.extra.sessionLog === 'string'))
const logLines = async (app: ElectronApplication): Promise<string[]> => {
  const logs = await sessionLogs(app)
  return logs.length === 1 ? logs[0]!.plainText.split('\n').filter(Boolean) : [`${logs.length} logs`]
}
const notesWindow = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Trading Notes')!
    return { visible: win.isVisible(), focused: win.isFocused() }
  })
const handBack = (app: ElectronApplication): Promise<string | null> => app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.hotkeys.record.lastHandBack)
const statuses = (app: ElectronApplication): Promise<Record<HotkeyId, Status>> => app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.shortcuts.statuses())
const registered = (app: ElectronApplication, accelerator: string): Promise<boolean> => app.evaluate(({ globalShortcut }, value) => globalShortcut.isRegistered(value), accelerator)
const prefs = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.library.getPreferences())

/** A window standing in for Chrome with the chart: it takes the keyboard, as clicking the chart does. */
async function focusOtherApp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const notes = BrowserWindow.getAllWindows()[0]!
    const probe = { focusEvents: 0, other: null as InstanceType<typeof BrowserWindow> | null }
    ;(globalThis as Record<string, unknown>).__probe = probe
    notes.on('focus', () => probe.focusEvents++)
    const other = new BrowserWindow({ x: 0, y: 0, width: 500, height: 400, title: 'chart' })
    probe.other = other
    other.show()
    other.focus()
  })
  await expect.poll(async () => (await notesWindow(app)).focused).toBe(false)
}
const focusEvents = (app: ElectronApplication): Promise<number> => app.evaluate(() => ((globalThis as Record<string, unknown>).__probe as { focusEvents: number }).focusEvents)

const strip = (page: Page) => page.getByTestId('quick-note')
const stripInput = (page: Page) => page.getByRole('textbox', { name: 'Quick note' })

test('quick note from hidden notes: the line lands in today’s log and the notes hide again; Esc writes nothing', async () => {
  const { app, page } = await start()
  const errors = await collectConsoleErrors(page)
  await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.windows.hide())
  await expect.poll(async () => (await notesWindow(app)).visible).toBe(false)

  await pressAt(app, 'quickNote', at(25, 10, 32, 14))
  await expect(strip(page)).toBeVisible()
  expect(await notesWindow(app)).toEqual({ visible: true, focused: true })
  await expect(stripInput(page)).toBeFocused()
  await expect(strip(page)).toContainText('10:32:14')
  await page.keyboard.type('Swept the overnight low, waiting for displacement')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  await expect.poll(async () => (await notesWindow(app)).visible).toBe(false)
  expect(await handBack(app)).toBe('hide')

  const logs = await sessionLogs(app)
  expect(logs).toHaveLength(1)
  expect(logs[0]!.title).toMatch(/^Session log · /)
  expect(logs[0]!.extra).toEqual({ sessionLog: '2026-11-25' })
  expect(await logLines(app)).toEqual(['10:32:14 — Swept the overnight low, waiting for displacement'])
  // An ordinary note: at the top of the board, searchable by its text.
  await app.evaluate(() => (globalThis as unknown as { __tnTest: { windows: { show: (f: boolean) => void } } }).__tnTest.windows.show(false))
  await expect(page.locator('.board > .note').first()).toContainText('10:32:14 — Swept the overnight low')
  await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.windows.hide())

  // Esc: nothing is written and the notes hide again.
  await pressAt(app, 'quickNote', at(25, 10, 40, 0))
  await expect(strip(page)).toBeVisible()
  await page.keyboard.type('never mind')
  await page.keyboard.press('Escape')
  await expect(strip(page)).toBeHidden()
  await expect.poll(async () => (await notesWindow(app)).visible).toBe(false)
  expect(await logLines(app)).toEqual(['10:32:14 — Swept the overnight low, waiting for displacement'])
  expect(await windowCount(app)).toBe(1)
  expect(errors.filter((e) => !e.includes('Content Security Policy'))).toEqual([])
})

test('quick note while the chart has the keyboard: it is given back to the chart afterwards', async () => {
  const { app, page } = await start()
  await focusOtherApp(app)

  await pressAt(app, 'quickNote', at(25, 9, 31, 5))
  await expect(stripInput(page)).toBeFocused()
  expect(await notesWindow(app)).toEqual({ visible: true, focused: true })
  await page.keyboard.type('London high taken')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  await expect.poll(async () => (await notesWindow(app)).focused).toBe(false)
  expect((await notesWindow(app)).visible).toBe(true)
  expect(await handBack(app)).toBe('blur')
  expect(await logLines(app)).toEqual(['09:31:05 — London high taken'])

  // Esc does the same, and writes nothing.
  await app.evaluate(() => ((globalThis as Record<string, unknown>).__probe as { other: { focus: () => void } }).other.focus())
  await expect.poll(async () => (await notesWindow(app)).focused).toBe(false)
  await press(app, 'quickNote')
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('scratch that')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await notesWindow(app)).focused).toBe(false)
  expect((await notesWindow(app)).visible).toBe(true)
  expect(await logLines(app)).toEqual(['09:31:05 — London high taken'])

  // Opened while the notes had the keyboard, then the chart was clicked with the strip still
  // open: the next press finds the keyboard with the chart, so that is where it goes back.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Trading Notes')!.focus())
  await expect.poll(async () => (await notesWindow(app)).focused).toBe(true)
  await pressAt(app, 'quickNote', at(25, 9, 40, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('Asia low')
  await app.evaluate(() => ((globalThis as Record<string, unknown>).__probe as { other: { focus: () => void } }).other.focus())
  await expect.poll(async () => (await notesWindow(app)).focused).toBe(false)
  await pressAt(app, 'quickNote', at(25, 9, 41, 0))
  await expect(stripInput(page)).toBeFocused()
  await expect(stripInput(page)).toHaveValue('Asia low')
  await page.keyboard.type(' holds')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  await expect.poll(async () => (await notesWindow(app)).focused).toBe(false)
  expect(await handBack(app)).toBe('blur')
  expect(await logLines(app)).toEqual(['09:31:05 — London high taken', '09:41:00 — Asia low holds'])
  // One notes window throughout (plus the stand-in for the chart).
  expect(await windowCount(app)).toBe(2)
})

test('quick note over a note being written: the editor is untouched and the caret comes back', async () => {
  const { app, page } = await start()
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('alpha beta')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')

  await pressAt(app, 'quickNote', at(25, 14, 0, 1))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('Ctrl+Enter must not log the note underneath')
  await page.keyboard.press('Control+Enter')
  await expect(strip(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText('alpha beta')
  await expect(editorBody(page)).toBeFocused()
  expect(await handBack(app)).toBe('none')
  expect((await notesWindow(app)).focused).toBe(true)
  await page.keyboard.type('X')
  await expect(editorBody(page)).toHaveText('alpha Xbeta')
  expect(await logLines(app)).toEqual(['14:00:01 — Ctrl+Enter must not log the note underneath'])

  // The strip has the keyboard the moment it is there: keys typed as soon as it shows land in
  // it, never in the note underneath.
  await pressAt(app, 'quickNote', at(25, 14, 1, 0))
  await strip(page).waitFor()
  await page.keyboard.type('fast typist')
  await expect(stripInput(page)).toHaveValue('fast typist')
  await page.keyboard.press('Escape')
  await expect(strip(page)).toBeHidden()
  await expect(editorBody(page)).toHaveText('alpha Xbeta')
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await expect(page.locator('.board > .note')).toHaveCount(2)
})

test('two quick notes in a row, one log all day, a new log the next day and after the old one is trashed', async () => {
  const { app, page } = await start()
  await pressAt(app, 'quickNote', at(25, 10, 0, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('first')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  await pressAt(app, 'quickNote', at(25, 10, 5, 30))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('second')
  // Pressed again while the strip is open: the same strip, ready for the line, which now
  // carries the time of the latest press.
  await pressAt(app, 'quickNote', at(25, 10, 5, 45))
  await expect(strip(page)).toHaveCount(1)
  await expect(stripInput(page)).toHaveValue('second')
  await expect(strip(page)).toContainText('10:05:45')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  expect(await logLines(app)).toEqual(['10:00:00 — first', '10:05:45 — second'])
  const today = (await sessionLogs(app))[0]!
  // At the top of the board.
  expect((await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.library.db.getLayout().rows[0]!.notes))).toEqual([today.id])

  // The next day: a new log, on top.
  await pressAt(app, 'quickNote', at(26, 8, 59, 59))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('new day')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  const logs = await sessionLogs(app)
  expect(logs.map((note) => note.extra.sessionLog).sort()).toEqual(['2026-11-25', '2026-11-26'])
  const tomorrow = logs.find((note) => note.extra.sessionLog === '2026-11-26')!
  expect(tomorrow.plainText).toBe('08:59:59 — new day')
  expect(await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.library.db.getLayout().rows[0]!.notes)).toEqual([tomorrow.id])
  await expect(page.locator('.board > .note').first()).toContainText('new day')

  // That day's log moved to Trash: the next line starts a new one.
  await app.evaluate((_electron, id) => (globalThis as unknown as { __tnTest: Handle }).__tnTest.library.trashNote(id), tomorrow.id)
  await pressAt(app, 'quickNote', at(26, 9, 15, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('after trash')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  const after = (await sessionLogs(app)).filter((note) => note.extra.sessionLog === '2026-11-26')
  expect(after).toHaveLength(1)
  expect(after[0]!.id).not.toBe(tomorrow.id)
  expect(after[0]!.plainText).toBe('09:15:00 — after trash')
})

test('a quick note goes in through the editor when the log itself is open, keeping what is being typed', async () => {
  const { app, page } = await start()
  await pressAt(app, 'quickNote', at(25, 11, 0, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('one')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  await pressAt(app, 'openLog', at(25, 11, 1, 0))
  await expect(focusView(page)).toBeVisible()
  await expect(page.locator('.focus-title')).toHaveValue(/^Session log · /)
  // Typing at the end of the log, not saved yet.
  await page.keyboard.press('Enter')
  await page.keyboard.type('typing here')
  await pressAt(app, 'quickNote', at(25, 11, 2, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('two')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.type('!')
  await expect(editorBody(page).locator('p')).toHaveText(['11:00:00 — one', 'typing here!', '11:02:00 — two'])
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  expect(await logLines(app)).toEqual(['11:00:00 — one', 'typing here!', '11:02:00 — two'])
})

test('opening today’s log while the strip holds text adds that text first', async () => {
  const { app, page } = await start()
  await pressAt(app, 'quickNote', at(25, 10, 30, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('not thrown away')
  await pressAt(app, 'openLog', at(25, 10, 31, 0))
  await expect(strip(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(page.locator('.focus-title')).toHaveValue(/^Session log · /)
  await expect(editorBody(page).locator('p')).toHaveText(['10:30:00 — not thrown away'])
  expect(await logLines(app)).toEqual(['10:30:00 — not thrown away'])
})

test('the strip keeps its keys over a drawing and stays in sight over the image preview', async () => {
  const { app, page } = await start()
  await clickEmptySpace(page)
  await page.keyboard.type('a note with a drawing')
  await page.getByRole('toolbar', { name: 'Formatting', exact: true }).getByRole('button', { name: 'Draw' }).click()
  const space = page.getByTestId('drawing-space')
  const eraser = page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Eraser', exact: true })
  await expect(space).toBeVisible()
  await expect(eraser).toHaveAttribute('aria-pressed', 'false')

  // The drawing's own keys (E for the eraser, 1-3 for the size, Tab kept in the sheet) are
  // not taken from the strip on top of it.
  await pressAt(app, 'quickNote', at(25, 13, 0, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('e1 entry 3 here')
  await page.keyboard.press('Tab')
  await expect(stripInput(page)).toBeFocused()
  await expect(stripInput(page)).toHaveValue('e1 entry 3 here')
  await expect(eraser).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  await expect(space).toBeVisible()
  expect(await logLines(app)).toEqual(['13:00:00 — e1 entry 3 here'])
  // The sheet has its keys back.
  await page.keyboard.press('e')
  await expect(eraser).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(space).toBeHidden()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  // The image preview covers the whole window: the strip goes over it, and Esc closes the
  // strip first, the preview after.
  await app.evaluate(
    (_electron, png) => {
      ;(globalThis as unknown as { __tnTest: Handle }).__tnTest.testHooks.desktopSources = [{ id: 'window:42:0', name: 'ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome', png }]
    },
    makePng(800, 450, [40, 160, 150]).toString('base64')
  )
  await pressAt(app, 'snapshot', at(25, 13, 5, 0))
  const card = page.locator('.board > .note').filter({ hasText: '13:00:00 — e1 entry 3 here' })
  await expect(card.locator('img')).toBeVisible()
  await card.locator('.note-image-button').first().click()
  const preview = page.getByTestId('image-preview')
  await expect(preview).toBeVisible()
  await pressAt(app, 'quickNote', at(25, 13, 6, 0))
  await expect(stripInput(page)).toBeFocused()
  const onTop = await page.evaluate(() => {
    const box = document.querySelector('.quick-note-input')!.getBoundingClientRect()
    return document.elementFromPoint(box.x + 30, box.y + box.height / 2)?.classList.contains('quick-note-input') ?? false
  })
  expect(onTop).toBe(true)
  await page.keyboard.press('Escape')
  await expect(strip(page)).toBeHidden()
  await expect(preview).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
})

test('hidden while the strip is open: the next press brings the strip back with what was typed', async () => {
  const { app, page } = await start()
  await pressAt(app, 'quickNote', at(25, 15, 0, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('half a thought')
  // The show/hide shortcut hides the notes: that typing session is over.
  await press(app, 'toggle')
  await expect.poll(async () => (await notesWindow(app)).visible).toBe(false)
  await pressAt(app, 'quickNote', at(25, 15, 1, 0))
  await expect(stripInput(page)).toBeFocused()
  await expect(stripInput(page)).toHaveValue('half a thought')
  await expect(strip(page)).toContainText('15:01:00')
  await page.keyboard.type(', finished')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  // The new press found the notes hidden, so they hide again.
  await expect.poll(async () => (await notesWindow(app)).visible).toBe(false)
  expect(await handBack(app)).toBe('hide')
  expect(await logLines(app)).toEqual(['15:01:00 — half a thought, finished'])
})

test('snapshot: the chart window goes into today’s log as a managed image, without taking the keyboard', async () => {
  const { app, page, dataDir } = await start()
  const chart = makePng(1600, 900, [40, 160, 150]).toString('base64')
  const other = makePng(300, 200, [200, 60, 60]).toString('base64')
  await app.evaluate(
    (_electron, input) => {
      ;(globalThis as unknown as { __tnTest: Handle }).__tnTest.testHooks.desktopSources = [
        { id: 'window:7:0', name: 'Inbox - Mail', png: input.other },
        { id: 'window:42:0', name: 'ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome', png: input.chart },
        { id: 'screen:0:0', name: 'Entire screen', display_id: '0', png: input.other }
      ]
    },
    { chart, other }
  )
  await focusOtherApp(app)
  await pressAt(app, 'snapshot', at(25, 10, 32, 14))
  await expect.poll(async () => (await sessionLogs(app)).length).toBe(1)
  await expect.poll(async () => (await sessionLogs(app))[0]!.content.content?.some((block) => block.type === 'noteImage')).toBe(true)
  const log = (await sessionLogs(app))[0]!
  const image = log.content.content!.find((block) => block.type === 'noteImage')!
  expect(image.attrs).toMatchObject({ caption: '10:32:14 · ES1! 6,123.25', naturalWidth: 1600, naturalHeight: 900 })
  // A managed attachment on disk: the original and a preview, never the picture inside the note.
  const id = String(image.attrs!.attachmentId)
  const folder = join(dataDir, 'library', 'attachments')
  expect(existsSync(join(folder, `${id}.png`))).toBe(true)
  expect(statSync(join(folder, `${id}.png`)).size).toBeGreaterThan(10_000)
  expect(JSON.stringify(log.content)).not.toMatch(/base64|data:/)
  expect(await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.hotkeys.record.lastCapture)).toEqual({ from: 'window', title: 'ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome' })
  // The keyboard stayed with the chart; the notes never came forward.
  expect(await focusEvents(app)).toBe(0)
  expect(await notesWindow(app)).toEqual({ visible: true, focused: false })
  await expect(page.locator('.toast').filter({ hasText: 'Chart snapshot added' })).toBeVisible()
  await expect(page.locator('.board > .note').first().locator('img')).toBeVisible()
  const tooltip = await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.tray?.testTooltip() ?? null)
  if (tooltip !== null) expect(tooltip).toBe('Trading Notes\nLast chart snapshot 10:32:14')

  // No TradingView window: the display under the pointer, without the notes docked on its right half.
  const display = await app.evaluate(({ screen }) => {
    const d = screen.getPrimaryDisplay()
    return { id: String(d.id), width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor), scale: d.scaleFactor }
  })
  const screenPng = makePng(display.width, display.height, [90, 90, 160]).toString('base64')
  await app.evaluate(
    (_electron, input) => {
      ;(globalThis as unknown as { __tnTest: Handle }).__tnTest.testHooks.desktopSources = [
        { id: 'window:7:0', name: 'Inbox - Mail', png: input.other },
        { id: `screen:${input.id}:0`, name: 'Entire screen', display_id: input.id, png: input.screenPng }
      ]
    },
    { other, id: display.id, screenPng }
  )
  // Docked to the right half again (the test launch gave it a size of its own).
  await page.evaluate(() => window.tn.windowAction('dock-right'))
  const dockedLeft = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Trading Notes')!.getBounds().x)
  await pressAt(app, 'snapshot', at(25, 10, 45, 0))
  await expect.poll(async () => (await sessionLogs(app))[0]!.content.content!.filter((block) => block.type === 'noteImage').length).toBe(2)
  const second = (await sessionLogs(app))[0]!.content.content!.filter((block) => block.type === 'noteImage')[1]!
  expect(dockedLeft).toBeGreaterThan(0)
  expect(second.attrs).toMatchObject({ caption: '10:45:00', naturalWidth: Math.round(dockedLeft * display.scale), naturalHeight: display.height })

  // Capture refused: said so in a toast, nothing added.
  await app.evaluate(() => {
    ;(globalThis as unknown as { __tnTest: Handle }).__tnTest.testHooks.captureError = 'Screen capture permission was denied.'
  })
  await pressAt(app, 'snapshot', at(25, 10, 50, 0))
  await expect(page.locator('.toast.is-error')).toContainText('Chart snapshot failed')
  await expect(page.locator('.toast.is-error')).toContainText('permission was denied')
  expect((await sessionLogs(app))[0]!.content.content!.filter((block) => block.type === 'noteImage')).toHaveLength(2)
  expect(await focusEvents(app)).toBe(0)
})

test('snapshot of a browser window keeps only the web page: its tabs, address bar and side panel are cut away', async () => {
  const { app, page, dataDir } = await start()
  type Rgb = [number, number, number]
  const BAR: Rgb = [222, 225, 230] // the browser's tab strip, address bar and bookmarks bar
  const PANEL: Rgb = [250, 200, 40] // a side panel beside the page
  const PAGE: Rgb = [19, 23, 34] // TradingView's dark background, #131722
  const BORDER: Rgb = [0, 0, 0] // the window's invisible resize borders, as a GDI capture gives them
  const TITLE = 'ES1! 6,123.25 ▲ +0.35% Unnamed - Google Chrome'
  // A restored Chrome window, as Windows reports it in physical pixels: its rectangle at 93,50
  // 1014x807 includes invisible resize borders of 7 px on the left, right and bottom; the
  // visible frame is at 100,50 1000x800. Chrome's bars take its top 90 rows, a side panel 240
  // wide sits on the right, and the page fills the rest; both are page windows.
  const frame = { x: 100, y: 50, width: 1000, height: 800 }
  const pages = [{ x: 100, y: 140, width: 760, height: 710 }, { x: 860, y: 140, width: 240, height: 710 }]
  // Electron's window capture (webrtc's GDI capturer) pictures the window less 4 px on the left,
  // right and bottom and 1 px at the top (GetSystemMetrics at 96 DPI): some border is in it.
  const gdiRegion = { x: 97, y: 51, width: 1006, height: 802 }
  /** What is on screen at a physical pixel. */
  const screenAt = (sx: number, sy: number): Rgb =>
    sx < frame.x || sx >= frame.x + frame.width || sy >= frame.y + frame.height ? BORDER : sy < 140 ? BAR : sx >= 860 ? PANEL : PAGE
  /** A picture of `region`, scaled to `width` x `height`. */
  const pictureOf = (region: Box, width: number, height: number): string =>
    makePaintedPng(width, height, (x, y) => screenAt(region.x + Math.floor((x * region.width) / width), region.y + Math.floor((y * region.height) / height))).toString('base64')
  const setWindow = (png: string, geometry: { frame: Box; gdiRegion?: Box; pages: Box[]; dpi?: number } | null): Promise<void> =>
    app.evaluate(
      (_electron, input) => {
        const hooks = (globalThis as unknown as { __tnTest: Handle }).__tnTest.testHooks
        hooks.desktopSources = [
          { id: 'window:7:0', name: 'Inbox - Mail', png: input.png },
          { id: 'window:42:0', name: input.title, png: input.png }
        ]
        hooks.windowGeometry = input.geometry ? { 'window:42:0': input.geometry } : null
        hooks.lastWindowThumbnailSize = null
      },
      { png, title: TITLE, geometry }
    )
  const logImages = async () => (await sessionLogs(app))[0]?.content.content?.filter((block) => block.type === 'noteImage') ?? []
  const stored = (image: { attrs?: Record<string, unknown> }) => readPng(readFileSync(join(dataDir, 'library', 'attachments', `${String(image.attrs!.attachmentId)}.png`)))
  const record = (): Promise<{ crop: CropReport | null; asked: Size | null }> =>
    app.evaluate(() => {
      const t = (globalThis as unknown as { __tnTest: Handle }).__tnTest
      return { crop: t.hotkeys.record.lastCrop, asked: t.testHooks.lastWindowThumbnailSize }
    })
  /** Every pixel along the four edges, and every tenth one inside, has this colour. */
  const allOf = (picture: ReturnType<typeof readPng>, colour: Rgb): string[] => {
    const wrong: string[] = []
    const look = (x: number, y: number): void => {
      const seen = picture.rgbAt(x, y)
      if (seen.some((value, i) => value !== colour[i])) wrong.push(`${x},${y}: ${seen.join(',')}`)
    }
    for (let x = 0; x < picture.width; x++) [0, picture.height - 1].forEach((y) => look(x, y))
    for (let y = 0; y < picture.height; y++) [0, picture.width - 1].forEach((x) => look(x, y))
    for (let y = 5; y < picture.height; y += 10) for (let x = 5; x < picture.width; x += 10) look(x, y)
    return wrong.slice(0, 5)
  }
  const snapshot = async (minute: number): Promise<{ attrs?: Record<string, unknown> }> => {
    const before = (await logImages()).length
    await pressAt(app, 'snapshot', at(25, 11, minute, 0))
    await expect.poll(async () => (await logImages()).length).toBe(before + 1)
    return (await logImages())[before]!
  }

  // 1. As Electron really pictures the window: the GDI region, asked for at its own size. The
  // page is placed in that region, so neither the border nor any row of Chrome's bars is kept.
  await setWindow(pictureOf(gdiRegion, 1006, 802), { frame, gdiRegion, pages, dpi: 96 })
  await focusOtherApp(app)
  const first = await snapshot(0)
  expect(first.attrs).toMatchObject({ caption: '11:00:00 · ES1! 6,123.25', naturalWidth: 760, naturalHeight: 710 })
  const kept = stored(first)
  expect({ width: kept.width, height: kept.height }).toEqual({ width: 760, height: 710 })
  // Its top row is the page, not the browser's bar; nothing of the side panel or the border either.
  expect(kept.rgbAt(0, 0)).toEqual(PAGE)
  expect(kept.rgbAt(759, 0)).toEqual(PAGE)
  expect(allOf(kept, PAGE)).toEqual([])
  expect(await record()).toEqual({
    asked: { width: 1006, height: 802 },
    crop: { method: 'page', reason: null, rect: { x: 3, y: 89, width: 760, height: 710 }, picture: { width: 1006, height: 802 }, requested: { width: 1006, height: 802 }, pictured: gdiRegion, frame, gdiRegion, pages, dpi: 96 }
  })
  expect(await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.hotkeys.record.lastCapture)).toEqual({ from: 'window', title: TITLE })
  // The keyboard stayed with the chart.
  expect(await focusEvents(app)).toBe(0)
  expect(await notesWindow(app)).toEqual({ visible: true, focused: false })

  // 2. Windows 11 falls back to Windows Graphics Capture, which pictures the visible frame,
  // scaled to fit the size asked for (1003x802): told apart by its size and cut to the page.
  await setWindow(pictureOf(frame, 1003, 802), { frame, gdiRegion, pages, dpi: 96 })
  const fallback = stored(await snapshot(1))
  expect({ width: fallback.width, height: fallback.height }).toEqual({ width: 760, height: 709 })
  expect(allOf(fallback, PAGE)).toEqual([])
  expect((await record()).crop).toMatchObject({ method: 'page', pictured: frame })

  // 3. Only the visible frame known, pictured at its size: cut the same way.
  await setWindow(pictureOf(frame, 1000, 800), { frame, pages })
  const frameOnly = stored(await snapshot(2))
  expect({ width: frameOnly.width, height: frameOnly.height }).toEqual({ width: 760, height: 710 })
  expect(allOf(frameOnly, PAGE)).toEqual([])
  expect(await record()).toMatchObject({ asked: { width: 1000, height: 800 }, crop: { method: 'page', rect: { x: 0, y: 90, width: 760, height: 710 } } })

  // 4. A picture of neither part of the window (not the size asked for): kept whole, not guessed at.
  await setWindow(pictureOf(gdiRegion, 503, 401), { frame, gdiRegion, pages, dpi: 96 })
  const odd = stored(await snapshot(3))
  expect({ width: odd.width, height: odd.height }).toEqual({ width: 503, height: 401 })
  expect((await record()).crop).toMatchObject({ method: 'none', reason: 'the picture is not of the browser window as Windows reports it', rect: null })

  // 5. Nothing said about the window: the whole window is kept, as before.
  await setWindow(pictureOf(gdiRegion, 1006, 802), null)
  const third = await snapshot(4)
  expect(third.attrs).toMatchObject({ caption: '11:04:00 · ES1! 6,123.25', naturalWidth: 1006, naturalHeight: 802 })
  const whole = stored(third)
  expect({ width: whole.width, height: whole.height }).toEqual({ width: 1006, height: 802 })
  expect(whole.rgbAt(3, 0)).toEqual(BAR)
  expect(whole.rgbAt(1001, 700)).toEqual(PANEL)
  expect(whole.rgbAt(0, 0)).toEqual(BORDER)
  expect((await record()).crop).toMatchObject({ method: 'none', reason: 'no window geometry was given for this stand-in window', rect: null, picture: { width: 1006, height: 802 } })
  expect(await focusEvents(app)).toBe(0)
  expect(await notesWindow(app)).toEqual({ visible: true, focused: false })
  await expect(page.locator('.toast').filter({ hasText: 'Chart snapshot added' }).first()).toBeVisible()
})

test('risk calculator: contracts from a dollar risk and a stop, in points, ticks or prices; Enter copies the count', async () => {
  const { app, page } = await start()
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
  await press(app, 'risk')
  const panel = page.getByTestId('risk-panel')
  await expect(panel).toBeVisible()
  const contracts = panel.getByTestId('risk-contracts')
  const risk = panel.getByTestId('risk-dollars')
  const stopField = panel.getByTestId('risk-stop')
  await expect(risk).toBeFocused()
  await page.keyboard.type('250')
  await page.keyboard.press('Tab')
  await expect(stopField).toBeFocused()
  await page.keyboard.type('4.5')
  // MES: 18 ticks x $1.25 = $22.50 a contract; floor(250 / 22.50) = 11.
  await expect(contracts).toHaveText('11 contracts')
  await expect(panel.getByTestId('risk-actual')).toHaveText('$247.50 at risk')
  await expect(panel.getByTestId('risk-per-contract')).toHaveText('$22.50 per contract')

  // ES: 18 ticks x $12.50 = $225 a contract.
  await panel.getByRole('radio', { name: 'ES', exact: true }).click()
  await expect(contracts).toHaveText('1 contract')
  await expect(panel.getByTestId('risk-actual')).toHaveText('$225 at risk')
  // Too wide: 6 points on ES is $300 a contract.
  await stopField.fill('6')
  await expect(contracts).toHaveText('0 contracts')
  await expect(panel.getByTestId('risk-result')).toContainText('Stop too wide for this risk')
  await expect(panel.getByTestId('risk-per-contract')).toHaveText('One contract risks $300.')
  // Enter copies nothing when nothing fits.
  await stopField.press('Enter')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Nothing to copy')

  // MNQ, 12.25 points = 49 ticks x $0.50 = $24.50; floor(250 / 24.50) = 10.
  await panel.getByRole('radio', { name: 'MNQ' }).click()
  await stopField.fill('12.25')
  await expect(contracts).toHaveText('10 contracts')
  await expect(panel.getByTestId('risk-actual')).toHaveText('$245 at risk')
  // NQ: 49 ticks x $5 = $245, one contract.
  await panel.getByRole('radio', { name: 'NQ', exact: true }).click()
  await expect(contracts).toHaveText('1 contract')
  // A distance between ticks is rounded up to the next whole tick (never more contracts).
  await panel.getByRole('radio', { name: 'MES' }).click()
  await stopField.fill('3.1')
  await expect(panel.getByTestId('risk-result')).toContainText('rounded up to whole ticks: 3.25 pts (13 ticks)')
  await expect(contracts).toHaveText('15 contracts')

  // Ticks: the field converts, and 10 ticks on MES are $12.50 a contract: 20 contracts.
  await stopField.fill('4.5')
  await panel.getByRole('radio', { name: 'ticks' }).click()
  await expect(stopField).toHaveValue('18')
  await stopField.fill('10')
  await expect(contracts).toHaveText('20 contracts')
  await expect(panel.getByTestId('risk-actual')).toHaveText('$250 at risk')

  // Entry and stop prices fill the distance: 3.5 points = 14 ticks; floor(250 / 17.50) = 14.
  await panel.getByTestId('risk-entry').fill('6123.25')
  await panel.getByTestId('risk-stop-price').fill('6,119.75')
  await expect(stopField).toHaveValue('14')
  await expect(contracts).toHaveText('14 contracts')
  await expect(panel.getByTestId('risk-actual')).toHaveText('$245 at risk')

  await page.keyboard.press('Enter')
  await expect(panel).toBeHidden()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('14')
  await expect(page.locator('.toast').filter({ hasText: '14 contracts copied' })).toBeVisible()
  expect(await handBack(app)).toBe('none')

  // Remembered: the instrument, the dollar risk and the unit; the stop starts empty.
  await expect.poll(async () => { const p = await prefs(app); return [p.riskInstrument, p.riskCents, p.riskUnit] }).toEqual(['MES', 25000, 'ticks'])
  await press(app, 'risk')
  await expect(panel).toBeVisible()
  await expect(risk).toHaveValue('250')
  await expect(stopField).toHaveValue('')
  await expect(stopField).toBeFocused()
  await expect(panel.getByRole('radio', { name: 'ticks' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('14')
})

test('risk calculator from the chart: Enter copies and the keyboard goes back to the chart', async () => {
  const { app, page } = await start()
  await focusOtherApp(app)
  await press(app, 'risk')
  const panel = page.getByTestId('risk-panel')
  await expect(panel.getByTestId('risk-dollars')).toBeFocused()
  await page.keyboard.type('100')
  await page.keyboard.press('Tab')
  await page.keyboard.type('2')
  await expect(panel.getByTestId('risk-contracts')).toHaveText('10 contracts')
  await page.keyboard.press('Enter')
  await expect(panel).toBeHidden()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('10')
  await expect.poll(async () => (await notesWindow(app)).focused).toBe(false)
  expect(await handBack(app)).toBe('blur')
})

test('risk calculator: Tab stays in the panel, edge amounts, and Settings never undoes what it remembered', async () => {
  const { app, page } = await start()
  await clickEmptySpace(page)
  await page.keyboard.type('note underneath')
  await press(app, 'risk')
  const panel = page.getByTestId('risk-panel')
  await expect(panel.getByTestId('risk-dollars')).toBeFocused()
  // Round and round the panel's own fields, both ways: never into the note underneath.
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="risk-panel"]') != null), `Tab ${i + 1}`).toBe(true)
  }
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="risk-panel"]') != null), `Shift+Tab ${i + 1}`).toBe(true)
  }
  await expect(editorBody(page)).toHaveText('note underneath')

  const contracts = panel.getByTestId('risk-contracts')
  const risk = panel.getByTestId('risk-dollars')
  const stopField = panel.getByTestId('risk-stop')
  for (const bad of ['-5', '0', '1e3', 'abc', '0.001']) {
    await risk.fill(bad)
    await stopField.fill('4')
    await expect(contracts, bad).toHaveText('–')
    await expect(panel.getByTestId('risk-result'), bad).toContainText('Enter the dollars you are willing to lose')
  }
  // A stop under one tick counts as one tick (and says "1 tick").
  await risk.fill('0.01')
  await stopField.fill('0.0001')
  await expect(contracts).toHaveText('0 contracts')
  await expect(panel.getByTestId('risk-result')).toContainText('0.25 pts (1 tick)')
  // A huge risk on the smallest stop: millions of contracts, shown grouped and copied whole.
  await risk.fill('5,000,000')
  await stopField.fill('0.25')
  await expect(contracts).toHaveText('4,000,000 contracts')
  await stopField.press('Enter')
  await expect(panel).toBeHidden()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('4000000')
  await expect(page.locator('.toast').filter({ hasText: '4,000,000 contracts copied' })).toBeVisible()
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  // Settings shows the remembered risk, follows the calculator while it is open, and does not
  // write its own older value back when the field loses the keyboard.
  await openHotkeySettings(page)
  const field = page.getByTestId('settings-risk')
  await expect(field).toHaveValue('5000000')
  await field.fill('250')
  await field.press('Enter')
  await expect.poll(async () => (await prefs(app)).riskCents).toBe(25000)
  await field.focus()
  await press(app, 'risk')
  await expect(risk).toHaveValue('250')
  await risk.fill('300')
  await stopField.fill('2')
  await expect(contracts).toHaveText('30 contracts')
  await page.keyboard.press('Enter')
  await expect(panel).toBeHidden()
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('300')
  await page.getByTestId('settings').getByRole('heading', { name: 'Hotkeys' }).click()
  await expect(field).not.toBeFocused()
  await expect.poll(async () => (await prefs(app)).riskCents).toBe(30000)
})

test('candle timer: the chip counts down to the close, and the main process announces each close', async () => {
  const { app, page } = await start()
  const chip = page.getByTestId('candle-chip')
  await expect(chip).toHaveCount(0)
  expect((await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.candles.state())).nextCloseAt).toBeNull()

  // Three seconds before a 5-minute close.
  await pressAt(app, 'candleTimer', at(25, 10, 4, 57))
  await expect(chip).toBeVisible()
  await expect(page.getByTestId('candle-frame')).toHaveText('5m')
  await expect(page.getByTestId('candle-time')).toHaveText(/^0:0[1-3]$/)
  await expect(chip).toHaveAttribute('data-urgent', 'true')
  const state = await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.candles.state())
  expect(state).toMatchObject({ on: true, minutes: 5, nextCloseAt: at(25, 10, 5, 0), closes: 0 })
  expect((await prefs(app)).candleTimer).toBe(true)

  // The close: announced by the main process, received by the window.
  await expect.poll(async () => (await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.candles.state())).closes, { timeout: 8000 }).toBe(1)
  expect((await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.candles.state())).lastCloseAt).toBe(at(25, 10, 5, 0))
  await expect(chip).toHaveAttribute('data-closes', '1')
  await expect(page.getByTestId('candle-time')).toHaveText(/^4:5\d$/)
  await expect(chip).toHaveAttribute('data-urgent', 'false')
  // It counts.
  const first = await page.getByTestId('candle-time').textContent()
  await expect(page.getByTestId('candle-time')).not.toHaveText(first!, { timeout: 3000 })

  // The timeframe is chosen on the chip and remembered; 60 minutes is "1h", on the local hour.
  await chip.click()
  await page.getByRole('menuitemcheckbox', { name: '1 hour' }).click()
  await expect(page.getByTestId('candle-frame')).toHaveText('1h')
  await expect.poll(async () => (await prefs(app)).candleMinutes).toBe(60)
  await expect.poll(async () => (await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.candles.state())).nextCloseAt).toBe(at(25, 11, 0, 0))
  await expect(page.getByTestId('candle-time')).toHaveText(/^5[45]:\d\d$/)

  // The hotkey again: gone, and nothing scheduled.
  await press(app, 'candleTimer')
  await expect(chip).toHaveCount(0)
  expect(await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.candles.state())).toMatchObject({ on: false, nextCloseAt: null })
  expect(await windowCount(app)).toBe(1)
})

test('see-through hotkey: solid and the see-through value last chosen, without taking the keyboard', async () => {
  const { app, page } = await start()
  await focusOtherApp(app)
  expect((await prefs(app)).windowOpacity).toBe(1)
  await press(app, 'seeThrough')
  await expect.poll(async () => (await prefs(app)).windowOpacity).toBe(0.7)
  await expect(page.getByTestId('opacity-button')).toHaveAccessibleName('Window opacity 70%')
  await press(app, 'seeThrough')
  await expect.poll(async () => (await prefs(app)).windowOpacity).toBe(1)
  // A value chosen elsewhere is the one it goes back to.
  await page.evaluate(() => window.tn.setPreferences({ windowOpacity: 0.5 }))
  await page.evaluate(() => window.tn.setPreferences({ windowOpacity: 1 }))
  await press(app, 'seeThrough')
  await expect.poll(async () => (await prefs(app)).windowOpacity).toBe(0.5)
  await press(app, 'seeThrough')
  await expect.poll(async () => (await prefs(app)).windowOpacity).toBe(1)
  expect(await focusEvents(app)).toBe(0)
  expect(await notesWindow(app)).toEqual({ visible: true, focused: false })
})

test('open today’s log: the notes take the keyboard with the caret at the end of the log', async () => {
  const { app, page } = await start()
  await pressAt(app, 'quickNote', at(25, 12, 0, 0))
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.type('noon')
  await page.keyboard.press('Enter')
  await expect(strip(page)).toBeHidden()
  // A note being written is saved and left first.
  await clickEmptySpace(page)
  await page.keyboard.type('half-written thought')
  await focusOtherApp(app)
  await pressAt(app, 'openLog', at(25, 12, 5, 0))
  await expect(page.locator('.focus-title')).toHaveValue(/^Session log · /)
  expect(await notesWindow(app)).toEqual({ visible: true, focused: true })
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.type(' and after')
  await expect(editorBody(page)).toHaveText('12:00:00 — noon and after')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  expect(await logLines(app)).toEqual(['12:00:00 — noon and after'])
  expect(await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.library.listLive().map((note) => note.plainText))).toContain('half-written thought')

  // On a day without a log yet, it is created.
  await pressAt(app, 'openLog', at(27, 7, 0, 0))
  await expect(page.locator('.focus-title')).toHaveValue(/^Session log · /)
  await page.keyboard.type('plan')
  await page.keyboard.press('Control+Enter')
  await expect.poll(async () => (await sessionLogs(app)).map((note) => note.extra.sessionLog).sort()).toEqual(['2026-11-25', '2026-11-27'])
})

test('the tray menu offers Quick note and Snapshot chart', async () => {
  const { app, page } = await start()
  const hasTray = await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.tray !== null)
  test.skip(!hasTray, 'This desktop has no notification area.')
  const labels = await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.tray!.testMenu().map((entry) => entry.label))
  expect(labels).toEqual(expect.arrayContaining(['Quick note', 'Snapshot chart']))
  expect(await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.tray!.testChoose('Quick note'))).toBe(true)
  await expect(stripInput(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(strip(page)).toBeHidden()
})

async function openHotkeySettings(page: Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await expect(page.getByTestId('settings')).toBeVisible()
  await page.getByRole('heading', { name: 'Hotkeys' }).scrollIntoViewIfNeeded()
}

test('Settings: every hotkey can be rebound; a taken combination is reported and the working one kept', async () => {
  let ctx = await start({ env: { TRADING_NOTES_TEST_BLOCKED_SHORTCUTS: 'Control+Alt+M' } })
  const { app, page } = ctx
  await openHotkeySettings(page)
  const settings = page.getByTestId('settings')
  for (const name of ['Show or hide notes', 'Quick note', 'Snapshot chart', 'Risk calculator', 'Candle timer', 'See-through', 'Open today’s log']) {
    await expect(settings.getByRole('switch', { name: `${name} hotkey` })).toHaveAttribute('aria-checked', 'true')
  }
  const quickRow = page.getByTestId('hotkey-row-quickNote')
  const quickButton = page.getByTestId('hotkey-button-quickNote')
  await expect(quickButton).toHaveText('Ctrl + Alt + N')

  // Owned by another app: reported, and the working combination stays.
  await quickButton.click()
  await expect(quickButton).toHaveText('Press keys…')
  await page.keyboard.press('Control+Alt+M')
  await expect(quickRow.getByText(/already in use by another app/)).toBeVisible()
  await expect(quickButton).toHaveText('Ctrl + Alt + N')
  expect((await statuses(app)).quickNote).toMatchObject({ accelerator: 'Control+Alt+N', registered: true })
  expect(await registered(app, 'Control+Alt+N')).toBe(true)

  // A free combination: registered, the old one released, stored.
  await quickButton.click()
  await page.keyboard.press('Control+Alt+Q')
  await expect(quickButton).toHaveText('Ctrl + Alt + Q')
  await expect(quickRow).toContainText('now opens a quick note')
  expect(await registered(app, 'Control+Alt+Q')).toBe(true)
  expect(await registered(app, 'Control+Alt+N')).toBe(false)
  expect((await prefs(app)).hotkeys.quickNote).toEqual({ accelerator: 'Control+Alt+Q', enabled: true })

  // Taken from another of the app's own hotkeys: that one is switched off and says so.
  const snapButton = page.getByTestId('hotkey-button-snapshot')
  await snapButton.click()
  await page.keyboard.press('Control+Alt+Q')
  await expect(snapButton).toHaveText('Ctrl + Alt + Q')
  await expect(page.getByTestId('hotkey-row-snapshot')).toContainText('It was set for Quick note, which is now off.')
  await expect(settings.getByRole('switch', { name: 'Quick note hotkey' })).toHaveAttribute('aria-checked', 'false')
  expect((await statuses(app)).quickNote).toMatchObject({ enabled: false, registered: false })
  expect((await statuses(app)).snapshot).toMatchObject({ accelerator: 'Control+Alt+Q', enabled: true, registered: true })
  expect(await registered(app, 'Control+Alt+S')).toBe(false)
  // Switching it back on while Snapshot holds the combination is refused, and it stays off.
  await settings.getByRole('switch', { name: 'Quick note hotkey' }).click()
  await expect(quickRow.getByText(/already set for Snapshot chart/)).toBeVisible()
  await expect(settings.getByRole('switch', { name: 'Quick note hotkey' })).toHaveAttribute('aria-checked', 'false')

  // While recording, every hotkey is released, so pressing one is captured instead of acting.
  await page.getByTestId('hotkey-button-risk').click()
  await expect.poll(() => registered(app, 'Control+Shift+Space')).toBe(false)
  expect(await registered(app, 'Control+Alt+Q')).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('hotkey-button-risk')).toHaveText('Ctrl + Alt + R')
  await expect(page.getByTestId('settings')).toBeVisible()
  await expect.poll(() => registered(app, 'Control+Shift+Space')).toBe(true)
  expect(await registered(app, 'Control+Alt+Q')).toBe(true)
  expect(await registered(app, 'Control+Alt+R')).toBe(true)

  // However the recording ends, the hotkeys come back: moving to another row, Settings closed
  // with its button while still listening, or the notes hidden while listening.
  await page.getByTestId('hotkey-button-risk').click()
  await expect.poll(() => registered(app, 'Control+Shift+Space')).toBe(false)
  await page.getByTestId('hotkey-button-openLog').click()
  await expect(page.getByTestId('hotkey-button-openLog')).toHaveText('Press keys…')
  await expect(page.getByTestId('hotkey-button-risk')).toHaveText('Ctrl + Alt + R')
  await page.waitForTimeout(200)
  expect(await registered(app, 'Control+Shift+Space')).toBe(false)
  await settings.getByRole('button', { name: 'Close' }).click()
  await expect(settings).toBeHidden()
  await expect.poll(() => registered(app, 'Control+Shift+Space')).toBe(true)
  expect(await registered(app, 'Control+Alt+L')).toBe(true)
  await openHotkeySettings(page)
  await page.getByTestId('hotkey-button-risk').click()
  await expect.poll(() => registered(app, 'Control+Shift+Space')).toBe(false)
  await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.windows.hide())
  await expect.poll(() => registered(app, 'Control+Shift+Space')).toBe(true)
  expect(await registered(app, 'Control+Alt+R')).toBe(true)
  await stop(ctx)

  // All of it survives a restart.
  ctx = await start({ dataDir: ctx.dataDir })
  expect(await statuses(ctx.app)).toMatchObject({
    quickNote: { accelerator: 'Control+Alt+Q', enabled: false, registered: false },
    snapshot: { accelerator: 'Control+Alt+Q', enabled: true, registered: true },
    risk: { accelerator: 'Control+Alt+R', enabled: true, registered: true }
  })
})

test('every hotkey switched off is released, and nothing runs at rest with the timer off', async () => {
  const { app, page } = await start()
  await openHotkeySettings(page)
  const settings = page.getByTestId('settings')
  const names = ['Show or hide notes', 'Quick note', 'Snapshot chart', 'Risk calculator', 'Candle timer', 'See-through', 'Open today’s log']
  for (const name of names) {
    const toggle = settings.getByRole('switch', { name: `${name} hotkey` })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  }
  for (const accelerator of ['Control+Shift+Space', 'Control+Alt+N', 'Control+Alt+S', 'Control+Alt+R', 'Control+Alt+T', 'Control+Alt+O', 'Control+Alt+L']) {
    expect(await registered(app, accelerator), accelerator).toBe(false)
  }
  expect(Object.values(await statuses(app)).every((status) => !status.enabled && !status.registered && status.error === null)).toBe(true)
  // Switched off on purpose is not a problem to report.
  await expect(page.getByTestId('shortcut-banner')).toHaveCount(0)
  expect((await prefs(app)).shortcutEnabled).toBe(false)
  // One back on.
  await settings.getByRole('switch', { name: 'Quick note hotkey' }).click()
  await expect.poll(() => registered(app, 'Control+Alt+N')).toBe(true)

  // At rest, with the candle timer off: no timers in either process, no frames.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).toBeHidden()
  await page.waitForTimeout(1500)
  const mainTimers = await app.evaluate(async () => {
    const g = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>
    const original = g.setTimeout!
    let count = 0
    g.setTimeout = (...args: unknown[]) => {
      count++
      return original(...args)
    }
    await new Promise((resolve) => original(resolve, 2000))
    g.setTimeout = original
    return count
  })
  const pageWork = await page.evaluate(async () => {
    const w = window as unknown as Record<string, (...args: unknown[]) => unknown>
    const counts = { setTimeout: 0, setInterval: 0, requestAnimationFrame: 0 }
    const originals = { setTimeout: w.setTimeout!, setInterval: w.setInterval!, requestAnimationFrame: w.requestAnimationFrame! }
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      w[key] = (...args: unknown[]) => {
        counts[key]++
        return originals[key].apply(window, args)
      }
    }
    await new Promise((resolve) => originals.setTimeout.call(window, resolve, 2000))
    Object.assign(w, originals)
    return { ...counts, animations: document.getAnimations().filter((a) => a.playState === 'running').length }
  })
  expect(mainTimers, 'main-process timers at rest').toBe(0)
  expect(pageWork).toEqual({ setTimeout: 0, setInterval: 0, requestAnimationFrame: 0, animations: 0 })
})
