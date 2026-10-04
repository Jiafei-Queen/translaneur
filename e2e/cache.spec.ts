import { test, expect } from './fixtures'
import {
  billedTexts,
  configureMockProvider,
  getMockLog,
  openBackgroundPopup,
  startTranslation,
  stopTranslation,
  setSettings,
} from './helpers'

const TRANSLATED = '.imp-translate-result:not(.imp-translate-loading)'

// The bug this file exists for: switching Display re-translated the whole page,
// so an OpenAI user paid twice for the same content. Both modes now send the
// same marked payload, so the second pass is a cache hit.
test('switching display mode re-translates nothing', async ({
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

  const afterFirstPass = await billedTexts(page, baseURL)
  expect(afterFirstPass.length).toBeGreaterThan(0)

  // bilingual → translation-only. Wait for the mode to have actually applied
  // (the bilingual wrapper is gone, the text is written into the runs): the
  // `[翻译]` text is on screen both before and after, so asserting on it would
  // pass without the switch having done anything.
  const popup = await openBackgroundPopup(context, extensionId)
  await popup.locator('#imp-display [data-value="translation-only"]').click()
  await expect(page.locator('.imp-translate-result')).toHaveCount(0, { timeout: 15000 })
  await expect(page.locator('p').first()).toContainText('[翻译]', { timeout: 15000 })

  expect(await billedTexts(page, baseURL)).toEqual(afterFirstPass)

  // …and back again, which was a third full pass before.
  await popup.locator('#imp-display [data-value="bilingual"]').click()
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  expect(await billedTexts(page, baseURL)).toEqual(afterFirstPass)
})

// The same contract for a multi-run block, where the payload actually differs
// between the two modes if the markers are dropped. A plain <p> is one run, so
// it would pass even with the bug present; the link is what makes the two
// payloads differ.
test('a multi-run block is not re-translated when switching display mode', async ({
  context,
  baseURL,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)
  await expect(page.locator('#link-page2').locator('..').locator(TRANSLATED)).toBeVisible({
    timeout: 15000,
  })

  const afterFirstPass = await billedTexts(page, baseURL)
  // The link is its own block, so its payload is marked — which is precisely
  // what would have missed the cache before.
  expect(afterFirstPass.some((t) => t.includes('⟦1⟧Go to Page 2⟦2⟧'))).toBe(true)

  const popup = await openBackgroundPopup(context, extensionId)
  await popup.locator('#imp-display [data-value="translation-only"]').click()
  await expect(page.locator('#link-page2')).toHaveText('[翻译] Go to Page 2', { timeout: 15000 })

  expect(await billedTexts(page, baseURL)).toEqual(afterFirstPass)
})

// A block whose text is one run must be sent with no marker noise at all —
// buildMarkedSource skips markers for a single run, so the request is
// byte-identical to what it was before display modes shared a payload. Only a
// genuine single-run block; the page's two links share a parent element and are
// therefore one multi-run block.
test('a single-run block is sent without markers', async ({
  context,
  baseURL,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  const texts = await billedTexts(page, baseURL)
  expect(texts).toContain('This is the home page for testing translation.')
  // The sibling links are one block of three runs and do carry markers; what
  // matters here is that the single-run paragraph above does not.
  const singleRun = texts.find((t) => t.startsWith('This is the home page'))
  expect(singleRun).not.toMatch(/[⟦⟧]/)
  expect(texts.some((t) => /⟦1⟧Go to Page 2/.test(t))).toBe(true)
})

// Switching the target language is a different key (lang is part of it) and must
// still re-translate — the shared-key change must not have made every
// translation a permanent hit.
test('changing the target language still re-translates', async ({
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

  const afterFirstPass = await billedTexts(page, baseURL)
  expect(afterFirstPass.length).toBeGreaterThan(0)

  await setSettings(context, { targetLang: 'ja' })
  const popup = await openBackgroundPopup(context, extensionId)
  await popup.locator('#imp-lang').selectOption('ja')

  // Wait for the provider, not the DOM: the previous translation is still on
  // screen when the switch starts, so a visibility assertion would pass before
  // anything was re-requested.
  await expect
    .poll(async () => (await billedTexts(page, baseURL)).length, { timeout: 15000 })
    .toBeGreaterThan(afterFirstPass.length)
})

// Editing the glossary changes the request but not the cache key, so the term
// the user just corrected will keep serving the translation cached before the
// edit. This is the deliberate consequence of a key that carries no
// provider/glossary fingerprint — see docs/cache.md — pinned here so it cannot
// be broken silently, and so the behaviour is not mistaken for an accident.
test('editing the glossary does not re-translate', async ({
  context,
  baseURL,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await setSettings(context, { glossary: 'Home = 主页' })
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  const afterFirstPass = await billedTexts(page, baseURL)
  expect(afterFirstPass.length).toBeGreaterThan(0)
  // The glossary really did reach the request, so this is not passing because
  // the setting was inert.
  const system = (await getMockLog(page, baseURL))[0]!.system
  expect(system).toContain('"Home" → "主页"')

  // Same language, so the key is unchanged. Restarting re-renders from cache.
  await setSettings(context, { glossary: 'Home = 首页' })
  await stopTranslation(page)
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  // Still the pre-edit rendering, and no new request.
  expect(await billedTexts(page, baseURL)).toEqual(afterFirstPass)
})
