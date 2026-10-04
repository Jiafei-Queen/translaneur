import { test, expect } from './fixtures'
import { billedTexts, configureMockProvider, getMockLog, startTranslation } from './helpers'

const TRANSLATED = '.imp-translate-result:not(.imp-translate-loading)'

// The coherence instruction in lib/translator.ts is an assertion about the shape
// of a request: that its blocks are consecutive segments of one document, which
// is what lets the model disambiguate a short block from its neighbours instead
// of guessing alone. These tests pin both halves of that — the instruction
// appears exactly when the request carries more than one block, and a batch
// never spans two documents.

// `/` yields three blocks: the h1, the paragraph, and the two links (one
// multi-run block, since they share a parent).
const HOME_TEXTS = 3

test('the coherence instruction is sent exactly when a request carries multiple blocks', async ({
  context,
  baseURL,
}) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  // Wait for the provider, not the DOM: reading the log while later requests
  // are still in flight would assert over a partial batch set.
  await expect
    .poll(async () => (await billedTexts(page, baseURL)).length, { timeout: 15000 })
    .toBe(HOME_TEXTS)

  const log = await getMockLog(page, baseURL)
  const multi = log.filter((entry) => entry.texts.length > 1)
  const single = log.filter((entry) => entry.texts.length === 1)

  // Checked as a property over whatever the batcher produced rather than
  // against one hard-coded request, so this survives a change in how many
  // blocks the walker finds.
  for (const entry of multi) {
    expect(
      entry.system,
      `a ${entry.texts.length}-block request must tell the model the blocks are one document`,
    ).toContain('consecutive segments of a single document')
    expect(entry.system).toContain('disambiguate polysemous words using the surrounding blocks')
  }
  // A single-block request has no neighbours. Telling the model to consult them
  // would be an instruction it cannot act on, and it invites it to invent
  // continuity that is not in the request.
  for (const entry of single) {
    expect(entry.system).not.toContain('consecutive segments')
  }

  // …and the multi-block path has to have actually run, or the loop above
  // proves nothing.
  expect(multi.length, 'the page must produce at least one multi-block request').toBeGreaterThan(0)
})

test('a frame is batched separately from the page that embeds it', async ({
  context,
  baseURL,
}) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/with-iframes`)
  await page.waitForLoadState('domcontentloaded')

  await configureMockProvider(page, baseURL)
  await startTranslation(page)

  const frame = page.frameLocator('#large-iframe')
  await expect(frame.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })
  // The iframe's content script finishes on its own clock, so wait for the
  // embedding page too before reading the log.
  await expect(page.locator(TRANSLATED).first()).toBeVisible({ timeout: 15000 })

  const IN_FRAME = 'This paragraph lives inside an iframe'
  const log = await getMockLog(page, baseURL)
  const withFrameText = log.filter((entry) => entry.texts.some((t) => t.includes(IN_FRAME)))

  expect(withFrameText.length, 'the iframe block must have been billed').toBeGreaterThan(0)

  for (const entry of withFrameText) {
    // This is the regression the scope key exists for. The main frame and its
    // iframe are two documents, and they translate concurrently — so before
    // the queue was scoped they landed in one request, and the model was told
    // that an ad iframe's text was the next paragraph of the article.
    expect(
      entry.texts,
      'a frame must never share a request with the page that embeds it',
    ).toHaveLength(1)
    expect(entry.system).not.toContain('consecutive segments')
  }

  // The embedding page's own blocks still batch together, or the assertion
  // above would also pass with a batcher that never batches anything.
  const multi = log.filter((entry) => entry.texts.length > 1)
  expect(multi.length).toBeGreaterThan(0)
  for (const entry of multi) {
    expect(entry.texts.some((t) => t.includes(IN_FRAME))).toBe(false)
  }
})

// Two tabs translating at the same instant is the same scope key and the same
// code path as the frame case, so it is not pinned here: the batch window is
// 100ms and driving two UI-driven walks into the same window is not
// deterministic, which would make the test able to pass without exercising
// anything. The frame test above covers the mechanism with a real concurrent
// second document. If a tab-scoped regression is ever suspected, drive
// `translate` messages into the background back-to-back instead of going
// through the UI.
