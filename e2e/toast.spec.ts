import { test, expect } from './fixtures'
import {
  billedTexts,
  startTranslation,
  stopTranslation,
  configureMockProvider,
  enableMobileMode,
} from './helpers'

const TOAST = '#imp-translate-toast'
const LANG_SELECT = `${TOAST} .imp-toast-lang`
const TRANSLATED = '.imp-translate-result:not(.imp-translate-loading)'

test('toast shows language selector on mobile', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page, 'ja', true)

  await expect(page.locator(TOAST)).toBeVisible({ timeout: 5000 })
  await expect(page.locator(LANG_SELECT)).toHaveValue('ja')
})

test('toast stays visible during language change', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page, 'ja', true)

  const toast = page.locator(TOAST)
  await expect(toast).toBeVisible({ timeout: 5000 })

  // Change language via select
  await page.locator(LANG_SELECT).selectOption('zh')

  // Toast must remain visible immediately after change
  await expect(toast).toBeVisible()

  // Still visible 2 seconds later (no premature dismiss)
  await page.waitForTimeout(2000)
  await expect(toast).toBeVisible()

  // Translation restarted with new language
  const result = page.locator(TRANSLATED).first()
  await expect(result).toBeVisible({ timeout: 15000 })
})

test('toast timer pauses when select is reopened after language change', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page, 'ja', true)

  const toast = page.locator(TOAST)
  const langSelect = page.locator(LANG_SELECT)
  await expect(toast).toBeVisible({ timeout: 5000 })

  // Change language
  await langSelect.selectOption('zh')
  await expect(toast).toBeVisible()

  // Wait 3s, then click select again without changing
  await page.waitForTimeout(3000)
  await langSelect.click()

  // Toast should still be visible 3s later (timer was paused by click)
  await page.waitForTimeout(3000)
  await expect(toast).toBeVisible()
})

test('toast auto-dismisses 5s after language change', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page, 'ja', true)

  const toast = page.locator(TOAST)
  await expect(toast).toBeVisible({ timeout: 5000 })

  await page.locator(LANG_SELECT).selectOption('zh')

  // Should dismiss within ~6s after the change (5s timer + animation)
  await expect(toast).not.toBeVisible({ timeout: 8000 })
})

test('toast restore button stops translation', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page, 'zh', true)

  const toast = page.locator(TOAST)
  await expect(toast).toBeVisible({ timeout: 5000 })

  // Wait for some translations to appear
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  // Click restore
  await page.locator(`${TOAST} .imp-toast-restore`).click()

  // Toast should disappear
  await expect(toast).not.toBeVisible({ timeout: 3000 })

  // Translations should be removed
  await expect(page.locator('.imp-translate-result')).toHaveCount(0)
})

// Mobile has no action popup, so the toolbar icon is the only way back to the
// panel while translating — tapping it now stops translation (restoring the
// original page) instead of just re-summoning the bar over a live
// translation (see openPanelForActiveTab in entrypoints/background.ts). The
// content script re-opens the panel itself, in its restored state, as part of
// handling the stopTranslation message that stopTranslationForTab sends.
test('toolbar tap while translating restores the page and offers "Translate"', async ({
  context,
  baseURL,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page, 'zh', true)

  const toast = page.locator(TOAST)
  await expect(toast).toBeVisible({ timeout: 5000 })
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  // Simulates a toolbar tap while translating: stops translation and lets
  // the content script re-open the panel itself.
  await stopTranslation(page)

  await expect(page.locator('.imp-translate-result')).toHaveCount(0)
  await expect(toast).toBeVisible({ timeout: 3000 })
  await expect(page.locator(`${TOAST} .imp-toast-restore`)).toHaveText('Translate')
  await expect(page.locator(LANG_SELECT)).toBeVisible()
  await expect(page.locator(`${TOAST} .imp-toast-settings`)).toBeVisible()
})

// The mobile counterpart of the popup's "Re-translate". Driven from the
// restored bar rather than straight from startTranslation: that way the test
// does not depend on the helper's start winning its race with the content
// script's auto-init, which starts without the toast.
test('toast offers re-translate while translating, and it forces a fresh pass', async ({
  context,
  baseURL,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  // Toolbar tap while translating → restored bar. "Translate" from there
  // rebuilds the bar in translating mode, which is where ↻ lives.
  await stopTranslation(page)
  const toast = page.locator(TOAST)
  await expect(toast).toBeVisible({ timeout: 3000 })
  await page.locator(`${TOAST} .imp-toast-restore`).click()
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  const retranslate = page.locator(`${TOAST} .imp-toast-retranslate`)
  await expect(retranslate).toBeVisible()

  // That second pass was a cache hit, so the bill is the first pass alone.
  const before = await billedTexts(page, baseURL)
  await retranslate.click()

  // The forced pass asks again for every block of the page…
  await expect
    .poll(async () => (await billedTexts(page, baseURL)).length, { timeout: 15000 })
    .toBe(before.length * 2)
  // …and the page really re-rendered from it.
  await expect(page.locator('h1')).toContainText('[翻译] Home Page')

  // Restored: nothing is on screen to refresh, so the control is gone.
  await stopTranslation(page)
  await expect(page.locator(`${TOAST} .imp-toast-retranslate`)).toHaveCount(0)
})

test('clicking "Translate" re-translates and flips the button back', async ({
  context,
  baseURL,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page, 'zh', true)

  const toast = page.locator(TOAST)
  await expect(toast).toBeVisible({ timeout: 5000 })
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  await stopTranslation(page)
  await expect(toast).toBeVisible({ timeout: 3000 })
  await expect(page.locator(`${TOAST} .imp-toast-restore`)).toHaveText('Translate')

  await page.locator(`${TOAST} .imp-toast-restore`).click()

  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator(`${TOAST} .imp-toast-restore`)).toHaveText('Show Original')
})

test('toast display select switches render mode on mobile', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await enableMobileMode(context)
  await startTranslation(page, 'ja', true)

  await expect(page.locator(TOAST)).toBeVisible({ timeout: 5000 })
  const displayGroup = page.locator(`${TOAST} .imp-toast-display`)
  await expect(displayGroup.locator('[data-value="bilingual"]')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  await displayGroup.locator('[data-value="translation-only"]').click()

  // Switching modes restarts translation, so the ring is injected in
  // translation-only too. What matters is that it drains: the settled state
  // carries no wrapper, only the translated text written in place.
  await expect(page.locator('p').first()).toContainText('[翻译]', { timeout: 15000 })
  await expect(page.locator('.imp-translate-loading')).toHaveCount(0, { timeout: 15000 })
  await expect(page.locator('.imp-translate-result')).toHaveCount(0, { timeout: 15000 })
})

// The toast draws its own CSS rather than using the ghost Button, and carries
// a separate `@media (prefers-color-scheme: dark)` block. Both are easy to
// get backwards, so assert hover direction in each scheme: the active half
// must not respond, the inactive one must.
for (const scheme of ['light', 'dark'] as const) {
  test(`toast display hover only the unselected half in ${scheme} mode`, async ({
    context,
    baseURL,
  }) => {
    const page = await context.newPage()
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(baseURL)
    await page.waitForLoadState('domcontentloaded')

    await configureMockProvider(page, baseURL)
    await enableMobileMode(context)
    await startTranslation(page, 'ja', true)

    await expect(page.locator(TOAST)).toBeVisible({ timeout: 5000 })
    const group = page.locator(`${TOAST} .imp-toast-display`)
    const selected = group.locator('[data-value="bilingual"]')
    const unselected = group.locator('[data-value="translation-only"]')
    await expect(selected).toHaveAttribute('aria-checked', 'true')

    const snap = (loc: typeof selected) =>
      loc.evaluate((el) => {
        const s = getComputedStyle(el)
        return `${s.backgroundColor} | ${s.color}`
      })

    const selectedIdle = await snap(selected)
    const unselectedIdle = await snap(unselected)

    await selected.hover()
    await page.waitForTimeout(200)
    expect(
      await snap(selected),
      'selected half must not react to hover',
    ).toBe(selectedIdle)

    await unselected.hover()
    await page.waitForTimeout(200)
    expect(
      await snap(unselected),
      'unselected half must react to hover',
    ).not.toBe(unselectedIdle)

    // The hover fill must land strictly between the track and the selected
    // half, so it reads as "closer to selected" rather than as an unrelated
    // highlight. Both palettes stack white overlays, so that means a
    // higher alpha than the track and a lower one than the selected fill.
    const alpha = (c: string) => {
      const m = /rgba?\([^)]*?([\d.]+)\s*\)$/.exec(c)
      return m ? Number(m[1]) : c === 'rgb(255, 255, 255)' ? 1 : 0
    }
    const trackAlpha = alpha(await group.evaluate((el) => getComputedStyle(el).backgroundColor))
    const selectedFill = alpha(await snap(selected).then((s) => s.split(' | ')[0]))
    const hoverAlpha = alpha((await snap(unselected)).split(' | ')[0])
    expect(hoverAlpha).toBeGreaterThan(trackAlpha)
    expect(hoverAlpha).toBeLessThan(selectedFill)
  })
}
