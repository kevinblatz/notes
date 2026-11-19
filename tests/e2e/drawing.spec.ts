/**
 * The drawing space (Draw in the formatting bar, Ctrl+Shift+D) and the fold-away formatting
 * bar. Strokes are drawn with real mouse moves; what was drawn is read back from the canvas.
 */
import { expect, test } from './fixtures'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { clickEmptySpace, collectConsoleErrors, editorBody, focusView, notes, storedNotes } from './helpers'
import { freshDataDir, launch, removeDataDir, setWindowSize } from './launch'

const SIZE = { width: 960, height: 1000 }

const space = (page: Page): Locator => page.getByTestId('drawing-space')
const formatBar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Formatting', exact: true })
const tools = (page: Page): Locator => page.getByRole('toolbar', { name: 'Drawing tools' })
const tool = (page: Page, name: string): Locator => tools(page).getByRole('button', { name, exact: true })
const question = (page: Page): Locator => page.getByRole('alertdialog', { name: 'Discard this drawing?' })
const images = (page: Page): Locator => page.locator('.focus-editor .image-node')

async function openDrawingSpace(page: Page): Promise<void> {
  await formatBar(page).getByRole('button', { name: 'Draw' }).click()
  await expect(space(page)).toBeVisible()
}

/** One stroke with real mouse moves through the given window points. */
async function draw(page: Page, points: Array<[number, number]>, steps = 8): Promise<void> {
  await page.mouse.move(points[0]![0], points[0]![1])
  await page.mouse.down()
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps })
  await page.mouse.up()
}

/** Opacity (0-255) of the ink on the sheet at a window point. */
async function inkAt(page: Page, x: number, y: number): Promise<number> {
  return page.getByTestId('drawing-ink').evaluate(
    (element, point) => {
      const canvas = element as HTMLCanvasElement
      const box = canvas.getBoundingClientRect()
      const scale = canvas.width / box.width
      return canvas.getContext('2d')!.getImageData(Math.floor((point.x - box.left) * scale), Math.floor((point.y - box.top) * scale), 1, 1).data[3]!
    },
    { x, y }
  )
}

/** Colour of the ink at a window point. */
async function colorAt(page: Page, x: number, y: number): Promise<number[]> {
  return page.getByTestId('drawing-ink').evaluate(
    (element, point) => {
      const canvas = element as HTMLCanvasElement
      const box = canvas.getBoundingClientRect()
      const scale = canvas.width / box.width
      return Array.from(canvas.getContext('2d')!.getImageData(Math.floor((point.x - box.left) * scale), Math.floor((point.y - box.top) * scale), 1, 1).data)
    },
    { x, y }
  )
}

/** How many pixels on the sheet hold ink. */
async function inkPixels(page: Page): Promise<number> {
  return page.getByTestId('drawing-ink').evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) count++
    return count
  })
}

/** Width and height (CSS pixels) of the solid ink on the sheet. */
async function inkExtent(page: Page): Promise<{ width: number; height: number }> {
  return page.getByTestId('drawing-ink').evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let minX = canvas.width
    let maxX = -1
    let minY = canvas.height
    let maxY = -1
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3]! > 128) {
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
        }
      }
    }
    const scale = canvas.width / canvas.getBoundingClientRect().width
    return { width: (maxX - minX + 1) / scale, height: (maxY - minY + 1) / scale }
  })
}

async function waitForImages(page: Page, selector: string, count: number): Promise<void> {
  await expect(page.locator(selector)).toHaveCount(count)
  await expect.poll(() => page.locator(selector).evaluateAll((list) => list.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
}

interface StoredImage {
  type: string
  attrs?: { attachmentId: string; width: number; caption: string; naturalWidth: number; naturalHeight: number; drawing?: number | true }
  content?: StoredImage[]
}

function imagesIn(node: StoredImage, out: StoredImage[] = []): StoredImage[] {
  if (node.type === 'noteImage') out.push(node)
  for (const child of node.content ?? []) imagesIn(child, out)
  return out
}

/** What the editor shows, block by block: the text of a paragraph, or "image". */
const blocks = (page: Page): Promise<string[]> =>
  editorBody(page).evaluate((root) => Array.from(root.children).map((child) => (child.querySelector('.image-node') || child.matches('.image-node') ? 'image' : (child.textContent ?? ''))))

/** Width and height of a PNG file. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('a drawing goes into the note like a pasted screenshot, survives a restart, and is edited in place', async () => {
  const dataDir = freshDataDir()
  let ctx = await launch({ dataDir, size: SIZE })
  let errors = await collectConsoleErrors(ctx.page)
  let { page, app } = ctx

  await clickEmptySpace(page)
  await page.keyboard.type('Before the drawing')
  await page.keyboard.press('Enter')
  await page.keyboard.type('After the drawing')
  // The caret goes back to the end of the first line: the drawing lands there.
  await editorBody(page).locator('p').first().click()
  await page.keyboard.press('End')

  await expect(formatBar(page).getByRole('button', { name: 'Draw' })).toHaveAttribute('title', 'Draw (Ctrl+Shift+D)')
  await openDrawingSpace(page)
  // It is part of this window, below the title bar, and covers all of it.
  const layer = (await space(page).boundingBox())!
  expect(layer.width).toBeGreaterThan(SIZE.width - 30)
  expect(layer.y).toBeGreaterThan(20)
  expect(layer.y).toBeLessThan(60)
  await expect(space(page).locator('.draw-hint')).toBeVisible()
  // A big zig-zag across most of the sheet.
  await draw(page, [
    [120, 250],
    [840, 250],
    [120, 600],
    [840, 600]
  ])
  await expect(space(page).locator('.draw-hint')).toHaveCount(0)
  expect(await inkAt(page, 480, 250)).toBeGreaterThan(200)
  const drawn = await inkExtent(page)
  expect(drawn.width).toBeGreaterThan(600)
  await tool(page, 'Done').click()
  await expect(space(page)).toBeHidden()

  // At the caret, as an image block, loaded from the managed attachments.
  await waitForImages(page, '.focus-editor .image-node img', 1)
  expect(await blocks(page)).toEqual(['Before the drawing', 'image', 'After the drawing'])
  await expect(images(page).first()).toHaveAttribute('data-drawing', '')
  // Sized down the way a screenshot of the whole sheet would be: the sheet maps onto the note's width.
  const shown = (await images(page).first().locator('img').boundingBox())!
  expect(shown.width).toBeLessThan(720)
  expect(shown.width).toBeGreaterThan(450)
  const widthStyle = await images(page).first().evaluate((element) => (element as HTMLElement).style.width)
  expect(Number.parseInt(widthStyle, 10)).toBeGreaterThan(70)
  expect(Number.parseInt(widthStyle, 10)).toBeLessThan(90)

  // One undo step in the note takes exactly the drawing away; redo brings it back.
  await page.keyboard.press('Control+z')
  await expect(images(page)).toHaveCount(0)
  await expect(editorBody(page).locator('p')).toHaveText(['Before the drawing', 'After the drawing'])
  await page.keyboard.press('Control+y')
  await waitForImages(page, '.focus-editor .image-node img', 1)

  // Captionable like any image.
  await images(page).first().locator('img').click()
  await images(page).first().locator('.image-caption').fill('Sweep then retest')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await waitForImages(page, '.note .note-image img', 1)

  // Stored as a managed attachment (a real PNG on disk), not inside the note.
  const stored = (await storedNotes(app))[0]!
  expect(JSON.stringify(stored.content)).not.toContain('base64')
  const [image] = imagesIn(stored.content as StoredImage)
  expect(image!.attrs).toMatchObject({ caption: 'Sweep then retest', drawing: 1 })
  const firstId = image!.attrs!.attachmentId
  const attachmentDir = join(dataDir, 'library', 'attachments')
  const original = readdirSync(attachmentDir).find((name) => name.startsWith(firstId) && !name.includes('.preview.'))!
  expect(original).toMatch(/\.png$/)
  const size = pngSize(readFileSync(join(attachmentDir, original)))
  expect(size).toEqual({ width: image!.attrs!.naturalWidth, height: image!.attrs!.naturalHeight })
  // Cropped to what was drawn (plus a small margin), not the whole sheet.
  expect(size.width).toBeGreaterThan(720)
  expect(size.width).toBeLessThan(800)
  expect(size.height).toBeGreaterThan(350)
  expect(size.height).toBeLessThan(430)
  expect(errors).toEqual([])
  await ctx.quit()

  // ---- restart
  ctx = await launch({ dataDir, size: SIZE })
  errors = await collectConsoleErrors(ctx.page)
  ;({ page, app } = ctx)
  await waitForImages(page, '.note .note-image img', 1)
  await expect(notes(page).first().locator('figcaption')).toHaveText('Sweep then retest')

  // Edit drawing: back into the drawing space with the picture as it was drawn.
  await notes(page).first().locator('.prose p').first().click()
  await expect(focusView(page)).toBeVisible()
  await waitForImages(page, '.focus-editor .image-node img', 1)
  await images(page).first().locator('img').hover()
  await images(page).first().getByRole('button', { name: 'Edit drawing' }).click()
  await expect(space(page)).toBeVisible()
  await expect(space(page)).toHaveAttribute('data-mode', 'edit')
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(2000)
  // At the same scale as it was drawn (centred on the sheet now).
  const reopened = await inkExtent(page)
  expect(Math.abs(reopened.width - drawn.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(reopened.height - drawn.height)).toBeLessThanOrEqual(2)
  // Cancel without changing anything: the note keeps the drawing untouched, nothing is asked.
  await tool(page, 'Cancel').click()
  await expect(question(page)).toHaveCount(0)
  await expect(space(page)).toBeHidden()

  // Edit again, add a stroke underneath, Done: the same image block, same width and caption.
  await images(page).first().locator('img').hover()
  await images(page).first().getByRole('button', { name: 'Edit drawing' }).click()
  await expect(space(page)).toBeVisible()
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(2000)
  await draw(page, [
    [200, 820],
    [760, 840]
  ])
  await page.keyboard.press('Control+Enter')
  await expect(space(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await waitForImages(page, '.focus-editor .image-node img', 1)
  expect(await blocks(page)).toEqual(['Before the drawing', 'image', 'After the drawing'])
  expect(await images(page).first().evaluate((element) => (element as HTMLElement).style.width)).toBe(widthStyle)
  await expect(images(page).first().locator('.image-caption')).toHaveValue('Sweep then retest')
  const tall = await images(page).first().locator('img').evaluate((element) => (element as HTMLImageElement).naturalHeight)
  expect(tall).toBeGreaterThan(size.height + 150)

  // Replacing was one undo step too: Ctrl+Z shows the earlier picture again.
  await page.keyboard.press('Control+z')
  await expect.poll(() => images(page).first().locator('img').evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBe(size.height)
  await page.keyboard.press('Control+y')
  await expect.poll(() => images(page).first().locator('img').evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBe(tall)
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const [edited] = imagesIn((await storedNotes(app))[0]!.content as StoredImage)
  expect(edited!.attrs).toMatchObject({ caption: 'Sweep then retest', width: Number.parseInt(widthStyle, 10), drawing: 1, naturalHeight: tall })
  expect(edited!.attrs!.attachmentId).not.toBe(firstId)
  expect(errors).toEqual([])
  await ctx.quit()
  removeDataDir(dataDir)
})

test('undo, redo, clear and the eraser; Esc asks before a drawing is thrown away; Cancel with nothing drawn adds nothing', async () => {
  const ctx = await launch({ size: SIZE })
  const errors = await collectConsoleErrors(ctx.page)
  const { page } = ctx
  await clickEmptySpace(page)
  await page.keyboard.type('Tools')

  // Nothing drawn: Cancel and Esc simply close, without a question, and add nothing.
  await openDrawingSpace(page)
  await tool(page, 'Cancel').click()
  await expect(space(page)).toBeHidden()
  await openDrawingSpace(page)
  await page.keyboard.press('Escape')
  await expect(space(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(images(page)).toHaveCount(0)

  await openDrawingSpace(page)
  await expect(tool(page, 'Undo')).toBeDisabled()
  // The pointer is a crisp circle of the brush (1x and 2x pictures, at most 32 px, centred hotspot).
  const cursor = await page.getByTestId('drawing-canvas').evaluate((element) => getComputedStyle(element).cursor)
  expect(cursor).toMatch(/^image-set\(url\("data:image\/svg\+xml,.+"\) 1(x|dppx), url\("data:image\/svg\+xml,.+"\) 2(x|dppx)\) \d+ \d+, crosshair$/)
  const box = Number(/width%3D%22(\d+)%22/.exec(cursor)![1])
  expect(box).toBeLessThanOrEqual(32)
  expect(cursor).toContain(`) ${box / 2} ${box / 2}, crosshair`)
  await expect(tool(page, 'Clear')).toBeDisabled()
  await draw(page, [
    [200, 400],
    [600, 400]
  ])
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)
  await expect(tool(page, 'Undo')).toBeEnabled()

  // Undo and redo from the keyboard (Ctrl+Y and Ctrl+Shift+Z) and with the buttons.
  await page.keyboard.press('Control+z')
  expect(await inkAt(page, 400, 400)).toBe(0)
  await page.keyboard.press('Control+y')
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+Shift+z')
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)
  await tool(page, 'Undo').click()
  expect(await inkAt(page, 400, 400)).toBe(0)
  await tool(page, 'Redo').click()
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)
  // The note's own text was not touched by any of that.
  await expect(editorBody(page)).toHaveText('Tools')

  // The eraser cuts through the line where it passes, and nowhere else.
  await tool(page, 'Eraser').click()
  await expect(tool(page, 'Eraser')).toHaveAttribute('aria-pressed', 'true')
  await draw(page, [
    [400, 380],
    [400, 420]
  ])
  expect(await inkAt(page, 400, 400)).toBe(0)
  expect(await inkAt(page, 300, 400)).toBeGreaterThan(200)
  await page.keyboard.press('Control+z')
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)

  // Picking a colour is back to the pen, in that colour.
  await tools(page).getByRole('radio', { name: 'Red' }).click()
  await expect(tool(page, 'Eraser')).toHaveAttribute('aria-pressed', 'false')
  await tools(page).getByRole('radio', { name: 'Bold' }).click()
  await draw(page, [
    [200, 500],
    [600, 500]
  ])
  const [red, green, blue] = await colorAt(page, 400, 500)
  expect(red!).toBeGreaterThan(green! + 60)
  expect(red!).toBeGreaterThan(blue! + 60)

  // A tap leaves a dot as big as the pointer showed (Bold: 10 px), and a short tick shows too.
  await page.mouse.click(700, 300)
  expect(await inkAt(page, 700, 300)).toBeGreaterThan(200)
  expect(await inkAt(page, 703, 300)).toBeGreaterThan(200)
  expect(await inkAt(page, 708, 300)).toBe(0)
  await draw(page, [
    [700, 340],
    [704, 343]
  ], 2)
  expect(await inkAt(page, 702, 341)).toBeGreaterThan(200)

  // Clear takes everything away, and is undone like any other step.
  await tool(page, 'Clear').click()
  expect(await inkAt(page, 400, 400)).toBe(0)
  expect(await inkAt(page, 400, 500)).toBe(0)
  await expect(tool(page, 'Clear')).toBeDisabled()
  await page.keyboard.press('Control+z')
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)
  expect(await inkAt(page, 400, 500)).toBeGreaterThan(200)

  // Something is drawn: Esc asks first, inside the window, with "Keep drawing" ready.
  await page.keyboard.press('Escape')
  await expect(question(page)).toBeVisible()
  await expect(question(page).getByRole('button', { name: 'Keep drawing' })).toBeFocused()
  // The question is on top, so Esc closes only the question.
  await page.keyboard.press('Escape')
  await expect(question(page)).toBeHidden()
  await expect(space(page)).toBeVisible()
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)
  await expect(focusView(page)).toBeVisible()

  // Cancel asks too; Discard throws the drawing away and nothing is added.
  await tool(page, 'Cancel').click()
  await expect(question(page)).toBeVisible()
  await question(page).getByRole('button', { name: 'Discard' }).click()
  await expect(space(page)).toBeHidden()
  await expect(images(page)).toHaveCount(0)
  // The keyboard is back in the text.
  await page.keyboard.type(' still here')
  await expect(editorBody(page)).toHaveText('Tools still here')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()

  // A note that holds nothing but a drawing is kept.
  await clickEmptySpace(page)
  await openDrawingSpace(page)
  await draw(page, [
    [300, 300],
    [500, 420]
  ])
  await tool(page, 'Done').click()
  await waitForImages(page, '.focus-editor .image-node img', 1)

  // An edited drawing that is cleared and finished empty leaves the note; Ctrl+Z brings it back.
  await images(page).first().locator('img').hover()
  await images(page).first().getByRole('button', { name: 'Edit drawing' }).click()
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(200)
  await tool(page, 'Clear').click()
  await tool(page, 'Done').click()
  await expect(space(page)).toBeHidden()
  await expect(images(page)).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await waitForImages(page, '.focus-editor .image-node img', 1)

  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page)).toHaveCount(2)
  await waitForImages(page, '.note .note-image img', 1)
  expect(errors).toEqual([])
  await ctx.quit()
})

test('Ctrl+Shift+D opens the space; there Ctrl+Enter is Done, not Log note; a window resize keeps every stroke', async () => {
  const ctx = await launch({ size: SIZE })
  const errors = await collectConsoleErrors(ctx.page)
  const { page, app } = ctx
  await clickEmptySpace(page)
  await page.keyboard.type('Keys')
  await page.keyboard.press('Control+Shift+D')
  await expect(space(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(space(page)).toBeHidden()

  // From the title as well.
  await page.locator('.focus-title').click()
  await page.keyboard.press('Control+Shift+D')
  await expect(space(page)).toBeVisible()
  // Nothing else opens on top of a drawing in progress.
  await page.keyboard.press('Control+k')
  await page.keyboard.press('Control+,')
  await expect(page.getByTestId('palette')).toHaveCount(0)
  await expect(page.locator('.sheet')).toHaveCount(0)
  await expect(space(page)).toBeVisible()

  await draw(page, [
    [780, 300],
    [900, 340]
  ])
  expect(await inkAt(page, 840, 320)).toBeGreaterThan(200)

  // Left alone, the open sheet does nothing: no frames, no timers, no running animation.
  await page.waitForTimeout(500)
  const idle = await page.evaluate(async () => {
    const w = window as unknown as Record<string, (...args: unknown[]) => unknown>
    const counts: Record<string, number> = { requestAnimationFrame: 0, setInterval: 0, setTimeout: 0 }
    const originals = Object.fromEntries(Object.keys(counts).map((name) => [name, w[name]!]))
    for (const name of Object.keys(counts)) {
      w[name] = (...args: unknown[]) => {
        counts[name]!++
        return originals[name]!.apply(window, args)
      }
    }
    await new Promise((resolve) => originals.setTimeout!.call(window, () => resolve(null), 1500))
    Object.assign(w, originals)
    return { ...counts, animations: document.getAnimations().filter((animation) => animation.playState === 'running').length }
  })
  expect(idle).toEqual({ requestAnimationFrame: 0, setInterval: 0, setTimeout: 0, animations: 0 })

  // A narrower window: the stroke is out of view, not squeezed into it.
  await setWindowSize(app, page, 680, SIZE.height)
  await expect.poll(() => space(page).evaluate((element) => (element as HTMLElement).clientWidth)).toBeLessThan(700)
  await draw(page, [
    [100, 500],
    [300, 520]
  ])
  expect(await inkAt(page, 200, 510)).toBeGreaterThan(200)
  // Wide again: both strokes exactly where they were drawn.
  await setWindowSize(app, page, SIZE.width, SIZE.height)
  await expect.poll(() => inkAt(page, 840, 320)).toBeGreaterThan(200)
  expect(await inkAt(page, 200, 510)).toBeGreaterThan(200)
  expect(await inkAt(page, 840, 360)).toBe(0)

  // Ctrl+Enter finishes the drawing; the note stays open.
  await page.keyboard.press('Control+Enter')
  await expect(space(page)).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await waitForImages(page, '.focus-editor .image-node img', 1)
  const ratio = await page.evaluate(() => window.devicePixelRatio)
  const natural = await images(page).first().locator('img').evaluate((element) => (element as HTMLImageElement).naturalWidth)
  expect(natural / ratio).toBeGreaterThan(800)

  // With the space closed, Ctrl+Enter logs the note again.
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page)).toHaveCount(1)
  expect(errors).toEqual([])
  await ctx.quit()
})

/** True when the keyboard is somewhere inside the drawing space. */
const keyboardInSpace = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('[data-testid="drawing-space"]') != null)

/** Colour of the top-left pixel of an attachment's original file, read back through the attachment scheme. */
async function cornerPixel(page: Page, attachmentId: string): Promise<number[]> {
  return page.evaluate(async (id) => {
    const picture = new Image()
    picture.crossOrigin = 'anonymous'
    picture.src = `tn-attachment://file/${encodeURIComponent(id)}?v=full`
    await picture.decode()
    const canvas = new OffscreenCanvas(picture.naturalWidth, picture.naturalHeight)
    const context = canvas.getContext('2d')!
    context.drawImage(picture, 0, 0)
    return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3))
  }, attachmentId)
}

test('the keyboard never leaves the drawing space; an edited drawing keeps the colours it was drawn in', async () => {
  const ctx = await launch({ size: SIZE })
  const errors = await collectConsoleErrors(ctx.page)
  const { page, app } = ctx
  await clickEmptySpace(page)
  await page.keyboard.type('Drawn in charcoal')
  await openDrawingSpace(page)
  await draw(page, [
    [200, 400],
    [600, 400]
  ])

  // A focused button that turns disabled (Clear, with nothing left to clear) keeps Tab inside.
  await tool(page, 'Clear').focus()
  await page.keyboard.press('Enter')
  await expect(tool(page, 'Clear')).toBeDisabled()
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    expect(await keyboardInSpace(page), `after ${key}`).toBe(true)
  }
  await page.keyboard.press('Control+z')
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)

  // Hidden to the tray from the title bar and shown again: the drawing is still there, and
  // from the title bar's buttons Tab goes into the drawing tools, never to the note behind
  // or to the menu (which would open on top of the drawing).
  await page.getByTestId('hide-window').click()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false)
  await app.evaluate(() => (globalThis as unknown as { __tnTest: { windows: { toggle: () => void } } }).__tnTest.windows.toggle())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true)
  await expect(space(page)).toBeVisible()
  expect(await inkAt(page, 400, 400)).toBeGreaterThan(200)
  for (const key of ['Tab', 'Shift+Tab']) {
    await page.getByTestId('hide-window').focus()
    await page.keyboard.press(key)
    expect(await keyboardInSpace(page), `${key} from the title bar`).toBe(true)
  }
  // Shift+Tab from Minimize would otherwise land on the menu button.
  await page.getByRole('button', { name: 'Minimize' }).focus()
  await page.keyboard.press('Shift+Tab')
  expect(await keyboardInSpace(page)).toBe(true)
  await expect(page.getByTestId('gear')).not.toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(editorBody(page)).toHaveText('Drawn in charcoal')

  await tool(page, 'Done').click()
  await waitForImages(page, '.focus-editor .image-node img', 1)
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const [charcoal] = imagesIn((await storedNotes(app))[0]!.content as StoredImage)
  expect(await cornerPixel(page, charcoal!.attrs!.attachmentId)).toEqual([37, 38, 42])

  // The app moves to the light theme. The dark drawing is edited on its own dark sheet, in
  // its own light ink (in the light theme's ink it would all but vanish), and stays dark.
  await page.getByTestId('gear').click()
  await page.getByRole('menuitem', { name: /^Settings/ }).click()
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Paper' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper')
  await page.keyboard.press('Escape')
  await notes(page).first().locator('.prose p').first().click()
  await waitForImages(page, '.focus-editor .image-node img', 1)
  await images(page).first().locator('img').hover()
  await images(page).first().getByRole('button', { name: 'Edit drawing' }).click()
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(300)
  await expect(space(page)).toHaveAttribute('data-sheet-theme', 'charcoal')
  expect(await space(page).evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(37, 38, 42)')
  const opened = (await space(page).boundingBox())!
  const line = await page.getByTestId('drawing-ink').evaluate((element) => {
    // The brightest pixel of the reopened line: its own light ink, solid.
    const canvas = element as HTMLCanvasElement
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let best = [0, 0, 0, 0]
    for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 250 && data[i]! > best[0]!) best = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]
    return best
  })
  expect(line[0]!).toBeGreaterThan(200)
  // New ink is in the drawing's own colours too.
  await draw(page, [
    [opened.x + 200, opened.y + 700],
    [opened.x + 600, opened.y + 700]
  ])
  expect((await colorAt(page, opened.x + 400, opened.y + 700))[0]!).toBeGreaterThan(200)
  await page.keyboard.press('Control+Enter')
  await expect(space(page)).toBeHidden()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const [edited] = imagesIn((await storedNotes(app))[0]!.content as StoredImage)
  expect(edited!.attrs!.attachmentId).not.toBe(charcoal!.attrs!.attachmentId)
  expect(await cornerPixel(page, edited!.attrs!.attachmentId)).toEqual([37, 38, 42])

  // A new drawing is made on the light sheet.
  await clickEmptySpace(page)
  await openDrawingSpace(page)
  await expect(space(page)).toHaveAttribute('data-sheet-theme', 'paper')
  await draw(page, [
    [300, 300],
    [500, 320]
  ])
  await page.keyboard.press('Control+Enter')
  await waitForImages(page, '.focus-editor .image-node img', 1)
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  const paper = (await storedNotes(app)).flatMap((note) => imagesIn(note.content as StoredImage)).find((image) => image.attrs!.attachmentId !== edited!.attrs!.attachmentId)!
  expect(await cornerPixel(page, paper.attrs!.attachmentId)).toEqual([245, 243, 237])
  expect(errors).toEqual([])
  await ctx.quit()
})

test('the formatting bar folds away behind a small arrow, everything still works, and the choice is remembered', async () => {
  const dataDir = freshDataDir()
  let ctx = await launch({ dataDir, size: SIZE })
  const errors = await collectConsoleErrors(ctx.page)
  let { page } = ctx
  await clickEmptySpace(page)
  await page.keyboard.type('Folded bar')
  await expect(formatBar(page)).toBeVisible()
  const hide = page.getByRole('button', { name: 'Hide formatting' })
  await expect(hide).toHaveAttribute('aria-expanded', 'true')
  const roomBefore = await page.locator('.focus-scroll').evaluate((element) => element.clientHeight)

  await hide.click()
  const show = page.getByRole('button', { name: 'Show formatting' })
  await expect(show).toHaveAttribute('aria-expanded', 'false')
  await expect(formatBar(page)).toBeHidden()
  // The note gets the room, and the keyboard stayed in the text.
  await expect.poll(() => page.locator('.focus-scroll').evaluate((element) => element.clientHeight)).toBeGreaterThan(roomBefore + 25)
  await expect(editorBody(page)).toBeFocused()

  // Shortcuts and the selection bar work as before.
  await page.keyboard.press('Control+a')
  await expect(page.getByRole('toolbar', { name: 'Selection formatting' })).toBeVisible()
  await page.keyboard.press('Control+b')
  await expect(editorBody(page).locator('strong')).toHaveText('Folded bar')
  await page.keyboard.press('Control+Shift+D')
  await expect(space(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(space(page)).toBeHidden()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  expect(errors).toEqual([])
  await ctx.quit()

  // ---- restart: still folded away, until the arrow brings it back.
  ctx = await launch({ dataDir, size: SIZE })
  ;({ page } = ctx)
  await notes(page).first().locator('.prose p').first().click()
  await expect(focusView(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show formatting' })).toHaveAttribute('aria-expanded', 'false')
  await expect(formatBar(page)).toBeHidden()
  await page.getByRole('button', { name: 'Show formatting' }).click()
  await expect(formatBar(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Hide formatting' })).toHaveAttribute('aria-expanded', 'true')
  // A bar button that has the keyboard when the bar folds away hands it back to the text.
  await formatBar(page).getByRole('button', { name: 'Bold' }).focus()
  await page.getByRole('button', { name: 'Hide formatting' }).click()
  await expect(formatBar(page)).toBeHidden()
  await expect(editorBody(page)).toBeFocused()
  await page.getByRole('button', { name: 'Show formatting' }).click()
  await expect(formatBar(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await ctx.quit()

  ctx = await launch({ dataDir, size: SIZE })
  ;({ page } = ctx)
  await notes(page).first().locator('.prose p').first().click()
  await expect(formatBar(page)).toBeVisible()
  await ctx.quit()
  removeDataDir(dataDir)
})

test('after a button in the selection bar was used, moving the keyboard to the title takes the bar away', async () => {
  const ctx = await launch({ size: SIZE })
  const { page } = ctx
  await clickEmptySpace(page)
  await page.keyboard.type('Mark the retest level')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  const bubble = page.getByRole('toolbar', { name: 'Selection formatting' })
  await expect(bubble).toBeVisible()
  await bubble.getByRole('button', { name: 'Bold' }).click()
  await expect(editorBody(page).locator('strong')).toHaveText('level')
  await expect(bubble).toBeVisible()

  await page.locator('.focus-title').click()
  await expect(page.locator('.focus-title')).toBeFocused()
  await expect(bubble).toBeHidden()

  // It still comes back for the next selection.
  await editorBody(page).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await expect(bubble).toBeVisible()
  await page.keyboard.press('Escape')
  await ctx.quit()
})
