import { test, expect } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import {
  billedTexts,
  configureMockProvider,
  openBackgroundPopup,
  setMockReplies,
  startTranslation,
  stopTranslation,
} from './helpers'

const TRANSLATED = '.imp-translate-result:not(.imp-translate-loading)'
// The three blocks of the home page fixture.
const HOME_BLOCK_COUNT = 3

async function setup(page: Page, baseURL: string): Promise<string[]> {
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')
  await configureMockProvider(page, baseURL)
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  const billed = await billedTexts(page, baseURL)
  expect(billed).toContain('Home Page')
  expect(billed.length).toBe(HOME_BLOCK_COUNT)
  return billed
}

async function retranslateFromPopup(context: BrowserContext, extensionId: string) {
  const popup = await openBackgroundPopup(context, extensionId)
  await popup.getByRole('button', { name: 'Re-translate' }).click()
}

// A forced pass asks for exactly the blocks it walked, so once every text has
// been billed twice the pass is complete. Waiting on the rendered text instead
// would race: the first block's response can land while the rest are in
// flight, and the log assertions below would then read a half-finished bill.
async function waitForForcedPass(page: Page, baseURL: string, before: string[]) {
  await expect
    .poll(async () => (await billedTexts(page, baseURL)).length, { timeout: 15000 })
    .toBe(before.length * 2)
}

// The feature: a page already translated can be asked for again. The cache
// read is skipped, so the provider is hit for every block of the page.
test('re-translate asks the provider again and shows the fresh answer', async ({
  context,
  baseURL,
  extensionId,
}) => {
  const page = await context.newPage()
  const before = await setup(page, baseURL)

  // From here the provider answers differently, so "read the cache" and "asked
  // again" are distinguishable by what lands on the page.
  await setMockReplies(page, baseURL, { 'Home Page': '[刷新] Home Page' })
  await retranslateFromPopup(context, extensionId)

  await expect(page.locator('h1')).toContainText('[刷新] Home Page', { timeout: 15000 })
  await waitForForcedPass(page, baseURL, before)
})

// A forced pass is a refresh, not a one-off: it overwrites the cached entry,
// so the next normal pass reads the fresh answer instead of paying again.
// Not re-billing is proven by the log; the value the page shows proves the
// write happened.
test('a normal pass after a forced one is a cache hit', async ({
  context,
  baseURL,
  extensionId,
}) => {
  const page = await context.newPage()
  const before = await setup(page, baseURL)

  await setMockReplies(page, baseURL, { 'Home Page': '[刷新] Home Page' })
  await retranslateFromPopup(context, extensionId)
  await expect(page.locator('h1')).toContainText('[刷新] Home Page', { timeout: 15000 })
  await waitForForcedPass(page, baseURL, before)
  const afterForce = await billedTexts(page, baseURL)

  await stopTranslation(page)
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  expect(await billedTexts(page, baseURL)).toEqual(afterForce)
  // Still the forced answer: had the forced pass not written through, this
  // read would have produced the pre-force [翻译] value.
  await expect(page.locator('h1')).toContainText('[刷新] Home Page')
})

// Force is scoped to the blocks of the walk it started, not to the run. A
// block that appears afterwards — SPA navigation, mutation — is a cache hit
// even though the page was force-translated a moment earlier, or every route
// the user moved to afterwards would be re-billed.
test('force does not reach content that appears after it', async ({
  context,
  baseURL,
  extensionId,
}) => {
  const page = await context.newPage()
  const before = await setup(page, baseURL)

  await retranslateFromPopup(context, extensionId)
  await waitForForcedPass(page, baseURL, before)
  const afterForce = await billedTexts(page, baseURL)
  // Change the answer only now: from here a fresh call would render [刷新],
  // while a cached read renders the [翻译] written by the passes above.
  await setMockReplies(page, baseURL, { 'Home Page': '[刷新] Home Page' })

  // "Home Page" is already cached, so this block is a hit unless the force
  // leaked past its own walk.
  await page.evaluate(() => {
    history.pushState(null, '', '/new-page')
    const p = document.createElement('p')
    p.id = 'spa-block'
    p.textContent = 'Home Page'
    document.body.appendChild(p)
  })

  await expect(page.locator('#spa-block')).toContainText('[翻译] Home Page', {
    timeout: 15000,
  })
  expect(await billedTexts(page, baseURL)).toEqual(afterForce)
})
