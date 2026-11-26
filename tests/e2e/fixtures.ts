import { test as base } from '@playwright/test'
import { closeLeftovers } from './launch'

/** Same as Playwright's `test`, plus a guarantee that no app instance outlives its test. */
export const test = base.extend<{ cleanup: void }>({
  cleanup: [
    async ({}, use) => {
      await use()
      await closeLeftovers()
    },
    { auto: true }
  ]
})

export { expect } from '@playwright/test'
