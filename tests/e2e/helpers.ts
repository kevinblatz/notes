import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'

export const board = (page: Page): Locator => page.getByTestId('board')
export const notes = (page: Page): Locator => page.locator('.board > .note')
export const focusView = (page: Page): Locator => page.getByTestId('focus-view')
export const editorBody = (page: Page): Locator => page.locator('.focus-editor .ProseMirror')

/** A point in the open space below the last note (board coordinates). */
export async function emptyPointBelow(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="board"]')!
    const cards = Array.from(element.querySelectorAll<HTMLElement>(':scope > .note'))
    const bottom = cards.reduce((max, card) => Math.max(max, card.offsetTop + card.offsetHeight), 0)
    return { x: Math.round(element.clientWidth / 2), y: bottom + 90 }
  })
}

export async function clickEmptySpace(page: Page): Promise<void> {
  const point = await emptyPointBelow(page)
  await board(page).click({ position: point })
}

/** Create a note by clicking empty space, typing paragraphs, and logging it. */
export async function writeNote(page: Page, paragraphs: string[], options: { title?: string } = {}): Promise<void> {
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  if (options.title) {
    await page.locator('.focus-title').fill(options.title)
    await editorBody(page).click()
  }
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index > 0) await page.keyboard.press('Enter')
    await page.keyboard.type(paragraph)
  }
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
}

/** First line of every note on the board, in reading order. */
export async function boardLabels(page: Page): Promise<string[]> {
  return notes(page).evaluateAll((cards) => cards.map((card) => (card.querySelector('.note-title')?.textContent ?? card.querySelector('.prose > *')?.textContent ?? '').trim()))
}

interface TestHandle {
  library: {
    db: { getLayout: () => { rows: Array<{ id: string; notes: string[] }> }; getPins: () => string[]; countTrash: () => number }
    listLive: () => Array<{ id: string; title: string | null; plainText: string; content: unknown; revision: number; tags: string[] }>
  }
  windows: { toggle: () => void; isShown: () => boolean; reconcileDisplays: () => void; dockTo: (side: 'left' | 'right') => void; status: () => unknown }
  shortcuts: { status: () => { accelerator: string; registered: boolean; error: string | null } }
  testHooks: { failSaves: boolean }
  quit: () => Promise<void>
}
export type { TestHandle }

/** Board layout as stored in the database, with note IDs replaced by each note's first line. */
export async function storedLayout(app: ElectronApplication): Promise<string[][]> {
  return app.evaluate(() => {
    const { library } = (globalThis as unknown as { __tnTest: TestHandle }).__tnTest
    const label = new Map(library.listLive().map((note) => [note.id, (note.title ?? note.plainText.split('\n')[0] ?? '').trim()]))
    return library.db.getLayout().rows.map((row) => row.notes.map((id) => label.get(id) ?? `?${id}`))
  })
}

export async function storedNotes(app: ElectronApplication): Promise<Array<{ title: string | null; plainText: string; content: unknown; tags: string[] }>> {
  return app.evaluate(() => {
    const { library } = (globalThis as unknown as { __tnTest: TestHandle }).__tnTest
    return library.listLive().map((note) => ({ title: note.title, plainText: note.plainText, content: note.content, tags: note.tags }))
  })
}

export const noteByText = (page: Page, text: string): Locator => notes(page).filter({ hasText: text }).first()

/**
 * Layout boxes of several notes, read in one call and in the board's own coordinates.
 * Unlike boundingBox(), these are not affected by a transition that is still settling,
 * and all notes are measured at the same instant.
 */
export async function layoutBoxes(page: Page, texts: string[]): Promise<Record<string, { x: number; y: number; width: number; height: number }>> {
  return page.evaluate((wanted) => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.board > .note'))
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {}
    for (const text of wanted) {
      const card = cards.find((element) => element.textContent?.includes(text))
      if (!card) throw new Error(`No note contains "${text}"`)
      out[text] = { x: card.offsetLeft, y: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight }
    }
    return out
  }, texts)
}

/**
 * Drag a note by its handle to a point given relative to another note's box
 * (fx, fy are fractions of that note's width and height).
 */
export async function dragNote(page: Page, sourceText: string, targetText: string, fx: number, fy: number): Promise<void> {
  const source = noteByText(page, sourceText)
  await source.scrollIntoViewIfNeeded()
  await source.hover({ position: { x: 30, y: 12 } })
  const handle = source.locator('.note-handle')
  const from = (await handle.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 - 6, from.y + from.height / 2 + 8, { steps: 3 })
  await expect(page.locator('.board.is-dragging')).toBeVisible()
  // Like a person would: pick a spot on the target note, move there, and hold still while
  // the board reflows around the pointer.
  const box = (await noteByText(page, targetText).boundingBox())!
  const x = box.x + box.width * fx
  const y = box.y + box.height * fy
  await page.mouse.move(x, y, { steps: 10 })
  await page.waitForTimeout(150)
  await page.mouse.move(x + 1, y + 1, { steps: 2 })
  await page.waitForTimeout(200)
  await page.mouse.up()
  await expect(page.locator('.board.is-dragging')).toHaveCount(0)
  await page.waitForTimeout(250)
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, tail])
}

/** A real PNG with a colour gradient (so previews and resizing have something to show). */
export function makePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((1 + width * 3) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3)
    for (let x = 0; x < width; x++) {
      const shade = 0.55 + 0.45 * ((x / width + y / height) / 2)
      raw[rowStart + 1 + x * 3] = Math.round(rgb[0] * shade)
      raw[rowStart + 2 + x * 3] = Math.round(rgb[1] * shade)
      raw[rowStart + 3 + x * 3] = Math.round(rgb[2] * shade)
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())])
}

/** Put an image on the system clipboard, as a screenshot tool would. */
export async function copyImageToClipboard(app: ElectronApplication, png: Buffer): Promise<void> {
  await app.evaluate(async ({ clipboard, ClipboardItem }, base64) => {
    clipboard.clear()
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' }) })])
  }, png.toString('base64'))
}

/** Put rich text on the system clipboard, as copying from a web page would. */
export async function copyHtmlToClipboard(app: ElectronApplication, html: string, text: string): Promise<void> {
  await app.evaluate(async ({ clipboard, ClipboardItem }, value) => {
    clipboard.clear()
    await clipboard.write([new ClipboardItem({ 'text/html': value.html, 'text/plain': value.text })])
  }, { html, text })
}

export async function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

export async function collectConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  return errors
}
