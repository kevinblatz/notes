/**
 * Window behaviour (requirements section 2, acceptance checks 2, 4 and 12): docking, always on
 * top, show/hide through the tray/shortcut code path, drafts surviving hide / focus loss / quit /
 * crash, failed saves, shortcut conflicts, display recovery and single instance.
 *
 * Real OS focus, tray clicks and z-order are verified on Windows by scripts/windows-native-check.ps1.
 */
import { spawn } from 'node:child_process'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { clickEmptySpace, editorBody, focusView, storedNotes, windowCount, type TestHandle } from './helpers'
import { freshDataDir, launch, removeDataDir, ROOT, type Launched, type LaunchOptions } from './launch'

interface Rect { x: number; y: number; width: number; height: number }

const live: Launched[] = []
const dirs = new Set<string>()

async function start(options: LaunchOptions = {}): Promise<Launched> {
  const ctx = await launch(options)
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


const bounds = (app: ElectronApplication): Promise<Rect> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
const workArea = (app: ElectronApplication): Promise<Rect> => app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
const isVisible = (app: ElectronApplication): Promise<boolean> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())
const onTop = (app: ElectronApplication): Promise<boolean> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isAlwaysOnTop())
const toggle = (app: ElectronApplication): Promise<void> => app.evaluate(() => (globalThis as unknown as { __tnTest: TestHandle }).__tnTest.windows.toggle())
const dockState = (app: ElectronApplication): Promise<string> =>
  app.evaluate(() => ((globalThis as unknown as { __tnTest: TestHandle }).__tnTest.windows.status() as { dock: string }).dock)
const shortcutStatus = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __tnTest: TestHandle }).__tnTest.shortcuts.status())
const setFailSaves = (app: ElectronApplication, flag: boolean): Promise<void> =>
  app.evaluate((_electron, value) => {
    ;(globalThis as unknown as { __tnTest: TestHandle }).__tnTest.testHooks.failSaves = value
  }, flag)

const leftHalf = (area: Rect): Rect => ({ x: area.x, y: area.y, width: Math.floor(area.width / 2), height: area.height })
const rightHalf = (area: Rect): Rect => {
  const left = Math.floor(area.width / 2)
  return { x: area.x + left, y: area.y, width: area.width - left, height: area.height }
}

/** Move the window as a person dragging it would (not through the app's own docking). */
async function moveByHand(app: ElectronApplication, rect: Rect): Promise<void> {
  // Well clear of the app's own placement at launch or docking, as a person would be.
  await new Promise((resolve) => setTimeout(resolve, 900))
  await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0]!.setBounds(target), rect)
  await expect.poll(() => dockState(app)).toBe('custom')
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('gear').click()
  await page.getByRole('menu').getByText('Settings', { exact: true }).click()
  await expect(page.getByTestId('settings')).toBeVisible()
}

async function openDraft(page: Page, text: string): Promise<void> {
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type(text)
}

const savedStatus = (page: Page) => page.locator('.save-status[data-state="saved"]')

test('first launch: one always-on-top window on the right half of the work area', async () => {
  const { app } = await start()
  expect(await windowCount(app)).toBe(1)
  const area = await workArea(app)
  expect(await bounds(app)).toEqual(rightHalf(area))
  expect(await isVisible(app)).toBe(true)
  expect(await onTop(app)).toBe(true)
  const info = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    return { resizable: win.isResizable(), min: win.getMinimumSize(), fullscreen: win.isFullScreen(), opacity: win.getOpacity() }
  })
  expect(info.resizable).toBe(true)
  expect(info.min).toEqual([420, 360])
  // An ordinary window: no fullscreen or transparent surface over the chart.
  expect(info.fullscreen).toBe(false)
  expect(info.opacity).toBe(1)

  // Manual resizing is allowed, but never below the minimum size.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(700, 600))
  await expect.poll(async () => (await bounds(app)).width).toBe(700)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(200, 150))
  await expect.poll(async () => (await bounds(app)).width).toBe(420)
  expect((await bounds(app)).height).toBe(360)
})

test('docking left and right through Settings; a hand-moved window snaps back', async () => {
  const { app, page } = await start()
  const area = await workArea(app)
  await openSettings(page)
  const settings = page.getByTestId('settings')
  const left = settings.getByRole('radio', { name: 'Left half' })
  const right = settings.getByRole('radio', { name: 'Right half' })
  await expect(right).toHaveAttribute('aria-checked', 'true')

  await left.click()
  await expect.poll(() => bounds(app)).toEqual(leftHalf(area))
  await expect(left).toHaveAttribute('aria-checked', 'true')
  await right.click()
  await expect.poll(() => bounds(app)).toEqual(rightHalf(area))
  await expect(right).toHaveAttribute('aria-checked', 'true')

  await moveByHand(app, { x: 200, y: 120, width: 700, height: 640 })
  await expect(settings.getByText(/moved or resized by hand/)).toBeVisible()
  await expect(left).toHaveAttribute('aria-checked', 'false')
  await expect(right).toHaveAttribute('aria-checked', 'false')
  await right.click()
  await expect.poll(() => bounds(app)).toEqual(rightHalf(area))
  await expect(settings.getByText(/moved or resized by hand/)).toBeHidden()
  await expect(right).toHaveAttribute('aria-checked', 'true')
  expect(await windowCount(app)).toBe(1)
})

test('dock side and a custom size each survive a restart', async () => {
  let ctx = await start()
  const area = await workArea(ctx.app)
  await openSettings(ctx.page)
  await ctx.page.getByTestId('settings').getByRole('radio', { name: 'Left half' }).click()
  await expect.poll(() => bounds(ctx.app)).toEqual(leftHalf(area))
  await stop(ctx)

  ctx = await start({ dataDir: ctx.dataDir })
  expect(await bounds(ctx.app)).toEqual(leftHalf(area))
  expect(await dockState(ctx.app)).toBe('left')
  const custom = { x: 300, y: 140, width: 760, height: 620 }
  await moveByHand(ctx.app, custom)
  await stop(ctx)

  ctx = await start({ dataDir: ctx.dataDir })
  expect(await bounds(ctx.app)).toEqual(custom)
  expect(await dockState(ctx.app)).toBe('custom')
})

test('a window moved just before quitting reopens where it was left', async () => {
  let ctx = await start()
  const custom = { x: 260, y: 100, width: 800, height: 700 }
  await ctx.page.waitForTimeout(900)
  await ctx.app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0]!.setBounds(target), custom)
  await stop(ctx)
  ctx = await start({ dataDir: ctx.dataDir })
  expect(await bounds(ctx.app)).toEqual(custom)
})

test('a window dragged right after docking is still recognised as moved by hand', async () => {
  const { app } = await start()
  const area = await workArea(app)
  await new Promise((resolve) => setTimeout(resolve, 900))
  await app.evaluate(() => (globalThis as unknown as { __tnTest: TestHandle }).__tnTest.windows.dockTo('left'))
  expect(await bounds(app)).toEqual(leftHalf(area))
  const custom = { x: 240, y: 110, width: 720, height: 610 }
  await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0]!.setBounds(target), custom)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(await bounds(app)).toEqual(custom)
  expect(await dockState(app)).toBe('custom')
})

test('always on top can be turned off in Settings and the choice survives a restart', async () => {
  let ctx = await start()
  await openSettings(ctx.page)
  const toggleSwitch = ctx.page.getByRole('switch', { name: 'Always on top' })
  await expect(toggleSwitch).toHaveAttribute('aria-checked', 'true')
  await toggleSwitch.click()
  await expect.poll(() => onTop(ctx.app)).toBe(false)
  await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false')
  await stop(ctx)

  ctx = await start({ dataDir: ctx.dataDir })
  expect(await onTop(ctx.app)).toBe(false)
  // Showing again must not silently restore the flag.
  await toggle(ctx.app)
  await toggle(ctx.app)
  expect(await onTop(ctx.app)).toBe(false)
  await openSettings(ctx.page)
  const again = ctx.page.getByRole('switch', { name: 'Always on top' })
  await expect(again).toHaveAttribute('aria-checked', 'false')
  await again.click()
  await expect.poll(() => onTop(ctx.app)).toBe(true)
})

test('show/hide keeps one window at the same place; close hides; the menu offers Hide and Quit', async () => {
  const ctx = await start()
  const { app, page } = ctx
  const id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)
  const before = await bounds(app)

  for (let round = 0; round < 3; round++) {
    await toggle(app)
    expect(await isVisible(app)).toBe(false)
    expect(await windowCount(app)).toBe(1)
    await toggle(app)
    expect(await isVisible(app)).toBe(true)
    expect(await windowCount(app)).toBe(1)
  }
  expect(await bounds(app)).toEqual(before)
  expect(await onTop(app)).toBe(true)

  // The close button hides to the tray instead of quitting.
  await page.getByTestId('hide-window').click()
  await expect.poll(() => isVisible(app)).toBe(false)
  expect(await windowCount(app)).toBe(1)
  await toggle(app)
  expect(await isVisible(app)).toBe(true)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.id))).toEqual([id])
  expect(await bounds(app)).toEqual(before)

  // A native close request (Alt+F4, taskbar "Close window") also only hides.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  await expect.poll(() => isVisible(app)).toBe(false)
  expect(await windowCount(app)).toBe(1)
  await toggle(app)

  await page.getByTestId('gear').click()
  const menu = page.getByRole('menu')
  await expect(menu.getByText('Quit Trading Notes')).toBeVisible()
  await menu.getByText('Hide to tray').click()
  await expect.poll(() => isVisible(app)).toBe(false)
  await toggle(app)

  // Quit is explicit and really ends the app.
  live.splice(live.indexOf(ctx), 1)
  const closed = app.waitForEvent('close')
  await page.getByTestId('gear').click()
  await page.getByRole('menu').getByText('Quit Trading Notes').click()
  await closed
})

test('a draft typed right before hiding is stored and still open after showing', async () => {
  const { app, page } = await start()
  await openDraft(page, 'Liquidity above the high')
  await toggle(app) // no wait: this is the tray click / global shortcut path
  expect(await isVisible(app)).toBe(false)
  await expect.poll(async () => (await storedNotes(app)).map((n) => n.plainText), { timeout: 4000 }).toEqual(['Liquidity above the high'])

  await toggle(app)
  expect(await isVisible(app)).toBe(true)
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText('Liquidity above the high')
  await page.keyboard.type(' gets swept')
  await expect(editorBody(page)).toHaveText('Liquidity above the high gets swept')
  await expect(savedStatus(page)).toBeVisible()
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['Liquidity above the high gets swept'])

  // Same through the close button, again without waiting.
  await page.keyboard.type(' then reverses')
  await page.getByTestId('hide-window').click()
  await expect.poll(() => isVisible(app)).toBe(false)
  await expect.poll(async () => (await storedNotes(app)).map((n) => n.plainText), { timeout: 4000 }).toEqual(['Liquidity above the high gets swept then reverses'])
  expect(await windowCount(app)).toBe(1)
})

test('a draft survives another window taking focus, and the notes window never grabs focus back', async () => {
  const { app, page } = await start()
  await openDraft(page, 'alpha beta')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
  const before = await bounds(app)

  await app.evaluate(({ BrowserWindow }) => {
    const notes = BrowserWindow.getAllWindows()[0]!
    const state = { focusEvents: 0, other: null as InstanceType<typeof BrowserWindow> | null }
    ;(globalThis as Record<string, unknown>).__focusProbe = state
    notes.on('focus', () => state.focusEvents++)
    // Stands in for the chart / Chrome being clicked.
    const other = new BrowserWindow({ x: 0, y: 0, width: 500, height: 400 })
    state.other = other
    other.show()
    other.focus()
  })
  await page.waitForTimeout(1500)
  const during = await app.evaluate(({ BrowserWindow }) => {
    const state = (globalThis as Record<string, unknown>).__focusProbe as { focusEvents: number; other: InstanceType<typeof BrowserWindow> }
    const notes = BrowserWindow.getAllWindows().find((w) => w !== state.other)!
    return { focusEvents: state.focusEvents, visible: notes.isVisible(), bounds: notes.getBounds(), onTop: notes.isAlwaysOnTop(), count: BrowserWindow.getAllWindows().length }
  })
  expect(during.focusEvents, 'notes window did not refocus itself').toBe(0)
  expect(during.visible).toBe(true)
  expect(during.bounds).toEqual(before)
  expect(during.onTop).toBe(true)
  expect(during.count).toBe(2)
  await expect(focusView(page)).toBeVisible()

  await app.evaluate(() => ((globalThis as Record<string, unknown>).__focusProbe as { other: { destroy: () => void } }).other.destroy())
  await expect.poll(() => windowCount(app)).toBe(1)
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText('alpha beta')
  await page.keyboard.type('X')
  await expect(editorBody(page)).toHaveText('alpha Xbeta')
  await expect(savedStatus(page)).toBeVisible()
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['alpha Xbeta'])
})

test('a second launch exits by itself and leaves the one existing window', async () => {
  const { app, dataDir } = await start()
  await toggle(app)
  expect(await isVisible(app)).toBe(false)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as unknown as string
  const child = spawn(electronPath, [process.env.TRADING_NOTES_E2E_ENTRY ?? ROOT, '--no-sandbox'], {
    cwd: ROOT,
    env: { ...process.env, TRADING_NOTES_TEST: '1', TRADING_NOTES_DATA_DIR: dataDir },
    stdio: 'ignore'
  })
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(false)
    }, 20_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  expect(exited, 'second instance exited on its own').toBe(true)
  expect(await windowCount(app)).toBe(1)
  // Launching again is a request for the notes: the existing window comes back.
  await expect.poll(() => isVisible(app)).toBe(true)
})

test('quitting while typing keeps the text', async () => {
  let ctx = await start({ size: { width: 960, height: 1000 } })
  await openDraft(ctx.page, 'Typed a moment before quitting')
  await stop(ctx)
  ctx = await start({ dataDir: ctx.dataDir })
  expect((await storedNotes(ctx.app)).map((n) => n.plainText)).toEqual(['Typed a moment before quitting'])
  // The draft that was open is open again, ready to continue.
  await expect(focusView(ctx.page)).toBeVisible()
  await expect(editorBody(ctx.page)).toHaveText('Typed a moment before quitting')
  // A clean quit is not reported as a crash.
  await expect(ctx.page.locator('.notice')).toHaveCount(0)
})

test('after an unclean exit the app reopens the note that was open, with a recovery notice', async () => {
  const first = await start({ size: { width: 960, height: 1000 } })
  await openDraft(first.page, 'Saved before the crash')
  await expect(savedStatus(first.page)).toBeVisible()
  live.splice(live.indexOf(first), 1)
  const closed = first.app.waitForEvent('close')
  first.app.process().kill('SIGKILL')
  await closed

  const ctx = await start({ dataDir: first.dataDir })
  await expect(focusView(ctx.page)).toBeVisible()
  await expect(editorBody(ctx.page)).toHaveText('Saved before the crash')
  await expect(ctx.page.locator('.notice')).toBeVisible()
  await expect(ctx.page.locator('.notice')).toContainText('did not close normally')
  expect(await windowCount(ctx.app)).toBe(1)
  await editorBody(ctx.page).click()
  await ctx.page.keyboard.press('Control+End')
  await ctx.page.keyboard.type(' and continued')
  await expect(editorBody(ctx.page)).toHaveText('Saved before the crash and continued')
})

test('a failed save is reported, keeps the text and the editor, and can be retried', async () => {
  const { app, page } = await start({ size: { width: 960, height: 1000 } })
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await setFailSaves(app, true)
  // Record whether "Saved" is ever shown while saving is impossible.
  await page.evaluate(() => {
    const probe = { sawSaved: false }
    ;(window as unknown as { __savedProbe: typeof probe }).__savedProbe = probe
    new MutationObserver(() => {
      if (document.querySelector('.save-status[data-state="saved"]')) probe.sawSaved = true
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  await page.keyboard.type('Must not be lost')

  const status = page.locator('.save-status.is-error')
  await expect(status).toBeVisible()
  await expect(status).toContainText('Not saved')
  await expect(status.locator('.save-error-text')).toHaveText(/\S{3,}/)
  const retry = status.getByRole('button', { name: 'Try again' })
  await expect(retry).toBeVisible()

  await page.keyboard.press('Control+Enter')
  await expect(page.getByText(/could not be saved yet/)).toBeVisible()
  await expect(focusView(page)).toBeVisible()
  await page.getByRole('button', { name: /Log note/ }).click()
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText('Must not be lost')
  await expect(status).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __savedProbe: { sawSaved: boolean } }).__savedProbe.sawSaved)).toBe(false)
  expect(await storedNotes(app)).toEqual([])

  await setFailSaves(app, false)
  await retry.click()
  await expect(savedStatus(page)).toBeVisible()
  await expect(status).toHaveCount(0)
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['Must not be lost'])
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await expect(page.locator('.board > .note')).toHaveCount(1)
})

test('an unavailable shortcut is reported and can be rebound; the new one survives a restart', async () => {
  let ctx = await start({ size: { width: 960, height: 1000 }, env: { TRADING_NOTES_TEST_BLOCKED_SHORTCUTS: 'Control+Shift+Space,Control+Alt+M' } })
  const { app, page } = ctx
  expect(await shortcutStatus(app)).toMatchObject({ registered: false, accelerator: 'Control+Shift+Space' })
  const banner = page.getByTestId('shortcut-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Ctrl')
  await expect(banner).toContainText(/already in use/)
  await banner.getByRole('button', { name: 'Choose another shortcut' }).click()
  const settings = page.getByTestId('settings')
  await expect(settings).toBeVisible()
  const button = page.getByTestId('shortcut-button')

  // A combination that would interfere with typing is refused with an explanation.
  await button.click()
  await page.keyboard.press('Shift+N')
  await expect(settings.getByText(/Include Ctrl, Alt/)).toBeVisible()
  expect((await shortcutStatus(app)).registered).toBe(false)

  await page.keyboard.press('Control+Alt+N')
  await expect(banner).toHaveCount(0)
  await expect(button).toHaveText(/Ctrl.*Alt.*N/)
  expect(await shortcutStatus(app)).toMatchObject({ registered: true, accelerator: 'Control+Alt+N' })
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+N'))).toBe(true)

  // Rebinding to a combination another app owns reports it and keeps the working shortcut.
  await button.click()
  await page.keyboard.press('Control+Alt+M')
  await expect(settings.getByText(/already in use/)).toBeVisible()
  await expect(button).toHaveText(/Ctrl.*Alt.*N/)
  await expect(banner).toHaveCount(0)
  expect(await shortcutStatus(app)).toMatchObject({ registered: true, accelerator: 'Control+Alt+N' })
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+N'))).toBe(true)
  await stop(ctx)

  ctx = await start({ dataDir: ctx.dataDir })
  expect(await shortcutStatus(ctx.app)).toMatchObject({ registered: true, accelerator: 'Control+Alt+N' })
  await expect(ctx.page.getByTestId('shortcut-banner')).toHaveCount(0)
})

const inside = (rect: Rect, area: Rect): boolean => rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height

test('a window left on a vanished display is brought back, now and at the next launch', async () => {
  let ctx = await start()
  const area = await workArea(ctx.app)
  await moveByHand(ctx.app, { x: 9000, y: 200, width: 700, height: 600 })
  await ctx.app.evaluate(() => (globalThis as unknown as { __tnTest: TestHandle }).__tnTest.windows.reconcileDisplays())
  await expect.poll(async () => inside(await bounds(ctx.app), area)).toBe(true)
  expect(await isVisible(ctx.app)).toBe(true)

  // Saved state pointing off-screen at quit: the next launch still opens somewhere visible.
  await ctx.page.waitForTimeout(800)
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 9000, y: 200, width: 700, height: 600 }))
  await expect.poll(async () => (await bounds(ctx.app)).x).toBe(9000)
  await ctx.page.waitForTimeout(600)
  await stop(ctx)
  ctx = await start({ dataDir: ctx.dataDir })
  const reopened = await bounds(ctx.app)
  expect(inside(reopened, area), `reopened at ${JSON.stringify(reopened)}`).toBe(true)
  expect(await isVisible(ctx.app)).toBe(true)
})

test('--hidden starts with no visible window until the tray or shortcut asks for it', async () => {
  const dataDir = freshDataDir()
  dirs.add(dataDir)
  const app = await electron.launch({
    args: [process.env.TRADING_NOTES_E2E_ENTRY ?? ROOT, '--no-sandbox', '--hidden'],
    cwd: ROOT,
    env: { ...(process.env as Record<string, string>), TRADING_NOTES_TEST: '1', TRADING_NOTES_DATA_DIR: dataDir }
  })
  try {
    await expect.poll(() => app.evaluate(() => Boolean((globalThis as Record<string, unknown>).__tnTest))).toBe(true)
    await app.evaluate(({ BrowserWindow }) => new Promise<void>((resolve) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      if (contents.isLoading()) contents.once('did-finish-load', () => resolve())
      else resolve()
    }))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(await windowCount(app)).toBe(1)
    expect(await isVisible(app)).toBe(false)

    await toggle(app)
    expect(await isVisible(app)).toBe(true)
    expect(await windowCount(app)).toBe(1)
    const page = await app.firstWindow()
    await page.waitForSelector('.app[data-ready="true"]')
    expect(await bounds(app)).toEqual(rightHalf(await workArea(app)))
  } finally {
    const closed = app.waitForEvent('close').catch(() => undefined)
    await app.evaluate(() => (globalThis as unknown as { __tnTest: TestHandle }).__tnTest.quit()).catch(() => app.process().kill('SIGKILL'))
    await closed
  }
})

test('quitting while a save is failing asks first, and never passes the loss off as a clean exit', async () => {
  const dataDir = freshDataDir()
  dirs.add(dataDir)
  let ctx = await start({ dataDir, size: { width: 960, height: 1000 } })
  let { page, app } = ctx
  const hooks = (patch: Record<string, unknown>): Promise<void> =>
    app.evaluate((_electron, values) => {
      Object.assign((globalThis as unknown as { __tnTest: TestHandle }).__tnTest.testHooks, values)
    }, patch)
  const chooseQuit = async (): Promise<void> => {
    await page.getByTestId('gear').click()
    await page.getByRole('menuitem', { name: 'Quit Trading Notes' }).click()
  }

  await clickEmptySpace(page)
  await page.keyboard.type('Saved part.')
  await expect(page.locator('.save-status')).toHaveText('Saved')

  // From here on nothing can be written.
  await hooks({ failSaves: true, quitChoice: 'keep' })
  await page.keyboard.type(' Unsaved part.')
  await expect(page.locator('.save-status')).toContainText('Not saved')

  // Quit, answered with "Keep editing": the app stays, the editor still holds every word.
  await chooseQuit()
  await page.waitForTimeout(1200)
  expect(await windowCount(app)).toBe(1)
  expect(await isVisible(app)).toBe(true)
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText('Saved part. Unsaved part.')
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['Saved part.'])

  // The save recovers and Quit is asked for again: now it just quits, with everything stored.
  await hooks({ failSaves: false })
  const closed = app.waitForEvent('close')
  await chooseQuit()
  await closed
  live.splice(live.indexOf(ctx), 1)

  ctx = await start({ dataDir, size: { width: 960, height: 1000 } })
  ;({ page, app } = ctx)
  expect((await storedNotes(app)).map((n) => n.plainText)).toEqual(['Saved part. Unsaved part.'])
  // A confirmed save means a clean exit: the note reopens without a recovery notice.
  await expect(focusView(page)).toBeVisible()
  await expect(page.locator('.notice')).toHaveCount(0)

  // Now "Quit anyway" while the save is failing: the app quits, and the next start says so.
  await editorBody(page).click()
  await page.keyboard.press('Control+End')
  await hooks({ failSaves: true, quitChoice: 'quit' })
  await page.keyboard.type(' Lost on purpose.')
  await expect(page.locator('.save-status')).toContainText('Not saved')
  const closedAgain = app.waitForEvent('close')
  await chooseQuit()
  await closedAgain
  live.splice(live.indexOf(ctx), 1)

  ctx = await start({ dataDir, size: { width: 960, height: 1000 } })
  ;({ page, app } = ctx)
  await expect(focusView(page)).toBeVisible()
  await expect(page.locator('.notice')).toBeVisible()
  await expect(editorBody(page)).toHaveText('Saved part. Unsaved part.')
})
