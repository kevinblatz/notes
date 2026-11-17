/**
 * Requirement 10: low idle CPU, no polling, no rebuilding every note per keystroke, and a few
 * hundred notes with screenshots stay responsive.
 *
 * A library of 300 notes, 30 side-by-side pairs and 80 screenshots (1280x720 PNG) is written
 * straight into the store once, then every test loads it from disk like a normal start.
 * Thresholds are deliberately loose (4 slow cores, software rendering): they catch a real
 * regression, not jitter. The measured numbers are printed at the end of the run.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { board, collectConsoleErrors, editorBody, focusView, makePng, noteByText, notes, type TestHandle } from './helpers'
import { freshDataDir, launch, removeDataDir, setWindowSize, type Launched } from './launch'

const NOTE_COUNT = 300
const IMAGE_COUNT = 80
const PAIR_COUNT = 30
const TARGET_INDEX = 150
const TARGET_TEXT = 'Perf target note in the middle of the board'
const SIZE = { width: 960, height: 1000 }

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Array<{ type: string }> }
interface SeedNote { id: string; title: string | null; content: { type: 'doc'; content: Node[] }; tags: string[]; images: number[] }
interface SeedHandle {
  library: {
    db: { transaction: <T>(fn: () => T) => T; getLayout: () => { rows: Array<{ id: string; notes: string[] }> } }
    importImage: (input: { bytes: Uint8Array; name: string | null; width: number; height: number; preview: null }) => { id: string }
    createNote: (input: { id: string; title: string | null; content: unknown; tags: string[]; placement: { kind: 'row'; index: number } }) => unknown
    saveLayout: (layout: unknown) => unknown
  }
}

const measurements: Record<string, unknown> = {}
const record = (key: string, value: unknown): void => {
  measurements[key] = value
  console.log(`[perf] ${key}: ${JSON.stringify(value)}`)
}
const round = (n: number, digits = 1): number => Number(n.toFixed(digits))
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

const p = (text: string): Node => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const SENTENCES = [
  'Wait for the sweep of the session low before looking for an entry.',
  'Liquidity above the equal highs is the draw for the afternoon.',
  'Displacement through the fair value gap, then the retest.',
  'No trade inside the first five minutes after the open.',
  'Risk one unit, target the opposing liquidity pool.',
  'If the level fails twice, stand aside and journal it.'
]
const sentence = (n: number): string => SENTENCES[n % SENTENCES.length]!

function buildNotes(): SeedNote[] {
  const out: SeedNote[] = []
  for (let i = 0; i < NOTE_COUNT; i++) {
    const id = `perf-note-${String(i).padStart(4, '0')}`
    let title: string | null = null
    let content: Node[]
    const kind = i % 6
    if (i === TARGET_INDEX) content = [p(TARGET_TEXT), p('Second line of the target note.')]
    else if (kind === 0) content = [p(`${sentence(i)} (${i})`)]
    else if (kind === 1) {
      title = `Setup ${i}: London sweep`
      content = [{ type: 'bulletList', content: [0, 1, 2, 3].map((k) => ({ type: 'listItem', content: [p(sentence(i + k))] })) }]
    } else if (kind === 2) {
      title = `Checklist ${i}`
      content = [{ type: 'taskList', content: [0, 1, 2, 3, 4].map((k) => ({ type: 'taskItem', attrs: { checked: k % 2 === 0 }, content: [p(sentence(i + k))] })) }]
    } else if (kind === 3) {
      title = `Journal ${i}`
      content = Array.from({ length: 12 }, (_, k) => p(`${sentence(i + k)} ${sentence(i + k + 1)} ${sentence(i + k + 2)}`))
    } else if (kind === 4) {
      content = [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Rules for day ${i}` }] },
        { type: 'orderedList', attrs: { start: 1 }, content: [0, 1, 2].map((k) => ({ type: 'listItem', content: [p(sentence(i + k))] })) }
      ]
    } else {
      content = [
        { type: 'paragraph', content: [{ type: 'text', text: 'Important: ', marks: [{ type: 'bold' }] }, { type: 'text', text: sentence(i) }] },
        p(`${sentence(i + 3)} (${i})`)
      ]
    }
    out.push({ id, title, content: { type: 'doc', content }, tags: i % 5 === 0 ? ['Setups'] : i % 7 === 0 ? ['Journal'] : [], images: [] })
  }
  // 75 notes carry one screenshot; five of them carry a second one: 80 screenshots in all.
  let image = 0
  for (let i = 0; i < NOTE_COUNT; i += 4) out[i]!.images.push(image++)
  for (let i = 0; image < IMAGE_COUNT; i += 60) out[i]!.images.push(image++)
  return out
}

async function seed(dataDir: string): Promise<void> {
  const images = Array.from({ length: IMAGE_COUNT }, (_, i) => makePng(1280, 720, [(i * 37) % 256, (i * 91 + 60) % 256, (i * 53 + 120) % 256]).toString('base64'))
  const started = Date.now()
  const ctx = await launch({ dataDir })
  record('launchEmptyMs', Date.now() - started)
  const seeded = await ctx.app.evaluate((_electron, input) => {
    const { library } = (globalThis as unknown as { __tnTest: SeedHandle }).__tnTest
    const t0 = Date.now()
    library.db.transaction(() => {
      const ids = input.images.map((base64, i) => library.importImage({ bytes: new Uint8Array(Buffer.from(base64, 'base64')), name: `shot-${i}.png`, width: 1280, height: 720, preview: null }).id)
      for (const note of input.notes) {
        const content = [...note.content.content]
        note.images.forEach((index, k) => {
          content.splice(1 + k, 0, { type: 'noteImage', attrs: { attachmentId: ids[index], width: 100, caption: `Chart ${index}`, naturalWidth: 1280, naturalHeight: 720 } })
        })
        library.createNote({ id: note.id, title: note.title, content: { type: 'doc', content }, tags: note.tags, placement: { kind: 'row', index: 99999 } })
      }
      // Every tenth row takes the following note as its right-hand neighbour.
      const rows = library.db.getLayout().rows
      const merged: Array<{ id: string; notes: string[] }> = []
      let pairs = 0
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!
        if (r % 10 === 1 && pairs < input.pairs && rows[r + 1]) {
          merged.push({ id: row.id, notes: [...row.notes, ...rows[r + 1]!.notes] })
          pairs++
          r++
        } else merged.push(row)
      }
      library.saveLayout({ rows: merged })
    })
    const layout = library.db.getLayout().rows
    return { ms: Date.now() - t0, rows: layout.length, pairs: layout.filter((row) => row.notes.length === 2).length }
  }, { images, notes: buildNotes(), pairs: PAIR_COUNT })
  record('seed', { ...seeded, pngKb: Math.round((images[0]!.length * 0.75) / 1024) })
  expect(seeded.pairs).toBe(PAIR_COUNT)
  await ctx.quit()
}

type Metric = { type: string; cpu: number; memMb: number }
const appMetrics = (app: ElectronApplication): Promise<Metric[]> =>
  app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => ({ type: m.serviceName ? `${m.type}:${m.serviceName}` : m.type, cpu: m.cpu.percentCPUUsage, memMb: m.memory.workingSetSize / 1024 })))

/** Average percentCPUUsage per process over `seconds` (Electron reports usage since the previous call). */
async function idleCpu(app: ElectronApplication, seconds = 6): Promise<Record<string, number>> {
  await appMetrics(app)
  const sums: Record<string, number> = {}
  const samples = 3
  for (let i = 0; i < samples; i++) {
    await new Promise((resolve) => setTimeout(resolve, (seconds * 1000) / samples))
    for (const m of await appMetrics(app)) sums[m.type] = (sums[m.type] ?? 0) + m.cpu / samples
  }
  const out: Record<string, number> = { total: 0 }
  for (const [type, value] of Object.entries(sums)) {
    out[type] = round(value, 2)
    out.total = round(out.total! + value, 2)
  }
  return out
}

async function memory(app: ElectronApplication): Promise<{ rendererMb: number; mainMb: number }> {
  const all = await appMetrics(app)
  const of = (type: string): number => Math.round(all.filter((m) => m.type === type).reduce((sum, m) => sum + m.memMb, 0))
  return { rendererMb: of('Tab'), mainMb: of('Browser') }
}

/** Count timer / frame requests made by the page, and the work the renderer did, over `ms` of idleness. */
async function idleActivity(page: Page, ms = 5000) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & { __idle?: { counts: Record<string, number>; stacks: string[]; restore: () => void } }
    const counts: Record<string, number> = { setInterval: 0, setTimeout: 0, requestAnimationFrame: 0 }
    const stacks: string[] = []
    const originals: Record<string, unknown> = {}
    for (const name of Object.keys(counts)) {
      const original = w[name] as (...args: unknown[]) => unknown
      originals[name] = original
      w[name] = (...args: unknown[]) => {
        counts[name]!++
        if (stacks.length < 8) stacks.push(`${name}: ${(new Error().stack ?? '').split('\n').slice(2, 5).join(' | ')}`)
        return original.apply(window, args)
      }
    }
    w.__idle = { counts, stacks, restore: () => Object.assign(w, originals) }
  })
  // CDP counters also see work started before the wrappers existed (an interval created at start-up).
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const read = async (): Promise<Record<string, number>> => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const before = await read()
  await page.waitForTimeout(ms)
  const after = await read()
  await cdp.detach()
  const result = await page.evaluate(() => {
    const idle = (window as unknown as { __idle: { counts: Record<string, number>; stacks: string[]; restore: () => void } }).__idle
    idle.restore()
    const running = document.getAnimations().filter((a) => a.playState === 'running')
    return {
      setInterval: idle.counts.setInterval ?? 0,
      setTimeout: idle.counts.setTimeout ?? 0,
      requestAnimationFrame: idle.counts.requestAnimationFrame ?? 0,
      stacks: idle.stacks,
      runningAnimations: running.length,
      animationTargets: running.slice(0, 5).map((a) => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.className ?? '?')
    }
  })
  const delta = (name: string): number => (after[name] ?? 0) - (before[name] ?? 0)
  return { ...result, scriptMs: round(delta('ScriptDuration') * 1000), taskMs: round(delta('TaskDuration') * 1000), layouts: delta('LayoutCount'), styleRecalcs: delta('RecalcStyleCount') }
}

/** Same count for the main process's own timers. */
async function mainTimers(app: ElectronApplication, ms = 5000): Promise<Record<string, number>> {
  return app.evaluate(async (_electron, wait) => {
    const g = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>
    const counts: Record<string, number> = { setInterval: 0, setTimeout: 0, setImmediate: 0 }
    const originals: Record<string, (...args: unknown[]) => unknown> = {}
    for (const name of Object.keys(counts)) {
      originals[name] = g[name]!
      g[name] = (...args: unknown[]) => {
        counts[name]!++
        return originals[name]!(...args)
      }
    }
    await new Promise((resolve) => originals.setTimeout!(resolve, wait))
    Object.assign(g, originals)
    return counts
  }, ms)
}

/** Scroll the whole board top to bottom, one step per frame, timing every frame. */
async function scrollBoard(page: Page) {
  return page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="board-scroll"]')!
    scroller.scrollTop = 0
    const max = scroller.scrollHeight - scroller.clientHeight
    const step = Math.max(160, Math.ceil(max / 300))
    const frames: number[] = []
    await new Promise<void>((resolve) => {
      let last = performance.now()
      const tick = (now: number): void => {
        frames.push(now - last)
        last = now
        if (scroller.scrollTop >= max - 1) return resolve()
        scroller.scrollTop = Math.min(max, scroller.scrollTop + step)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame((now) => {
        last = now
        requestAnimationFrame(tick)
      })
    })
    const loaded = Array.from(document.querySelectorAll('img')).filter((img) => img.complete && img.naturalWidth > 0).length
    return { frames, heightPx: scroller.scrollHeight, stepPx: step, imagesLoaded: loaded, images: document.querySelectorAll('img').length }
  })
}

let dataDir: string
let ctx: Launched
let errors: string[]
let launchMs = 0

test.beforeAll(async () => {
  test.setTimeout(180_000)
  dataDir = freshDataDir()
  await seed(dataDir)
})
test.afterAll(() => {
  console.log(`[perf] MEASUREMENTS ${JSON.stringify(measurements)}`)
  if (dataDir) removeDataDir(dataDir)
})
test.beforeEach(async () => {
  const started = Date.now()
  ctx = await launch({ dataDir })
  await expect(notes(ctx.page)).toHaveCount(NOTE_COUNT)
  launchMs = Date.now() - started
  errors = await collectConsoleErrors(ctx.page)
  await setWindowSize(ctx.app, ctx.page, SIZE.width, SIZE.height)
})
test.afterEach(async () => {
  expect(errors, 'no console errors').toEqual([])
  await ctx.quit()
})

test('300 notes with 80 screenshots: start-up, scrolling and memory stay reasonable', async () => {
  test.setTimeout(180_000)
  const { page, app } = ctx
  record('launchToReady300Ms', launchMs)
  // Threshold: process start to all 300 notes rendered within 15 s (an empty start takes about 1-2 s here).
  expect(launchMs).toBeLessThan(15_000)
  expect(await page.locator('.board > .note img').count()).toBe(IMAGE_COUNT)

  await page.waitForTimeout(1500)
  const memoryAfterLoad = await memory(app)
  record('memoryAfterLoad', memoryAfterLoad)

  const first = await scrollBoard(page)
  // A second pass has every screenshot decoded: this is what scrolling back through notes feels like.
  const second = await scrollBoard(page)
  const summarize = (frames: number[]) => ({
    frames: frames.length,
    avgMs: round(frames.reduce((a, b) => a + b, 0) / frames.length),
    worstMs: round(Math.max(...frames)),
    over50ms: frames.filter((f) => f > 50).length
  })
  const cold = summarize(first.frames)
  const warm = summarize(second.frames)
  record('scrollFirstPass', { ...cold, boardHeightPx: first.heightPx, stepPx: first.stepPx, imagesLoaded: `${first.imagesLoaded}/${first.images}` })
  record('scrollSecondPass', warm)
  // Thresholds (60 Hz display = 16.7 ms per frame): average frame under 50 ms on both passes; no
  // single frame over 1 s; at most 15 % of frames over 50 ms while screenshots are first decoded
  // and at most 10 % once they are.
  expect(cold.avgMs).toBeLessThan(50)
  expect(warm.avgMs).toBeLessThan(50)
  expect(cold.worstMs).toBeLessThan(1000)
  expect(warm.worstMs).toBeLessThan(1000)
  expect(cold.over50ms).toBeLessThanOrEqual(Math.ceil(cold.frames * 0.15))
  expect(warm.over50ms).toBeLessThanOrEqual(Math.ceil(warm.frames * 0.1))

  await page.waitForTimeout(1000)
  const memoryAfterScroll = await memory(app)
  record('memoryAfterScroll', memoryAfterScroll)
  // Thresholds: renderer working set under 1500 MB with all 80 screenshots (3.5 MB each decoded)
  // having been on screen; main process under 600 MB.
  expect(memoryAfterScroll.rendererMb).toBeLessThan(1500)
  expect(memoryAfterScroll.mainMb).toBeLessThan(600)
})

test('typing in a note is fast and never touches the board; logging changes only that note', async () => {
  test.setTimeout(180_000)
  const { page } = ctx
  const target = noteByText(page, TARGET_TEXT)
  await target.scrollIntoViewIfNeeded()
  const targetId = await target.getAttribute('data-note-id')
  expect(targetId).toBe(`perf-note-${String(TARGET_INDEX).padStart(4, '0')}`)

  // Watch the whole board for any change at all, from before the note is opened.
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="board"]')!
    const log: Array<{ type: string; note: string; attr: string | null }> = []
    new MutationObserver((records) => {
      for (const r of records) {
        const owner = r.target instanceof Element ? r.target : r.target.parentElement
        const card = owner?.closest('[data-note-id]')
        log.push({ type: r.type, note: card?.getAttribute('data-note-id') ?? (r.target === element ? '(board)' : '(other)'), attr: r.attributeName })
      }
    }).observe(element, { subtree: true, childList: true, attributes: true, characterData: true })
    ;(window as unknown as { __boardLog: typeof log }).__boardLog = log
  })
  const boardLog = (): Promise<Array<{ type: string; note: string; attr: string | null }>> =>
    page.evaluate(() => (window as unknown as { __boardLog: Array<{ type: string; note: string; attr: string | null }> }).__boardLog.splice(0))

  let started = Date.now()
  await target.locator('.prose p').first().click()
  await expect(editorBody(page)).toBeFocused()
  const openMs = Date.now() - started
  record('openMiddleNoteMs', openMs)
  // Threshold: click to a focused editor within 1.5 s (includes Playwright's own click overhead).
  expect(openMs).toBeLessThan(1500)
  await page.keyboard.press('Control+End')
  await page.waitForTimeout(400)
  const openingMutations = await boardLog()

  // Keydown to the character being in the editor's DOM, and to the next frame after that.
  await page.evaluate(() => {
    const editor = document.querySelector('.focus-editor .ProseMirror')!
    const timing = { dom: [] as number[], frame: [] as number[] }
    let pressed: number | null = null
    window.addEventListener('keydown', () => (pressed = performance.now()), true)
    new MutationObserver(() => {
      if (pressed === null) return
      const t0 = pressed
      pressed = null
      timing.dom.push(performance.now() - t0)
      requestAnimationFrame(() => timing.frame.push(performance.now() - t0))
    }).observe(editor, { subtree: true, childList: true, characterData: true })
    ;(window as unknown as { __typing: typeof timing }).__typing = timing
  })
  const text = ' the sweep of the low held and price came back to the level before the close of the session and then ran the highs again'
  await page.keyboard.type(text, { delay: 25 })
  await expect(editorBody(page).locator('p').nth(1)).toHaveText(`Second line of the target note.${text}`)
  const typing = await page.evaluate(() => (window as unknown as { __typing: { dom: number[]; frame: number[] } }).__typing)
  const typingMutations = await boardLog()
  record('typing', {
    keystrokes: typing.dom.length,
    domMedianMs: round(percentile(typing.dom, 50), 2),
    domP95Ms: round(percentile(typing.dom, 95), 2),
    domWorstMs: round(Math.max(...typing.dom), 2),
    frameMedianMs: round(percentile(typing.frame, 50)),
    frameP95Ms: round(percentile(typing.frame, 95))
  })
  record('boardMutations', { whileOpening: openingMutations.length, whileTyping: typingMutations.length })
  expect(typing.dom.length).toBeGreaterThanOrEqual(text.length - 2)
  // Thresholds: median keystroke in the DOM within 16 ms (one frame) and 95th percentile within
  // 50 ms; painted (next frame) within 100 ms at the 95th percentile.
  expect(percentile(typing.dom, 50)).toBeLessThan(16)
  expect(percentile(typing.dom, 95)).toBeLessThan(50)
  expect(percentile(typing.frame, 95)).toBeLessThan(100)
  // Not one node of the board (300 notes) may change while typing, autosaves included.
  expect(typingMutations, 'board mutations while typing').toEqual([])

  // The autosave after a pause in typing may refresh the edited note's own (hidden) card, nothing else.
  await page.waitForTimeout(900)
  const autosave = await boardLog()
  record('boardMutationsFromAutosave', { records: autosave.length, notesTouched: [...new Set(autosave.map((m) => m.note))] })
  expect(autosave.filter((m) => m.note !== targetId), 'autosave touches no other note').toEqual([])

  started = Date.now()
  await page.keyboard.press('Control+Enter')
  await expect(focusView(page)).toBeHidden()
  await expect(target.locator('.prose p').nth(1)).toHaveText(`Second line of the target note.${text}`)
  const backMs = Date.now() - started
  record('returnToBoardMs', backMs)
  // Threshold: back on the board with the edit showing within 1.5 s.
  expect(backMs).toBeLessThan(1500)
  await page.waitForTimeout(2200) // the "just edited" outline has come and gone
  const logged = await boardLog()
  const touched = [...new Set(logged.map((m) => m.note))]
  record('boardMutationsAfterLogging', { records: logged.length, notesTouched: touched })
  expect(touched, 'only the edited note changes when it is logged').toEqual([targetId])
  await expect(notes(page)).toHaveCount(NOTE_COUNT)

  // Find: Ctrl+K, type a word, results on screen.
  started = Date.now()
  await page.keyboard.press('Control+K')
  const input = page.getByRole('combobox', { name: 'Find notes' })
  await expect(input).toBeFocused()
  const paletteMs = Date.now() - started
  started = Date.now()
  await page.keyboard.type('liquidity', { delay: 20 })
  await expect(page.getByRole('option').first()).toContainText(/liquidity/i)
  const queryMs = Date.now() - started
  const results = await page.getByRole('option').count()
  record('find', { openPaletteMs: paletteMs, typeQueryToResultsMs: queryMs, typingItselfMs: 9 * 20, results })
  // Thresholds: palette open within 1 s; nine typed characters (180 ms of typing) to rendered results within 2 s.
  expect(paletteMs).toBeLessThan(1000)
  expect(queryMs).toBeLessThan(2000)
  expect(results).toBeGreaterThan(5)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toBeHidden()
})

test('idle: no polling, no endless animation, negligible CPU (board, hidden window, open editor)', async () => {
  test.setTimeout(180_000)
  const { page, app } = ctx
  const handle = <T>(fn: (h: TestHandle) => T): Promise<T> => app.evaluate((_e, source) => (0, eval)(`(${source})`)((globalThis as unknown as { __tnTest: TestHandle }).__tnTest), fn.toString())
  await page.waitForTimeout(4000) // start-up work and image decoding have finished

  // Thresholds for every idle state below. CPU: all processes together under 5 % of one core on
  // average. Renderer: no setInterval at all, at most 2 one-off timers and 2 frame requests in
  // 5 s, no running animation, under 100 ms of script in 5 s. Main process: no setInterval and at
  // most 3 one-off timers in 5 s (a debounced window-state save is one-off).
  const check = async (label: string): Promise<void> => {
    const cpu = await idleCpu(app)
    const activity = await idleActivity(page)
    const main = await mainTimers(app)
    record(`idle.${label}`, { cpuPercent: cpu, renderer: activity, mainTimers: main })
    expect(cpu.total, `${label}: total CPU %`).toBeLessThan(5)
    expect(activity.setInterval, `${label}: setInterval calls`).toBe(0)
    expect(activity.setTimeout, `${label}: setTimeout calls ${activity.stacks.join(' ;; ')}`).toBeLessThanOrEqual(2)
    expect(activity.requestAnimationFrame, `${label}: requestAnimationFrame calls ${activity.stacks.join(' ;; ')}`).toBeLessThanOrEqual(2)
    expect(activity.runningAnimations, `${label}: running animations on ${activity.animationTargets.join(', ')}`).toBe(0)
    expect(activity.scriptMs, `${label}: renderer script time in 5 s`).toBeLessThan(100)
    expect(main.setInterval, `${label}: main-process setInterval`).toBe(0)
    expect(main.setTimeout, `${label}: main-process setTimeout`).toBeLessThanOrEqual(3)
  }

  await expect(board(page)).toBeVisible()
  await check('board')

  await handle((h) => h.windows.toggle())
  await expect.poll(() => handle((h) => h.windows.isShown())).toBe(false)
  await page.waitForTimeout(1500)
  await check('windowHidden')
  await handle((h) => h.windows.toggle())
  await expect.poll(() => handle((h) => h.windows.isShown())).toBe(true)

  await noteByText(page, 'Checklist 2').first().locator('.note-title').click()
  await expect(editorBody(page)).toBeFocused()
  await page.keyboard.type('x')
  await page.waitForTimeout(2500) // autosave written, opening transition finished
  await check('editorOpen')
  await page.keyboard.press('Escape')
  await expect(focusView(page)).toBeHidden()
})
