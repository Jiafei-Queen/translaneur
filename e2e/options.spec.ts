import { test, expect } from './fixtures'

test('options page renders with default settings', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.locator('text=Translaneur')).toBeVisible()
  await expect(page.locator('text=Microsoft Translator')).toBeVisible()
  await expect(page.locator('text=Google Translate')).toBeVisible()
  await expect(page.locator('text=OpenAI Compatible')).toBeVisible()

  const googleRadio = page.locator('button[role="radio"][value="google"]')
  await expect(googleRadio).toHaveAttribute('data-state', 'checked')
})

test('options page shows OpenAI settings when selected', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.locator('input[type="password"]')).not.toBeVisible()

  await page.locator('button[role="radio"][value="openai"]').click()

  await expect(page.getByText('Base URL', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Requests will be sent to: https://api.openai.com/v1/chat/completions'),
  ).toBeVisible()
  await expect(page.getByText('API Key', { exact: true })).toBeVisible()
  await expect(page.getByText('Model', { exact: true })).toBeVisible()
  await expect(page.getByText('System Prompt', { exact: true })).toBeVisible()
})

test('options page saves and persists settings', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  // Open language select and pick Japanese (日本語)
  await page.locator('#imp-lang').click()
  await page.getByRole('option', { name: '日本語' }).click()

  // Pick the non-default provider so the reload actually proves persistence
  await page.locator('button[role="radio"][value="microsoft"]').click()

  await page.waitForTimeout(200)
  await page.reload()

  await expect(page.locator('#imp-lang')).toContainText('日本語')
  await expect(page.locator('button[role="radio"][value="microsoft"]')).toHaveAttribute('data-state', 'checked')
})

test('options page persists display mode', async ({ context, extensionId }) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.locator('#imp-display [data-value="bilingual"]')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.locator('#imp-display [data-value="translation-only"]').click()

  await page.waitForTimeout(200)
  await page.reload()

  await expect(page.locator('#imp-display [data-value="translation-only"]')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.locator('#imp-display [data-value="bilingual"]')).toHaveAttribute(
    'aria-checked',
    'false',
  )
})

// Hover must read as "this one is selectable", not "this one is selected".
// The ghost button variant ships hover:bg-accent, hover:text-accent-foreground
// and dark:hover:bg-accent/50, all of which can win the cascade over a plain
// utility of equal specificity — dark:hover:bg-accent/50 resolves to --accent
// (oklch(0.269 0 0)), the same grey as the --muted track, which turned the
// *selected* half grey on hover. Both halves therefore pin background and
// text with Tailwind's `!` important suffix; this locks that in for both
// colour schemes.
for (const scheme of ['light', 'dark'] as const) {
  test(`display options hover only the unselected half in ${scheme} mode`, async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage()
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(`chrome-extension://${extensionId}/options.html`)

    const group = page.locator('#imp-display')
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

    // Pointer input so the `@media (hover: hover)` guard is satisfied.
    await selected.hover()
    await page.waitForTimeout(200)
    const selectedHover = await snap(selected)
    expect(selectedHover, 'selected half must not react to hover').toBe(selectedIdle)

    await unselected.hover()
    await page.waitForTimeout(200)
    const unselectedHover = await snap(unselected)
    expect(unselectedHover, 'unselected half must react to hover').not.toBe(unselectedIdle)

    // In dark mode the hover fill is an opaque colour, and it must fall
    // strictly between the track (0.269) and the selected half (0.145):
    // --foreground is 0.985 there, so tinting with it would brighten off the
    // selected black, which is what --seg-hover (0.207) avoids. Light mode
    // paints a translucent foreground over the track instead, so it has no
    // single lightness to compare and is only checked for changing at all.
    if (scheme === 'dark') {
      const lightness = (c: string) => {
        const m = /^oklch\(\s*([\d.]+)/.exec(c)
        return m ? Number(m[1]) : NaN
      }
      const trackL = lightness(
        await group.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      const selectedL = lightness(selectedIdle.split(' | ')[0])
      const hoverL = lightness(unselectedHover.split(' | ')[0])
      expect(Number.isNaN(hoverL), 'hover fill must be an opaque oklch()').toBe(false)
      expect(
        hoverL,
        'hover fill must sit between the track and the selected half',
      ).toBeGreaterThan(Math.min(selectedL, trackL))
      expect(hoverL).toBeLessThan(Math.max(selectedL, trackL))
    }
  })
}
