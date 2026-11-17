import { defineConfig } from '@playwright/test'

// Desktop tests drive the real Electron app (built into out/). Run `npm run build` first,
// or use `npm run test:e2e`, which does both.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results'
})
