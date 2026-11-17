import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export const ROOT = resolve(__dirname, '../..')

export interface Launched {
  app: ElectronApplication
  page: Page
  dataDir: string
  /** Quit through the app's own shutdown path (flushes pending edits, closes the database). */
  quit: () => Promise<void>
}

export function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'tn-e2e-'))
}

export function removeDataDir(dir: string): void {
  // On Windows a file can stay locked for a moment after the app's processes exit.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch {
    // A leftover temp folder is not worth failing a test over.
  }
}

const mainPids = new WeakMap<ElectronApplication, number>()

/**
 * End the app the hard way, as a crash or a power cut would. On Windows the process handle
 * Playwright holds is a shell wrapper, so the app's own main process is killed by its PID.
 */
export async function crash(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close', { timeout: 20_000 }).catch(() => undefined)
  killHard(app)
  await closed
}

function killHard(app: ElectronApplication): void {
  const pid = mainPids.get(app)
  for (const target of [pid, app.process().pid]) {
    if (typeof target !== 'number') continue
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

const running = new Set<ElectronApplication>()

/** Force-close anything a failed test left running, so it cannot disturb the next test. */
export async function closeLeftovers(): Promise<void> {
  for (const app of [...running]) {
    running.delete(app)
    killHard(app)
  }
}

export interface LaunchOptions {
  dataDir?: string
  env?: Record<string, string>
  args?: string[]
  /** Window size to apply after launch (the app otherwise docks to half the screen). */
  size?: { width: number; height: number }
}

/** Start the built app against a throwaway data directory. */
export async function launch(options: LaunchOptions = {}): Promise<Launched> {
  const dataDir = options.dataDir ?? freshDataDir()
  const app = await electron.launch({
    // TRADING_NOTES_E2E_ENTRY lets a run target a different build of the main process.
    args: [process.env.TRADING_NOTES_E2E_ENTRY ?? ROOT, '--no-sandbox', ...(options.args ?? [])],
    cwd: ROOT,
    env: {
      ...(process.env as Record<string, string>),
      TRADING_NOTES_TEST: '1',
      TRADING_NOTES_DATA_DIR: dataDir,
      ...options.env
    }
  })
  running.add(app)
  app.on('close', () => running.delete(app))
  mainPids.set(app, await app.evaluate(() => process.pid))
  const page = await app.firstWindow()
  await page.waitForSelector('.app[data-ready="true"]')
  if (options.size) await setWindowSize(app, page, options.size.width, options.size.height)
  const quit = async (): Promise<void> => {
    const closed = app.waitForEvent('close').catch(() => undefined)
    await app.evaluate(() => (globalThis as unknown as { __tnTest: { quit: () => Promise<void> } }).__tnTest.quit()).catch(() => undefined)
    await closed
  }
  return { app, page, dataDir, quit }
}

export async function setWindowSize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setBounds({ x: 0, y: 0, width: size.width, height: size.height })
  }, { width, height })
  await page.waitForFunction((w) => Math.abs(window.innerWidth - w) <= 2, width)
}
