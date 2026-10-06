# Sequenced task plan

Work ordered by risk, with a gate after each step. The only large unknown
(message display scriptability) is cheapest to resolve first; every later step
assumes the gates before it passed. See [port.md](port.md) for the module
detail behind steps 2–4 and [spike.md](spike.md) for the probe that step 1
runs.

```
Spike ──go──▶ Build target ──▶ Background skeleton ──▶ Render validation ──▶ Provider E2E ──▶ Distribution
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
| 6 | Distribution (file distribution) | ≤ 1 day | unsigned XPI installs from file in release Thunderbird |

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
  `tab_translating_${tabId}` is retained — the key drives the popup and the
  action icon, and the display document is rewritten per message anyway. A
  switch is a navigation: translating stays on and each new document's
  auto-init picks the key up (see [bugs.md](bugs.md) TB-3 for the first
  implementation's switch-as-reload regression)
- preserve the existing race-pattern *semantics*, not its code: write the
  session key before content-script state flips, an in-flight barrier keyed by
  tab, state cleared only where the web build clears it (tab close, web
  reload — mail display never fires `transitionType`)

Gate: the toolbar button / `Alt+T` translates and restores an opened mail. At
this point the port's spine is through.

**Gate passed** (TB 157): toolbar button and `Alt+T` translate and restore on
message tabs, stand-alone windows, and the 3-pane preview pane; switching
messages resets state as designed (the `onMessagesDisplayed` handler).

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

**Gate passed** (TB 157): every real-mail form above verified live by hand —
plain-text (TB-1) and bare-`pre` HTML (TB-2) both fixed in `bugs.md`, and the
user confirmed all mail renders correctly across surfaces and both render
modes; the written checklist was skipped in favour of that live verification.

## Step 5 — Provider end-to-end (overlaps step 4)

Real translation requests run from Thunderbird's background: Imp, Google,
Bing, and an OpenAI key each verified, including cache hits and forced
re-translate.

**Gate passed**: all four providers verified live from the Thunderbird
background, cache hits and forced re-translate included.

## Step 6 — Distribution (file distribution; ATN listing deferred)

Thunderbird enforces no add-on signatures — every TB build ships
`xpinstall.signatures.required=false` (Bug 1727113), and the developer docs
state "Thunderbird does not sign add-ons". File distribution therefore needs
no ATN submission: the unsigned XPI installs permanently via Add-ons and
Themes → gear → "Install Add-on From File"; updates are manual.

- package the Thunderbird build as an `.xpi` (`pnpm xpi:thunderbird`) and ship
  it with the release
- distribution note: install steps and an unsigned-build trust statement
- gate: installs from file on a clean profile, survives restart, no signature
  warning (TB 152+ suppresses the unsigned warning in official builds)

An ATN listing is a later task, not this step — when it happens, revisit
`VENDOR.md` + source-archive submission, the `messagesRead` usage
description, the minimal-permission review, and listing metadata. Note for
that day: the shared gecko id `translaneur@jiafei.dev` means a Firefox build
listed on AMO would be offered to Thunderbird installs as an update unless a
TB-specific `update_url` isolates them (updates stay manual until then).

## What starts first

| Priority | Task | Why first |
| --- | --- | --- |
| 1 | Spike probe extension | half a day removes the project's largest unknown; failure is cheap |
| 2 | Build/manifest target | everything from step 3 on needs a bundle that installs in Thunderbird |

Step 3 is where the real port starts, and only after steps 1–2 are green.
