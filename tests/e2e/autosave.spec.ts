/**
 * Autosave while typing without a pause: the text must reach the disk during the typing,
 * not only once the typist stops.
 */
import { expect, test } from './fixtures'
import { clickEmptySpace, focusView, storedNotes } from './helpers'
import { launch, removeDataDir, type Launched } from './launch'

let ctx: Launched | null = null

test.afterEach(async () => {
  if (!ctx) return
  await ctx.quit()
  removeDataDir(ctx.dataDir)
  ctx = null
})

test('non-stop typing is saved while it is still going on', async () => {
  ctx = await launch()
  const { app, page } = ctx
  await clickEmptySpace(page)
  await expect(focusView(page)).toBeVisible()

  // About 6 seconds of typing with no pause long enough for the usual "after a pause" save.
  const text = 'steady typing without a single pause long enough to trigger the usual save '.repeat(1)
  let finished = false
  const typing = page.keyboard.type(text, { delay: 80 }).then(() => {
    finished = true
  })

  // Something must be on disk well before the typing ends.
  await expect.poll(async () => (await storedNotes(app))[0]?.plainText.length ?? 0, { timeout: 4000, intervals: [100] }).toBeGreaterThan(5)
  expect(finished).toBe(false)

  // And it keeps being saved as the typing goes on, not just once.
  const first = (await storedNotes(app))[0]!.plainText.length
  await expect.poll(async () => (await storedNotes(app))[0]?.plainText.length ?? 0, { timeout: 4000, intervals: [100] }).toBeGreaterThan(first + 5)
  expect(finished).toBe(false)

  await typing
  await expect.poll(async () => (await storedNotes(app))[0]?.plainText.trim()).toBe(text.trim())
})
