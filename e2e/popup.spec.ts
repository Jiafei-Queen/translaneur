import { test, expect } from './fixtures'
import {
  configureMockProvider,
  openBackgroundPopup,
  startTranslation,
  stopTranslation,
} from './helpers'

const TRANSLATED = '.imp-translate-result:not(.imp-translate-loading)'

test('popup renders with translate button and language selector', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)

  await expect(page.locator('text=Translaneur')).toBeVisible()
  await expect(page.locator('text=Translate Page')).toBeVisible()

  const select = page.locator('#imp-lang')
  await expect(select).toBeVisible()
  const value = await select.inputValue()
  expect(value).toBeTruthy()
})

test('popup language selector changes target language', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)

  const select = page.locator('#imp-lang')
  await select.selectOption('ja')
  await expect(select).toHaveValue('ja')

  // Reopen popup — language should persist
  await page.reload()
  await expect(page.locator('#imp-lang')).toHaveValue('ja')
})

test('popup settings button opens options page', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)

  const [optionsPage] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('button').filter({ has: page.locator('svg') }).last().click(),
  ])

  await expect(optionsPage).toHaveURL(new RegExp(`chrome-extension://${extensionId}/options.html`))
})

// Covers what the three tests above can't: the popup's translate/restore path
// against a tab that is really translating. The button label is the assertion —
// it comes from the getTabState query, refetched after each mutation.
test('popup translates and restores the active tab', async ({
  context,
  baseURL,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  const popup = await openBackgroundPopup(context, extensionId)
  const restore = popup.getByRole('button', { name: 'Show Original' })
  await expect(restore).toBeVisible({ timeout: 5000 })

  await restore.click()

  // The popup asked the background to stop, and the page really reverted
  await expect(page.locator('.imp-translate-result')).toHaveCount(0, { timeout: 5000 })
  await expect(popup.getByRole('button', { name: 'Translate Page' })).toBeVisible({
    timeout: 5000,
  })

  // ...and back again
  await popup.getByRole('button', { name: 'Translate Page' }).click()
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })
  await expect(restore).toBeVisible({ timeout: 5000 })
})

// State changing behind the popup's back (Alt+A, the content script's
// stopSelfTab): the popup stays open throughout, so only the storage.onChanged
// listener in popup/main.tsx — not a fresh mount — can bring the label back.
test('popup updates its button label when translation state changes behind its back', async ({
  context,
  baseURL,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  const popup = await openBackgroundPopup(context, extensionId)
  await expect(popup.getByRole('button', { name: 'Translate Page' })).toBeVisible()

  await startTranslation(page)
  await expect(popup.getByRole('button', { name: 'Show Original' })).toBeVisible({
    timeout: 5000,
  })

  await stopTranslation(page)

  await expect(popup.getByRole('button', { name: 'Translate Page' })).toBeVisible({
    timeout: 5000,
  })
})

// Display-mode switch from the popup against a translating tab: the page
// re-renders in place (no result font at all) and the links' text is split per
// run — the mock's "[翻译] " prefix lands in the first run only.
test('popup display mode re-translates the page', async ({
  context,
  baseURL,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  const popup = await openBackgroundPopup(context, extensionId)
  await popup.locator('#imp-display [data-value="translation-only"]').click()

  await expect(page.locator('p').first()).toContainText(
    '[翻译] This is the home page for testing translation.',
    { timeout: 15000 },
  )
  await expect(page.locator('#link-page2')).toHaveText('[翻译] Go to Page 2', { timeout: 15000 })
  await expect(page.locator('#link-pdf')).toHaveText('Open PDF')
  await expect(page.locator('.imp-translate-result')).toHaveCount(0)
})

// See the twin test in options.spec.ts: ghost's dark:hover:bg-accent/50
// resolved to --accent (the --muted track's own grey) and won the cascade,
// turning the selected half grey on hover. The `!` pins hold it in both
// colour schemes.
for (const scheme of ['light', 'dark'] as const) {
  test(`popup display hover only the unselected half in ${scheme} mode`, async ({
    context,
    extensionId,
  }) => {
    const popup = await openBackgroundPopup(context, extensionId)
    await popup.emulateMedia({ colorScheme: scheme })
    await popup.reload()

    const group = popup.locator('#imp-display')
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
    await popup.waitForTimeout(200)
    expect(
      await snap(selected),
      'selected half must not react to hover',
    ).toBe(selectedIdle)

    await unselected.hover()
    await popup.waitForTimeout(200)
    expect(
      await snap(unselected),
      'unselected half must react to hover',
    ).not.toBe(unselectedIdle)

    // See the twin test in options.spec.ts: in dark mode the hover fill is
    // opaque and must sit strictly between the track and the selected half,
    // so it darkens toward the selected black instead of brightening off it.
    // Light mode paints a translucent foreground over the track, so it has
    // no single lightness to compare.
    if (scheme === 'dark') {
      const lightness = (c: string) => {
        const m = /^oklch\(\s*([\d.]+)/.exec(c)
        return m ? Number(m[1]) : NaN
      }
      const trackL = lightness(
        await group.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      const selectedL = lightness(selectedIdle.split(' | ')[0])
      const hoverL = lightness((await snap(unselected)).split(' | ')[0])
      expect(Number.isNaN(hoverL), 'hover fill must be an opaque oklch()').toBe(false)
      expect(
        hoverL,
        'hover fill must sit between the track and the selected half',
      ).toBeGreaterThan(Math.min(selectedL, trackL))
      expect(hoverL).toBeLessThan(Math.max(selectedL, trackL))
    }
  })
}
