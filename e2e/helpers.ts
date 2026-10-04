import type { Page, BrowserContext } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRules, matchRulesForHostname, type SiteRule } from '../lib/rules'

const __dirname = dirname(fileURLToPath(import.meta.url))
const builtinRulesRaw = readFileSync(resolve(__dirname, '../lib/rules.txt'), 'utf-8')
const builtinRules = parseRules(builtinRulesRaw)

async function computeRulesForPage(page: Page): Promise<SiteRule[]> {
  const hostname = new URL(page.url()).hostname
  const sw = await getServiceWorker(page.context())
  const settings = (await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('settings')
    return r.settings as { developerMode?: boolean; customRules?: string } | undefined
  })) ?? {}

  const allRules: SiteRule[] = [...builtinRules]
  if (settings.developerMode && typeof settings.customRules === 'string') {
    allRules.push(...parseRules(settings.customRules))
  }
  return matchRulesForHostname(allRules, hostname)
}

export async function setCustomRules(context: BrowserContext, rules: string) {
  const sw = await getServiceWorker(context)
  await sw.evaluate(async (customRules) => {
    const existing = ((await chrome.storage.local.get('settings')).settings ?? {}) as Record<
      string,
      unknown
    >
    await chrome.storage.local.set({
      settings: { ...existing, developerMode: true, customRules },
    })
  }, rules)
}

// Merge-writes a settings patch (like setCustomRules). configureMockProvider
// replaces the whole settings object, so call this AFTER it when patching
// fields it doesn't set (e.g. renderMode).
export async function setSettings(
  context: BrowserContext,
  patch: Record<string, unknown>,
) {
  const sw = await getServiceWorker(context)
  await sw.evaluate(async (patch) => {
    const existing = ((await chrome.storage.local.get('settings')).settings ?? {}) as Record<
      string,
      unknown
    >
    await chrome.storage.local.set({ settings: { ...existing, ...patch } })
  }, patch)
}

export async function getServiceWorker(context: BrowserContext) {
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')
  return sw
}

// The getAll() interception both stubs below need. Self-contained so Playwright
// can serialize it into the service worker.
const installShortcutOverrides = () => {
  const g = globalThis as unknown as {
    __getAllOrig?: typeof chrome.commands.getAll
    __shortcutOverrides?: Record<string, string>
  }
  if (g.__getAllOrig) return
  g.__getAllOrig = chrome.commands.getAll.bind(chrome.commands)
  chrome.commands.getAll = async () => {
    const all = await g.__getAllOrig!()
    return all.map((c) =>
      g.__shortcutOverrides?.[c.name] !== undefined
        ? { ...c, shortcut: g.__shortcutOverrides[c.name] }
        : c,
    )
  }
}

// Chrome has no commands.update(), so a test cannot change the binding the way
// a user does. Override getAll() in the service worker instead: the background
// calls it on every getHotkeyState, so the options page reads whatever this
// returns. Call again to change or clear the override for the same command.
export async function stubBrowserShortcut(
  context: BrowserContext,
  shortcut: string,
  command = 'toggle-translate',
) {
  const sw = await getServiceWorker(context)
  await sw.evaluate(installShortcutOverrides)
  await sw.evaluate(
    ({ shortcut, command }) => {
      const g = globalThis as unknown as {
        __shortcutOverrides?: Record<string, string>
      }
      g.__shortcutOverrides = { ...g.__shortcutOverrides, [command]: shortcut }
    },
    { shortcut, command },
  )
}

// Makes the background believe commands.update() exists, which on a real Chrome
// it does not. Recording is refused there by design, so this is the only way to
// drive the recorder — and the calls it captures prove which command name and
// shortcut reached the browser API. A recorded binding also shows up in
// getAll(), so the page's "currently active" line follows it like it would on
// Firefox. Returns a reader for the captured calls.
export async function stubBrowserUpdate(context: BrowserContext) {
  const sw = await getServiceWorker(context)
  await sw.evaluate(installShortcutOverrides)
  await sw.evaluate(() => {
    const g = globalThis as unknown as {
      __hotkeyUpdates?: { name: string; shortcut: string }[]
      __shortcutOverrides?: Record<string, string>
    }
    g.__hotkeyUpdates = []
    ;(chrome.commands as { update?: unknown }).update = async (details: {
      name: string
      shortcut: string
    }) => {
      g.__hotkeyUpdates!.push(details)
      g.__shortcutOverrides = {
        ...g.__shortcutOverrides,
        [details.name]: details.shortcut,
      }
    }
  })
  return async () =>
    await sw.evaluate(() => {
      const g = globalThis as unknown as {
        __hotkeyUpdates?: { name: string; shortcut: string }[]
      }
      return g.__hotkeyUpdates ?? []
    })
}

export async function getCommands(context: BrowserContext) {
  const sw = await getServiceWorker(context)
  return await sw.evaluate(async () =>
    (await chrome.commands.getAll()).map((c) => ({
      name: c.name,
      shortcut: c.shortcut,
    })),
  )
}

export async function getTabId(page: Page): Promise<number> {
  const url = page.url()
  const sw = await getServiceWorker(page.context())
  const tabId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url })
    return tabs[0]?.id
  }, url)
  if (!tabId) throw new Error('No tab ID found')
  return tabId
}

// Messages to the content script go through @webext-core/messaging on the
// receiving side, so tests must send the library's wire envelope
// ({ id, type, data, timestamp }) instead of a bare { action } object — the
// content script's listener rejects anything without a `type` and
// `timestamp`, and `tabs.sendMessage` would then hang with no response.
// Keeping the envelope in one place here keeps that coupling visible.
export async function sendToContentScript(
  context: BrowserContext,
  tabId: number,
  type: 'startTranslation' | 'stopTranslation' | 'getState',
  data?: unknown,
): Promise<unknown> {
  const sw = await getServiceWorker(context)
  return await sw.evaluate(
    async ([tabId, type, data]) =>
      await chrome.tabs.sendMessage(tabId, {
        id: 1,
        type,
        data,
        timestamp: Date.now(),
      }),
    [tabId, type, data] as const,
  )
}

export async function configureMockProvider(page: Page, baseURL: string) {
  const sw = await getServiceWorker(page.context())
  await sw.evaluate(async (endpoint) => {
    await chrome.storage.local.set({
      settings: {
        provider: 'openai',
        targetLang: 'zh',
        openai: {
          apiKey: 'test-key',
          endpoint,
          model: 'mock',
          systemPrompt: 'Translate to {{targetLang}}.',
        },
      },
    })
  }, `${baseURL}/v1/chat/completions`)
}

export async function startTranslation(page: Page, targetLang = 'zh', showToast = false) {
  const tabId = await getTabId(page)
  const sw = await getServiceWorker(page.context())
  const rules = await computeRulesForPage(page)
  await sw.evaluate(
    async ([tabId, lang]) => {
      await chrome.storage.session.set({ [`tab_translating_${tabId}`]: lang })
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['/inject.js'],
      })
    },
    [tabId, targetLang] as const,
  )
  await sendToContentScript(page.context(), tabId, 'startTranslation', {
    targetLang,
    showToast,
    rules,
  })
}

export async function enableMobileMode(context: BrowserContext) {
  const sw = await getServiceWorker(context)
  await sw.evaluate(() => {
    chrome.runtime.getPlatformInfo = (() =>
      Promise.resolve({ os: 'android', arch: 'x86-64', nacl_arch: 'x86-64' })) as any
  })
}

// Mirrors stopTranslationForTab in entrypoints/background.ts (minus the
// setIcon call, which these tests don't assert) — the same sequence used by
// toggleTranslationForActiveTab and, on mobile, by openPanelForActiveTab's
// "already translating" branch (a toolbar tap there stops translation and
// lets the content script re-open the panel itself, restored).
export async function stopTranslation(page: Page) {
  const tabId = await getTabId(page)
  const sw = await getServiceWorker(page.context())
  try {
    await sendToContentScript(page.context(), tabId, 'stopTranslation')
  } catch {
    // No content script in this tab (the test may drive a tab that just
    // navigated, e.g. before the background re-injected on DOMContentLoaded).
    // Clearing the session key below is what the assertions depend on — the
    // same best-effort shape the background's stopTranslationForTab uses.
  }
  await sw.evaluate(async (tabId) => {
    await chrome.storage.session.remove(`tab_translating_${tabId}`)
  }, tabId)
}

// The popup inspects `tabs.query({ active: true, currentWindow: true })`, so
// opening popup.html as a normal tab (what a plain page.goto does) makes it
// inspect itself — a chrome-extension:// page with no content script, which is
// never translating. Creating the tab in the background instead keeps the page
// under test active, and is the only way to reach the popup's translate path:
// chrome.action.onClicked cannot be dispatched from a test.
export async function openBackgroundPopup(
  context: BrowserContext,
  extensionId: string,
): Promise<Page> {
  const url = `chrome-extension://${extensionId}/popup.html`
  const sw = await getServiceWorker(context)
  await sw.evaluate(async (url) => {
    await chrome.tabs.create({ url, active: false })
  }, url)

  for (let i = 0; i < 50; i++) {
    const found = context.pages().find((p) => p.url().startsWith(url))
    if (found) {
      await found.waitForLoadState('domcontentloaded')
      return found
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('popup tab did not appear')
}

// Chrome has no chrome.action.getIcon, so to assert icon state in e2e we
// monkey-patch chrome.action.setIcon in the service worker and record every
// call. Detect kind by path: '/icon/active/...' is active, anything else is
// default. Idempotent — safe to call once per test before the navigation we
// care about.
export async function instrumentSetIcon(context: BrowserContext) {
  const sw = await getServiceWorker(context)
  await sw.evaluate(() => {
    type Call = { tabId?: number; icon: 'active' | 'default' }
    const g = globalThis as {
      __setIconCalls?: Call[]
      __setIconOrig?: typeof chrome.action.setIcon
    }
    if (g.__setIconCalls) return
    g.__setIconCalls = []
    g.__setIconOrig = chrome.action.setIcon.bind(chrome.action)
    chrome.action.setIcon = ((details: chrome.action.TabIconDetails) => {
      const path = details.path
      const sample =
        typeof path === 'string'
          ? path
          : ((path as Record<string, string> | undefined)?.['16'] ?? '')
      const icon: Call['icon'] = sample.includes('active') ? 'active' : 'default'
      g.__setIconCalls!.push({ tabId: details.tabId, icon })
      return g.__setIconOrig!(details)
    }) as typeof chrome.action.setIcon
  })
}

export async function getLastIcon(
  context: BrowserContext,
  tabId: number,
): Promise<'active' | 'default' | null> {
  const sw = await getServiceWorker(context)
  return sw.evaluate((tabId) => {
    type Call = { tabId?: number; icon: 'active' | 'default' }
    const calls = (globalThis as { __setIconCalls?: Call[] }).__setIconCalls ?? []
    const mine = calls.filter((c) => c.tabId === tabId)
    return mine.length > 0 ? mine[mine.length - 1].icon : null
  }, tabId)
}

export interface MockLogEntry {
  texts: string[]
  system: string
  receivedAt: number
  completedAt: number | null
}

export async function getMockLog(page: Page, baseURL: string): Promise<MockLogEntry[]> {
  const resp = await page.request.get(`${baseURL}/mock/log`)
  return (await resp.json()) as MockLogEntry[]
}

// Every text the provider was asked to translate, across all requests. A cache
// hit never reaches the mock, so this is the bill.
export async function billedTexts(page: Page, baseURL: string): Promise<string[]> {
  const log = await getMockLog(page, baseURL)
  return log.flatMap((entry) => entry.texts)
}

// Make the provider's answer for a source text differ from now on. A call
// count alone cannot tell "skipped the cache read" from "read a refreshed
// entry"; changing the answer makes the difference visible on the page.
export async function setMockReplies(
  page: Page,
  baseURL: string,
  replies: Record<string, string>,
) {
  await page.request.post(`${baseURL}/mock/replies`, { data: { replies } })
}
