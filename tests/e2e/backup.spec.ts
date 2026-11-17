import { expect, test } from './fixtures'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { boardLabels, clickEmptySpace, collectConsoleErrors, copyImageToClipboard, dragNote, editorBody, focusView, makePng, noteByText, notes, writeNote } from './helpers'
import { freshDataDir, launch, removeDataDir, type Launched } from './launch'

/**
 * Backup export and import (requirement 8, acceptance check 10b), driven through the real
 * interface: gear -> Backup and import. Only the native file dialogs are answered from the
 * test, because nothing can click them here.
 */

const SIZE = { width: 960, height: 1000 }
const RED = makePng(640, 360, [220, 70, 60])
const BLUE = makePng(2400, 1350, [60, 110, 220])
const GREEN = makePng(480, 270, [70, 180, 90])
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

// ------------------------------------------------------------------ temp files

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
test.afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ zip files

async function writeZip(path: string, files: Record<string, Buffer | string>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [name, body] of Object.entries(files)) zip.addBuffer(Buffer.isBuffer(body) ? body : Buffer.from(body), name)
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(path))
}

function readZip(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('not a zip file'))
        return
      }
      const files = new Map<string, Buffer>()
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`cannot read ${entry.fileName}`))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('error', reject)
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks))
            zip.readEntry()
          })
        })
      })
      zip.once('end', () => resolve(files))
      zip.once('error', reject)
      zip.readEntry()
    })
  })
}

// ------------------------------------------------------------------ stored data

interface StoredNote {
  title: string | null
  plainText: string
  captions: string
  content: unknown
  tags: string[]
  collapsed: boolean
  createdAt: number
  updatedAt: number
  revision: number
}

/** What the database holds, with note IDs replaced by each note's label (title or first line). */
interface Stored {
  notes: StoredNote[]
  layout: string[][]
  pins: string[]
  trash: Array<{ label: string; imageCount: number }>
  preferences: Record<string, unknown>
}

interface MainHandle {
  library: {
    listLive: () => Array<StoredNote & { id: string }>
    listTrash: () => Array<{ id: string; label: string; imageCount: number }>
    getPreferences: () => Record<string, unknown>
    db: { getLayout: () => { rows: Array<{ id: string; notes: string[] }> }; getPins: () => string[] }
  }
}

async function storedState(app: ElectronApplication): Promise<Stored> {
  return app.evaluate(() => {
    const { library } = (globalThis as unknown as { __tnTest: MainHandle }).__tnTest
    const live = library.listLive()
    const label = new Map(live.map((note) => [note.id, (note.title ?? note.plainText.split('\n')[0] ?? '').trim()]))
    return {
      notes: live.map((note) => ({
        title: note.title,
        plainText: note.plainText,
        captions: note.captions,
        content: note.content,
        tags: note.tags,
        collapsed: note.collapsed,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        revision: note.revision
      })),
      layout: library.db.getLayout().rows.map((row) => row.notes.map((id) => label.get(id) ?? `?${id}`)),
      pins: library.db.getPins().map((id) => label.get(id) ?? `?${id}`),
      trash: library.listTrash().map((entry) => ({ label: entry.label, imageCount: entry.imageCount })),
      preferences: library.getPreferences()
    }
  })
}

const attachmentsDir = (dataDir: string): string => join(dataDir, 'library', 'attachments')
const backupsDir = (dataDir: string): string => join(dataDir, 'library', 'backups')

/** Every file in the managed attachments folder (originals and previews) with its hash. */
function attachmentFiles(dataDir: string): Record<string, string> {
  const dir = attachmentsDir(dataDir)
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) out[name] = sha256(readFileSync(join(dir, name)))
  return out
}

function safetyBackups(dataDir: string): string[] {
  const dir = backupsDir(dataDir)
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.tnbackup')).sort() : []
}

// ------------------------------------------------------------------ native dialogs

interface DialogLog {
  save: Array<{ defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }>
  open: Array<{ filters?: Array<{ name: string; extensions: string[] }> }>
  shown: string[]
}

/** Answer the native Save dialog: a path, or null for Cancel. */
async function answerSaveDialog(app: ElectronApplication, filePath: string | null): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    const scope = globalThis as unknown as { __tnDialogs?: DialogLog }
    const log = (scope.__tnDialogs ??= { save: [], open: [], shown: [] })
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      log.save.push(args[args.length - 1] as DialogLog['save'][number])
      return target ? { canceled: false, filePath: target } : { canceled: true, filePath: '' }
    }) as unknown as typeof dialog.showSaveDialog
  }, filePath)
}

/** Answer the native Open dialog: a path, or null for Cancel. */
async function answerOpenDialog(app: ElectronApplication, filePath: string | null): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    const scope = globalThis as unknown as { __tnDialogs?: DialogLog }
    const log = (scope.__tnDialogs ??= { save: [], open: [], shown: [] })
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      log.open.push(args[args.length - 1] as DialogLog['open'][number])
      return target ? { canceled: false, filePaths: [target] } : { canceled: true, filePaths: [] }
    }) as unknown as typeof dialog.showOpenDialog
  }, filePath)
}

/** "Show file" would open a file manager; record which file it points at instead. */
async function recordShownFiles(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const scope = globalThis as unknown as { __tnDialogs?: DialogLog }
    const log = (scope.__tnDialogs ??= { save: [], open: [], shown: [] })
    shell.showItemInFolder = (path: string) => {
      log.shown.push(path)
    }
  })
}

async function dialogLog(app: ElectronApplication): Promise<DialogLog> {
  return app.evaluate(() => (globalThis as unknown as { __tnDialogs?: DialogLog }).__tnDialogs ?? { save: [], open: [], shown: [] })
}

// ------------------------------------------------------------------ interface helpers

const sheet = (page: Page): Locator => page.getByTestId('backup')
const preview = (page: Page): Locator => page.getByTestId('import-preview')
const importResult = (page: Page): Locator => page.getByTestId('import-result')
const runImport = (page: Page): Locator => page.getByTestId('run-import')
const addChoice = (page: Page): Locator => preview(page).getByRole('radio', { name: /^Add to my notes/ })
const replaceChoice = (page: Page): Locator => preview(page).getByRole('radio', { name: /^Replace my notes with this backup/ })
const panelError = (page: Page): Locator => sheet(page).getByRole('alert')

async function openGearItem(page: Page, name: RegExp): Promise<void> {
  const item = page.getByRole('menuitem', { name })
  // The menu closes when the board scrolls. Right after a note is logged the board may still
  // be scrolling it into view, so open the menu again if it closed, as a person would.
  await expect(async () => {
    if (!(await item.isVisible())) await page.getByTestId('gear').click()
    await item.click({ timeout: 2000 })
  }).toPass({ timeout: 15_000 })
}

async function openBackupPanel(page: Page): Promise<void> {
  await openGearItem(page, /Backup and import/)
  await expect(sheet(page)).toBeVisible()
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.sheet, .palette')).toHaveCount(0)
}

/** Click "Choose backup file…" with the native dialog answering `file`. */
async function chooseBackupFile(ctx: Launched, file: string | null): Promise<void> {
  await answerOpenDialog(ctx.app, file)
  await ctx.page.getByTestId('choose-backup').click()
}

/** The Pinned notes index as the gear menu shows it, top to bottom. */
async function pinnedIndex(page: Page): Promise<string[]> {
  await openGearItem(page, /^Pinned notes/)
  await expect(page.getByTestId('palette')).toBeVisible()
  const labels = await page.getByTestId('palette').locator('.pin-row .pin-open .result-label').allTextContents()
  await closePanel(page)
  return labels
}

/** What the Trash panel lists. */
async function trashPanel(page: Page): Promise<Array<{ label: string; meta: string }>> {
  await openGearItem(page, /^Trash/)
  const panel = page.getByTestId('trash')
  await expect(panel.locator('.setting-help').first()).toBeVisible()
  const rows = await panel.locator('.trash-row').evaluateAll((elements) =>
    elements.map((row) => ({ label: row.querySelector('.result-label')?.textContent ?? '', meta: row.querySelector('.trash-meta')?.textContent ?? '' }))
  )
  await closePanel(page)
  return rows
}

/** Scroll every matching image into view and wait until it has really decoded. */
async function expectImagesLoaded(page: Page, selector: string, count: number): Promise<void> {
  const images = page.locator(selector)
  await expect(images).toHaveCount(count)
  for (let index = 0; index < count; index++) {
    const image = images.nth(index)
    await image.scrollIntoViewIfNeeded()
    await expect.poll(async () => image.evaluate((element) => (element as HTMLImageElement).naturalWidth), { message: `image ${index + 1} of ${count} loads` }).toBeGreaterThan(0)
  }
}

async function expectSideBySide(page: Page, left: string, right: string): Promise<void> {
  const a = (await noteByText(page, left).boundingBox())!
  const b = (await noteByText(page, right).boundingBox())!
  expect(Math.abs(a.y - b.y), `"${left}" and "${right}" share a row`).toBeLessThan(2)
  expect(b.x, `"${right}" sits to the right of "${left}"`).toBeGreaterThan(a.x + a.width - 1)
}

async function pin(page: Page, text: string): Promise<void> {
  const note = noteByText(page, text)
  await note.hover({ position: { x: 60, y: 14 } })
  await note.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(note).toHaveClass(/is-pinned/)
}

async function moveToTrash(page: Page, text: string): Promise<void> {
  const note = noteByText(page, text)
  await note.hover({ position: { x: 60, y: 14 } })
  await note.getByRole('button', { name: 'Note actions' }).click()
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(notes(page).filter({ hasText: text })).toHaveCount(0)
}

async function restoreFromTrash(page: Page, label: string): Promise<void> {
  await openGearItem(page, /^Trash/)
  await page.getByTestId('trash').locator('.trash-row', { hasText: label }).getByTestId('restore-note').click()
  await closePanel(page)
  await expect(noteByText(page, label)).toBeVisible()
}

async function pasteScreenshot(ctx: Launched, png: Buffer, expectedInEditor: number): Promise<void> {
  await copyImageToClipboard(ctx.app, png)
  await ctx.page.keyboard.press('Control+v')
  await expectImagesLoaded(ctx.page, '.image-node img', expectedInEditor)
}

async function logNote(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Log note/ }).click()
  await expect(focusView(page)).toBeHidden()
}

/** How the formatted note looks on the board: the real, computed appearance. */
async function richNoteLook(page: Page): Promise<Record<string, unknown>> {
  const note = noteByText(page, 'London rules')
  await note.scrollIntoViewIfNeeded()
  return note.evaluate((card) => {
    const styled = Array.from(card.querySelectorAll('.prose p')).find((paragraph) => paragraph.textContent === 'Styled words') ?? null
    let leaf: Element | null = styled
    while (leaf && leaf.children.length > 0) leaf = leaf.children[0]!
    const style = leaf ? getComputedStyle(leaf) : null
    const mark = styled?.querySelector('mark') ?? null
    return {
      title: card.querySelector('.note-title')?.textContent ?? null,
      heading: card.querySelector('.prose h2')?.textContent ?? null,
      styledHtml: styled?.innerHTML ?? null,
      family: style?.fontFamily ?? null,
      size: style?.fontSize ?? null,
      color: style?.color ?? null,
      weight: style ? Number(style.fontWeight) : null,
      highlight: mark ? getComputedStyle(mark).backgroundColor : null,
      bold: Array.from(card.querySelectorAll('.prose strong')).map((element) => element.textContent),
      tasks: Array.from(card.querySelectorAll('li[data-type="taskItem"]')).map((item) => ({ text: item.textContent, checked: item.querySelector('input')?.checked ?? null })),
      tags: Array.from(card.querySelectorAll('.note-tags span')).map((element) => element.textContent),
      plainSize: getComputedStyle(card.querySelector('.prose p:last-of-type') ?? card).fontSize,
      plainColor: getComputedStyle(card.querySelector('.prose p:last-of-type') ?? card).color
    }
  })
}

/** Width, caption and decoded size of each image in the screenshots note, as shown on the board. */
async function screenshotsLook(page: Page): Promise<Array<{ width: string; caption: string; natural: number }>> {
  return noteByText(page, 'Screens above')
    .locator('.note-image')
    .evaluateAll((figures) =>
      figures.map((figure) => ({
        width: (figure as HTMLElement).style.width,
        caption: figure.querySelector('figcaption')?.textContent ?? '',
        natural: figure.querySelector('img')?.naturalWidth ?? 0
      }))
    )
}

async function appearance(page: Page): Promise<{ theme: string | undefined; noteSize: string; ground: string }> {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    noteSize: document.documentElement.style.getPropertyValue('--note-size'),
    ground: getComputedStyle(document.body).backgroundColor
  }))
}

// ------------------------------------------------------------------ the source collection

interface Source {
  dataDir: string
  file: string
  state: Stored
  labels: string[]
  files: Record<string, string>
  richLook: Record<string, unknown>
  screenshots: Array<{ width: string; caption: string; natural: number }>
  appearance: { theme: string | undefined; noteSize: string; ground: string }
  defaultGround: string
  pinsBeforeReorder: string[]
  pinsShown: string[]
  errors: string[]
  cancelled: { dialogCalls: number; filesWritten: string[]; statusLines: number; alerts: number; stateUnchanged: boolean; buttonEnabled: boolean }
  exported: { line: string; dialog: DialogLog['save'][number] | undefined; showsFile: boolean }
}

/**
 * Build a collection the way a person would: a formatted note, a note with two screenshots,
 * a side-by-side pair, two pins in a chosen order, a trashed note and changed settings.
 */
async function buildCollection(ctx: Launched): Promise<{ pinsBeforeReorder: string[]; pinsShown: string[]; defaultGround: string }> {
  const { page, app } = ctx
  const bar = page.getByRole('toolbar', { name: 'Formatting', exact: true })
  const pick = async (control: string, item: string): Promise<void> => {
    await bar.getByRole('button', { name: control }).click()
    await page.getByRole('menuitemcheckbox', { name: item, exact: true }).click()
  }
  const defaultGround = (await appearance(page)).ground

  // 1. A note with a title, a tag and every kind of formatting the backup has to carry.
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.locator('.focus-title').fill('London rules')
  await page.keyboard.press('Enter')
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.type('Session plan')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Styled words')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Wait for ')
  await page.keyboard.press('Control+b')
  await page.keyboard.type('confirmation')
  await page.keyboard.press('Control+b')
  await page.keyboard.type(' before entry.')
  await page.keyboard.press('Enter')
  await bar.getByRole('button', { name: 'Checklist' }).click()
  await page.keyboard.type('Check the calendar')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Mark the levels')
  await editorBody(page).locator('p', { hasText: 'Session plan' }).click()
  await pick('Paragraph style', 'Heading 2')
  await editorBody(page).locator('p', { hasText: 'Styled words' }).click({ clickCount: 3 })
  await pick('Font', 'Literata')
  await pick('Text size', '22')
  await bar.getByRole('button', { name: 'Text color' }).click()
  await page.getByRole('group', { name: 'Text color' }).getByRole('button', { name: 'red' }).click()
  await bar.getByRole('button', { name: 'Highlight' }).click()
  await page.getByRole('group', { name: 'Highlight color' }).getByRole('button', { name: 'teal' }).click()
  await bar.getByRole('button', { name: 'Bold' }).click()
  await page.locator('.tag-add').click()
  await page.getByLabel('New tag').fill('Rules')
  await page.keyboard.press('Enter')
  await logNote(page)
  // Tick the first checklist item on the board.
  await noteByText(page, 'London rules').locator('li[data-type="taskItem"] input').first().check()

  // 2. Two notes arranged side by side, the later one on the left.
  await writeNote(page, ['Alpha setup', 'Buy the first pullback.'])
  await writeNote(page, ['Bravo setup', 'Fade the failed breakout.'])
  await dragNote(page, 'Bravo setup', 'Alpha setup', 0.06, 0.5)

  // 3. Screenshots: one pasted, one through the file picker with a caption and a smaller width.
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Screens above')
  await page.keyboard.press('Enter')
  await pasteScreenshot(ctx, RED, 1)
  await page.keyboard.type('Between the screenshots')
  await page.getByTestId('image-input').setInputFiles({ name: 'nq-london.png', mimeType: 'image/png', buffer: BLUE })
  await expectImagesLoaded(page, '.image-node img', 2)
  await page.keyboard.type('Below both')
  const second = page.locator('.image-node').nth(1)
  await second.locator('img').click()
  await second.locator('.image-caption').fill('NQ 5 minute, London open')
  await second.locator('.image-resize').focus()
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft')
  await expect(second.locator('.image-resize')).toHaveAttribute('aria-valuenow', '80')
  await logNote(page)

  // 4. A note with its own screenshot that ends up in Trash, and one more note after it.
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Trashed idea')
  await page.keyboard.press('Enter')
  await pasteScreenshot(ctx, GREEN, 1)
  await logNote(page)
  await writeNote(page, ['Echo closing note', 'Flat by the close.'])
  await moveToTrash(page, 'Trashed idea')

  // 5. Two pins, then put them in a chosen order in the pinned index (keyboard: Space, arrow, Space).
  await pin(page, 'London rules')
  await pin(page, 'Echo closing note')
  await openGearItem(page, /^Pinned notes/)
  const rows = page.getByTestId('pin-list').locator('.pin-open .result-label')
  await expect(rows).toHaveText(['London rules', 'Echo closing note'])
  const pinsBeforeReorder = await rows.allTextContents()
  await page.getByRole('button', { name: 'Reorder London rules' }).focus()
  await page.keyboard.press('Space')
  await page.waitForTimeout(150)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)
  await page.keyboard.press('Space')
  await expect(rows).toHaveText(['Echo closing note', 'London rules'])
  const pinsShown = await rows.allTextContents()
  await closePanel(page)

  // 6. Settings: another theme and a larger default text size.
  await openGearItem(page, /^Settings/)
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Midnight' }).click()
  await page.getByLabel('Default text size').selectOption('19')
  await expect.poll(async () => (await storedState(app)).preferences).toMatchObject({ theme: 'midnight', fontSize: 19 })
  await closePanel(page)
  return { pinsBeforeReorder, pinsShown, defaultGround }
}

/** Build the collection, try a cancelled export, then export for real. Observations only; the tests assert. */
async function makeSource(): Promise<Source> {
  const dataDir = tempDir('tn-backup-source-')
  const exportDir = tempDir('tn-backup-export-')
  const file = join(exportDir, 'Trading Notes round trip.tnbackup')
  const ctx = await launch({ dataDir, size: SIZE })
  const errors = await collectConsoleErrors(ctx.page)
  const { page, app } = ctx
  const built = await buildCollection(ctx)

  const before = await storedState(app)
  await openBackupPanel(page)

  // Cancel in the Save dialog.
  await answerSaveDialog(app, null)
  await page.getByTestId('export-backup').click()
  await expect.poll(async () => (await dialogLog(app)).save.length).toBe(1)
  await expect(sheet(page).getByText('Exporting…')).toHaveCount(0)
  const cancelled = {
    dialogCalls: (await dialogLog(app)).save.length,
    filesWritten: readdirSync(exportDir),
    statusLines: await sheet(page).locator('.setting-success').count(),
    alerts: await panelError(page).count(),
    stateUnchanged: JSON.stringify(await storedState(app)) === JSON.stringify(before),
    buttonEnabled: await page.getByTestId('export-backup').isEnabled()
  }

  // Export for real.
  await answerSaveDialog(app, file)
  await page.getByTestId('export-backup').click()
  const line = sheet(page).locator('.setting-success')
  await expect(line).toBeVisible()
  const exported = {
    line: (await line.innerText()).replace(/\s+/g, ' ').trim(),
    dialog: (await dialogLog(app)).save[1],
    showsFile: await line.getByRole('button', { name: 'Show file' }).isVisible()
  }
  await closePanel(page)

  await expectImagesLoaded(page, '.note .note-image img', 2)
  const source: Source = {
    dataDir,
    file,
    state: await storedState(app),
    labels: await boardLabels(page),
    files: {},
    richLook: await richNoteLook(page),
    screenshots: await screenshotsLook(page),
    appearance: await appearance(page),
    errors,
    cancelled,
    exported,
    ...built
  }
  await ctx.quit()
  source.files = attachmentFiles(dataDir)
  return source
}

let cachedSource: Promise<Source> | null = null
/** The exported source collection, built once per worker and shared by the tests that import it. */
function sourceBackup(): Promise<Source> {
  cachedSource ??= makeSource()
  return cachedSource
}

/** Everything a person can see, and everything stored, is the source collection again. */
async function expectSameAsSource(ctx: Launched, source: Source): Promise<void> {
  const { page, app, dataDir } = ctx
  // Stored data: notes with their exact rich-text JSON, the arrangement, pins, Trash, settings.
  const state = await storedState(app)
  expect(state.notes.map((note) => note.title ?? note.plainText.split('\n')[0])).toEqual(source.state.notes.map((note) => note.title ?? note.plainText.split('\n')[0]))
  for (const [index, note] of source.state.notes.entries()) {
    expect(JSON.stringify(state.notes[index]!.content), `rich-text JSON of "${note.title ?? note.plainText.split('\n')[0]}"`).toBe(JSON.stringify(note.content))
  }
  expect(state).toEqual(source.state)

  // On screen: same notes in the same places.
  expect(await boardLabels(page)).toEqual(source.labels)
  await expectSideBySide(page, 'Bravo setup', 'Alpha setup')

  // Images really load, at the stored widths, with their captions.
  await expectImagesLoaded(page, '.note .note-image img', 2)
  expect(await screenshotsLook(page)).toEqual(source.screenshots)
  await expect(noteByText(page, 'Screens above').locator('figcaption')).toHaveText('NQ 5 minute, London open')
  await expect(noteByText(page, 'Screens above').locator('.prose > p')).toHaveText(['Screens above', 'Between the screenshots', 'Below both'])
  await expect(page.locator('.note-image[data-missing]')).toHaveCount(0)

  // Formatting looks the same.
  expect(await richNoteLook(page)).toEqual(source.richLook)

  // Image files: the same originals and previews, byte for byte.
  expect(attachmentFiles(dataDir)).toEqual(source.files)

  // Settings took effect in the window.
  expect(await appearance(page)).toEqual(source.appearance)

  // Pinned index order and Trash, as the menus show them.
  expect(await pinnedIndex(page)).toEqual(source.pinsShown)
  const trash = await trashPanel(page)
  expect(trash.map((row) => row.label)).toEqual(['Trashed idea'])
  expect(trash[0]!.meta).toContain('1 image')
  await expect(page.getByTestId('gear')).toBeVisible()
}

// ------------------------------------------------------------------ hand-made backup files

interface CraftedNote {
  id: string
  text: string
  images?: string[]
  /** Further blocks appended to the note exactly as given (used for hostile content). */
  blocks?: unknown[]
}

function craftedBackup(options: { notes: CraftedNote[]; attachments: Array<{ id: string; file: string; bytes: Buffer }>; manifest?: Record<string, unknown> }): { manifest: string; data: string } {
  const now = Date.now()
  const manifest = {
    format: 'trading-notes-backup',
    formatVersion: 1,
    schemaVersion: 1,
    appVersion: '0.1.0',
    createdAt: now,
    counts: { notes: options.notes.length, trashed: 0, attachments: options.attachments.length, pins: 0 },
    attachments: options.attachments.map((attachment) => ({
      id: attachment.id,
      file: attachment.file,
      preview: null,
      mime: 'image/png',
      byteSize: attachment.bytes.length,
      width: 480,
      height: 270,
      sha256: sha256(attachment.bytes),
      originalName: null,
      createdAt: now
    })),
    ...options.manifest
  }
  const data = {
    notes: options.notes.map((note, index) => ({
      id: note.id,
      kind: 'note',
      title: null,
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: note.text }] },
          ...(note.images ?? []).map((attachmentId) => ({ type: 'noteImage', attrs: { attachmentId, width: 100, caption: '', naturalWidth: 480, naturalHeight: 270 } })),
          ...(note.blocks ?? [])
        ]
      },
      tags: [],
      collapsed: false,
      createdAt: now + index,
      updatedAt: now + index,
      deletedAt: null,
      trashOrigin: null,
      revision: 1,
      extra: {}
    })),
    layout: { rows: options.notes.map((note, index) => ({ id: `crafted-row-${index}`, notes: [note.id] })) },
    pins: [],
    preferences: { theme: 'paper', fontSize: 26 }
  }
  return { manifest: JSON.stringify(manifest), data: JSON.stringify(data) }
}

// ------------------------------------------------------------------ tests

test('export writes one archive with every note, image, the arrangement, pins and settings; a cancelled dialog changes nothing', async () => {
  const source = await sourceBackup()

  // The collection really is what the later tests rely on.
  expect(source.labels).toEqual(['London rules', 'Bravo setup', 'Alpha setup', 'Screens above', 'Echo closing note'])
  expect(source.state.layout).toEqual([['London rules'], ['Bravo setup', 'Alpha setup'], ['Screens above'], ['Echo closing note']])
  expect(source.pinsBeforeReorder).toEqual(['London rules', 'Echo closing note'])
  expect(source.state.pins).toEqual(['Echo closing note', 'London rules'])
  expect(source.state.trash).toEqual([{ label: 'Trashed idea', imageCount: 1 }])
  expect(source.state.preferences).toMatchObject({ theme: 'midnight', fontSize: 19 })
  expect(source.appearance.theme).toBe('midnight')
  expect(source.appearance.noteSize).toBe('19px')
  expect(source.appearance.ground).not.toBe(source.defaultGround)
  const rich = JSON.stringify(source.state.notes.find((note) => note.title === 'London rules')!.content)
  for (const fragment of ['"type":"heading"', '"level":2', '"type":"bold"', '"color":"var(--ink-red)"', '"fontFamily":"var(--font-serif)"', '"fontSize":"22px"', '"type":"highlight"', 'var(--hl-teal)', '"type":"taskList"', '"checked":true', '"checked":false']) {
    expect(rich, `formatted note stores ${fragment}`).toContain(fragment)
  }
  expect(source.state.notes.find((note) => note.title === 'London rules')!.tags).toEqual(['Rules'])
  expect(source.richLook).toMatchObject({ title: 'London rules', heading: 'Session plan', size: '22px', bold: ['Styled words', 'confirmation'], tags: ['Rules'], plainSize: '19px' })
  expect(String(source.richLook.family)).toContain('Literata')
  expect(Number(source.richLook.weight)).toBeGreaterThanOrEqual(600)
  expect(String(source.richLook.styledHtml)).toContain('var(--ink-red)')
  expect(String(source.richLook.styledHtml)).toContain('var(--hl-teal)')
  expect(source.richLook.color).toMatch(/^rgb/)
  expect(source.richLook.color).not.toBe(source.richLook.plainColor)
  expect(source.richLook.highlight).toMatch(/^rgb/)
  expect(source.richLook.highlight).not.toBe('rgba(0, 0, 0, 0)')
  expect(source.richLook.tasks).toEqual([{ text: 'Check the calendar', checked: true }, { text: 'Mark the levels', checked: false }])
  expect(source.screenshots.map((image) => image.width)).toEqual(['100%', '80%'])
  expect(source.screenshots.map((image) => image.caption)).toEqual(['', 'NQ 5 minute, London open'])
  const screens = JSON.stringify(source.state.notes.find((note) => note.plainText.startsWith('Screens above'))!.content)
  expect(screens).not.toContain('base64')
  expect(source.errors).toEqual([])

  // Cancelling the Save dialog: nothing written, nothing changed, nothing reported.
  expect(source.cancelled).toEqual({ dialogCalls: 1, filesWritten: [], statusLines: 0, alerts: 0, stateUnchanged: true, buttonEnabled: true })

  // The Save dialog proposes a .tnbackup file, and the result line reports what was saved.
  expect(source.exported.dialog?.defaultPath).toMatch(/Trading Notes \d{4}-\d{2}-\d{2}\.tnbackup$/)
  expect(source.exported.dialog?.filters?.[0]?.extensions).toEqual(['tnbackup'])
  expect(source.exported.line).toMatch(/^Saved 5 notes and 3 images \(\d+(\.\d)? (KB|MB)\)\. Show file$/)
  expect(source.exported.showsFile).toBe(true)

  // One file, a zip, with a manifest, the data and the images.
  expect(readdirSync(dirname(source.file))).toEqual([basename(source.file)])
  const raw = readFileSync(source.file)
  expect(raw.subarray(0, 2).toString('latin1')).toBe('PK')
  const size = /\((\d+(?:\.\d)?) (KB|MB)\)/.exec(source.exported.line)!
  const reported = Number(size[1]) * (size[2] === 'MB' ? 1024 * 1024 : 1024)
  expect(Math.abs(reported - raw.length)).toBeLessThanOrEqual(size[2] === 'MB' ? 0.06 * 1024 * 1024 : 1024)

  const entries = await readZip(source.file)
  expect([...entries.keys()].filter((name) => !name.startsWith('attachments/')).sort()).toEqual(['data.json', 'manifest.json'])
  const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
    format: string
    formatVersion: number
    schemaVersion: number
    appVersion: string
    counts: Record<string, number>
    attachments: Array<{ id: string; file: string; preview: string | null; sha256: string; byteSize: number; originalName: string | null }>
  }
  expect(manifest).toMatchObject({ format: 'trading-notes-backup', formatVersion: 1, counts: { notes: 5, trashed: 1, attachments: 3, pins: 2 } })
  expect(typeof manifest.schemaVersion).toBe('number')
  expect(manifest.appVersion).toMatch(/^\d+\.\d+\.\d+/)
  expect(manifest.attachments).toHaveLength(3)
  for (const attachment of manifest.attachments) {
    expect(attachment.file).toMatch(/^attachments\/[A-Za-z0-9_.-]+$/)
    const bytes = entries.get(attachment.file)
    expect(bytes, `${attachment.file} is in the archive`).toBeDefined()
    expect(sha256(bytes!)).toBe(attachment.sha256)
    expect(bytes!.length).toBe(attachment.byteSize)
    // The archive holds exactly the file the notes folder holds.
    expect(source.files[basename(attachment.file)]).toBe(attachment.sha256)
    if (attachment.preview) expect(entries.has(attachment.preview)).toBe(true)
  }
  // The picked file is exported at full resolution, byte for byte, next to its smaller preview.
  const picked = manifest.attachments.find((attachment) => attachment.originalName === 'nq-london.png')!
  expect(entries.get(picked.file)!.equals(BLUE)).toBe(true)
  expect(picked.preview).not.toBeNull()
  expect(entries.get(picked.preview!)!.length).toBeLessThan(BLUE.length)
  // Every archive entry is accounted for by the manifest.
  const listed = new Set(manifest.attachments.flatMap((attachment) => [attachment.file, ...(attachment.preview ? [attachment.preview] : [])]))
  expect([...entries.keys()].filter((name) => name.startsWith('attachments/')).sort()).toEqual([...listed].sort())

  const data = JSON.parse(entries.get('data.json')!.toString('utf8')) as {
    notes: Array<{ id: string; title: string | null; deletedAt: number | null; content: unknown }>
    layout: { rows: Array<{ notes: string[] }> }
    pins: string[]
    preferences: Record<string, unknown>
  }
  expect(data.notes).toHaveLength(6)
  expect(data.notes.filter((note) => note.deletedAt !== null)).toHaveLength(1)
  expect(data.layout.rows.map((row) => row.notes.length)).toEqual([1, 2, 1, 1])
  expect(data.pins).toHaveLength(2)
  expect(data.preferences).toMatchObject({ theme: 'midnight', fontSize: 19 })
  expect(JSON.stringify(data.notes.find((note) => note.title === 'London rules')!.content)).toBe(rich)
  // No picture is embedded in the note records.
  expect(entries.get('data.json')!.length).toBeLessThan(20_000)
})

test('restore into a brand-new profile: preview first, Add is the default, Replace needs confirming, and everything comes back', async () => {
  const source = await sourceBackup()
  const dataDir = freshDataDir()
  let ctx = await launch({ dataDir, size: SIZE })
  let errors = await collectConsoleErrors(ctx.page)
  let { page, app } = ctx
  await expect(page.getByText('Click anywhere to write')).toBeVisible()
  const empty = await storedState(app)
  expect(empty).toMatchObject({ notes: [], layout: [], pins: [], trash: [], preferences: { theme: 'charcoal', fontSize: 17 } })

  await openBackupPanel(page)
  await expect(sheet(page)).toContainText('You will see what it contains before anything changes.')

  // Cancelling the Open dialog leaves the panel as it was.
  await chooseBackupFile(ctx, null)
  await expect.poll(async () => (await dialogLog(app)).open.length).toBe(1)
  await expect(preview(page)).toHaveCount(0)
  await expect(panelError(page)).toHaveCount(0)
  await expect(page.getByTestId('choose-backup')).toBeEnabled()

  // Choosing the file shows what it holds, and nothing has changed yet.
  await chooseBackupFile(ctx, source.file)
  await expect(preview(page)).toBeVisible()
  expect((await dialogLog(app)).open[1]?.filters?.[0]?.extensions).toContain('tnbackup')
  await expect(preview(page)).toContainText(basename(source.file))
  await expect(preview(page)).toContainText('Contains 5 notes, 3 images and 2 pins, plus 1 note in Trash.')
  await expect(preview(page).locator('.setting-warning')).toHaveCount(0)
  expect(await storedState(app)).toEqual(empty)
  expect(attachmentFiles(dataDir)).toEqual({})
  await expect(notes(page)).toHaveCount(0)

  // "Add to my notes" is the default; Replace is a separate, explained choice.
  await expect(addChoice(page)).toBeChecked()
  await expect(replaceChoice(page)).not.toBeChecked()
  await expect(runImport(page)).toHaveText('Add to my notes')
  await expect(runImport(page)).toBeEnabled()
  await expect(page.getByTestId('confirm-replace')).toHaveCount(0)
  await expect(preview(page)).toContainText('Notes from the backup are added at the bottom of the board.')
  await expect(preview(page)).toContainText('restores exactly what the backup holds, including its settings')

  // Replace needs the confirmation ticked before the button works.
  await replaceChoice(page).check()
  await expect(runImport(page)).toHaveText('Replace my notes')
  await expect(runImport(page)).toBeDisabled()
  const confirm = page.getByTestId('confirm-replace')
  await expect(confirm).not.toBeChecked()
  await expect(page.getByText('I understand my current notes will be replaced.')).toBeVisible()
  expect(await storedState(app)).toEqual(empty)
  await confirm.check()
  await expect(runImport(page)).toBeEnabled()
  await runImport(page).click()

  await expect(importResult(page)).toContainText('Restored 6 notes and 3 images from the backup.')
  await expect(importResult(page)).not.toContainText('could not be found')
  // There was nothing here to protect, so no safety backup is claimed.
  await expect(importResult(page)).not.toContainText('safety backup')
  expect(safetyBackups(dataDir)).toEqual([])
  await expect(preview(page)).toHaveCount(0)
  await expect(panelError(page)).toHaveCount(0)

  // The board behind the panel already shows the restored notes: no restart needed.
  await expect(notes(page)).toHaveCount(5)
  await expect(page.getByText('Click anywhere to write')).toBeHidden()
  await closePanel(page)
  await expectSameAsSource(ctx, source)
  expect(errors).toEqual([])
  await ctx.quit()

  // ---- restart: the same thing again.
  ctx = await launch({ dataDir, size: SIZE })
  errors = await collectConsoleErrors(ctx.page)
  ;({ page, app } = ctx)
  await expect(notes(page)).toHaveCount(5)
  await expectSameAsSource(ctx, source)

  // The settings panel shows the restored preferences.
  await openGearItem(page, /^Settings/)
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Midnight' })).toBeChecked()
  await expect(page.getByLabel('Default text size')).toHaveValue('19')
  await closePanel(page)

  // The larger preview loads the full-resolution original from the restored files.
  await noteByText(page, 'Screens above').locator('.note-image-button').nth(1).click()
  await expect(page.getByTestId('image-preview')).toBeVisible()
  await expect.poll(async () => page.locator('[data-testid="image-preview"] img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(2400)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('image-preview')).toBeHidden()

  // A restored note still opens for editing with its formatting active.
  await noteByText(page, 'London rules').locator('.prose p', { hasText: 'Styled words' }).click()
  await expect(focusView(page)).toBeVisible()
  const bar = page.getByRole('toolbar', { name: 'Formatting', exact: true })
  await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
  await expect(bar.getByRole('button', { name: 'Font' })).toContainText('Literata')
  await expect(bar.getByRole('button', { name: 'Text size' })).toContainText('22')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  expect((await storedState(app)).notes).toEqual(source.state.notes)

  // The trashed note comes back from Trash to where it was, with its screenshot.
  await restoreFromTrash(page, 'Trashed idea')
  expect((await storedState(app)).layout).toEqual([['London rules'], ['Bravo setup', 'Alpha setup'], ['Screens above'], ['Trashed idea'], ['Echo closing note']])
  expect(await boardLabels(page)).toEqual(['London rules', 'Bravo setup', 'Alpha setup', 'Screens above', 'Trashed idea', 'Echo closing note'])
  await expectImagesLoaded(page, '.note .note-image img', 3)
  expect(errors).toEqual([])
  await ctx.quit()
  removeDataDir(dataDir)
})

test('Replace on a profile with notes: nothing changes before the confirmation, a safety backup is written first, and it restores the old notes', async () => {
  const source = await sourceBackup()
  const dataDir = freshDataDir()
  const ctx = await launch({ dataDir, size: SIZE })
  const errors = await collectConsoleErrors(ctx.page)
  const { page, app } = ctx

  // A small collection of its own: two notes, a note with a screenshot, a pin.
  await writeNote(page, ['Old rule one', 'Never chase the open.'])
  await writeNote(page, ['Old rule two', 'Size down after two losses.'])
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Old chart')
  await page.keyboard.press('Enter')
  await pasteScreenshot(ctx, GREEN, 1)
  await logNote(page)
  await pin(page, 'Old rule two')
  const before = await storedState(app)
  const filesBefore = attachmentFiles(dataDir)
  expect(before.layout).toEqual([['Old rule one'], ['Old rule two'], ['Old chart']])
  expect(Object.keys(filesBefore)).toHaveLength(1)

  await openBackupPanel(page)
  await chooseBackupFile(ctx, source.file)
  await expect(preview(page)).toContainText('Contains 5 notes, 3 images and 2 pins, plus 1 note in Trash.')
  // Both choices say what happens to the three notes that are here now.
  await expect(preview(page)).toContainText('Keeps everything you have now (3 notes).')
  await expect(preview(page)).toContainText('Removes your current 3 notes, Trash, pins and arrangement')
  await expect(preview(page)).toContainText('A safety backup of what you have now is saved automatically first.')
  await expect(addChoice(page)).toBeChecked()

  // Choosing Replace alone does nothing: the button is disabled until the box is ticked.
  await replaceChoice(page).check()
  await expect(runImport(page)).toBeDisabled()
  await runImport(page).click({ force: true })
  await page.waitForTimeout(300)
  await expect(preview(page)).toBeVisible()
  await expect(importResult(page)).toHaveCount(0)
  expect(await storedState(app)).toEqual(before)
  expect(attachmentFiles(dataDir)).toEqual(filesBefore)
  expect(safetyBackups(dataDir)).toEqual([])
  await expect(notes(page)).toHaveCount(3)

  // Changing your mind is free: back to Add, then Cancel. Still nothing has changed.
  await addChoice(page).check()
  await expect(page.getByTestId('confirm-replace')).toHaveCount(0)
  await sheet(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(preview(page)).toHaveCount(0)
  expect(await storedState(app)).toEqual(before)
  expect(safetyBackups(dataDir)).toEqual([])

  // If the safety backup cannot be written, the replace does not go ahead.
  expect(existsSync(backupsDir(dataDir))).toBe(false)
  writeFileSync(backupsDir(dataDir), 'a file sitting where the backups folder has to be created')
  await chooseBackupFile(ctx, source.file)
  await replaceChoice(page).check()
  await page.getByTestId('confirm-replace').check()
  await runImport(page).click()
  await expect(panelError(page)).toContainText('Nothing was changed.')
  await expect(importResult(page)).toHaveCount(0)
  expect(await storedState(app)).toEqual(before)
  expect(attachmentFiles(dataDir)).toEqual(filesBefore)
  await expect(notes(page)).toHaveCount(3)
  expect(await boardLabels(page)).toEqual(['Old rule one', 'Old rule two', 'Old chart'])
  rmSync(backupsDir(dataDir))

  // Now for real.
  await chooseBackupFile(ctx, source.file)
  await expect(preview(page)).toBeVisible()
  await expect(addChoice(page)).toBeChecked()
  await replaceChoice(page).check()
  await expect(page.getByTestId('confirm-replace')).not.toBeChecked()
  await expect(runImport(page)).toBeDisabled()
  await page.getByTestId('confirm-replace').check()
  await runImport(page).click()
  await expect(importResult(page)).toContainText('Restored 6 notes and 3 images from the backup.')
  await expect(importResult(page)).toContainText('Your previous notes were saved to a safety backup.')

  // The safety backup exists, in the app's own backups folder, and holds what was replaced.
  const safety = safetyBackups(dataDir)
  expect(safety).toHaveLength(1)
  expect(safety[0]).toMatch(/^before-restore-\d{4}-\d{2}-\d{2}_\d{6}\.tnbackup$/)
  await recordShownFiles(app)
  await importResult(page).getByRole('button', { name: 'Show file' }).click()
  await expect.poll(async () => (await dialogLog(app)).shown).toEqual([join(backupsDir(dataDir), safety[0]!)])
  const safetyFile = join(backupsDir(dataDir), safety[0]!)
  expect(readFileSync(safetyFile).subarray(0, 2).toString('latin1')).toBe('PK')
  const safetyEntries = await readZip(safetyFile)
  const safetyData = JSON.parse(safetyEntries.get('data.json')!.toString('utf8')) as { notes: Array<{ plainText: string }>; pins: string[] }
  expect(safetyData.notes.map((note) => note.plainText.split('\n')[0])).toEqual(['Old rule one', 'Old rule two', 'Old chart'])
  expect(safetyData.pins).toHaveLength(1)
  const oldImageName = Object.keys(filesBefore)[0]!
  expect(sha256(safetyEntries.get(`attachments/${oldImageName}`)!)).toBe(filesBefore[oldImageName])

  // The previous notes are gone from the board and from the store; the backup's are here.
  await expect(notes(page).filter({ hasText: /Old rule|Old chart/ })).toHaveCount(0)
  await closePanel(page)
  await expectSameAsSource(ctx, source)
  expect(Object.keys(attachmentFiles(dataDir))).not.toContain(oldImageName)

  // The safety backup is a real backup: restoring it brings the previous notes back.
  await openBackupPanel(page)
  await chooseBackupFile(ctx, safetyFile)
  await expect(preview(page)).toContainText('Contains 3 notes, 1 image and 1 pin.')
  await replaceChoice(page).check()
  await page.getByTestId('confirm-replace').check()
  await runImport(page).click()
  await expect(importResult(page)).toContainText('Restored 3 notes and 1 image from the backup.')
  await expect(importResult(page)).toContainText('Your previous notes were saved to a safety backup.')
  await closePanel(page)
  expect(await boardLabels(page)).toEqual(['Old rule one', 'Old rule two', 'Old chart'])
  expect(await storedState(app)).toEqual(before)
  expect(attachmentFiles(dataDir)).toEqual(filesBefore)
  await expectImagesLoaded(page, '.note .note-image img', 1)
  expect(await appearance(page)).toMatchObject({ theme: 'charcoal', noteSize: '17px' })
  expect(await pinnedIndex(page)).toEqual(['Old rule two'])
  expect(safetyBackups(dataDir)).toHaveLength(2)
  expect(errors).toEqual([])
  await ctx.quit()
  removeDataDir(dataDir)
})

test('Add to my notes keeps what is here, appends the backup in its own order, and adds nothing the second time', async () => {
  const source = await sourceBackup()
  const dataDir = freshDataDir()
  let ctx = await launch({ dataDir, size: SIZE })
  let errors = await collectConsoleErrors(ctx.page)
  let { page, app } = ctx

  // A different collection with its own settings, pair, pin and trashed note.
  await openGearItem(page, /^Settings/)
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Paper' }).click()
  await page.getByLabel('Default text size').selectOption('22')
  await expect.poll(async () => (await storedState(app)).preferences).toMatchObject({ theme: 'paper', fontSize: 22 })
  await closePanel(page)
  await writeNote(page, ['Mine one', 'Kept exactly as written.'])
  await writeNote(page, ['Mine two', 'Also kept.'])
  await writeNote(page, ['Mine three', 'Sits beside the first.'])
  await writeNote(page, ['Mine trashed', 'Already in Trash before the import.'])
  await dragNote(page, 'Mine three', 'Mine one', 0.93, 0.5)
  await moveToTrash(page, 'Mine trashed')
  await pin(page, 'Mine two')
  const before = await storedState(app)
  expect(before.layout).toEqual([['Mine one', 'Mine three'], ['Mine two']])
  expect(before.pins).toEqual(['Mine two'])

  await openBackupPanel(page)
  await chooseBackupFile(ctx, source.file)
  await expect(preview(page)).toContainText('Contains 5 notes, 3 images and 2 pins, plus 1 note in Trash.')
  await expect(preview(page)).toContainText('Keeps everything you have now (3 notes).')
  await expect(preview(page)).toContainText('Nothing is overwritten.')
  expect(await storedState(app)).toEqual(before)

  // The default choice needs no confirmation.
  await expect(addChoice(page)).toBeChecked()
  await expect(runImport(page)).toHaveText('Add to my notes')
  await runImport(page).click()
  // Six notes come in: five on the board and the one that was in the backup's Trash.
  await expect(importResult(page)).toContainText('Added 6 notes, with 3 new images.')
  await expect(importResult(page)).not.toContainText('safety backup')
  await expect(importResult(page)).not.toContainText('could not be found')
  expect(safetyBackups(dataDir)).toEqual([])

  // The board updates at once: existing notes first and untouched, the backup's notes below.
  const merged = ['Mine one', 'Mine three', 'Mine two', ...source.labels]
  await expect(notes(page)).toHaveCount(merged.length)
  await closePanel(page)
  const expectMerged = async (): Promise<Stored> => {
    expect(await boardLabels(page)).toEqual(merged)
    const state = await storedState(app)
    expect(state.layout).toEqual([...before.layout, ...source.state.layout])
    expect(state.pins).toEqual([...before.pins, ...source.state.pins])
    expect(state.preferences).toEqual(before.preferences)
    expect(state.notes).toHaveLength(before.notes.length + source.state.notes.length)
    for (const note of [...before.notes, ...source.state.notes]) expect(state.notes).toContainEqual(note)
    expect(state.trash.map((entry) => entry.label).sort()).toEqual(['Mine trashed', 'Trashed idea'])
    await expectSideBySide(page, 'Mine one', 'Mine three')
    await expectSideBySide(page, 'Bravo setup', 'Alpha setup')
    await expectImagesLoaded(page, '.note .note-image img', 2)
    expect(await screenshotsLook(page)).toEqual(source.screenshots)
    expect(attachmentFiles(dataDir)).toEqual(source.files)
    // The imported settings did not replace this profile's own.
    expect(await appearance(page)).toMatchObject({ theme: 'paper', noteSize: '22px' })
    expect(await pinnedIndex(page)).toEqual(['Mine two', ...source.pinsShown])
    expect((await trashPanel(page)).map((row) => row.label).sort()).toEqual(['Mine trashed', 'Trashed idea'])
    return state
  }
  const after = await expectMerged()

  // The same file again: every note is already here, so nothing new appears.
  await openBackupPanel(page)
  await chooseBackupFile(ctx, source.file)
  await expect(preview(page)).toContainText('Keeps everything you have now (8 notes).')
  await expect(preview(page)).toContainText('6 notes in the backup already exist here')
  await expect(runImport(page)).toHaveText('Add to my notes')
  await runImport(page).click()
  await expect(importResult(page)).toContainText('Added 0 notes, skipped 6 you already have, with 0 new images.')
  await closePanel(page)
  expect(await expectMerged()).toEqual(after)
  expect(errors).toEqual([])
  await ctx.quit()

  // ---- restart
  ctx = await launch({ dataDir, size: SIZE })
  errors = await collectConsoleErrors(ctx.page)
  ;({ page, app } = ctx)
  await expect(notes(page)).toHaveCount(merged.length)
  expect(await expectMerged()).toEqual(after)

  // Change one of the imported notes, then add the same backup once more: the changed note is
  // not overwritten, and the backup's wording arrives as a separate note at the bottom.
  await noteByText(page, 'Alpha setup').locator('.prose p').nth(1).click()
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Edited after the import.')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await openBackupPanel(page)
  await chooseBackupFile(ctx, source.file)
  await expect(preview(page)).toContainText("where the wording differs the backup's version is added as a separate copy. Nothing is overwritten.")
  await runImport(page).click()
  await expect(importResult(page)).toContainText('Added 1 note (1 as a separate copy because your version differs), skipped 5 you already have, with 0 new images.')
  await closePanel(page)
  expect(await boardLabels(page)).toEqual([...merged, 'Alpha setup'])
  const both = notes(page).filter({ hasText: 'Alpha setup' })
  await expect(both).toHaveCount(2)
  await expect(both.nth(0).locator('.prose p')).toHaveText(['Alpha setup', 'Buy the first pullback. Edited after the import.'])
  await expect(both.nth(1).locator('.prose p')).toHaveText(['Alpha setup', 'Buy the first pullback.'])
  await expectSideBySide(page, 'Bravo setup', 'Alpha setup')
  const final = await storedState(app)
  expect(final.layout).toEqual([...after.layout, ['Alpha setup']])
  expect(final.notes.map((note) => note.plainText).filter((text) => text.startsWith('Alpha setup')).sort()).toEqual([
    'Alpha setup\nBuy the first pullback.',
    'Alpha setup\nBuy the first pullback. Edited after the import.'
  ])
  expect(final.notes).toHaveLength(after.notes.length + 1)
  expect(final.pins).toEqual(after.pins)
  expect(final.preferences).toEqual(after.preferences)
  expect(errors).toEqual([])
  await ctx.quit()
  removeDataDir(dataDir)
})

test('invalid backups are refused with a clear message and change nothing; a missing image is reported and the words still import', async () => {
  const dataDir = freshDataDir()
  const files = tempDir('tn-backup-crafted-')
  const outside = `evil-${sha256(Buffer.from(dataDir)).slice(0, 12)}.png`
  let ctx = await launch({ dataDir, size: SIZE })
  let { page, app } = ctx
  await writeNote(page, ['My own note', 'Must survive every refused import.'])
  const before = await storedState(app)

  const noteId = 'crafted-note-0001'
  const presentId = 'crafted-image-present'
  const missingId = 'crafted-image-missing'
  // A second note carries things no note written in the app could contain.
  const hostile: unknown[] = [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'click me', marks: [{ type: 'link', attrs: { href: 'javascript:window.__pwned=1' } }] },
        { type: 'text', text: ' loud', marks: [{ type: 'textStyle', attrs: { color: 'red;background:url(https://evil.example/x.png)', fontFamily: 'Comic Sans MS', fontSize: '400px' } }] },
        { type: 'text', text: ' safe link', marks: [{ type: 'link', attrs: { href: 'https://example.com/ok' } }] }
      ]
    },
    { type: 'iframe', attrs: { src: 'https://evil.example/frame' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'words inside an unknown block' }] }] },
    { type: 'noteImage', attrs: { attachmentId: '../../../etc/passwd', width: 100, caption: 'not an attachment' } }
  ]
  const valid = craftedBackup({
    notes: [
      { id: noteId, text: 'Words survive without the picture', images: [presentId, missingId] },
      { id: 'crafted-note-0002', text: 'Hostile formatting is stripped', blocks: hostile }
    ],
    attachments: [
      { id: presentId, file: `attachments/${presentId}.png`, bytes: GREEN },
      { id: missingId, file: `attachments/${missingId}.png`, bytes: RED }
    ]
  })

  // --- files that must be refused
  const textFile = join(files, 'renamed-text.tnbackup')
  writeFileSync(textFile, 'These are just words in a text file, renamed to look like a backup.\n')

  const plainZip = join(files, 'holiday-photos.zip')
  await writeZip(plainZip, { 'readme.txt': 'not a backup', 'photo.png': GREEN })

  const refused: Array<{ name: string; file: string; message: RegExp }> = [
    { name: 'a text file renamed .tnbackup', file: textFile, message: /not a readable Trading Notes backup/ },
    { name: 'a zip that is not a backup', file: plainZip, message: /not a Trading Notes backup/ }
  ]
  for (const [index, path] of ['../../' + outside, 'attachments/../../' + outside, '/tmp/' + outside, 'attachments\\..\\..\\' + outside].entries()) {
    const crafted = craftedBackup({
      notes: [{ id: noteId, text: 'Carries an image with an unsafe path', images: [presentId] }],
      attachments: [{ id: presentId, file: path, bytes: GREEN }]
    })
    const file = join(files, `unsafe-path-${index}.tnbackup`)
    await writeZip(file, { 'manifest.json': crafted.manifest, 'data.json': crafted.data, [`attachments/${presentId}.png`]: GREEN })
    refused.push({ name: `a manifest listing the attachment path ${path}`, file, message: /not valid|unsafe|not a/i })
  }
  // An archive entry that tries to climb out of the folder (written under a harmless name of
  // the same length, then renamed inside the file, because zip tools refuse to create it).
  const slipFile = join(files, 'entry-outside.tnbackup')
  const harmless = `aa/aa/${outside}`
  await writeZip(slipFile, { 'manifest.json': valid.manifest, 'data.json': valid.data, [harmless]: GREEN })
  const slipBytes = readFileSync(slipFile)
  let renamed = 0
  for (let at = slipBytes.indexOf(harmless); at !== -1; at = slipBytes.indexOf(harmless, at + 1)) {
    slipBytes.write(`../../${outside}`, at, 'latin1')
    renamed++
  }
  expect(renamed).toBe(2)
  writeFileSync(slipFile, slipBytes)
  refused.push({ name: `an archive entry named ../../${outside}`, file: slipFile, message: /damaged or contains unsafe file paths/ })

  const newer = craftedBackup({ notes: [{ id: noteId, text: 'From the future' }], attachments: [], manifest: { formatVersion: 99 } })
  const newerFile = join(files, 'newer-format.tnbackup')
  await writeZip(newerFile, { 'manifest.json': newer.manifest, 'data.json': newer.data })
  refused.push({ name: 'a backup from a newer format version', file: newerFile, message: /newer than this app understands/ })
  const brokenFile = join(files, 'broken-data.tnbackup')
  await writeZip(brokenFile, { 'manifest.json': valid.manifest, 'data.json': '{ "notes": [ this is not json' })
  refused.push({ name: 'a backup whose data is not valid JSON', file: brokenFile, message: /not valid/ })

  await openBackupPanel(page)
  for (const attempt of refused) {
    await chooseBackupFile(ctx, attempt.file)
    await expect(panelError(page), attempt.name).toBeVisible()
    await expect(panelError(page), attempt.name).toHaveText(attempt.message)
    // No preview and no way to import it; the picker is offered again.
    await expect(preview(page), attempt.name).toHaveCount(0)
    await expect(runImport(page), attempt.name).toHaveCount(0)
    await expect(importResult(page), attempt.name).toHaveCount(0)
    await expect(page.getByTestId('choose-backup'), attempt.name).toBeEnabled()
    expect(await storedState(app), attempt.name).toEqual(before)
  }
  // Nothing was written anywhere: not into the notes folder, and not outside it.
  expect(attachmentFiles(dataDir)).toEqual({})
  expect(safetyBackups(dataDir)).toEqual([])
  for (const place of [dataDir, join(dataDir, 'library'), dirname(dataDir), dirname(dirname(dataDir)), '/tmp', files]) {
    expect(existsSync(join(place, outside)), `${join(place, outside)} must not exist`).toBe(false)
  }
  await closePanel(page)
  expect(await boardLabels(page)).toEqual(['My own note'])

  // --- a backup whose manifest lists two images, but the archive only contains one of them
  const missingFile = join(files, 'one-image-missing.tnbackup')
  await writeZip(missingFile, { 'manifest.json': valid.manifest, 'data.json': valid.data, [`attachments/${presentId}.png`]: GREEN })
  await openBackupPanel(page)
  await chooseBackupFile(ctx, missingFile)
  // A good file after a refused one clears the old error.
  await expect(preview(page)).toBeVisible()
  await expect(panelError(page)).toHaveCount(0)
  await expect(preview(page)).toContainText('Contains 2 notes, 2 images and 0 pins.')
  await expect(preview(page).locator('.setting-warning')).toHaveText(/1 image is referenced by notes but missing from the backup/)
  expect(await storedState(app)).toEqual(before)
  await expect(addChoice(page)).toBeChecked()
  await runImport(page).click()
  await expect(importResult(page)).toContainText('Added 2 notes, with 1 new image.')
  await expect(importResult(page)).toContainText('1 image could not be found in the backup; those notes show an empty placeholder.')
  await closePanel(page)

  const expectImported = async (): Promise<void> => {
    expect(await boardLabels(page)).toEqual(['My own note', 'Words survive without the picture', 'Hostile formatting is stripped'])
    const imported = noteByText(page, 'Words survive without the picture')
    await expect(imported.locator('.prose > p')).toHaveText('Words survive without the picture')
    // One image loads; the other shows an honest placeholder instead of a broken picture.
    const figures = imported.locator('.note-image')
    await expect(figures).toHaveCount(2)
    await figures.nth(1).scrollIntoViewIfNeeded()
    await expect.poll(async () => figures.nth(0).locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(480)
    await expect(figures.nth(1)).toHaveAttribute('data-missing', 'true')
    await expect(figures.nth(1).getByText('Image file missing')).toBeVisible()
    await expect(figures.nth(0).getByText('Image file missing')).toBeHidden()
    const state = await storedState(app)
    expect(state.notes).toContainEqual(before.notes[0])
    expect(state.notes.map((note) => note.plainText)).toEqual([
      'My own note\nMust survive every refused import.',
      'Words survive without the picture',
      'Hostile formatting is stripped\nclick me loud safe link\nwords inside an unknown block'
    ])
    expect(state.layout).toEqual([['My own note'], ['Words survive without the picture'], ['Hostile formatting is stripped']])
    // Imported content is cleaned: the words stay, the unsafe link, foreign styling, unknown
    // block and bogus image reference do not.
    const cleaned = JSON.stringify(state.notes[2]!.content)
    expect(cleaned).not.toMatch(/javascript:|evil\.example|Comic|400px|iframe|passwd|noteImage/)
    expect(cleaned).toContain('https://example.com/ok')
    const hostileNote = noteByText(page, 'Hostile formatting is stripped')
    expect(await hostileNote.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(['https://example.com/ok'])
    await expect(hostileNote.locator('iframe, img, script, [style*="url("]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
    // Merging never touches settings, whatever the file says.
    expect(state.preferences).toEqual(before.preferences)
    // Only the image that was really in the archive is on disk, under the app's own name.
    expect(attachmentFiles(dataDir)).toEqual({ [`${presentId}.png`]: sha256(GREEN) })
  }
  await expectImported()
  await ctx.quit()

  // ---- restart
  ctx = await launch({ dataDir, size: SIZE })
  ;({ page, app } = ctx)
  await expect(notes(page)).toHaveCount(3)
  await expectImported()
  await ctx.quit()
  removeDataDir(dataDir)
})

test('a note still open in the editor is included in an export, and safely set aside by a restore', async () => {
  const dataDir = freshDataDir()
  const file = join(tempDir('tn-backup-open-'), 'made-while-writing.tnbackup')
  const ctx = await launch({ dataDir, size: SIZE })
  const { page, app } = ctx
  await writeNote(page, ['Logged earlier', 'Already on the board.'])

  // A draft that is typed but not logged; the backup is made with the editor still open.
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Still being written when the backup is made')
  await openBackupPanel(page)
  await answerSaveDialog(app, file)
  await page.getByTestId('export-backup').click()
  await expect(sheet(page).locator('.setting-success')).toContainText('Saved 2 notes and 0 images')
  const exported = JSON.parse((await readZip(file)).get('data.json')!.toString('utf8')) as { notes: Array<{ plainText: string }> }
  expect(exported.notes.map((note) => note.plainText)).toEqual(['Logged earlier\nAlready on the board.', 'Still being written when the backup is made'])
  await closePanel(page)

  // The draft is still open exactly as it was, and writing carries on.
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText('Still being written when the backup is made')
  await editorBody(page).locator('p').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(', and changed afterwards')

  // Restore the backup straight away, with the editor still open on the newer wording.
  await openBackupPanel(page)
  await chooseBackupFile(ctx, file)
  await expect(preview(page)).toContainText('Contains 2 notes, 0 images and 0 pins.')
  await replaceChoice(page).check()
  await page.getByTestId('confirm-replace').check()
  await runImport(page).click()
  await expect(importResult(page)).toContainText('Restored 2 notes and 0 images from the backup.')
  await expect(importResult(page)).toContainText('Your previous notes were saved to a safety backup.')
  // The window is back on the board, showing the backup's wording.
  await expect(focusView(page)).toBeHidden()
  await closePanel(page)
  expect(await boardLabels(page)).toEqual(['Logged earlier', 'Still being written when the backup is made'])
  expect((await storedState(app)).notes.map((note) => note.plainText)).toEqual(['Logged earlier\nAlready on the board.', 'Still being written when the backup is made'])
  // What had been typed after the backup was written first, into the safety backup.
  const safety = safetyBackups(dataDir)
  expect(safety).toHaveLength(1)
  const kept = JSON.parse((await readZip(join(backupsDir(dataDir), safety[0]!))).get('data.json')!.toString('utf8')) as { notes: Array<{ plainText: string }> }
  expect(kept.notes.map((note) => note.plainText)).toEqual(['Logged earlier\nAlready on the board.', 'Still being written when the backup is made, and changed afterwards'])
  await ctx.quit()
  removeDataDir(dataDir)
})

test('after an import the window shows the board, even when this run began with a note reopened in the editor', async () => {
  const dataDir = freshDataDir()
  const file = join(tempDir('tn-backup-session-'), 'one-note.tnbackup')
  const crafted = craftedBackup({ notes: [{ id: 'crafted-note-0003', text: 'Arrived by import' }], attachments: [] })
  await writeZip(file, { 'manifest.json': crafted.manifest, 'data.json': crafted.data })

  // Quit while a note is open in the editor.
  let ctx = await launch({ dataDir, size: SIZE })
  let { page } = ctx
  await writeNote(page, ['Open at quit', 'The editor was showing this note when the app was closed.'])
  await noteByText(page, 'Open at quit').locator('.prose p').first().click()
  await expect(focusView(page)).toBeVisible()
  await ctx.quit()

  // The next start opens that note again; go back to the board.
  ctx = await launch({ dataDir, size: SIZE })
  ;({ page } = ctx)
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toContainText('Open at quit')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  expect(await boardLabels(page)).toEqual(['Open at quit'])

  await openBackupPanel(page)
  await chooseBackupFile(ctx, file)
  await expect(addChoice(page)).toBeChecked()
  await runImport(page).click()
  await expect(importResult(page)).toContainText('Added 1 note, with 0 new images.')

  // The import leaves the window on the board: no editor opens behind the panel.
  await expect(focusView(page)).toBeHidden()
  await closePanel(page)
  await expect(page.getByTestId('board-scroll')).toBeVisible()
  expect(await boardLabels(page)).toEqual(['Open at quit', 'Arrived by import'])
  await ctx.quit()
  removeDataDir(dataDir)
})

test('a pinned note that was in Trash is still pinned when it is brought back from a restored backup', async () => {
  const dataDir = freshDataDir()
  const file = join(tempDir('tn-backup-pin-'), 'pinned-in-trash.tnbackup')
  let ctx = await launch({ dataDir, size: SIZE })
  let { page, app } = ctx
  await writeNote(page, ['Keeper note', 'Stays on the board.'])
  await writeNote(page, ['Pinned rule', 'Pinned, then moved to Trash.'])
  await pin(page, 'Pinned rule')
  await moveToTrash(page, 'Pinned rule')
  expect(await pinnedIndex(page)).toEqual([])

  // In the app itself a note restored from Trash gets its pin back.
  await restoreFromTrash(page, 'Pinned rule')
  await expect(noteByText(page, 'Pinned rule')).toHaveClass(/is-pinned/)
  expect(await pinnedIndex(page)).toEqual(['Pinned rule'])
  await moveToTrash(page, 'Pinned rule')

  await openBackupPanel(page)
  await answerSaveDialog(app, file)
  await page.getByTestId('export-backup').click()
  await expect(sheet(page).locator('.setting-success')).toContainText('Saved 1 note and 0 images')
  await ctx.quit()
  removeDataDir(dataDir)

  // Restore on a new profile, then take the note out of Trash there.
  const restoredDir = freshDataDir()
  ctx = await launch({ dataDir: restoredDir, size: SIZE })
  ;({ page, app } = ctx)
  await openBackupPanel(page)
  await chooseBackupFile(ctx, file)
  await expect(preview(page)).toContainText('plus 1 note in Trash')
  await replaceChoice(page).check()
  await page.getByTestId('confirm-replace').check()
  await runImport(page).click()
  await expect(importResult(page)).toContainText('Restored 2 notes and 0 images from the backup.')
  await closePanel(page)
  expect(await boardLabels(page)).toEqual(['Keeper note'])
  await restoreFromTrash(page, 'Pinned rule')
  expect(await boardLabels(page)).toEqual(['Keeper note', 'Pinned rule'])
  await expect(noteByText(page, 'Pinned rule')).toHaveClass(/is-pinned/)
  expect(await pinnedIndex(page)).toEqual(['Pinned rule'])
  expect((await storedState(app)).pins).toEqual(['Pinned rule'])
  await ctx.quit()
  removeDataDir(restoredDir)
})

test('export says so when a screenshot file is gone from the notes folder and could not be included', async () => {
  const dataDir = freshDataDir()
  const file = join(tempDir('tn-backup-lost-'), 'image-file-lost.tnbackup')
  const ctx = await launch({ dataDir, size: SIZE })
  const { page, app } = ctx
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()
  await page.keyboard.type('Chart note')
  await page.keyboard.press('Enter')
  await pasteScreenshot(ctx, GREEN, 1)
  await logNote(page)
  expect(Object.keys(attachmentFiles(dataDir))).toHaveLength(1)

  // The image file disappears from the managed folder (disk fault, cleanup tool, deleted by hand).
  for (const name of Object.keys(attachmentFiles(dataDir))) rmSync(join(attachmentsDir(dataDir), name))

  await openBackupPanel(page)
  await answerSaveDialog(app, file)
  await page.getByTestId('export-backup').click()
  const line = sheet(page).locator('.setting-success')
  await expect(line).toContainText('Saved 1 note and 0 images')
  // The archive is still written, with the words, and without the picture.
  const entries = await readZip(file)
  expect([...entries.keys()].sort()).toEqual(['data.json', 'manifest.json'])
  expect(JSON.parse(entries.get('manifest.json')!.toString('utf8'))).toMatchObject({ counts: { notes: 1, attachments: 0 }, attachments: [] })

  // Importing this file warns that an image is missing, so the export has to say so as well:
  // otherwise the backup looks complete on the day it is made.
  await expect(sheet(page).locator('.setting-section').first()).toContainText(/1 (image|screenshot)[^.]*(missing|could not|not included|left out)/i)
  await ctx.quit()
  removeDataDir(dataDir)
})

test('a failed export says why, writes nothing, and does not leave an earlier success line on screen', async () => {
  const dataDir = freshDataDir()
  const dir = tempDir('tn-backup-fail-')
  const good = join(dir, 'first.tnbackup')
  const blocker = join(dir, 'not-a-folder')
  writeFileSync(blocker, 'a plain file, so nothing can be created underneath it')
  const impossible = join(blocker, 'inside', 'second.tnbackup')
  const ctx = await launch({ dataDir, size: SIZE })
  const { page, app } = ctx
  await writeNote(page, ['Only note', 'Enough to export.'])
  await openBackupPanel(page)
  const success = sheet(page).locator('.setting-success')

  // A destination that cannot be written: a clear error, no success line, no file.
  await answerSaveDialog(app, impossible)
  await page.getByTestId('export-backup').click()
  await expect(panelError(page)).toContainText('The backup could not be written')
  await expect(success).toHaveCount(0)
  expect(readdirSync(dir).sort()).toEqual(['not-a-folder'])
  await expect(page.getByTestId('export-backup')).toBeEnabled()

  // Trying again somewhere writable works, and the error goes away.
  await answerSaveDialog(app, good)
  await page.getByTestId('export-backup').click()
  await expect(success).toContainText('Saved 1 note and 0 images')
  await expect(panelError(page)).toHaveCount(0)
  expect(readdirSync(dir).sort()).toEqual(['first.tnbackup', 'not-a-folder'])
  // "Show file" points at the file that was just written.
  await recordShownFiles(app)
  await success.getByRole('button', { name: 'Show file' }).click()
  await expect.poll(async () => (await dialogLog(app)).shown).toEqual([good])

  // A later export that fails must not keep saying "Saved ..." next to its error.
  await answerSaveDialog(app, impossible)
  await page.getByTestId('export-backup').click()
  await expect(panelError(page)).toContainText('The backup could not be written')
  await expect(success).toHaveCount(0)
  await ctx.quit()
  removeDataDir(dataDir)
})
