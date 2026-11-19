/**
 * Window opacity: the title bar control (slider by keyboard and mouse, presets, the wheel over
 * the icon, the keyboard shortcut), Settings, the tray submenu, persistence, "solid while I
 * use it" (pointer and keyboard, with a grace period on leaving and a short fade), the
 * minimum, and that none of it takes focus or leaves timers running.
 *
 * BrowserWindow.setOpacity only changes the real window on Windows and macOS, so the window's
 * own reading (getOpacity) is asserted on Windows; everywhere the tests check the value the
 * app asked for, which the window manager keeps for them.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { clickEmptySpace, editorBody, focusView } from './helpers'
import { launch, removeDataDir, type Launched, type LaunchOptions } from './launch'

interface OpacityState {
  chosen: number
  solidOnHover: boolean
  preview: number | null
  pointerInside: boolean
  focused: boolean
  requested: number
  applied: number
  native: number
  initial: number
  fading: boolean
  leavePending: boolean
  lastChange: number[]
  applyCount: number
}
interface MenuEntry { label: string; checked: boolean; submenu?: MenuEntry[] }
interface Handle {
  library: {
    getPreferences: () => { windowOpacity: number; opacitySolidOnHover: boolean }
    setPreferences: (patch: unknown) => unknown
  }
  windows: { opacityState: () => OpacityState; reportPointer: (source: 'page' | 'frame', inside: boolean) => void }
  tray: { testMenu: () => MenuEntry[]; testChoose: (...path: string[]) => boolean } | null
}

const SIZE = { width: 960, height: 1032 }
const live: Launched[] = []
const dirs = new Set<string>()

async function start(options: LaunchOptions = {}): Promise<Launched> {
  const ctx = await launch({ size: SIZE, ...options })
  live.push(ctx)
  dirs.add(ctx.dataDir)
  return ctx
}

async function stop(ctx: Launched): Promise<void> {
  live.splice(live.indexOf(ctx), 1)
  await ctx.quit()
}

test.afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.quit()
  for (const dir of dirs) removeDataDir(dir)
  dirs.clear()
})

const opacity = (app: ElectronApplication): Promise<OpacityState> =>
  app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.windows.opacityState())
const requested = async (app: ElectronApplication): Promise<number> => (await opacity(app)).requested
const stored = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.library.getPreferences().windowOpacity)
const storedSolid = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.library.getPreferences().opacitySolidOnHover)
const setPrefs = async (page: Page, patch: Record<string, unknown>): Promise<void> => {
  await page.evaluate((value) => window.tn.setPreferences(value), patch)
}
/** Stand-in for the chart taking or giving back the keyboard. */
const windowEvent = (app: ElectronApplication, name: 'focus' | 'blur'): Promise<void> =>
  app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]!.emit(event as 'focus')
  }, name)
/** The page's own pointer events, exactly as Chromium sends them when the pointer crosses the window edge. */
const pointer = (page: Page, inside: boolean): Promise<void> =>
  page.evaluate((enter) => {
    document.documentElement.dispatchEvent(new MouseEvent(enter ? 'mouseenter' : 'mouseleave'))
  }, inside)
/** Count the main process's preference writes that change the opacity. */
const countOpacityWrites = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => {
    const handle = (globalThis as unknown as { __tnTest: Handle & { opacityWrites: number } }).__tnTest
    handle.opacityWrites = 0
    const original = handle.library.setPreferences.bind(handle.library)
    handle.library.setPreferences = (patch: unknown) => {
      if (patch && typeof patch === 'object' && 'windowOpacity' in patch) handle.opacityWrites++
      return original(patch)
    }
  })
const opacityWrites = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => (globalThis as unknown as { __tnTest: { opacityWrites: number } }).__tnTest.opacityWrites)

/** On Windows the window's own reading must match what the app asked for. */
async function expectNative(app: ElectronApplication, value: number): Promise<void> {
  if (process.platform !== 'win32') return
  await expect.poll(async () => (await opacity(app)).native).toBeCloseTo(value, 2)
}

const button = (page: Page) => page.getByTestId('opacity-button')
const popover = (page: Page) => page.getByRole('dialog', { name: 'Window opacity' })

test('the title bar control: keyboard and mouse on the slider, presets, live preview, stored once', async () => {
  const { app, page } = await start()
  await expect(button(page)).toHaveAccessibleName('Window opacity 100%')
  await expect(button(page)).toHaveAttribute('title', /Ctrl\+Shift\+Minus \/ Ctrl\+Shift\+Plus/)
  expect(await opacity(app)).toMatchObject({ requested: 1, initial: 1 })
  await countOpacityWrites(app)

  await button(page).click()
  await expect(popover(page)).toBeVisible()
  const slider = popover(page).getByRole('slider', { name: 'Window opacity' })
  // The keyboard lands on the slider, so arrow keys work straight away.
  await expect(slider).toBeFocused()
  await expect(slider).toHaveAttribute('aria-valuetext', '100 percent')
  await expect(slider).toHaveAttribute('aria-valuemin', '30')

  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await expect(slider).toHaveAttribute('aria-valuetext', '85 percent')
  await expect(slider).toHaveAttribute('aria-valuenow', '85')
  await expect(popover(page).getByTestId('opacity-value')).toHaveText('85%')
  // While the control is open the window shows the value being chosen, even though the pointer
  // is over it and it has the keyboard ("solid while I use it" would otherwise hide it).
  await expect.poll(() => requested(app)).toBe(0.85)
  await expectNative(app, 0.85)
  // Stored once the keys pause, in one write.
  await expect.poll(() => stored(app)).toBe(0.85)
  expect(await opacityWrites(app)).toBe(1)
  await page.keyboard.press('ArrowUp')
  await expect(slider).toHaveAttribute('aria-valuetext', '90 percent')
  await page.keyboard.press('PageDown')
  await expect(slider).toHaveAttribute('aria-valuetext', '80 percent')
  await page.keyboard.press('Home')
  await expect(slider).toHaveAttribute('aria-valuetext', '30 percent')
  await page.keyboard.press('End')
  await expect(slider).toHaveAttribute('aria-valuetext', '100 percent')
  await expect.poll(() => stored(app)).toBe(1)

  // Mouse: press on the thumb, drag to the middle of the range, release.
  const track = (await slider.locator('.opacity-track').boundingBox())!
  const y = track.y + track.height / 2
  const xFor = (value: number): number => track.x + (track.width * (value - 0.3)) / 0.7
  await page.mouse.move(xFor(1), y)
  await page.mouse.down()
  const writesBefore = await opacityWrites(app)
  await page.mouse.move(xFor(0.5), y, { steps: 24 })
  await expect(slider).toHaveAttribute('aria-valuetext', '50 percent')
  await expect.poll(() => requested(app)).toBe(0.5)
  // Nothing is stored while the pointer is still moving it.
  await page.waitForTimeout(600)
  expect(await stored(app)).toBe(1)
  expect(await opacityWrites(app)).toBe(writesBefore)

  // A burst of pointer moves inside one frame reaches the main process as a single preview.
  await app.evaluate(() => {
    const handle = (globalThis as unknown as { __tnTest: { windows: { previewOpacity: (v: number | null) => void }; previews: number } }).__tnTest
    handle.previews = 0
    const original = handle.windows.previewOpacity.bind(handle.windows)
    handle.windows.previewOpacity = (value) => {
      handle.previews++
      original(value)
    }
  })
  await slider.evaluate((element, box) => {
    for (let i = 0; i <= 40; i++) {
      const clientX = box.x + (box.width * (0.2 + i / 200))
      element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX, clientY: box.y, bubbles: true }))
    }
  }, { x: track.x, y, width: track.width })
  await page.waitForTimeout(300)
  const previews = await app.evaluate(() => (globalThis as unknown as { __tnTest: { previews: number } }).__tnTest.previews)
  expect(previews, '41 pointer moves in one task').toBeLessThanOrEqual(2)
  expect(previews).toBeGreaterThanOrEqual(1)

  await page.mouse.move(xFor(0.6), y, { steps: 4 })
  await page.mouse.up()
  await expect(slider).toHaveAttribute('aria-valuetext', '60 percent')
  await expect.poll(() => stored(app)).toBe(0.6)
  expect(await opacityWrites(app)).toBe(writesBefore + 1)
  await expect(button(page)).toHaveAccessibleName('Window opacity 60%')

  // Presets, most see-through first like the slider; the current one is marked.
  const presets = popover(page).getByRole('group', { name: 'Quick choices' }).getByRole('button')
  await expect(presets).toHaveText(['50%', '70%', '85%', '100%'])
  await presets.filter({ hasText: '70%' }).click()
  await expect(slider).toHaveAttribute('aria-valuetext', '70 percent')
  await expect(presets.filter({ hasText: '70%' })).toHaveAttribute('aria-pressed', 'true')
  await expect(presets.filter({ hasText: '50%' })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => stored(app)).toBe(0.7)
  await expect.poll(() => requested(app)).toBe(0.7)
  await expectNative(app, 0.7)

  // "Solid while I use it" is in the popover too.
  const solid = popover(page).getByRole('switch', { name: 'Solid while I use it' })
  await expect(solid).toHaveAttribute('aria-checked', 'true')
  await solid.click()
  await expect(solid).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => storedSolid(app)).toBe(false)
  await solid.click()
  await expect.poll(() => storedSolid(app)).toBe(true)

  // Esc closes it and gives the keyboard back to the button. The preview lasts a moment more,
  // then the window is solid again while it is in use (pointer over it, keyboard in it).
  await page.keyboard.press('Escape')
  await expect(popover(page)).toBeHidden()
  await expect(button(page)).toBeFocused()
  expect(await requested(app)).toBe(0.7)
  await expect.poll(() => requested(app), { timeout: 4000 }).toBe(1)
  await expect(button(page)).toHaveAccessibleName('Window opacity 70%')
})

test('the wheel over the icon and the keyboard shortcut step by 5 % with a small readout', async () => {
  const { app, page } = await start()
  await countOpacityWrites(app)
  await button(page).hover()
  await page.mouse.wheel(0, 100)
  await expect(page.getByTestId('opacity-flash')).toHaveText('95%')
  await expect(button(page)).toHaveAccessibleName('Window opacity 95%')
  // Shown as it is right away, although the pointer is over the window.
  await expect.poll(() => requested(app)).toBe(0.95)
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100)
  await expect(page.getByTestId('opacity-flash')).toHaveText('80%')
  await expect.poll(() => stored(app)).toBe(0.8)
  expect(await opacityWrites(app), 'four notches, one write').toBe(1)
  await page.mouse.wheel(0, -100)
  await expect(page.getByTestId('opacity-flash')).toHaveText('85%')
  // A touchpad's small deltas add up to one notch.
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 20)
  await expect(button(page)).toHaveAccessibleName('Window opacity 85%')
  await page.mouse.wheel(0, 20)
  await expect(button(page)).toHaveAccessibleName('Window opacity 80%')
  // The readout goes away by itself, and after a moment "solid while I use it" applies again.
  await expect(page.getByTestId('opacity-flash')).toBeHidden({ timeout: 3000 })
  await expect.poll(() => requested(app), { timeout: 4000 }).toBe(1)
  await expect.poll(() => stored(app)).toBe(0.8)

  // The shortcut works from the board and from inside a note, without taking anything over.
  await page.mouse.move(400, 600)
  await page.keyboard.press('Control+Shift+Minus')
  await expect(button(page)).toHaveAccessibleName('Window opacity 75%')
  await expect(page.getByTestId('opacity-flash')).toHaveText('75%')
  await expect(page.locator('.sr-only[aria-live="polite"]')).toHaveText('Window opacity 75%')
  await page.keyboard.press('Control+Shift+Equal')
  await page.keyboard.press('Control+Shift+Equal')
  await expect(button(page)).toHaveAccessibleName('Window opacity 85%')
  await expect.poll(() => stored(app)).toBe(0.85)
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Sweep of the low')
  await page.keyboard.press('Control+Shift+Minus')
  await expect(button(page)).toHaveAccessibleName('Window opacity 80%')
  await expect(editorBody(page)).toHaveText('Sweep of the low')
  await expect(editorBody(page)).toBeFocused()
  await expect.poll(() => stored(app)).toBe(0.8)
})

test('Settings has the same slider and switch', async () => {
  const { app, page } = await start()
  await page.keyboard.press('Control+,')
  const settings = page.getByTestId('settings')
  await expect(settings).toBeVisible()
  const slider = settings.getByRole('slider', { name: 'Window opacity' })
  await expect(slider).toHaveAttribute('aria-valuetext', '100 percent')
  await slider.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(slider).toHaveAttribute('aria-valuetext', '90 percent')
  await expect(settings.getByText('90%')).toBeVisible()
  await expect.poll(() => requested(app)).toBe(0.9)
  await expect.poll(() => stored(app)).toBe(0.9)
  // The title bar follows.
  await expect(button(page)).toHaveAccessibleName('Window opacity 90%')

  const track = (await slider.locator('.opacity-track').boundingBox())!
  await page.mouse.click(track.x + 1, track.y + track.height / 2)
  await expect(slider).toHaveAttribute('aria-valuetext', '30 percent')
  await expect.poll(() => stored(app)).toBe(0.3)

  const solid = settings.getByRole('switch', { name: 'Solid while I use it' })
  await expect(solid).toHaveAttribute('aria-checked', 'true')
  await solid.click()
  await expect.poll(() => storedSolid(app)).toBe(false)
  // With it off the chosen opacity stays while the notes are in use.
  await expect.poll(() => requested(app), { timeout: 4000 }).toBe(0.3)
  expect((await opacity(app)).pointerInside || (await opacity(app)).focused).toBe(true)
  await expectNative(app, 0.3)
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
})

test('the tray menu has an Opacity submenu with 100 / 85 / 70 / 50 %', async () => {
  const { app, page } = await start()
  const menu = (): Promise<MenuEntry[]> => app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.tray?.testMenu() ?? [])
  const choose = (...path: string[]): Promise<boolean> =>
    app.evaluate((_electron, labels) => (globalThis as unknown as { __tnTest: Handle }).__tnTest.tray?.testChoose(...labels) ?? false, path)
  const hasTray = await app.evaluate(() => (globalThis as unknown as { __tnTest: Handle }).__tnTest.tray !== null)
  test.skip(!hasTray, 'This desktop has no notification area.')
  const submenu = async (): Promise<MenuEntry[]> => (await menu()).find((entry) => entry.label === 'Opacity')?.submenu ?? []

  expect((await menu()).map((entry) => entry.label)).toContain('Opacity')
  expect(await submenu()).toEqual([
    { label: '100%', checked: true },
    { label: '85%', checked: false },
    { label: '70%', checked: false },
    { label: '50%', checked: false }
  ])
  // The notes are not in use while the tray menu is (it has the pointer and the keyboard).
  await windowEvent(app, 'blur')
  await page.mouse.move(-20, -20)
  expect(await choose('Opacity', '70%')).toBe(true)
  await expect.poll(() => stored(app)).toBe(0.7)
  await expect.poll(() => requested(app)).toBe(0.7)
  await expectNative(app, 0.7)
  await expect(button(page)).toHaveAccessibleName('Window opacity 70%')
  await expect.poll(async () => (await submenu()).filter((entry) => entry.checked).map((entry) => entry.label)).toEqual(['70%'])

  // A value set in between shows as its own checked entry.
  await setPrefs(page, { windowOpacity: 0.65 })
  await expect.poll(async () => (await submenu()).map((entry) => `${entry.label}${entry.checked ? '*' : ''}`)).toEqual(['100%', '85%', '70%', '65%*', '50%'])
  expect(await choose('Opacity', '50%')).toBe(true)
  await expect.poll(() => stored(app)).toBe(0.5)
  expect(await choose('Opacity', '100%')).toBe(true)
  await expect.poll(() => stored(app)).toBe(1)
  await expect.poll(() => requested(app)).toBe(1)
  expect(await choose('Opacity', '42%')).toBe(false)
  expect(await choose('Opacity')).toBe(false)
})

test('solid while in use: the pointer and the keyboard decide, with a grace period and a short fade', async () => {
  const { app, page } = await start()
  await setPrefs(page, { windowOpacity: 0.6, reducedMotion: 'off' })
  await windowEvent(app, 'blur')
  await pointer(page, false)
  await expect.poll(() => requested(app)).toBe(0.6)
  await expect.poll(async () => (await opacity(app)).fading).toBe(false)
  expect((await opacity(app)).applied).toBe(0.6)
  await expectNative(app, 0.6)

  // Pointer onto the page: solid at once, in a short fade of a few steps.
  await pointer(page, true)
  await expect.poll(() => requested(app)).toBe(1)
  let state = await opacity(app)
  expect(state.lastChange.length).toBeGreaterThanOrEqual(3)
  expect(state.lastChange.length).toBeLessThanOrEqual(8)
  expect(state.lastChange.at(-1)).toBe(1)
  expect([...state.lastChange].sort((a, b) => a - b)).toEqual(state.lastChange)
  await expect.poll(async () => (await opacity(app)).fading).toBe(false)
  expect((await opacity(app)).applied).toBe(1)

  // Leaving counts only after a moment: brushing past the edge changes nothing.
  const before = (await opacity(app)).applyCount
  await pointer(page, false)
  state = await opacity(app)
  expect(state.leavePending).toBe(true)
  expect(state.requested).toBe(1)
  await page.waitForTimeout(80)
  await pointer(page, true)
  await page.waitForTimeout(400)
  state = await opacity(app)
  expect(state.leavePending).toBe(false)
  expect(state.requested).toBe(1)
  expect(state.applyCount, 'no flicker').toBe(before)

  // Really leaving: back to the chosen value after the grace period.
  await pointer(page, false)
  await page.waitForTimeout(100)
  expect(await requested(app)).toBe(1)
  await expect.poll(() => requested(app)).toBe(0.6)
  await expect.poll(async () => (await opacity(app)).fading).toBe(false)

  // The keyboard alone also makes it solid.
  await windowEvent(app, 'focus')
  await expect.poll(() => requested(app)).toBe(1)
  // Leaving with the keyboard still in the notes changes nothing and waits for nothing.
  await pointer(page, true)
  await pointer(page, false)
  expect((await opacity(app)).leavePending).toBe(false)
  await windowEvent(app, 'blur')
  await expect.poll(() => requested(app)).toBe(0.6)

  // The title bar's drag strip and the resize border are reported by the window frame on Windows.
  const frame = (inside: boolean): Promise<void> =>
    app.evaluate((_electron, value) => (globalThis as unknown as { __tnTest: Handle }).__tnTest.windows.reportPointer('frame', value), inside)
  await frame(true)
  await expect.poll(() => requested(app)).toBe(1)
  // From the page to the frame and back is still "over the notes".
  await pointer(page, true)
  await pointer(page, false)
  await frame(true)
  await page.waitForTimeout(400)
  expect(await requested(app)).toBe(1)
  await frame(false)
  await expect.poll(() => requested(app)).toBe(0.6)

  // Real pointer movement, as Chromium reports it.
  await page.mouse.move(300, 300)
  await expect.poll(() => requested(app)).toBe(1)
  await page.mouse.move(-20, -20)
  await expect.poll(() => requested(app)).toBe(0.6)

  // With "solid while I use it" off nothing makes it solid.
  await setPrefs(page, { opacitySolidOnHover: false })
  await pointer(page, true)
  await windowEvent(app, 'focus')
  await page.waitForTimeout(300)
  expect(await requested(app)).toBe(0.6)
  await setPrefs(page, { opacitySolidOnHover: true })
  await expect.poll(() => requested(app)).toBe(1)

  // Reduced motion: every change is instant.
  await setPrefs(page, { reducedMotion: 'on' })
  await windowEvent(app, 'blur')
  await pointer(page, false)
  await expect.poll(() => requested(app)).toBe(0.6)
  state = await opacity(app)
  expect(state.lastChange).toEqual([0.6])
  expect(state.fading).toBe(false)
  expect(state.applied).toBe(0.6)

  // Hidden, it has no pointer over it; shown again it keeps its opacity.
  await pointer(page, true)
  await expect.poll(() => requested(app)).toBe(1)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide())
  await expect.poll(() => requested(app)).toBe(0.6)
  expect((await opacity(app)).pointerInside).toBe(false)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive())
  await windowEvent(app, 'blur')
  await page.waitForTimeout(200)
  expect(await requested(app)).toBe(0.6)
  await expectNative(app, 0.6)
})

test('adjusting never takes the keyboard or changes the z-order, and nothing runs at rest', async () => {
  const { app, page } = await start()
  await setPrefs(page, { windowOpacity: 0.7 })
  await app.evaluate(({ BrowserWindow }) => {
    const notes = BrowserWindow.getAllWindows()[0]!
    const probe = { focusEvents: 0, other: null as InstanceType<typeof BrowserWindow> | null, otherFocused: false }
    ;(globalThis as Record<string, unknown>).__opacityProbe = probe
    notes.on('focus', () => probe.focusEvents++)
    // Stands in for the chart.
    const other = new BrowserWindow({ x: 0, y: 0, width: 400, height: 300 })
    probe.other = other
    other.show()
    other.focus()
  })
  await page.waitForTimeout(800)
  const otherFocusedBefore = await app.evaluate(() => ((globalThis as Record<string, unknown>).__opacityProbe as { other: { isFocused: () => boolean } }).other.isFocused())
  await windowEvent(app, 'blur')

  await button(page).hover()
  await page.mouse.wheel(0, 100)
  await expect(button(page)).toHaveAccessibleName('Window opacity 65%')
  await page.mouse.move(300, 400)
  await page.mouse.move(-20, -20)
  await expect.poll(() => stored(app)).toBe(0.65)
  await expect.poll(() => requested(app), { timeout: 4000 }).toBe(0.65)
  const after = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as Record<string, unknown>).__opacityProbe as { focusEvents: number; other: InstanceType<typeof BrowserWindow> }
    const notes = BrowserWindow.getAllWindows().find((w) => w !== probe.other)!
    return { focusEvents: probe.focusEvents, otherFocused: probe.other.isFocused(), onTop: notes.isAlwaysOnTop(), visible: notes.isVisible() }
  })
  expect(after.focusEvents, 'the notes never took the keyboard').toBe(0)
  expect(after.otherFocused).toBe(otherFocusedBefore)
  expect(after.onTop).toBe(true)
  expect(after.visible).toBe(true)

  // At rest (see-through, pointer away): no fade, no pending leave, no timers or frames.
  await page.waitForTimeout(2000)
  const state = await opacity(app)
  expect(state.fading).toBe(false)
  expect(state.leavePending).toBe(false)
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
    const counts = { setTimeout: 0, requestAnimationFrame: 0 }
    const originals = { setTimeout: w.setTimeout!, requestAnimationFrame: w.requestAnimationFrame! }
    w.setTimeout = (...args: unknown[]) => {
      counts.setTimeout++
      return originals.setTimeout.apply(window, args)
    }
    w.requestAnimationFrame = (...args: unknown[]) => {
      counts.requestAnimationFrame++
      return originals.requestAnimationFrame.apply(window, args)
    }
    await new Promise((resolve) => originals.setTimeout.call(window, resolve, 2000))
    Object.assign(w, originals)
    return { ...counts, animations: document.getAnimations().filter((a) => a.playState === 'running').length }
  })
  expect(mainTimers, 'main-process timers at rest').toBe(0)
  expect(pageWork).toEqual({ setTimeout: 0, requestAnimationFrame: 0, animations: 0 })
  await app.evaluate(() => ((globalThis as Record<string, unknown>).__opacityProbe as { other: { destroy: () => void } }).other.destroy())
})

test('Esc closes the opacity control first, and Ctrl+Enter does not log the note while it is open', async () => {
  const { page } = await start()
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Draw on liquidity')
  await button(page).click()
  await expect(popover(page)).toBeVisible()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popover(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText('Draw on liquidity')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
})

test('the chosen opacity survives a restart and is set before the window is first shown', async () => {
  let ctx = await start()
  await setPrefs(ctx.page, { windowOpacity: 0.6, opacitySolidOnHover: false })
  await expect.poll(() => requested(ctx.app)).toBe(0.6)
  await stop(ctx)

  ctx = await start({ dataDir: ctx.dataDir })
  let state = await opacity(ctx.app)
  expect(state.initial).toBe(0.6)
  expect(state.requested).toBe(0.6)
  expect(state.lastChange).toEqual([0.6])
  await expectNative(ctx.app, 0.6)
  await expect(button(ctx.page)).toHaveAccessibleName('Window opacity 60%')
  await ctx.page.keyboard.press('Control+,')
  await expect(ctx.page.getByTestId('settings').getByRole('slider', { name: 'Window opacity' })).toHaveAttribute('aria-valuetext', '60 percent')
  await expect(ctx.page.getByTestId('settings').getByRole('switch', { name: 'Solid while I use it' })).toHaveAttribute('aria-checked', 'false')
  await setPrefs(ctx.page, { opacitySolidOnHover: true })
  await stop(ctx)

  // Started at sign-in (no keyboard): see-through from the first frame, not solid first.
  ctx = await start({ dataDir: ctx.dataDir, args: ['--autostart'] })
  state = await opacity(ctx.app)
  expect(state.initial).toBe(0.6)
  expect(state.chosen).toBe(0.6)
  expect(state.solidOnHover).toBe(true)
})

test('the minimum of 30 % holds everywhere, and bad messages are ignored', async () => {
  const { app, page } = await start()
  // A stored value below the minimum is raised to it.
  const result = await page.evaluate(() => window.tn.setPreferences({ windowOpacity: 0.05 }))
  expect(result.windowOpacity).toBe(0.3)
  expect(await stored(app)).toBe(0.3)
  await expect(button(page)).toHaveAccessibleName('Window opacity 30%')

  // A preview below it too, and anything that is not a number is ignored.
  await page.evaluate(() => window.tn.previewOpacity(0))
  await expect.poll(async () => (await opacity(app)).preview).toBe(0.3)
  expect(await requested(app)).toBe(0.3)
  await page.evaluate(() => window.tn.previewOpacity(Number.NaN))
  await page.evaluate(() => window.tn.previewOpacity('0.1' as unknown as number))
  await page.evaluate(() => window.tn.previewOpacity(Number.POSITIVE_INFINITY))
  await page.waitForTimeout(200)
  expect((await opacity(app)).preview).toBe(0.3)
  await page.evaluate(() => window.tn.previewOpacity(null))
  await expect.poll(async () => (await opacity(app)).preview).toBe(null)
  const inside = (await opacity(app)).pointerInside
  await page.evaluate(() => window.tn.reportPointer('yes' as unknown as boolean))
  await page.waitForTimeout(200)
  expect((await opacity(app)).pointerInside).toBe(inside)

  // The wheel and the slider stop at the minimum.
  await button(page).hover()
  await page.mouse.wheel(0, 100)
  await page.mouse.wheel(0, 300)
  await expect(page.getByTestId('opacity-flash')).toHaveText('30%')
  await button(page).click()
  const slider = popover(page).getByRole('slider', { name: 'Window opacity' })
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('PageDown')
  await expect(slider).toHaveAttribute('aria-valuetext', '30 percent')
  const track = (await slider.locator('.opacity-track').boundingBox())!
  // Left of the track's end, still on the slider.
  await page.mouse.click(track.x - 6, track.y + track.height / 2)
  await expect(slider).toHaveAttribute('aria-valuetext', '30 percent')
  await expect.poll(() => requested(app)).toBe(0.3)
  expect(await stored(app)).toBe(0.3)
  await expectNative(app, 0.3)
})
