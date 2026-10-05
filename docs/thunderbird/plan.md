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

- a Thunderbird branch in `wxt.config.ts`'s manifest callback (the existing
  `env.browser === 'firefox'` hook suffices): gecko id, `strict_min_version`,
  `messagesModify` permission, `allowed_spaces`
- a `wxt build` bundle that installs as a temporary add-on, with popup and
  options pages opening normally

Gate: installable, both UI pages render. Everything after this verifies its
builds under both browser and Thunderbird targets.

## Step 3 — Background trigger skeleton

The port's core change: replace the code in `entrypoints/background.ts` that
assumes pages arrive by web navigation (~200–300 lines).

- `webNavigation.onCommitted/onDOMContentLoaded` →
  `messageDisplay.onMessageDisplayed` + `messageDisplayScripts.register()`
- triage injected targets by `tab.type` (`messageDisplay` | `content`), never
  `mail` tabs
- state-key decision: per `tabId` or per `(tabId, messageId)` — a message tab
  displays a *sequence* of messages, so the current
  `tab_translating_${tabId}` key may over-persist; decide during
  implementation (`storage.session` supports either)
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
- plain-text mail (`<pre>`): appended translation vs. unsupported — a product
  decision to make explicitly
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
- pre-review self-check of the `messagesModify` usage description — it is a
  high-sensitivity permission ATN reviews closely

## What starts first

| Priority | Task | Why first |
| --- | --- | --- |
| 1 | Spike probe extension | half a day removes the project's largest unknown; failure is cheap |
| 2 | Build/manifest target | everything from step 3 on needs a bundle that installs in Thunderbird |

Step 3 is where the real port starts, and only after steps 1–2 are green.
