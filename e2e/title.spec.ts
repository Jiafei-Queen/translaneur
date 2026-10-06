import { test, expect } from './fixtures'
import {
  startTranslation,
  stopTranslation,
  configureMockProvider,
  setSettings,
} from './helpers'

const TRANSLATED_SELECTOR = '.imp-translate-result:not(.imp-translate-loading)'

// The mock provider answers `[翻译] <source>`. The initial title itself
// contains the separator our composed titles use ("Test — Home") — it must be
// translated as one string, not split into a fragment.
test('translates the tab title when the setting is on', async ({
  context,
  page,
  baseURL,
}) => {
  await page.goto(`${baseURL}/title`)
  await page.waitForLoadState('domcontentloaded')
  await configureMockProvider(page, baseURL)
  await setSettings(context, { translateTitle: true })
  await startTranslation(page)

  await expect(page.locator(TRANSLATED_SELECTOR).first()).toBeVisible({
    timeout: 15000,
  })
  await expect
    .poll(() => page.title(), { timeout: 15000 })
    .toBe('[翻译] Test — Home — Test — Home')

  await stopTranslation(page)
  await expect.poll(() => page.title()).toBe('Test — Home')
})

test('does not touch the title when the setting is off', async ({
  context,
  page,
  baseURL,
}) => {
  await page.goto(`${baseURL}/title`)
  await page.waitForLoadState('domcontentloaded')
  await configureMockProvider(page, baseURL)
  await setSettings(context, { translateTitle: false })
  await startTranslation(page)

  await expect(page.locator(TRANSLATED_SELECTOR).first()).toBeVisible({
    timeout: 15000,
  })
  await page.waitForTimeout(1000)
  expect(await page.title()).toBe('Test — Home')

  await stopTranslation(page)
  expect(await page.title()).toBe('Test — Home')
})

test('follows a title the page rewrites mid-translation and restores the latest', async ({
  context,
  page,
  baseURL,
}) => {
  await page.goto(`${baseURL}/title`)
  await page.waitForLoadState('domcontentloaded')
  await configureMockProvider(page, baseURL)
  await setSettings(context, { translateTitle: true })
  await startTranslation(page)

  await expect
    .poll(() => page.title(), { timeout: 15000 })
    .toBe('[翻译] Test — Home — Test — Home')

  // The SPA-style rewrite: the observer must pick it up and re-translate.
  await page.locator('#rename-title').click()
  await expect
    .poll(() => page.title(), { timeout: 15000 })
    .toBe('[翻译] Renamed Title — Renamed Title')

  // Restoring must hand back the page's latest title, not the one captured
  // when translation started.
  await stopTranslation(page)
  await expect.poll(() => page.title()).toBe('Renamed Title')
})
