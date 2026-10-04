# Translation cache

Where translations are cached, what the key contains, and what deliberately it
does not.

Maintainer-facing. For what the user sees, see the Features section of
[`README.md`](../README.md).

## The key

```
`${PROMPT_REVISION}:${targetLang}:${blockSource}`
```

Three parts.

- **`PROMPT_REVISION`** — a constant in `lib/cache.ts`, currently `1`. Retires
  every entry written under an earlier prompt. See
  [Prompt revision](#prompt-revision).
- **`targetLang`** — the only settings-derived input. Switching the target
  language is a cache miss, by design.
- **`blockSource`** — the block's text-node runs, joined and prefixed with run
  markers: `⟦1⟧Click ⟦2⟧here⟦3⟧ now`. See
  [translation-only-alignment.md](translation-only-alignment.md) for the marker
  syntax and why two of them exist.

Built by `buildBlockSource` in `lib/dom.ts`, which is the single source for the
three places that must agree: what `extractBlocks` stores as `block.text`, what
`data-imp-text` records as the staleness token, and what the provider is asked.

## Both display modes send the same payload

Every block is sent marked, whether it renders bilingual or translation-only.
This is the whole reason switching Display costs nothing: the two modes derive
the same key for the same DOM, so the second pass reads the cache instead of
buying the page again.

Before this, bilingual sent `getVisibleText(node).trim()` and translation-only
sent the marked form. Two different strings for one piece of page text, so
switching modes missed every entry. For a user on their own OpenAI key that
meant paying twice for the same content.

The markers never reach the page. Bilingual rejoins the response in run order
before writing the wrapper — see `replaceWithTranslation` in `lib/render.ts`.

## Normalization

The payload is trimmed at both ends before being marked: leading and trailing
whitespace-only runs are dropped, and the outermost runs are trimmed. Without
this, a block indented by a template literal would key differently from the same
block written inline, and the cache would miss for formatting reasons alone.

Interior whitespace is **not** touched. That whitespace is the separation
between runs, and translation-only writes runs back individually, so trimming it
would reflow the page.

## Deliberately not in the key

The provider, the glossary, the user's edited system prompt, and the OpenAI
request parameters are **not** part of the key. Changing any of them does not
invalidate anything: a page translated before the change keeps serving the
cached translation, for up to 30 days.

This is a choice, not an oversight. Switching provider or editing a glossary is
rare, while invalidating on a settings write would silently re-bill pages the
user has already translated and looked at. The cost is that a term the user
just corrected does not take effect on a page already in the cache. That trade
is only tolerable because there is an explicit way to re-translate a page — see
[below](#re-translating).

A change to the *shipped* prompt is the one exception, and it goes through
`PROMPT_REVISION` rather than through the settings path above.

## Prompt revision

A stored translation records what the provider said under a *particular* system
prompt. Once that prompt changes, the entry stops being representative: a block
translated before the batch-coherence instruction existed
(see [openai-settings.md](openai-settings.md)) was translated without its
neighbours, and serving it back would make the new instruction look like it
changes nothing.

Bumping `PROMPT_REVISION` retires every older entry in one step — no migration,
no delete — and the orphaned rows age out on the existing
[limits](#limits) schedule. The cost is one re-translation of pages the user has
already read, paid once, on the upgrade where a prompt actually changed.

That cost is **not** confined to the provider whose prompt changed. One cache
serves all four, so an OpenAI-only edit re-bills a Google, Microsoft or Imp
Credits user whose prompt is byte-for-byte unchanged. Scoping the revision per
provider would mean putting the provider in the key — the trade
[above](#deliberately-not-in-the-key) rejects, since switching provider would
then re-bill instead of reusing. One global revision is the cheaper mistake,
because it costs once and only on a release that actually changed a prompt.

It is deliberately **not** a hash of the rendered prompt. That would re-bill a
page every time the user touched a setting, which is the trade
[above](#deliberately-not-in-the-key) exists to avoid.

Bump it when a change to `prompt.md`, `renderSystemPrompt`, or the request shape
would change how a block ought to come back.

## Re-translating

"Show Original" / "Translate Page" on an already-translated page re-reads the
cache — it is the toggle, and it is meant to be cheap. Refreshing is a
separate, deliberate action:

- **Desktop** — "Re-translate" in the popup, shown only while the tab is
  translated.
- **Mobile** — the ↻ button in the toast bar, likewise only while translating.
- **Keyboard** — `Alt+R` by default, configurable in the options page; see
  [hotkey.md](hotkey.md). Unlike the two above it also acts on a page that is
  not translating, since on a cold page a forced pass is simply the first
  translation.

All three end in the content script handling `startTranslation { force: true }`:
the popup sends `startTab { force: true }` and the hotkey calls the background's
start directly, while the toast bar restarts its own run in place. The content
script restarts its run rather than ignoring the start (a start on a translating
page is otherwise a no-op) and walks again with `force` on each `translate`
request. The service skips its cache *read* and still performs the *write*, so
the forced response replaces the entry: the pass is a refresh, and every later
pass is a hit again rather than paying twice.

### What a forced pass covers

The blocks of the extraction the forced walk started on — which includes the
blocks the IntersectionObserver reveals later as the user scrolls, since those
come from that same extraction.

It deliberately does **not** cover anything that appears afterwards:

- A rescan re-extracts the whole body and cannot tell content that hydrated late
  from content that arrived because the user navigated, so its blocks are never
  forced.
- The recheck path (`retranslateElement`, for page text that changed under a
  translation) never forces either — that is repair, not a refresh.

Without this scoping a run-scoped flag would leak: the user re-translates a
feed, clicks into a post, and every cached string on the new route is billed
again. `e2e/force-retranslate.spec.ts` pins both halves — the forced pass
re-bills, and a block appended after it does not.

## Limits

- **30 days** per entry (`MAX_AGE`), swept by `evictOldEntries` on an alarm and
  after every flush.
- **10 000 entries** (`MAX_ENTRIES`), oldest evicted first. Both display modes
  draw on the same budget, so a user who alternates between them gets half the
  effective depth of one who uses a single mode.
- One IndexedDB database, `imp-translate`, store `translations`.

## Code map

| File | Symbol | Role |
| --- | --- | --- |
| `lib/dom.ts` | `buildBlockSource` | Runs → the canonical, mode-independent payload. |
| `lib/dom.ts` | `extractBlocks` | Seeds `block.text` with it. |
| `entrypoints/inject.ts` | `currentBlockSource` | Recomputes it for the staleness token. |
| `lib/align.ts` | `buildMarkedSource` | Runs → marked form, with the run-id syntax. |
| `lib/align.ts` | `stripMarkers` | Marked → the visible text, for reading and comparisons. |
| `lib/cache.ts` | `getCached` / `setCached` | The key, the age check, the write. |
| `lib/cache.ts` | `evictOldEntries` | Age and size limits. |
| `lib/translate-service.ts` | `translate` | Read-through, then the batch queue; `force` skips the read. |
| `entrypoints/inject.ts` | `forceBlocks` | The elements of a forced extraction that skip the read. |
| `entrypoints/inject.ts` | `translateBatch` | Attaches `force` per block, by set membership. |
| `entrypoints/background.ts` | `startTranslationForTab` | Carries `force` from the popup down to the content script. |

## Tests

`e2e/cache.spec.ts` is the behavioural contract: switching Display must add
zero entries to the provider log, switching the target language must add some,
and editing a glossary must add none. The Display assertions were checked
against a reintroduced bug — with mode-dependent payloads they fail with exactly
the reported symptom, a marked re-translation of the same text.

`e2e/force-retranslate.spec.ts` covers the other direction: a forced pass must
re-bill every block and land the fresh answer, must leave that answer in the
cache for the next normal pass, and must *not* reach a block that appears after
it. Checked the same way — with the read no longer skipped, all three fail.

`lib/cache.test.ts` pins the revision directly: an entry written in the
pre-revision `${lang}:${text}` shape is unreachable, so a shipped prompt change
cannot be masked by a stale hit.
