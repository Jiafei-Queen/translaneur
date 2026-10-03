import { test, expect } from './fixtures'
import { startTranslation, configureMockProvider } from './helpers'

const TRANSLATED_SELECTOR = '.imp-translate-result:not(.imp-translate-loading)'

test('translates content inside a large iframe', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/with-iframes`)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)

  const frame = page.frameLocator('#large-iframe')
  await expect(frame.locator(TRANSLATED_SELECTOR).first()).toBeVisible({
    timeout: 15000,
  })
})

test('translates content inside a dynamically added iframe', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/with-iframes`)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)

  const largeFrame = page.frameLocator('#large-iframe')
  await expect(largeFrame.locator(TRANSLATED_SELECTOR).first()).toBeVisible({
    timeout: 15000,
  })

  await page.locator('#add-iframe').click()

  const dynamicFrame = page.frameLocator('#dynamic-iframe')
  await expect(dynamicFrame.locator(TRANSLATED_SELECTOR).first()).toBeVisible({
    timeout: 15000,
  })
})

test('reload stops translation in iframes too (no stale re-translate)', async ({
  context,
  baseURL,
}) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/with-iframes`)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)

  const largeFrame = page.frameLocator('#large-iframe')
  await expect(largeFrame.locator(TRANSLATED_SELECTOR).first()).toBeVisible({
    timeout: 15000,
  })

  // Reload: this stops translation (the reload-stop behavior). The iframe's
  // sub-frame onDOMContentLoaded handler must NOT read a stale session key
  // and re-translate. Regression guard for the cross-frame reload race.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  // The invariant is "no stale translation ever appears", not "none within N
  // ms". Poll across the whole observation window and fail on the first
  // sighting, instead of sleeping and then asserting once: a fixed 2s sleep
  // followed by toHaveCount's own 5s timeout meant a re-translate landing
  // after the sleep but inside the timeout failed the test, while the same
  // run passed standalone — the result depended on suite load. Sampling
  // throughout keeps the assertion honest either way.
  // The window covers the cross-frame race under test: inject.ts's pageshow
  // handler waits 100ms and re-checks the session key before stopping.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    expect(
      await page.locator(TRANSLATED_SELECTOR).count(),
      'main frame must not re-translate after reload',
    ).toBe(0)
    expect(
      await largeFrame.locator(TRANSLATED_SELECTOR).count(),
      'iframe must not re-translate after reload',
    ).toBe(0)
    await page.waitForTimeout(100)
  }
})

test('skips translation inside a tiny iframe', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/with-iframes`)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)

  // Wait for the large iframe to confirm translation is running
  const largeFrame = page.frameLocator('#large-iframe')
  await expect(largeFrame.locator(TRANSLATED_SELECTOR).first()).toBeVisible({
    timeout: 15000,
  })

  const tinyFrame = page.frameLocator('#tiny-iframe')
  await expect(tinyFrame.locator('.imp-translate-result')).toHaveCount(0)
})
