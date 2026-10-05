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

**Manifest / build** — `wxt.config.ts` gains a Thunderbird branch (same
`env.browser === 'firefox'` hook, or a small custom target): gecko id,
`messagesModify` permission, `allowed_spaces`. A `wxt build -b firefox` bundle
likely installs as-is; the deltas are manifest keys, not code.

**`entrypoints/background.ts` — the trigger skeleton** (~200–300 lines of the
file). Two lifelines assume pages arrive by web navigation:

- `webNavigation.onCommitted` / `onDOMContentLoaded` continue translation
  across navigations and detect reloads via `transitionType`
- `action.onClicked` targets the active content tab

In Thunderbird, mail display is not a navigation. Replace with:

- `messageDisplayScripts.register()` to auto-inject `inject.js` into newly
  opened messages (needs `messagesModify`)
- `messageDisplay.onMessageDisplayed` where `onDOMContentLoaded` drove
  state restoration and auto-translate
- Tab triage by `tab.type` (`messageDisplay` | `content`): skip `mail` tabs —
  the 3-pane interface itself cannot host scripts; query with `tabs` permission
  to read `url`/`title` as today

The existing race scaffolding is the pattern to keep, not the code to keep:
translate-key-in-`storage.session` before content-script state flips; an
in-flight barrier keyed by tab for sub-frame ordering; reload clears state.
Their mail-display equivalents need the same ordering guarantees around
`onMessageDisplayed`, which can fire per displayed message in one long-lived
tab.

Double-duty adjustment: `injectContentScript` targets message display tabs via
`scripting.executeScript` exactly as for content tabs — the target shape does
not change, only when it is called. The `reload` check
(`performance.getEntriesByType('navigation')`) does not apply to messages;
switching message resets state instead.

**State keying** — `tab_translating_${tabId}` keys translating state by tab,
but a message-display tab shows a *sequence* of messages. Key per
`(tabId, messageId)` — `messageDisplay.getDisplayedMessage(tabId)` supplies the
id — or accept tab-level state and reset on every `onMessageDisplayed`. Decide
during implementation; `storage.session` supports either.

## Tier 3 — blocked on the spike

**Message display DOM shape, CSP, and the 3-pane preview.** Whether
`extractBlocks(document.body)` can walk mail as it walks a page; whether
`lib/addStyle.ts`'s `<style>` insertion and renderer blocks survive
Thunderbird's remote-content sanitization; and above all whether the 3-pane
preview pane is scriptable — the most common reading surface. All are answered
by [spike.md](spike.md); none have a documented yes/no.

If the spike fails on the preview pane, the port still ships — a user reading
mail in a message tab or stand-alone window gets full translation — but the
everyday surface is restricted, which should be weighed before investing in
tier 3 elsewhere.

## Deliberately out of scope

- Compose-window translation (`composeScripts` exists, but translating
  outgoing mail is a different product and `README.md`'s scope excludes it)
- Attachments and `messageDisplay.getDisplayedMessage` body/HTML APIs as a
  translation source — the rendered DOM is the source, as in the browser
- Mobile-targeted code paths (`isMobile` etc.) — left in place, where they
  evaluate to false

## Suggested sequence

1. Spike ([spike.md](spike.md)) — go/no-go, half a day
2. Manifest + build target, extension installs and popup/options open in TB
3. Background trigger skeleton: messageDisplay injection + `onMessageDisplayed`
   state machine; toggle via action button and `commands` all work
4. Rendering validation on real mail: HTML newsletter, plain-text mail,
   sanitized remote content, long threads
5. Providers E2E in TB (Imp, Google, Bing, an OpenAI key)
6. ATN packaging: `VENDOR.md` + source submission, messaging copy review
   (`messagesModify` is a high-sensitivity permission)
