import { test, expect } from './fixtures'
import { startTranslation, stopTranslation, configureMockProvider } from './helpers'

// spring.io's `.button.is-spring` hides its hover fill in a ::before parked at
// translateX(-101%), clipped by the button's own overflow: hidden. Lifting that
// clip made the fill render as a stray block, and the inline `visible` was
// never restored. See docs/clipped-translations.md.
test('keeps a non-constraining button clip and restores it on stop', async ({
  context,
  baseURL,
}) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/overflow-clip-button`)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)

  const footer = page.locator('#footer-sub')
  // The loading ring also carries .imp-translate-result — wait for the
  // settled translation so the assertions read the final injected node.
  await expect(
    footer.locator('.imp-translate-result:not(.imp-translate-loading)'),
  ).toBeVisible({ timeout: 15000 })

  // The clip is the page's, untouched: no inline override, computed value intact.
  expect(await footer.evaluate((el) => el.style.overflow)).toBe('')
  expect(await footer.evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden')
  expect(await footer.evaluate((el) => el.hasAttribute('data-imp-style-orig'))).toBe(false)

  // The ::before stays parked outside, and the translation is fully visible
  // inside the button — growing it is what the clip would have prevented.
  const geometry = await footer.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const font = el
      .querySelector('.imp-translate-result:not(.imp-translate-loading)')!
      .getBoundingClientRect()
    const before = getComputedStyle(el, '::before')
    return {
      // The fill is still parked off the left edge — the page's own CSS never
      // changes, so the clip is the only thing that can expose it.
      parkedX: new DOMMatrix(before.transform).m41,
      buttonWidth: box.width,
      insideButton:
        font.left >= box.left - 0.5 && font.right <= box.right + 0.5 && font.width > 0,
    }
  })
  expect(geometry.insideButton).toBe(true)
  // Parked entirely to the left of the button, where only the clip hides it.
  expect(geometry.parkedX).toBeLessThan(-geometry.buttonWidth / 2)

  // The hero buttons sit in a block with two anchors, so the walker visits
  // each separately and both are the same non-constraining shape as the
  // footer button. Neither is written to.
  for (const id of ['#hero-1', '#hero-2']) {
    expect(await page.locator(id).evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden')
    expect(await page.locator(id).evaluate((el) => el.style.overflow)).toBe('')
  }

  await page.screenshot({ path: 'test-results/overflow-clip-translated.png', fullPage: true })

  await stopTranslation(page)
  await expect(footer.locator('.imp-translate-result')).toHaveCount(0)
  expect(await footer.evaluate((el) => el.style.overflow)).toBe('')
  expect(await footer.evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden')
  expect(await footer.evaluate((el) => el.hasAttribute('data-imp-style-orig'))).toBe(false)

  await page.screenshot({ path: 'test-results/overflow-clip-restored.png', fullPage: true })
})
