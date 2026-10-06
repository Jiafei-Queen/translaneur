import { defineExtensionMessaging } from '@webext-core/messaging'
import type { SiteRule } from './rules'

export interface TranslateRequest {
  text: string
  targetLang: string
  // Force re-translation: skip the cache read for this text. See
  // docs/cache.md — "Re-translate".
  force?: boolean
}

export interface TranslateBatchRequest {
  texts: string[]
  targetLang: string
}

// One protocol for both directions: extension page/content script → background
// with no target (runtime messaging), and background → content script with an
// explicit target. `@webext-core/messaging` picks the API from the send
// arguments, so the four entries at the bottom are addressed as
// `messager.sendMessage('stopTranslation', undefined, { tabId })` and are the
// only ones the content script (inject.ts) handles — everything above them is
// a background handler.
export const messager = defineExtensionMessaging<{
  translate(req: TranslateRequest): string
  translateBatch(req: TranslateBatchRequest): string[]
  // connect content script (imp-connect.content.ts) => background: exchanges
  // the one-time code read off the success page's <meta> tag for a persistent
  // Imp Credits api key (see imp-credits docs/extension-integration.md).
  impConnect(code: string): Promise<{ ok: boolean; error?: string }>
  // options page (on mount, when an Imp connection is stored) => background:
  // zero-cost check that the given Imp api key is still valid (401 == revoked)
  // so the "Connected" badge reflects reality rather than just local state.
  // The caller passes the key explicitly: the options page updates its state
  // before the storage write lands, so reading storage here would race.
  checkConnection(data: {
    baseUrl: string
    apiKey: string
  }): Promise<{ ok: true } | { ok: false; error: string }>
  getMatchedRulesForHostname(data: { hostname: string }): SiteRule[]
  // `force` re-translates a page that is already translated: the content
  // script stops itself and walks again with the cache read skipped. Without
  // it a start on a translating tab is a no-op (see the content script's
  // isTranslating guard).
  startTab(data: { tabId: number; targetLang: string; force?: boolean }): void
  stopTab(data: { tabId: number }): void
  getTabState(data: { tabId: number }): string | null
  getSelfTabState(): string | null
  stopSelfTab(): void
  startSelfTab(data: { targetLang: string }): void
  isMobile(): boolean
  openOptionsPage(): void
  detectLanguageBatch(data: { texts: string[] }): string[]
  refreshRemoteRules(): void
  // Temporary Thunderbird diagnostic: the content script reports what the
  // extractor saw on a message, the background logs it. See lib/diag.ts.
  diag(data: string): void

  // options page => background: apply the recorded shortcut for one command.
  // `applied` is false on Chrome, whose commands API has no update() — the
  // real binding lives in browser prefs and can only be changed by the user at
  // chrome://extensions/shortcuts.
  setHotkey(data: { command: string; hotkey: string }): { applied: boolean }
  // options page (on mount, and on every return to the tab) => background:
  // where the browser allows reading it, the binding that command actually
  // has. `command` rather than one fixed name because the page records two
  // shortcuts, each with its own binding to read back.
  getHotkeyState(data: { command: string }): {
    active: string
    canApply: boolean
  }

  // Background → content script (entrypoints/inject.ts). Omitting frameId
  // broadcasts to every frame in the tab; passing it drives a single frame
  // (dynamically added iframes) without re-waking the already-translating
  // ones. The content script receives the full host-matched rule set
  // (including each rule's pathPattern) — path filtering happens client-side
  // at walk time, so SPA navigation needs no extra round-trip.
  startTranslation(data: {
    targetLang: string
    showToast?: boolean
    rules: SiteRule[]
    force?: boolean
  }): void
  stopTranslation(): void
  getState(): boolean
}>()
