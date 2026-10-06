# Port plan

Module-by-module: what reuses unchanged, what gets an adapter, what gets
rewritten, and the open question that gates the last third. Read
[api-compat.md](api-compat.md) for the API basis and [spike.md](spike.md) for
the experiment that resolves the open question.

## Tier 1 — reuse unchanged (roughly 85%)

No Thunderbird-specific knowledge; Thunderbird renders these with the same
Gecko engine, on the same standard Web APIs.

| Module | Why it carries over |
| --- | --- |
| `lib/dom.ts` — block extraction, shadow-DOM walk, `PROCESSED_ATTR` guards | Pure DOM + observers |
| `lib/render.ts`, `lib/addStyle.ts` — bilingual insertion, translation-only write-back | Style injection is identical Gecko behaviour (CSP caveat in tier 3) |
| `lib/align.ts`, `lib/term-sentinel.ts`, `lib/glossary.ts` | String-processing only |
| `lib/translator.ts` — Google, Microsoft/Bing, OpenAI-compatible, Imp Credits providers | Background `fetch` under host permissions |
| `lib/translate-service.ts`, `lib/rate-limiter.ts` — batching, scoping | Runs in the background; `sender.tab.id`/`frameId` work as-is |
| `lib/cache.ts` (`idb`), `lib/eld-detect.ts`, `lib/rules.ts`, `lib/remote-rules.ts`, `lib/languages.ts`, `lib/prompt.ts`, `lib/hotkey.ts` | Storage, plain fetch, and parsing |
| `entrypoints/popup/`, `entrypoints/options/` — React UIs | Extension pages; `browser.tabs.query` and messaging behave the same |
| `entrypoints/inject.ts` — orchestration: observers, rescan, SPA URL watcher | Runs identically once injected; the SPA/BFCache logic is inert on mail but harmless |

## Tier 2 — thin adapter (targeted edits)

**Manifest / build** — implemented in `wxt.config.ts` as a first-class
`-b thunderbird` target (`build:thunderbird` / `zip:thunderbird` scripts):
gecko id, `strict_min_version: '140.0'`, `messagesRead` permission,
`action.allowed_spaces: ['mail']` + `action.default_windows:
['normal', 'messageDisplay']`. Two WXT quirks make the firefox hook
insufficient on its own:

- `-b firefox` alone cannot work: the Thunderbird deltas (`messagesRead`,
  `allowed_spaces`, `strict_min_version`) would then leak into every Firefox
  build, or need a separate env-var discriminator on top of the same target
- WXT only emits the Gecko MV3 event-page form (`background.scripts`) for
  the literal `firefox` name — for any other target it emits
  `background.service_worker`, so a `build:manifestGenerated` hook rewrites
  it to the scripts form (runs before `stripKeys`, so it sticks)

WXT's virtual `browser` global resolves to `globalThis.browser` whenever it
exists (Gecko), so no polyfill concern for the thunderbird target.

**`entrypoints/background.ts` — the trigger skeleton** (~200–300 lines of the
file). Two lifelines assume pages arrive by web navigation:

- `webNavigation.onCommitted` / `onDOMContentLoaded` continue translation
  across navigations and detect reloads via `transitionType`
- `action.onClicked` targets the active content tab

In Thunderbird, mail display is not a navigation. Replace with (names and
permissions verified by the spike, see [spike.md](spike.md) Results):

- `scripting.messageDisplay.registerScripts()` to auto-inject `inject.js`
  into displayed messages (needs `messagesRead` + `scripting`; the spike
  confirmed `messagesModify` is **not** required — it can be avoided at ATN
  review). Registered scripts only apply to newly displayed messages; for
  ones already open at startup, inject with `scripting.executeScript`
- `messageDisplay.onMessagesDisplayed` (MV3 renamed from
  `onMessageDisplayed`; second argument is a `MessageList`, not a single
  `MessageHeader`) where `onDOMContentLoaded` drove state restoration and
  auto-translate
- Tab triage by `tab.type` (`messageDisplay` | `content` | `mail`): the
  3-pane preview pane is a `mail` tab and **is** scriptable — but only via
  registered scripts; `scripting.executeScript` into a `mail` tab (or a
  just-created `messageDisplay` tab) hangs instead of failing. Deliver
  `inject.js` exclusively through `registerScripts`; never fall back to
  `executeScript` for mail surfaces

The existing race scaffolding is the pattern to keep, not the code to keep:
translate-key-in-`storage.session` before content-script state flips; an
in-flight barrier keyed by tab for sub-frame ordering; reload clears state.
Their mail-display equivalents need the same ordering guarantees around
`onMessagesDisplayed`, which can fire per displayed message in one long-lived
tab.

Delivery note from the spike: `registerScripts` and `executeScript` run in
**different JS worlds** — `window` state is not shared between them. The port
ended up with a mixed delivery (registered script plus an `executeScript`
fallback for messages displayed before registration), so `inject.js` marks
its document with a DOM attribute (`data-imp-script`) to dedupe across
worlds — the DOM is the only state they share.

Double-duty adjustment: the spike showed `executeScript` hangs on `mail`
tabs and just-created `messageDisplay` tabs, so `injectContentScript`'s
on-demand path is *fired without awaiting* for mail surfaces (a hung promise
must not block the command wake-ups) and awaited exactly as in the browser
for content tabs. The `reload` check
(`performance.getEntriesByType('navigation')`) does not apply to messages; a
message switch is a navigation and keeps translating.

**State keying** — `tab_translating_${tabId}` keys translating state by tab,
but a message-display tab shows a *sequence* of messages. Key per
`(tabId, messageId)` — `messageDisplay.getDisplayedMessages(tabId)` (MV3;
returns a `MessageList`) supplies the id — or accept tab-level state that
survives each `onMessagesDisplayed`. Decide during implementation;
`storage.session` supports either. (Decided — see "What Step 3 actually
implemented" below: tab-level state, and a switch keeps translating rather
than resetting it.)

## What Step 3 actually implemented

In `entrypoints/background.ts` (2026-10-06) — the webNavigation pair is
**kept, not replaced**: mail display is not a navigation so it never fires
for messages, Thunderbird content tabs (a web page opened inside Thunderbird)
keep the browser behaviour for free, and the file stays build-independent —
the mail pipeline activates on runtime namespace presence, not a `-b
thunderbird` branch.

- Runtime detection: `browser.scripting.messageDisplay.registerScripts` and
  `browser.messageDisplay.onMessagesDisplayed` are probed feature-detect
  style; both are absent from the shared `@wxt-dev/browser` types, so
  `background.ts` carries narrow local interfaces (the same tactic as the
  manifest casts in `wxt.config.ts`)
- Registration: `registerMailInjectScript()` registers the unlisted
  `/inject.js` (`id: imp-mail-inject`, `runAt: document_idle`) — idempotent,
  duplicates reject with "already registered" and serve as the no-op
- Tab triage: `startTranslationForTab` fetches the tab first and awaits
  `executeScript` for content tabs only. For `tab.type` `mail` /
  `messageDisplay` it *fires* executeScript without awaiting (the promise may
  never settle, spike probe 3) as a fallback for messages displayed before
  the registration landed, and delivers the command over two channels stamped
  with one revision (see below); the browser path keeps the direct
  `startTranslation` message
- Command delivery: `tabs.sendMessage` to a displayed message is unverified
  (the spike only ever messaged *from* display documents), so start/stop also
  ride `tab_wakeup_${tabId}` in `storage.local` (`storage.session` is not
  exposed to content scripts; the wake-up is a command, not state — the truth
  stays the session key). `inject.js` listens for its own wake-up and applies
  each command revision once, so the message + wake-up double delivery costs
  one walk
- State keying decision: **tab-level key retained** — the key drives the
  popup and the action icon, and both would need re-keying for
  `(tabId, messageId)`. The display document is rewritten per message (probe
  4), so the key outlives any one document and stays correct across switches
- Switch-as-navigation (revised after TB-3): a message switch keeps
  translating — the `onMessagesDisplayed` handler clears nothing (it only
  re-applies the icon) and the fresh document's auto-init picks the same
  session key up and translates the new message. This replaces the first
  implementation's switch-as-reload clear, which turned translation off on
  every switch and raced the new document's auto-init (see
  [bugs.md](bugs.md) TB-3)
- Messages already open at background startup get `inject.js` from the
  executeScript fallback fired on the first start command; if that lands
  nothing (the hang quirk), the next message switch re-injects via the
  registration

## Tier 3 — resolved by the spike

The three unknowns are answered (see [spike.md](spike.md) Results):

- **DOM shape**: the rendered message HTML is inline in `document.body` on
  every surface — no iframes. `extractBlocks` works as-is, but the body also
  contains Thunderbird's own header chrome (`table.moz-header-part1/2`), so
  the walker must start at the message content container (or skip those
  header tables), not raw `body.children`. Plain-text mail renders as
  `div.moz-text-plain`, not `<pre>`.
- **Styles**: injected `<style>` + styled nodes render with remote content
  both allowed and blocked. `lib/render.ts` / `lib/addStyle.ts` unchanged.
- **Preview pane**: scriptable via `registerScripts` — no narrowing; the
  everyday surface is fully covered.

Remaining spike-informed adjustments now fold into tiers 1–2: header chrome
(`table.moz-main-header`) is skipped in the inject entry's `skipSelectors`
(matched like site chrome, one lookup per document), delivery is the single
`registerScripts` path, and the MV3 API names are noted above.

## Deliberately out of scope

- Compose-window translation (`composeScripts` exists, but translating
  outgoing mail is a different product and `README.md`'s scope excludes it)
- Attachments and `messageDisplay.getDisplayedMessages` body/HTML APIs as a
  translation source — the rendered DOM is the source, as in the browser
- Mobile-targeted code paths (`isMobile` etc.) — left in place, where they
  evaluate to false

## Suggested sequence

1. Spike ([spike.md](spike.md)) — go/no-go, half a day
2. Manifest + build target, extension installs and popup/options open in TB
3. Background trigger skeleton: messageDisplay injection via
   `scripting.messageDisplay.registerScripts()` + `onMessagesDisplayed`
   state machine; toggle via action button and `commands` all work
4. Rendering validation on real mail: HTML newsletter, plain-text mail,
   sanitized remote content, long threads
5. Providers E2E in TB (Imp, Google, Bing, an OpenAI key)
6. ATN packaging: `VENDOR.md` + source submission, messaging copy review
   (`messagesRead` is a sensitive permission, though less so than the
   `messagesModify` the spike proved unnecessary)
