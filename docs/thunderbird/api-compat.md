# API compatibility

Every WebExtension API this extension touches, checked against the
[Thunderbird MV3 API documentation](https://webextension-api.thunderbird.net/en/mv3/)
(as of TB 157 stable / ESR 140+, October 2026). Thunderbird runs Gecko, so
wherever the API exists, it behaves like Firefox's — which this extension
already targets (`pnpm build:firefox`).

APIs are reached through `browser.*` (as on Firefox) or Thunderbird's
preferable `messenger.*` alias; the WXT-generated code uses `browser.*`, which
works in both.

## Supported, no change needed

| API | In TB | Where this extension uses it |
| --- | --- | --- |
| `storage.local` | 45 | settings (`lib/storage.ts`), remote rules (`lib/remote-rules.ts`) |
| `storage.session` | 115 | per-tab translating-language key (`getTabTranslatingLang` in `entrypoints/background.ts`) |
| `storage.onChanged` | 45 | popup refetch (`entrypoints/popup/main.tsx`) |
| `alarms.create / onAlarm` | 45 | remote-rules daily fetch, cache eviction |
| `action.setIcon` (per-tab), `onClicked`, `setPopup` | 105 | translating-state icon, toggle handler. `theme_icons` (also 105+) gives the theme-aware icon Chrome lacks |
| `commands.getAll / update / onCommand` | 66 | hotkeys. `commands.update()` — which the code feature-detects and falls back without on Chrome — **is** supported in Thunderbird, so `applyHotkey` runs its real path and the options page's "can't apply on Chrome" copy is unnecessarily pessimistic there |
| `scripting.executeScript` — `files`, `func` + `args`, `target.frameIds` / `allFrames`, `injectImmediately` | 102 | `injectContentScript` and the inline reload check in `background.ts`; `world: 'MAIN'` since 128 if ever needed |
| `scripting.messageDisplay.registerScripts` | 128 | auto-inject `inject.js` into displayed messages — spike-verified working on all three reading surfaces incl. the 3-pane preview pane (`mail` tab); requires `messagesRead` + `scripting` |
| `messageDisplay.onMessagesDisplayed` | 81 (MV3 name) | per-message hook (keeps translation running across switches, re-applies the icon); second arg is a `MessageList`; requires `messagesRead`. Spike-verified with a stable `tabId` across switches |
| `runtime.onInstalled / onStartup / openOptionsPage / getPlatformInfo / getManifest` | 45–52 | lifecycle hooks, options link |
| `tabs.query / get / remove / onRemoved` | 62 | active-tab lookup (`sender.tab?.id` fallback), session-key cleanup |
| `runtime.sendMessage → tabs.sendMessage(tabId, msg, { frameId })`, `sender.tab` / `sender.frameId` | 82 | the whole `@webext-core/messaging` RPC layer, including frame-targeted `startTranslation`. Caveat (TB-3): content → background (`runtime.sendMessage`, `sender.tab`) is spike-verified; **background → displayed-message** (`tabs.sendMessage`) is not — mail commands are duplicated over `storage.local` wake-ups so a missing delivery is harmless |
| `webNavigation.onCommitted / onDOMContentLoaded / onErrorOccurred` with `transitionType` | 45 | translation continuation across navigation, reload detection — **browser builds only**: the Thunderbird manifest drops `webNavigation` (mail display is not a navigation), and `background.ts` feature-detects the namespace before listening |
| `host_permissions` (`<all_urls>`) | yes | background `fetch` to translation providers |

## Different shape, adaptation needed

| Concern | Browser assumption | Thunderbird reality |
| --- | --- | --- |
| What a "page" is | any URL, navigation events fire | Translation targets **message display pages** (message tabs in the main window, or a stand-alone message window). Mail display is not a navigation; `webNavigation` never fires for it. Triggers must move to `messageDisplay.onMessagesDisplayed` (MV3 name) / `scripting.messageDisplay.registerScripts()` |
| Injection permission | `host_permissions` alone | Needs the `messagesRead` permission (listed in `permissions`, not host permissions) plus `scripting` for registered scripts — spike-verified on TB 156/157; `messagesModify` is **not** required |
| Background lifecycle | Chrome MV3 service worker: no DOM, killed when idle | **Event page**: has a DOM (`runtime.getBackgroundPage()`), stays alive with Thunderbird. In-memory state (`bingSession`, `services` map, `commitInFlight`) survives; `idb` cache just works |
| Toolbar surface | browser toolbar | Unified toolbar (`allowed_spaces` in the manifest's `action` block); also a `message_display_action` for stand-alone message windows |

## Manifest deltas

MV3 is supported since TB 128; target `strict_min_version: 140.0` (ESR) or
higher. Relative to `wxt.config.ts`:

- `browser_specific_settings.gecko.id` — the Firefox build already generates
  `translaneur@jiafei.dev`; reuse it, plus `strict_min_version: '140.0'`
- add `messagesRead` to `permissions` (spike-verified: `messagesRead` +
  `scripting` is what `scripting.messageDisplay.*` requires;
  `messagesModify` is not needed) and drop `webNavigation` — mail display is
  not a navigation, so the namespace goes unused
- `action` gains `allowed_spaces: ['mail']` / `default_windows:
  ['normal', 'messageDisplay']` so the button appears in the unified
  toolbar's mail space and in stand-alone message windows — one button, one
  `action.*` code path, no separate `message_display_action` key
- build target is `-b thunderbird` (custom name): WXT emits the MV3 event
  page (`background.scripts`) only for the literal `firefox` name, so a
  `build:manifestGenerated` hook rewrites `service_worker` → `scripts` for
  thunderbird
- `web_accessible_resources` is dropped entirely — `inject.js` reaches
  message documents through `scripting.messageDisplay` registration, which
  needs no WAT; the browser form stays for content tabs
- `commands` carries over unchanged, including `suggested_key`

## Not available (and what loses coverage because of it)

| API | Effect |
| --- | --- |
| `tabs` has no `executeScript` (removed like Firefox's) | Irrelevant — the code already uses `scripting.executeScript` |
| Mobile-only paths (`isMobile`, `setPopup({ popup: '' })`) | Harmlessly dead: TB reports `os: 'mac'/'win'/'linux'`, so both degrade to false |
| `i18n`, `menus`, `notifications` | Not used by this extension |
