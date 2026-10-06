# Sequenced task plan

Work ordered by risk, with a gate after each step. The only large unknown
(message display scriptability) is cheapest to resolve first; every later step
assumes the gates before it passed. See [port.md](port.md) for the module
detail behind steps 2–4 and [spike.md](spike.md) for the probe that step 1
runs.

```
Spike ──go──▶ Build target ──▶ Background skeleton ──▶ Render validation ──▶ Provider E2E ──▶ ATN
 go/no-go      installs        translates a mail       renders correctly    really works      shippable
```

Dependency rule: riskiest first. The paradox that only step 1 can resolve is
whether message display pages can be injected into at all — half a day up
front versus every later step built on a wrong assumption.

| Step | Task | Effort | Gate |
| --- | --- | --- | --- |
| 1 | Spike probe extension | half a day | go/no-go recorded in spike.md |
| 2 | Build target + manifest | ≤ 1 day | installs; popup/options open |
| 3 | Background trigger skeleton | 2–4 days | an HTML mail shows bilingually |
| 4 | Render validation | 3–5 days | browser-equivalent behaviour on real mail |
| 5 | Provider E2E (overlaps 4) | 1–2 days | all four providers + cache paths |
| 6 | ATN packaging & review | 1–2 days | submitted with vendor sources |

## Step 1 — Spike: the go/no-go experiment

The minimal extension in [spike.md](spike.md) (manifest + probe script, ~30
lines), loaded as a temporary add-on, answers four questions with no
documented answer:

1. **Message DOM shape** — is the rendered mail HTML inline in
   `document.body` (→ `extractBlocks` works unchanged) or confined to an
   iframe (→ an adapter in the injector)?
2. **Style survival** — does an injected `<style>` and styled element render?
   If CSP strips it, `render.ts` must inline per-element styles (a contained
   change); a yes keeps it unchanged.
3. **Scriptable surfaces** — message tab in the 3-pane window, stand-alone
   message window, and the 3-pane preview pane keyed by `tab.type`.
4. **Interaction with mail re-renders** — whether appended blocks survive
   message switching, and where script teardown/reset happens.

Gate: body inline + styles survive in a message tab → **go**. Preview pane
uninjectable → still go, but scope narrows to message tabs and stand-alone
windows — weigh that narrowing before the render investment. Only a total
failure (no injectable reading surface at all) stops the port.

Output: results recorded at the bottom of [spike.md](spike.md).

## Step 2 — Build target and manifest

Assumes step 1's gate. No logic changes — the build lands in Thunderbird:

- a Thunderbird branch in `wxt.config.ts`'s manifest callback, keyed on a
  dedicated `-b thunderbird` target: gecko id, `strict_min_version`,
  `messagesRead` permission, `allowed_spaces` (plus a
  `build:manifestGenerated` hook, since WXT emits `background.scripts` only
  for the literal `firefox` name)
- a `wxt build` bundle that installs as a temporary add-on, with popup and
  options pages opening normally

Gate: installable, both UI pages render. Everything after this verifies its
builds under both browser and Thunderbird targets.

**Gate passed** (TB 157, temporary add-on). Better than the gate asked: mail
translation, hotkeys, and bilingual/translation-only modes already work on
most messages via the accidental `executeScript` path (popup → active tab).
Silent-failure mails were observed and first attributed to the spike's
predicted surface blind spots (preview pane / just-opened tab); follow-up
testing pinned them to content type instead — text/plain mail, surface
independent. Diagnosed as TB-1 in `bugs.md` (the message body hides inside
a `<pre>` the extractor skips), a Step 4 fix.

## Step 3 — Background trigger skeleton

The port's core change: replace the code in `entrypoints/background.ts` that
assumes pages arrive by web navigation (~200–300 lines).

- `webNavigation.onCommitted/onDOMContentLoaded` →
  `messageDisplay.onMessagesDisplayed` + `scripting.messageDisplay.registerScripts()`
  (MV3 names, spike-verified; deliver `inject.js` via registered scripts only —
  `executeScript` hangs on `mail` and just-created `messageDisplay` tabs)
- triage injected targets by `tab.type` (`messageDisplay` | `content` | `mail`);
  the 3-pane preview pane is a `mail` tab and is covered by registered scripts
- state-key decision (made, see [port.md](port.md)): tab-level
  `tab_translating_${tabId}` is retained, reset on every
  `onMessagesDisplayed` — the key drives the popup and the action icon, and
  the display document is rewritten per message anyway; a switch is treated
  as the navigation that mail never fires
- preserve the existing race-pattern *semantics*, not its code: write the
  session key before content-script state flips, an in-flight barrier keyed by
  tab, state cleared on message switch (replacing the `transitionType` reload
  check, which never fires for mail)

Gate: the toolbar button / `Alt+T` translates and restores an opened mail. At
this point the port's spine is through.

## Step 4 — Render validation

Concentrated debugging on the surfaces step 1's spot-checks could not fully
cover, over real mail forms:

- HTML newsletters, with remote content both blocked and allowed
- plain-text mail — diagnosed as TB-1 (`bugs.md`): the body hides inside a
  `<pre class="moz-quote-pre">` that the walker skips. Fix the adapter or
  pull it forward; "appended translation vs. unsupported" is then a small
  product decision, not an unknown
- the 3-pane preview pane, if step 1 allowed it
- long threads, attachment structures, and both render modes

Output: a behaviour checklist matching the browser build, with found issues
triaged (fix `inject.js` / fix `render.ts` / accept).

## Step 5 — Provider end-to-end (overlaps step 4)

Real translation requests run from Thunderbird's background: Imp, Google,
Bing, and an OpenAI key each verified, including cache hits and forced
re-translate.

## Step 6 — ATN packaging and review

- `VENDOR.md` + source submission — every dependency (the eld dictionary,
  `idb`, react, tailwind, …) goes through the vendoring flow
- messages-copy review: browser-qualified strings such as the options page's
  "Chrome can't apply shortcuts" need Thunderbird's actual behaviour
  (`commands.update()` works there)
- pre-review self-check of the `messagesRead` usage description — it is a
  sensitive permission ATN reviews, though the spike proved the port can
  avoid the higher-sensitivity `messagesModify`

## What starts first

| Priority | Task | Why first |
| --- | --- | --- |
| 1 | Spike probe extension | half a day removes the project's largest unknown; failure is cheap |
| 2 | Build/manifest target | everything from step 3 on needs a bundle that installs in Thunderbird |

Step 3 is where the real port starts, and only after steps 1–2 are green.
