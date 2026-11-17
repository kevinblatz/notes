import { expect, test } from './fixtures'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clickEmptySpace, collectConsoleErrors, copyHtmlToClipboard, copyImageToClipboard, editorBody, focusView, makePng, notes, storedNotes, writeNote } from './helpers'
import { freshDataDir, launch, removeDataDir, type Launched } from './launch'

const RED = makePng(640, 360, [220, 70, 60])
const BLUE = makePng(2400, 1350, [60, 110, 220])

const loaded = (selector: string) => async (page: Launched['page']): Promise<number[]> =>
  page.locator(selector).evaluateAll((images) => images.map((image) => (image as HTMLImageElement).naturalWidth))

async function waitForImages(page: Launched['page'], selector: string, count: number): Promise<void> {
  await expect(page.locator(selector)).toHaveCount(count)
  await expect.poll(async () => (await loaded(selector)(page)).every((width) => width > 0)).toBe(true)
}

test('paste a screenshot, add text, import another image; everything survives a restart', async () => {
  const dataDir = freshDataDir()
  let ctx = await launch({ dataDir, size: { width: 960, height: 1000 } })
  let errors = await collectConsoleErrors(ctx.page)
  let { page, app } = ctx

  await clickEmptySpace(page)
  await page.keyboard.type('Text above the screenshot')
  await page.keyboard.press('Enter')

  // 1. Ctrl+V after taking a screenshot (image on the clipboard, no text).
  await copyImageToClipboard(app, RED)
  await page.keyboard.press('Control+v')
  await waitForImages(page, '.image-node img', 1)

  await page.keyboard.type('Text between the two images')

  // 3. The contextual Add image action (file picker).
  await page.getByTestId('image-input').setInputFiles({ name: 'big-chart.png', mimeType: 'image/png', buffer: BLUE })
  await waitForImages(page, '.image-node img', 2)
  await page.keyboard.type('Text below both')

  // Caption and resize (aspect ratio is preserved because only the width changes).
  const second = page.locator('.image-node').nth(1)
  await second.locator('img').click()
  await second.locator('.image-caption').fill('NQ 5 minute, London open')
  const handle = second.locator('.image-resize')
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  const ratioBefore = await second.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth / (image as HTMLImageElement).naturalHeight)
  const box = (await second.locator('img').boundingBox())!
  expect(Math.abs(box.width / box.height - ratioBefore)).toBeLessThan(0.02)

  // Drag-resize with the mouse too.
  const handleBox = (await handle.boundingBox())!
  await page.mouse.move(handleBox.x + 6, handleBox.y + 6)
  await page.mouse.down()
  await page.mouse.move(handleBox.x - 120, handleBox.y + 6, { steps: 6 })
  await page.mouse.up()
  const narrower = (await second.locator('img').boundingBox())!
  expect(narrower.width).toBeLessThan(box.width - 60)
  expect(Math.abs(narrower.width / narrower.height - ratioBefore)).toBeLessThan(0.02)

  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await waitForImages(page, '.note .note-image img', 2)
  await expect(notes(page).first().locator('figcaption')).toHaveText('NQ 5 minute, London open')

  // Images are files in the managed folder (not base64 in the note record).
  const stored = await storedNotes(app)
  expect(JSON.stringify(stored[0]!.content)).not.toContain('base64')
  expect(JSON.stringify(stored[0]!.content).length).toBeLessThan(3000)
  const attachmentDir = join(dataDir, 'library', 'attachments')
  const files = readdirSync(attachmentDir)
  // Two originals; the large one also has a smaller preview.
  expect(files.filter((name) => !name.includes('.preview.'))).toHaveLength(2)
  expect(files.filter((name) => name.includes('.preview.'))).toHaveLength(1)
  // The imported file is kept byte for byte at full resolution.
  expect(files.some((name) => !name.includes('.preview.') && readFileSync(join(attachmentDir, name)).equals(BLUE))).toBe(true)
  const previewName = files.find((name) => name.includes('.preview.'))!
  expect(readFileSync(join(attachmentDir, previewName)).length).toBeLessThan(BLUE.length)

  // The board shows the preview; the larger view loads the full-resolution original.
  const boardWidths = await loaded('.note .note-image img')(page)
  expect(Math.max(...boardWidths)).toBeLessThanOrEqual(1800)
  await notes(page).first().locator('.note-image-button').nth(1).click()
  await expect(page.getByTestId('image-preview')).toBeVisible()
  await expect.poll(async () => (await loaded('[data-testid="image-preview"] img')(page))[0]).toBe(2400)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.locator('.preview-zoom')).toHaveText('140%')
  // Esc closes the preview only; the board stays as it was.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('image-preview')).toBeHidden()
  await expect(focusView(page)).toBeHidden()

  expect(errors).toEqual([])
  await ctx.quit()

  // ---- restart
  ctx = await launch({ dataDir, size: { width: 960, height: 1000 } })
  errors = await collectConsoleErrors(ctx.page)
  ;({ page, app } = ctx)
  await expect(notes(page)).toHaveCount(1)
  await waitForImages(page, '.note .note-image img', 2)
  await expect(notes(page).first().locator('.prose > p')).toHaveText(['Text above the screenshot', 'Text between the two images', 'Text below both'])
  await expect(notes(page).first().locator('figcaption')).toHaveText('NQ 5 minute, London open')
  // The resized width was kept.
  const widths = await notes(page).first().locator('.note-image').evaluateAll((figures) => figures.map((figure) => (figure as HTMLElement).style.width))
  expect(widths[0]).toBe('100%')
  expect(Number.parseInt(widths[1]!, 10)).toBeLessThan(80)
  expect(errors).toEqual([])
  await ctx.quit()
  removeDataDir(dataDir)
})

test('an image-only note is kept; JPEG and WebP import; non-images are refused', async () => {
  const ctx = await launch({ size: { width: 960, height: 1000 } })
  const { page, app } = ctx

  await clickEmptySpace(page)
  await copyImageToClipboard(app, RED)
  await page.keyboard.press('Control+v')
  await waitForImages(page, '.image-node img', 1)
  await page.keyboard.press('Escape')
  await expect(notes(page)).toHaveCount(1)
  await expect(notes(page).first().locator('.note-image img')).toHaveCount(1)

  // Other raster formats, produced by the browser itself.
  const encoded = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(300, 200)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#3a7'
    context.fillRect(0, 0, 300, 200)
    const out: Record<string, string> = {}
    for (const type of ['image/jpeg', 'image/webp']) {
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type })).arrayBuffer())
      out[type] = btoa(String.fromCharCode(...bytes))
    }
    return out
  })
  await clickEmptySpace(page)
  await page.getByTestId('image-input').setInputFiles([
    { name: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(encoded['image/jpeg']!, 'base64') },
    { name: 'b.webp', mimeType: 'image/webp', buffer: Buffer.from(encoded['image/webp']!, 'base64') }
  ])
  await waitForImages(page, '.image-node img', 2)

  // A text file dressed up as a PNG is refused with a clear message and nothing is inserted.
  await page.getByTestId('image-input').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload=alert(1)>') })
  await expect(page.locator('.toast.is-error')).toContainText('not an image')
  await expect(page.locator('.image-node')).toHaveCount(2)
  await page.keyboard.press('Control+Enter')
  await expect(notes(page)).toHaveCount(2)

  const extensions = readdirSync(join(ctx.dataDir, 'library', 'attachments')).map((name) => name.slice(name.lastIndexOf('.'))).sort()
  expect(extensions).toEqual(['.jpg', '.png', '.webp'])
  await ctx.quit()
})

test('dropping an image on empty board space starts an image note there; dropping into the editor inserts at that spot', async () => {
  const ctx = await launch({ size: { width: 960, height: 1000 } })
  const { page } = ctx
  await writeNote(page, ['First note'])
  await writeNote(page, ['Second note'])

  const dropFile = async (selector: string, clientX: number, clientY: number): Promise<void> => {
    await page.evaluate(
      async ({ selector, clientX, clientY, base64 }) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        const transfer = new DataTransfer()
        transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
        const target = document.elementFromPoint(clientX, clientY)?.closest(selector) ?? document.querySelector(selector)!
        const init = { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: transfer }
        const at = document.elementFromPoint(clientX, clientY) ?? target
        at.dispatchEvent(new DragEvent('dragover', init))
        at.dispatchEvent(new DragEvent('drop', init))
      },
      { selector, clientX, clientY, base64: RED.toString('base64') }
    )
  }

  // Drop into the gap between the two notes.
  const firstBox = (await notes(page).nth(0).boundingBox())!
  const secondBox = (await notes(page).nth(1).boundingBox())!
  await dropFile('[data-testid="board"]', firstBox.x + 200, (firstBox.y + firstBox.height + secondBox.y) / 2)
  await expect(focusView(page)).toBeVisible()
  await waitForImages(page, '.image-node img', 1)
  await page.keyboard.press('Control+Enter')
  await expect(notes(page)).toHaveCount(3)
  // The image note sits between the two notes it was dropped between.
  await expect(notes(page).nth(1).locator('.note-image img')).toHaveCount(1)
  await expect(notes(page).nth(0)).toContainText('First note')
  await expect(notes(page).nth(2)).toContainText('Second note')

  // Drop into an open editor between two paragraphs.
  await clickEmptySpace(page)
  await page.keyboard.type('Paragraph one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Paragraph two')
  const target = (await editorBody(page).locator('p').nth(1).boundingBox())!
  await dropFile('.ProseMirror', target.x + 2, target.y + target.height / 2)
  await waitForImages(page, '.image-node img', 1)
  const order = await editorBody(page).evaluate((root) => Array.from(root.children).map((child) => (child.matches('.image-node, [data-node-view-wrapper], .react-renderer') ? 'image' : child.textContent)))
  expect(order.slice(0, 3)).toEqual(['Paragraph one', 'image', 'Paragraph two'])
  await page.keyboard.press('Escape')
  await ctx.quit()
})

test('fonts, sizes, colours and highlights persist across a restart', async () => {
  const dataDir = freshDataDir()
  let ctx = await launch({ dataDir, size: { width: 960, height: 1000 } })
  let { page, app } = ctx

  await clickEmptySpace(page)
  await page.keyboard.type('Styled words')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Plain words')
  // Select the first paragraph only.
  await editorBody(page).locator('p').first().click({ clickCount: 3 })

  const pick = async (control: string, item: string): Promise<void> => {
    await page.getByRole('toolbar', { name: 'Formatting', exact: true }).getByRole('button', { name: control }).click()
    await page.getByRole('menuitemcheckbox', { name: item, exact: true }).click()
  }
  await pick('Font', 'Literata')
  await pick('Text size', '22')
  const bar = page.getByRole('toolbar', { name: 'Formatting', exact: true })
  await bar.getByRole('button', { name: 'Text color' }).click()
  await page.getByRole('group', { name: 'Text color' }).getByRole('button', { name: 'red' }).click()
  await bar.getByRole('button', { name: 'Highlight' }).click()
  await page.getByRole('group', { name: 'Highlight color' }).getByRole('button', { name: 'teal' }).click()
  await bar.getByRole('button', { name: 'Bold' }).click()
  await bar.getByRole('button', { name: 'Italic' }).click()
  await bar.getByRole('button', { name: 'Underline' }).click()
  await bar.getByRole('button', { name: 'Strikethrough' }).click()

  // Mixed formatting inside one note: the second paragraph becomes a heading with its own style.
  await editorBody(page).locator('p').nth(1).click()
  await pick('Paragraph style', 'Heading 2')
  // Pressed immediately after choosing from the menu: must still log the note.
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()

  const expectFormatting = async (): Promise<void> => {
    const styled = notes(page).first().locator('.prose p').first()
    await expect(styled).toHaveText('Styled words')
    const computed = await styled.evaluate((paragraph) => {
      const leaf = paragraph.querySelector('span span, span mark, mark span, strong, em') ?? paragraph
      let node: Element | null = leaf
      while (node && node.children.length > 0) node = node.children[0]!
      const style = getComputedStyle(node ?? paragraph)
      return {
        family: style.fontFamily,
        size: style.fontSize,
        color: style.color,
        weight: Number(style.fontWeight),
        italic: style.fontStyle,
        decoration: style.textDecorationLine,
        marked: !!paragraph.querySelector('mark'),
        html: paragraph.innerHTML
      }
    })
    expect(computed.family).toContain('Literata')
    expect(computed.size).toBe('22px')
    expect(computed.color).toBe('rgb(240, 137, 122)')
    expect(computed.weight).toBeGreaterThanOrEqual(600)
    expect(computed.italic).toBe('italic')
    expect(computed.marked).toBe(true)
    expect(computed.html).toContain('<u>')
    expect(computed.html).toContain('<s>')
    expect(computed.html).toContain('var(--hl-teal)')
    await expect(notes(page).first().locator('.prose h2')).toHaveText('Plain words')
  }
  await expectFormatting()
  const before = JSON.stringify((await storedNotes(app))[0]!.content)
  await ctx.quit()

  ctx = await launch({ dataDir, size: { width: 960, height: 1000 } })
  ;({ page, app } = ctx)
  await expectFormatting()
  expect(JSON.stringify((await storedNotes(app))[0]!.content)).toBe(before)

  // Reopening shows the same formatting as active in the editor, and re-saving does not alter it.
  await notes(page).first().locator('.prose p').first().click()
  const bar2 = page.getByRole('toolbar', { name: 'Formatting', exact: true })
  await expect(bar2.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
  await expect(bar2.getByRole('button', { name: 'Font' })).toContainText('Literata')
  await expect(bar2.getByRole('button', { name: 'Text size' })).toContainText('22')
  // Undo and redo are ordinary editor operations.
  await page.keyboard.press('End')
  await page.keyboard.type(' extra')
  await page.keyboard.press('Control+z')
  await expect(editorBody(page).locator('p').first()).toHaveText('Styled words')
  await page.keyboard.press('Control+Enter')
  expect(JSON.stringify((await storedNotes(app))[0]!.content)).toBe(before)
  expect(existsSync(join(dataDir, 'library', 'notes.db'))).toBe(true)
  await ctx.quit()
  removeDataDir(dataDir)
})

test('pasting from a website keeps structure but not scripts, remote images or foreign styling', async () => {
  const ctx = await launch({ size: { width: 960, height: 1000 } })
  const { page, app } = ctx
  await clickEmptySpace(page)
  const html =
    '<h2 style="color:#000;font-family:Comic Sans MS;font-size:40px">Heading</h2>' +
    '<p style="background:yellow">Some <b>bold</b> and <i>italic</i> and <a href="https://example.com/x">a link</a> and <a href="javascript:alert(1)">bad link</a>.</p>' +
    '<ul><li>one</li><li>two</li></ul>' +
    '<img src="https://example.com/tracker.png" onerror="window.__pwned = 1"><script>window.__pwned = 1</script>' +
    '<iframe src="https://example.com"></iframe>'
  await copyHtmlToClipboard(app, html, 'Heading\nSome bold and italic and a link and bad link.\none\ntwo')
  await page.keyboard.press('Control+v')
  await expect(editorBody(page).locator('h2')).toHaveText('Heading')
  const pasted = await editorBody(page).innerHTML()
  expect(pasted).toContain('<strong>bold</strong>')
  expect(pasted).toContain('<em>italic</em>')
  expect(pasted).toContain('href="https://example.com/x"')
  expect(pasted).not.toMatch(/javascript:|<img|<script|<iframe|Comic|40px|yellow|onerror/)
  await expect(editorBody(page).locator('li')).toHaveText(['one', 'two'])
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()

  // Paste as plain text: no formatting at all.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Control+Shift+v')
  await expect(editorBody(page)).toContainText('Some bold and italic')
  expect(await editorBody(page).innerHTML()).not.toMatch(/<strong>|<h2>|<a /)
  await page.keyboard.press('Control+Enter')
  expect(JSON.stringify((await storedNotes(app))[0]!.content)).not.toMatch(/javascript|bold"/)
  await ctx.quit()
})

test('Esc closes the selection bubble row before the note; Ctrl+Enter in a caption logs the note', async () => {
  const ctx = await launch({ size: { width: 960, height: 1000 } })
  const { page, app } = ctx

  // Select text, open the link row in the bubble, start typing, then Esc: only the row closes.
  await clickEmptySpace(page)
  await page.keyboard.type('Read the session notes')
  await page.keyboard.press('Control+a')
  const bubble = page.getByRole('toolbar', { name: 'Selection formatting' })
  await expect(bubble).toBeVisible()
  await bubble.getByRole('button', { name: 'Link' }).click()
  const address = bubble.getByRole('textbox', { name: 'Link address' })
  await expect(address).toBeVisible()
  await address.fill('https://exam')
  await page.keyboard.press('Escape')
  await expect(address).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  await expect(editorBody(page)).toHaveText('Read the session notes')
  // The same for the colour row.
  await page.keyboard.press('Control+a')
  await bubble.getByRole('button', { name: 'Text color' }).click()
  await expect(bubble.getByRole('group', { name: 'Text color' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bubble.getByRole('group', { name: 'Text color' })).toBeHidden()
  await expect(focusView(page)).toBeVisible()
  // With nothing else open, Esc returns to the board and the note is kept.
  await editorBody(page).click()
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page)).toHaveCount(1)

  // A caption is being typed: Ctrl+Enter logs the note in one press, caption included.
  await clickEmptySpace(page)
  await copyImageToClipboard(app, RED)
  await page.keyboard.press('Control+v')
  await waitForImages(page, '.image-node img', 1)
  await page.locator('.image-node img').click()
  const caption = page.locator('.image-caption')
  await caption.click()
  await page.keyboard.type('Entry on the retest')
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await expect(notes(page).nth(1).locator('figcaption')).toHaveText('Entry on the retest')
  expect((await storedNotes(app)).some((n) => JSON.stringify(n.content).includes('Entry on the retest'))).toBe(true)
  await ctx.quit()
})
