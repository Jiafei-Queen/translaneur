# Thunderbird port

Evaluation and plan for porting Translaneur to Thunderbird as a mail
extension — translating displayed email messages bilingually, the way the
browser extension translates web pages.

Maintainer-facing. Branch: `thunderbird-port`.

## Verdict

Feasible. About 85% of the codebase carries over unchanged; the work is an
adaptation layer for injection triggers (Thunderbird's message display instead
of web navigation) plus one unknown that must be verified before committing:
whether the 3-pane preview pane can be scripted at all — see
[spike.md](spike.md).

Overall: a medium-size port, roughly 1–2 weeks including testing, not a
rewrite. Everything invested in the translation engine (bilingual rendering,
alignment, glossary, term sentinel) keeps its value.

## Documents

| File | Contents |
| --- | --- |
| [api-compat.md](api-compat.md) | Every WebExtension API this extension uses, checked against the Thunderbird MV3 docs (as of TB 157 / ESR 140+) |
| [port.md](port.md) | Module-by-module port plan: what reuses as-is, what gets an adapter, what gets rewritten |
| [spike.md](spike.md) | The go/no-go experiment: a minimal probe extension and the four unknowns it must answer |

## Why the port is cheap

The architecture separates cleanly:

- The **translation engine** (`lib/dom.ts`, `lib/render.ts`, `lib/align.ts`,
  `lib/term-sentinel.ts`, `lib/glossary.ts`) is pure standard Web API —
  `MutationObserver`, `IntersectionObserver`, shadow-DOM traversal. Thunderbird
  renders both content tabs and message display pages with Gecko, so DOM
  behaviour is identical to the browser build.
- The **background services** (`lib/translator.ts`, `lib/translate-service.ts`,
  `lib/cache.ts`, `lib/remote-rules.ts`) run plain `fetch` from the background;
  cross-origin is covered by host permissions there.
- The **UI pages** (popup, options) are extension pages, which Thunderbird
  supports as-is.
- The **background itself** is an event page with a DOM in Thunderbird, not a
  service worker — the in-memory Bing session and the `idb` cache actually get
  *more* reliable.

The only structural mismatch is at the edges of the background: which event
starts a translation, and which documents it may inject into. That is
[port.md](port.md)'s subject.
