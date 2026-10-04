import { test, expect } from './fixtures'
import { setSettings, stubBrowserShortcut } from './helpers'
import type { Page } from '@playwright/test'

const providerSection = (page: Page) =>
  page.locator('[role="radiogroup"][aria-label="Settings section"] [data-value="provider"]')

const openProviderSection = async (page: Page) => {
  await providerSection(page).click()
  await expect(providerSection(page)).toHaveAttribute('aria-checked', 'true')
}

test('options page renders with default settings', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await openProviderSection(page)

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

  // The OpenAI form sits behind the Provider section, so the API key field is
  // absent until that provider is selected.
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await openProviderSection(page)

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
  await openProviderSection(page)
  await page.locator('button[role="radio"][value="microsoft"]').click()

  await page.waitForTimeout(200)
  await page.reload()

  await expect(page.locator('#imp-lang')).toContainText('日本語')
  await openProviderSection(page)
  await expect(page.locator('button[role="radio"][value="microsoft"]')).toHaveAttribute('data-state', 'checked')
})

test('options page shows the default toggle shortcut', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  // The manifest default is Alt+T; before the configurable-hotkey change this
  // control did not exist at all and the binding was a hard-coded Alt+A.
  await expect(page.locator('#hotkey')).toContainText('Alt + T')
  await expect(page.locator('#hotkey')).not.toContainText('Not set')
})

// Chrome's commands API has no update(), so the extension can neither bind a
// shortcut nor let the user record one. The page must say so, render the real
// browser binding read-only, and point at the one place the user can finish
// the job — rather than implying the stored preference is already live.
test('options page explains that Chrome cannot assign the shortcut', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(
    page.getByText('Chrome does not let extensions assign shortcuts.', {
      exact: false,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Open browser shortcut settings' }),
  ).toBeVisible()
  // Offering a recorder here would let the user "save" a shortcut that can
  // never fire, which is the exact false success this guards against. Both
  // commands are read-only, so neither may offer a recorder or a Clear.
  await expect(page.locator('#hotkey')).toBeDisabled()
  await expect(page.locator('#retranslate-hotkey')).toBeDisabled()
  await expect(
    page.locator('[data-hotkey-command="toggle-translate"]').getByRole(
      'button',
      { name: 'Clear' },
    ),
  ).toBeHidden()
  // Recording instructions are meaningless on fields that cannot be edited.
  await expect(
    page.getByText('Click a field, then press a combination.', {
      exact: false,
    }),
  ).toBeHidden()
})

// The read-only field must show what the browser will actually fire. Seeding a
// preference Chrome never bound is the only way to tell the two apart: were the
// field echoing storage, it would read "Alt + K" instead.
test('options page shows the browser binding, not the stored preference', async ({
  context,
  extensionId,
}) => {
  await setSettings(context, { toggleHotkey: 'Alt+K' })

  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.locator('#hotkey')).toContainText('Alt + T')
  await expect(page.locator('#hotkey')).not.toContainText('Alt + K')
})

// The same lie when the user clears the binding at
// chrome://extensions/shortcuts: getSettings() merges DEFAULT_SETTINGS, so a
// fallback would still show "Alt + T" with nothing bound behind it.
test('options page does not claim a shortcut the browser has dropped', async ({
  context,
  extensionId,
}) => {
  await stubBrowserShortcut(context, '')

  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.locator('#hotkey')).toContainText('Not set')
  await expect(page.locator('#hotkey')).not.toContainText('Alt + T')
})

// The binding lives in browser prefs, which storage.onChanged cannot observe,
// so returning to the tab must re-read it instead of showing what was bound
// when the page first loaded.
test('options page picks up a shortcut changed in the browser', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await expect(page.locator('#hotkey')).toContainText('Alt + T')

  // No reload, no storage write. The focus event is dispatched rather than
  // driven by page.bringToFront(): headless Chromium reports hasFocus() true
  // for every page at once, so tab switching fires no focus transition there
  // (a plain page behaves the same — it is the harness, not this code).
  await stubBrowserShortcut(context, '⌥J')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  await expect(page.locator('#hotkey')).toContainText('Alt + J')
  await expect(page.locator('#hotkey')).not.toContainText('Alt + T')
})

// A disabled button must not open the recorder. Regression guard for the
// read-only contract: if this ever starts recording again, Chrome users are
// back to saving shortcuts that do nothing.
test('options page does not start recording on a read-only shortcut', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  // The control stays disabled from first paint — the capability query has to
  // resolve before it is offered, or a click can land in the gap and start a
  // recording that can never be applied.
  const hotkey = page.locator('#hotkey')
  await expect(hotkey).toBeDisabled()

  // Force the click past the disabled check so the handler is proven inert
  // rather than merely unreachable.
  await hotkey.dispatchEvent('click')
  await page.keyboard.press('k')

  // Still showing the browser's binding, not a capture prompt.
  await expect(hotkey).toContainText('Alt + T')
  await expect(hotkey).not.toContainText('Press keys')
  await expect(
    page.getByText('Use Alt or Ctrl plus one key.', { exact: false }),
  ).toBeHidden()
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
