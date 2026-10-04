import { test, expect } from './fixtures'
import {
  startTranslation,
  configureMockProvider,
  setSettings,
  getServiceWorker,
} from './helpers'
import type { Page } from '@playwright/test'

// The glossary is a settings-level feature: nothing about it is observable in
// the rendered page, because the mock provider echoes the source text. These
// tests assert on what the extension actually put on the wire — the system
// message the mock server records for OpenAI, and the request body the service
// worker builds for Google — which is the only place the behaviour exists.

interface MockLogEntry {
  texts: string[]
  system: string
}

async function getMockLog(page: Page, baseURL: string) {
  const resp = await page.request.get(`${baseURL}/mock/log`)
  return (await resp.json()) as MockLogEntry[]
}

const providerSection = (page: Page) =>
  page.locator('[role="radiogroup"][aria-label="Settings section"] [data-value="provider"]')

const openProviderSection = async (page: Page) => {
  await providerSection(page).click()
  await expect(providerSection(page)).toHaveAttribute('aria-checked', 'true')
}

const selectProvider = (page: Page, value: string) =>
  page.locator(`button[role="radio"][value="${value}"]`)

async function setup(page: Page, baseURL: string, glossary: string) {
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')
  await configureMockProvider(page, baseURL)
  await setSettings(page.context(), { glossary })
}

test('glossary terms are sent in the system prompt', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await setup(page, baseURL, 'Transformer = 变换器\nKubernetes = 库伯内特斯')

  await startTranslation(page)
  await expect(
    page.locator('.imp-translate-result:not(.imp-translate-loading)').first(),
  ).toBeVisible({ timeout: 15000 })

  const log = await getMockLog(page, baseURL)
  expect(log.length).toBeGreaterThan(0)
  for (const entry of log) {
    expect(entry.system).toContain('- "Transformer" → "变换器"')
    expect(entry.system).toContain('- "Kubernetes" → "库伯内特斯"')
  }
})

// The reverse regression: a glossary that no longer reaches the request path
// would look identical on the page while silently doing nothing.
test('no glossary terms are sent when the field is empty', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await setup(page, baseURL, '')

  await startTranslation(page)
  await expect(
    page.locator('.imp-translate-result:not(.imp-translate-loading)').first(),
  ).toBeVisible({ timeout: 15000 })

  const log = await getMockLog(page, baseURL)
  for (const entry of log) {
    expect(entry.system).not.toContain('Glossary')
  }
})

// The options page reports parsed terms as active. If a half-typed line made
// it suppress the whole list, the page would claim terms were applied while
// the request carried none.
// Google has no prompt to carry a glossary, so a term travels as a sentinel
// inside the text and comes back as its target rendering. This is a different
// mechanism from the OpenAI path and shares no code with it, so it is
// asserted in the service worker against the real request body — the rendered
// page cannot distinguish the two.
test('glossary terms reach Google as sentinels inside the text', async ({
  context,
  baseURL,
}) => {
  // Settings go through storage; the request is driven from a page, because a
  // service worker cannot chrome.runtime.sendMessage to itself.
  const sw = await getServiceWorker(context)
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      settings: { provider: 'google', targetLang: 'zh', glossary: 'Mercury = 汞' },
    })
  })

  // The real Google endpoint is unreachable from a test page, so the request
  // is intercepted where the extension runs and answered locally. What is
  // under test is the payload the extension built, not Google's behaviour.
  // The stub echoes the sentinel back, as the real endpoint does 6/6 on real
  // prose — a stub that returned finished text without it would describe a
  // dropped sentinel, and correctly trigger the unmasked retry instead.
  await sw.evaluate(async () => {
    const g = globalThis as unknown as { __sent: string[] }
    g.__sent = []
    fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Body is [[texts, from, to], 'te_lib']: [0][0] is the texts array.
      const text = (JSON.parse(init?.body as string)[0][0] as string[])[0] as string
      g.__sent.push(text)
      const m = /ZQX\d{1,4}QXZ/.exec(text)
      return {
        ok: true,
        json: async () => [[`${m?.[0] ?? text}是一种化学元素。`], ['en']],
      } as Response
    }) as typeof fetch
  })

  const page = await context.newPage()
  await page.goto(`${baseURL}/term-glossary`)
  await page.waitForLoadState('domcontentloaded')

  await startTranslation(page)
  const result = page.locator('.imp-translate-result:not(.imp-translate-loading)').first()
  await expect(result).toBeVisible({ timeout: 15000 })

  const sent = await sw.evaluate((): string[] => {
    const g = globalThis as { __sent?: string[] }
    return g.__sent ?? []
  })

  expect(sent.length).toBeGreaterThan(0)
  for (const payload of sent) {
    expect(payload).toMatch(/ZQX\d{1,4}QXZ/)
    expect(payload).not.toContain('Mercury')
  }

  // The whole point: the term comes back as the user's rendering, and no
  // sentinel is left visible on the page.
  await expect(result).toContainText('汞')
  await expect(page.locator('body')).not.toContainText('ZQX')
})

test('an unparseable line is reported and no terms are sent', async ({ context, baseURL }) => {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForLoadState('domcontentloaded')
  await configureMockProvider(page, baseURL)
  await setSettings(page.context(), { glossary: 'good = 好\nbroken line' })

  await startTranslation(page)
  await expect(
    page.locator('.imp-translate-result:not(.imp-translate-loading)').first(),
  ).toBeVisible({ timeout: 15000 })

  const log = await getMockLog(page, baseURL)
  for (const entry of log) {
    expect(entry.system).not.toContain('Glossary')
  }
})

// The glossary now covers Google (sentinels in the text) and OpenAI (prompt
// instructions), so it lives in General — not nested under a provider, which
// would hide it for exactly the default provider that can use it.
test('options page shows the glossary field in the general section', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  await expect(page.getByText('Glossary', { exact: true })).toBeVisible()
  await expect(page.getByText('Microsoft and Imp Credits cannot')).toBeVisible()
})

test('options page reports the parsed term count and a bad line', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)

  const field = page.getByPlaceholder('! One term per line')
  await field.fill('Transformer = 变换器\nKubernetes = 库伯内特斯')
  await expect(page.getByText('2 terms')).toBeVisible()

  await field.fill('no separator here')
  await expect(page.getByText('Line 1: expected "source = target"')).toBeVisible()
})
