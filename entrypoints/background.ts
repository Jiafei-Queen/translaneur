import { checkConnection, exchangeCode, humanizeError } from '@rxliuli/imp-credits-sdk'
import { messager, type TabWakeup, TAB_WAKEUP_PREFIX } from '@/lib/message'
import { getSettings, saveSettings, peekSettings, type TranslationProvider } from '@/lib/storage'
import { translate } from '@/lib/translator'
import { getCached, setCached, evictOldEntries } from '@/lib/cache'
import { createTranslateService, type BatchLimits, type TranslateService } from '@/lib/translate-service'
import { eldDetectLanguage } from '@/lib/eld-detect'
import { parseRules, matchRulesForHostname, type SiteRule } from '@/lib/rules'
import { getEffectiveRules, setupRemoteRulesAlarm, fetchRemoteRulesIfNeeded } from '@/lib/remote-rules'
import { PublicPath } from 'wxt/browser'
import { debugTime, isPdfUrl } from '@/lib/utils'
import { IMP_ORIGIN } from '@/lib/imp'
import {
  RETRANSLATE_COMMAND,
  TOGGLE_COMMAND,
  toBrowserShortcut,
  toStoredShortcut,
} from '@/lib/hotkey'

async function getMatchedRulesForHostname(hostname: string): Promise<SiteRule[]> {
  const effectiveRules = await getEffectiveRules()
  const rules: SiteRule[] = matchRulesForHostname(effectiveRules, hostname)
  try {
    const result = await browser.storage.local.get('settings')
    const settings = result.settings as Record<string, unknown> | undefined
    if (settings?.developerMode && typeof settings.customRules === 'string') {
      rules.push(...matchRulesForHostname(parseRules(settings.customRules), hostname))
    }
  } catch {}
  return rules
}

function hostnameFromUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// Thunderbird-only namespaces are absent from the shared @wxt-dev/browser
// type surface; the shapes here are spike-verified (docs/thunderbird/
// spike.md). Runtime feature detection: in the browser builds these resolve
// to undefined and the mail pipeline never activates, so one file serves all
// three targets without a build-time branch.
interface MailScripting {
  messageDisplay: {
    registerScripts(details: {
      id: string
      js: string[]
      runAt: 'document_idle'
    }): Promise<unknown>
  }
}

interface MailMessageDisplay {
  onMessagesDisplayed: {
    addListener(listener: (tab: { id?: number }, messageList: unknown) => void): void
  }
}

function messageDisplayScripts(): MailScripting['messageDisplay'] | undefined {
  const ns = (browser.scripting as unknown as Partial<MailScripting>)?.messageDisplay
  return typeof ns?.registerScripts === 'function' ? ns : undefined
}

function messageDisplay(): MailMessageDisplay | undefined {
  const ns = (browser as unknown as { messageDisplay?: MailMessageDisplay }).messageDisplay
  return typeof ns?.onMessagesDisplayed?.addListener === 'function' ? ns : undefined
}

// tab.type is Gecko-only (and untyped in the shared surface). The 3-pane
// preview pane reports `mail`; a message tab or a stand-alone message window
// reports `messageDisplay`.
function isMailSurfaceTab(tab: { type?: string }): boolean {
  return tab.type === 'mail' || tab.type === 'messageDisplay'
}

// inject.js auto-injects into every displayed message — message tab,
// stand-alone window, and the 3-pane preview pane alike (spike probe 3).
// A second call in one session rejects with "already registered"; the
// registration persists for the session, which is all we need.
async function registerMailInjectScript(): Promise<void> {
  const api = messageDisplayScripts()
  if (!api) return
  try {
    await api.registerScripts({
      id: 'imp-mail-inject',
      js: ['/inject.js'],
      runAt: 'document_idle',
    })
  } catch {}
}

async function injectContentScript(tabId: number, frameId?: number) {
  const t = debugTime(`injectContentScript(tabId=${tabId}${frameId !== undefined ? `, frameId=${frameId}` : ''})`)
  const target = frameId !== undefined
    ? { tabId, frameIds: [frameId] }
    : { tabId, allFrames: true }
  await browser.scripting.executeScript({
    target,
    files: ['/inject.js'],
  })
  t('executeScript resolved')
}

async function getTabTranslatingLang(tabId: number): Promise<string | null> {
  const key = `tab_translating_${tabId}`
  const result = await browser.storage.session.get(key)
  return (result[key] as string) ?? null
}

async function setTabTranslatingLang(tabId: number, lang: string | null) {
  const key = `tab_translating_${tabId}`
  if (lang) {
    await browser.storage.session.set({ [key]: lang })
  } else {
    await browser.storage.session.remove(key)
  }
}

// Remote commands ride storage next to the direct message: a displayed
// message's script may be absent, and background→content messages are not
// reliable on mail surfaces (docs/thunderbird/bugs.md TB-3) — but content
// scripts do see storage.onChanged, for storage.local only (storage.session
// is not exposed to them). See TabWakeup: a wake-up is a command, not state.
let commandRev = 0

// Wake-up keys name tab ids that die with the session, so clear the ones a
// previous session left behind. Started at module load and awaited by the
// writes below, so an early command can't be purged after it landed.
const wakeupsReady = (async () => {
  const all = await browser.storage.local.get(null)
  const stale = Object.keys(all).filter((k) => k.startsWith(TAB_WAKEUP_PREFIX))
  if (stale.length > 0) await browser.storage.local.remove(stale)
})()

async function ringTabWakeup(
  tabId: number,
  wakeup: Omit<TabWakeup, 'rev'>,
): Promise<number> {
  await wakeupsReady
  const rev = ++commandRev
  await browser.storage.local.set({
    [`${TAB_WAKEUP_PREFIX}${tabId}`]: { ...wakeup, rev },
  })
  return rev
}

// Chromium has no theme-aware toolbar icon API: no `theme_icons`, raster
// formats only, and no theme-change event. The same pixels therefore have to
// read on both the light and the dark toolbar, which caps the artwork at
// mid-luminance colours. Neutral grey while idle, brand blue while
// translating: white disappears on a light toolbar, near-black on a dark one.
const defaultIcon: Record<number, PublicPath> = {
  16: '/icon/16.png',
  32: '/icon/32.png',
  48: '/icon/48.png',
  96: '/icon/96.png',
  128: '/icon/128.png',
}

const activeIcon: Record<number, PublicPath> = {
  16: '/icon/active/16-active.png',
  32: '/icon/active/32-active.png',
  48: '/icon/active/48-active.png',
  96: '/icon/active/96-active.png',
  128: '/icon/active/128-active.png',
}

// Main-frame onCommitted handlers still running, keyed by tab. Sub-frames
// reach onDOMContentLoaded independently and can beat it, reading the session
// key before the reload branch has cleared it and re-translating a frame on a
// page that was just reloaded. Both listeners are async, so nothing orders
// them; sub-frames wait here instead.
const commitInFlight = new Map<number, Promise<void>>()

async function awaitMainFrameCommit(tabId: number): Promise<void> {
  const pending = commitInFlight.get(tabId)
  if (pending) await pending
}

async function startTranslationForTab(
  tabId: number,
  targetLang: string,
  showToast = false,
  force = false,
) {
  const t = debugTime(`startTranslationForTab(tabId=${tabId})`)
  await setTabTranslatingLang(tabId, targetLang)
  t('setTabTranslatingLang done')
  await browser.action.setIcon({ tabId, path: activeIcon })
  t('setIcon done')

  const tab = await browser.tabs.get(tabId)
  // Mail surfaces take inject.js from the registered message-display script,
  // in place since startup, so the displayed document usually has it. Do not
  // await executeScript for them: on `mail` and just-created `messageDisplay`
  // tabs its promise can fail to settle (spike probe 3), and a hung inject
  // would leave the wake-ups below unsent. Fire it anyway — for a message
  // displayed before the registration landed it is the only way in, and the
  // injection itself may still land. inject.js marks its document in the
  // DOM, so one that gets both deliveries still runs a single pipeline.
  if (isMailSurfaceTab(tab as unknown as { type?: string })) {
    void injectContentScript(tabId).catch(() => {})
  } else {
    await injectContentScript(tabId)
    t('injectContentScript done')
  }

  // Wake the content script over two channels stamped with one revision: the
  // storage wake-up (reaches mail display scripts) and the direct message
  // (the browser path). The content script applies a revision once.
  const rev = await ringTabWakeup(tabId, { lang: targetLang, force, showToast })
  t('ringTabWakeup done')
  const rules = await getMatchedRulesForHostname(hostnameFromUrl(tab.url))
  t('rules fetched')
  try {
    await messager.sendMessage('startTranslation', { targetLang, showToast, rules, force, rev }, { tabId })
    t('startTranslation sent')
  } catch {
    // No receiver — a displayed message without the script, or a mail
    // surface tabs.sendMessage cannot reach. The wake-up above is the
    // delivery that survives; state and icon are already consistent.
  }
}

async function stopTranslationForTab(tabId: number) {
  try {
    await messager.sendMessage('stopTranslation', undefined, { tabId })
  } catch {
    // Content script may not be loaded
  }
  await ringTabWakeup(tabId, { lang: null })
  await browser.action.setIcon({ tabId, path: defaultIcon })
  await setTabTranslatingLang(tabId, null)
}

async function isPageTranslating(tabId: number): Promise<boolean> {
  try {
    return (await messager.sendMessage('getState', undefined, { tabId })) === true
  } catch {
    return false
  }
}

// Whether to treat the tab as translating when toggling. The session key is
// the authority: it drives the icon and the popup, and it is the only state a
// mail surface has — a displayed message's script may be absent, and
// background→content messages are not reliable there (TB-3), so a getState
// round trip can answer "idle" for a tab that is translating. The content
// script's own state is kept as a second chance for web tabs only, covering
// the one desync where the key was cleared while a run is still live.
async function isTabActivelyTranslating(tab: { id?: number; type?: string }): Promise<boolean> {
  if (!tab.id) return false
  if (await getTabTranslatingLang(tab.id)) return true
  if (isMailSurfaceTab(tab)) return false
  return isPageTranslating(tab.id)
}

async function toggleTranslationForActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  if (isPdfUrl(tab.url)) return
  if (await isTabActivelyTranslating(tab as unknown as { type?: string })) {
    await stopTranslationForTab(tab.id)
  } else {
    const settings = await getSettings()
    await startTranslationForTab(tab.id, settings.targetLang, true)
  }
}

// The re-translate hotkey. Always acts rather than only refreshing a page that
// is already translating: on such a page this is the popup's "Re-translate"
// (a walk with the cache read skipped), and on a cold one a forced pass is
// just the first translation. A silent no-op would make the key look broken.
async function retranslateForActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  if (isPdfUrl(tab.url)) return
  const settings = await getSettings()
  await startTranslationForTab(tab.id, settings.targetLang, true, true)
}

// Mobile has no action popup, so the toolbar icon is the only way back to the
// in-page panel (restore / settings / language). Idle: start translation and
// open the panel. Translating: stop (restoring the original page) — the
// content script re-opens the panel itself, in its restored state
// ("Translate"), as part of handling the stopTranslation message below.
// Desktop keeps its popup and the keyboard keeps the toggle.
async function openPanelForActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  if (isPdfUrl(tab.url)) return
  if (await isTabActivelyTranslating(tab as unknown as { type?: string })) {
    await stopTranslationForTab(tab.id)
    return
  }
  const settings = await getSettings()
  await startTranslationForTab(tab.id, settings.targetLang, true)
}

async function isMobile(): Promise<boolean> {
  const info = await browser.runtime.getPlatformInfo()
  return info.os === 'android' || info.os === 'ios'
}

async function setupMobileAction() {
  if (await isMobile()) {
    await browser.action.setPopup({ popup: '' })
  }
}

function setupCacheCleanupAlarm() {
  browser.alarms.create('evict-old-cache', { periodInMinutes: 24 * 60 })
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'evict-old-cache') {
      evictOldEntries()
    }
  })
}

// Chrome's commands API exposes only getAll(); commands.update() is
// Firefox-only, so on Chrome the binding lives in browser prefs and only the
// user can change it. The cast is required because @wxt-dev/browser's type
// surface omits update() entirely; it is the one unchecked shape in this
// file, isolated here so the probe cannot be mistaken for a typed value.
type CommandsWithUpdate = typeof browser.commands & {
  update?: (details: { name: string; shortcut: string }) => Promise<void>
}

function commandsUpdate() {
  return (browser.commands as CommandsWithUpdate).update
}

async function applyHotkey(command: string, hotkey: string): Promise<boolean> {
  const update = commandsUpdate()
  if (!update) return false
  try {
    await update.call(browser.commands, {
      name: command,
      // Storage keeps "Ctrl+K"; macOS needs "MacCtrl+K" to bind Control
      // instead of Command.
      shortcut: toBrowserShortcut(hotkey),
    })
    return true
  } catch {
    // The browser refuses shortcuts it considers invalid or reserved.
    return false
  }
}

async function syncHotkeysFromSettings() {
  const { toggleHotkey, retranslateHotkey } = await getSettings()
  // Both, and independently: a browser that rejects one command's shortcut
  // must not leave the other unapplied on startup.
  await applyHotkey(TOGGLE_COMMAND, toggleHotkey)
  await applyHotkey(RETRANSLATE_COMMAND, retranslateHotkey)
}

export default defineBackground(() => {
  setupRemoteRulesAlarm()
  setupCacheCleanupAlarm()

  browser.runtime.onInstalled.addListener(async () => {
    await setupMobileAction()
    await syncHotkeysFromSettings()
  })
  browser.runtime.onStartup.addListener(async () => {
    await setupMobileAction()
    await syncHotkeysFromSettings()
  })

  browser.action.onClicked.addListener(() => openPanelForActiveTab())

  // browser.commands is absent on Firefox Android, which has no keyboard to
  // bind. Feature-detect rather than branch on the build target: a build-time
  // BROWSER check stripped this listener from desktop Firefox, where
  // onCommand is fully supported, so the hotkey did nothing at all.
  // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/commands#browser_compatibility
  if (browser.commands?.onCommand) {
    browser.commands.onCommand.addListener(async (command) => {
      if (command === TOGGLE_COMMAND) {
        // Keyboard keeps the toggle — a keypress is deliberate.
        await toggleTranslationForActiveTab()
      } else if (command === RETRANSLATE_COMMAND) {
        await retranslateForActiveTab()
      }
    })
  }

  messager.onMessage('setHotkey', async ({ data }) => {
    return { applied: await applyHotkey(data.command, data.hotkey) }
  })

  messager.onMessage('getHotkeyState', async ({ data }) => {
    const canApply = typeof commandsUpdate() === 'function'
    // getAll() exists wherever commands does, Chrome included, so read the
    // browser's real binding unconditionally. Gating it on canApply hid the
    // very fact that makes the Chrome limitation legible: the user's stored
    // preference and the shortcut Chrome will actually fire can differ.
    const all = await browser.commands.getAll()
    // The browser reports its own dialect; show the same one the user picked
    // so the two lines below the button agree.
    const active = toStoredShortcut(
      all.find((c) => c.name === data.command)?.shortcut ?? '',
    )
    return { active, canApply }
  })

  messager.onMessage('getMatchedRulesForHostname', async ({ data }) => {
    return await getMatchedRulesForHostname(data.hostname)
  })

  const BATCH_PARAMS: Record<TranslationProvider, BatchLimits> = {
    microsoft: { batchWindowMs: 50, maxBatchSize: 25 },
    google: { batchWindowMs: 50, maxBatchSize: 20, maxBatchChars: 14000 },
    openai: { batchWindowMs: 100, maxBatchSize: 8, maxBatchChars: 1000 },
    // Imp Credits chunks and guarantees 1:1 server-side (cap 500 texts per
    // request), so the client can hand the whole array over in one call
    // rather than partitioning itself.
    imp: { batchWindowMs: 100, maxBatchSize: 500, maxBatchChars: 20000 },
  }

  const services = new Map<TranslationProvider, TranslateService>()

  function getService(provider: TranslationProvider): TranslateService {
    let service = services.get(provider)
    if (!service) {
      const t = debugTime(`bg:createService(${provider})`)
      service = createTranslateService({
        getLimits: () => {
          const base = BATCH_PARAMS[provider]
          if (provider !== 'openai') return base
          const { openai } = peekSettings()
          return {
            batchWindowMs: base.batchWindowMs,
            maxBatchSize: openai.maxTextsPerRequest || base.maxBatchSize,
            maxBatchChars: openai.maxCharsPerRequest || base.maxBatchChars,
          }
        },
        getCached,
        setCached,
        translator: async (texts, lang) => {
          const settings = await getSettings()
          const result = await translate(texts, lang, settings)
          return result.texts
        },
        onAfterFlush: () => evictOldEntries(),
      })
      services.set(provider, service)
      t('created')
    }
    return service
  }

  messager.onMessage('translate', async ({ data, sender }) => {
    const t = debugTime(`bg:translate(lang=${data.targetLang}, text="${data.text.slice(0, 40)}")`)
    const settings = await getSettings()
    t('getSettings done')
    // A frame is a document: the page is the main frame, every iframe its own.
    // Scoping the queue that way keeps the "consecutive segments of one
    // document" instruction in lib/translator.ts true — otherwise two tabs, or
    // a page and an ad iframe, share a batch and the model is told a lie. One
    // tab and one frame, the common case, is unchanged. A sender with no tab is
    // an extension page and gets the unscoped default.
    const scope =
      sender.tab?.id !== undefined ? `${sender.tab.id}:${sender.frameId ?? 0}` : undefined
    const result = await getService(settings.provider).translate(data.text, data.targetLang, {
      force: data.force,
      scope,
    })
    t('translate done')
    return result
  })

  // Exchanges the one-time code the connect content script read off the
  // success page's <meta> tag for a persistent Imp Credits api key. See
  // imp-credits docs/extension-integration.md for the full contract.
  messager.onMessage('impConnect', async (message) => {
    const code = message.data
    try {
      // The SDK exchanges the one-time code for { apiKey, baseUrl, model }.
      const profile = await exchangeCode({ code, origin: IMP_ORIGIN })
      await saveSettings({ provider: 'imp', imp: profile })
      return { ok: true }
    } catch (err) {
      console.error(
        '[imp-translate] impConnect failed:',
        err instanceof Error ? err.message : err,
      )
      // Humanize in `imp` mode so a 400 (invalid/already-used code) and a
      // network error both become something the banner can say.
      return { ok: false, error: humanizeError(err, 'imp') }
    }
  })

  // Zero-cost check whether the stored Imp api key is still valid, so the
  // options page's "Connected" badge reflects reality rather than just local
  // state. Deliberately calls the /me endpoint with `credentials: 'omit'` —
  // without it, a logged-in session's cookie would make a REVOKED key still
  // return 200, so the badge would show "Connected" while real requests 401.
  messager.onMessage('checkConnection', async ({ data: imp }) => {
    try {
      // The SDK GETs {baseUrl}/me with `credentials: 'omit'` — the status
      // check must reflect the KEY only, not a logged-in session cookie (which
      // would make a revoked key still return 200 and show "Connected").
      return await checkConnection({ baseUrl: imp.baseUrl, apiKey: imp.apiKey })
    } catch (err) {
      console.error(
        '[imp-translate] checkConnection failed:',
        err instanceof Error ? err.message : err,
      )
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'network error',
      } as const
    }
  })

  messager.onMessage('translateBatch', async ({ data }) => {
    const t = debugTime(`bg:translateBatch(lang=${data.targetLang}, n=${data.texts.length})`)
    const settings = await getSettings()
    const lang = data.targetLang

    const results: string[] = new Array(data.texts.length)
    const uncachedIndices: number[] = []
    const uncachedTexts: string[] = []

    for (let i = 0; i < data.texts.length; i++) {
      const cached = await getCached(data.texts[i], lang)
      if (cached !== undefined) {
        results[i] = cached
      } else {
        uncachedIndices.push(i)
        uncachedTexts.push(data.texts[i])
      }
    }
    t(`cache: ${data.texts.length - uncachedTexts.length} hit, ${uncachedTexts.length} miss`)

    if (uncachedTexts.length > 0) {
      const translated = await translate(uncachedTexts, lang, settings)
      for (let j = 0; j < uncachedIndices.length; j++) {
        const text = uncachedTexts[j]
        const out = translated.texts[j]
        results[uncachedIndices[j]] = out
        if (out.trim() && out.toLowerCase() !== text.toLowerCase()) {
          await setCached(text, lang, out)
        }
      }
      evictOldEntries()
    }
    t('done')
    return results
  })

  messager.onMessage('startTab', async ({ data }) => {
    await startTranslationForTab(data.tabId, data.targetLang, true, data.force)
  })

  messager.onMessage('stopTab', async ({ data }) => {
    await stopTranslationForTab(data.tabId)
  })

  // Session key only — it is what drives the action icon, so the popup can
  // never disagree with it, and it is written before the content script
  // flips its own state, so a storage-triggered refetch (popup/main.tsx)
  // can't observe a half-started translation.
  messager.onMessage('getTabState', async ({ data }) => {
    return await getTabTranslatingLang(data.tabId)
  })

  messager.onMessage('getSelfTabState', async ({ sender }) => {
    const tabId = sender.tab?.id
    if (!tabId) return null
    return await getTabTranslatingLang(tabId)
  })

  messager.onMessage('getSelfTabId', async ({ sender }) => {
    return sender.tab?.id ?? null
  })

  messager.onMessage('stopSelfTab', async ({ sender }) => {
    const tabId = sender.tab?.id
    if (!tabId) return
    await setTabTranslatingLang(tabId, null)
    await browser.action.setIcon({ tabId, path: defaultIcon })
  })

  messager.onMessage('startSelfTab', async ({ sender, data }) => {
    const tabId = sender.tab?.id
    if (!tabId) return
    await setTabTranslatingLang(tabId, data.targetLang)
    // Turns the icon back on when this follows a mobile "Translate"
    // (restored → translating); idempotent for the plain lang-change case,
    // where the icon is already active.
    await browser.action.setIcon({ tabId, path: activeIcon })
  })

  messager.onMessage('isMobile', async () => {
    return await isMobile()
  })

  messager.onMessage('openOptionsPage', async () => {
    await browser.runtime.openOptionsPage()
  })

  messager.onMessage('detectLanguageBatch', ({ data }) => {
    return data.texts.map((text) => eldDetectLanguage(text))
  })

  messager.onMessage('refreshRemoteRules', async () => {
    await fetchRemoteRulesIfNeeded(true)
  })

  messager.onMessage('diag', ({ data }) => {
    console.info('[imp-diag]\n' + data)
  })

  // Per WebExtension spec, per-tab action icons reset on navigation (Chrome +
  // Firefox follow this; Safari preserves them). Reapply on commit — the
  // earliest event we can hook — so the icon doesn't blink to default during
  // link nav. If the navigation turns out to be a reload, the reload branch
  // in onDOMContentLoaded below will revert it.
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return
    // Publish the whole handler as an in-flight promise so a sub-frame's
    // onDOMContentLoaded can wait for the reload decision before reading the
    // session key (see commitInFlight). Covers the `!lang` early return too, so
    // a sub-frame never waits on a promise that was never registered.
    const done = (async () => {
      const lang = await getTabTranslatingLang(details.tabId)
      if (!lang) return
      // A reload (or navigating to a PDF) stops translation. Detect the reload
      // here at commit — the earliest available event — and clear the
      // translating state now, so that sub-frame onDOMContentLoaded handlers
      // below don't read a stale "translating" key and re-translate an iframe
      // on a page that was just reloaded. The performance.navigation check in
      // onDOMContentLoaded remains as a backstop for cases transitionType misses.
      if (details.transitionType === 'reload' || isPdfUrl(details.url)) {
        await setTabTranslatingLang(details.tabId, null)
        await browser.action.setIcon({ tabId: details.tabId, path: defaultIcon })
        return
      }
      await browser.action.setIcon({ tabId: details.tabId, path: activeIcon })
    })()
    commitInFlight.set(details.tabId, done)
    void done.finally(() => {
      if (commitInFlight.get(details.tabId) === done) commitInFlight.delete(details.tabId)
    })
  })

  browser.webNavigation.onDOMContentLoaded.addListener(async (details) => {
    // Non-main frames (dynamically added iframes, sub-frames): drive them
    // explicitly from the background rather than letting inject.js self-start.
    // Sub-frame auto-init is disabled (it would read the session key on its
    // own and could win a race against frame 0's reload check, translating an
    // iframe on a page that was just reloaded). Here we read the key *after*
    // onCommitted has already cleared it for reloads, so the decision is
    // correct: only inject + start this specific frame when the tab is
    // genuinely translating.
    if (details.frameId !== 0) {
      // Ordering barrier, see commitInFlight.
      await awaitMainFrameCommit(details.tabId)
      const lang = await getTabTranslatingLang(details.tabId)
      if (!lang) return
      // Transient sub-frames (ad/embed iframes, especially common on Reddit)
      // often vanish between onDOMContentLoaded and the time these async calls
      // run, so executeScript / sendMessage reject with "No frame with id N".
      // That's expected, not an error — swallow it instead of letting it
      // surface as an uncaught promise rejection.
      try {
        // Inject only into this specific frame; allFrames:true would re-inject
        // into every frame including the main one (harmless thanks to the
        // __imp_injected guard, but wasteful).
        await injectContentScript(details.tabId, details.frameId)
        const tab = await browser.tabs.get(details.tabId)
        const rules = await getMatchedRulesForHostname(hostnameFromUrl(tab.url))
        // Target this frame only — broadcasting would needlessly re-wake every
        // already-translating frame in the tab.
        await messager.sendMessage(
          'startTranslation',
          { targetLang: lang, rules },
          { tabId: details.tabId, frameId: details.frameId },
        )
      } catch {
        // Frame gone (or otherwise un-injectable) — nothing to translate.
      }
      return
    }

    if (isPdfUrl(details.url)) return
    const lang = await getTabTranslatingLang(details.tabId)
    if (!lang) return
    const t = debugTime(`onDOMContentLoaded(tabId=${details.tabId})`)

    try {
      const [result] = await browser.scripting.executeScript({
        target: { tabId: details.tabId },
        func: () =>
          (performance.getEntriesByType('navigation') as PerformanceNavigationTiming[])[0]
            ?.type,
      })
      if (result?.result === 'reload') {
        await setTabTranslatingLang(details.tabId, null)
        await browser.action.setIcon({ tabId: details.tabId, path: defaultIcon })
        t('reload detected, stopped')
        return
      }
    } catch {
      // scripting may fail on restricted pages; skip reload check
    }
    t('reload check done')

    await injectContentScript(details.tabId)
    t('injectContentScript done')
    const tab = await browser.tabs.get(details.tabId)
    const rules = await getMatchedRulesForHostname(hostnameFromUrl(tab.url))
    t('rules fetched')
    await messager.sendMessage(
      'startTranslation',
      { targetLang: lang, rules },
      { tabId: details.tabId },
    )
    t('startTranslation sent')
  })

  browser.tabs.onRemoved.addListener(async (tabId) => {
    await browser.storage.session.remove(`tab_translating_${tabId}`)
    await browser.storage.local.remove(`${TAB_WAKEUP_PREFIX}${tabId}`)
  })

  // The mail-display counterpart of the onCommitted/onDOMContentLoaded pair
  // above. A message tab displays a sequence of documents — one per message,
  // rewritten on every switch (spike probe 4) — and mail display is not a
  // navigation, so those listeners never fire for it. A switch is a
  // navigation, not a reload: translating stays on, and the fresh document's
  // auto-init reads the same session key and translates the new message.
  // Only the icon is touched here — per-tab icons reset with the document.
  void registerMailInjectScript()
  messageDisplay()?.onMessagesDisplayed.addListener(async (tab) => {
    const tabId = tab.id
    if (!tabId) return
    const lang = await getTabTranslatingLang(tabId)
    if (lang) await browser.action.setIcon({ tabId, path: activeIcon })
  })

  if (import.meta.env.DEV) {
    const activeTabId = async () =>
      (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id
    ;(globalThis as Record<string, unknown>).__imp = {
      start: async (lang?: string, tabId?: number) => {
        const id = tabId ?? (await activeTabId())
        if (!id) return null
        const settings = await getSettings()
        await startTranslationForTab(id, lang ?? settings.targetLang, false)
        return id
      },
      stop: async (tabId?: number) => {
        const id = tabId ?? (await activeTabId())
        if (!id) return null
        await stopTranslationForTab(id)
        return id
      },
      toggle: () => toggleTranslationForActiveTab(),
      // What clicking the toolbar icon does on mobile (see above).
      openPanel: () => openPanelForActiveTab(),
      state: async (tabId?: number) => {
        const id = tabId ?? (await activeTabId())
        if (!id) return null
        return { tabId: id, lang: await getTabTranslatingLang(id) }
      },
    }
  }
})
