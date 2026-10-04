# Translation-only run alignment

How `translation-only` mode maps a translated block back onto the individual
text nodes it came from, and what it does when it cannot.

Maintainer-facing. For what the mode promises the user, see the Features
section of [`README.md`](../README.md).

## The problem

A block is translated as one string, so the mapping back to its text nodes is
lost as soon as the provider reorders segments. In `the *free* encyclopedia`,
the run structure is `['the ', 'free', ' encyclopedia']` — a response that
returns them out of order, or merged into one run, cannot be written back
without chopping text at the wrong offsets.

The failure is not cosmetic. Cutting at wrong offsets inside a link produces
`免` / `费百` / `科全书` across three separate `<a>` elements: the text is still
all there, but the links now point at arbitrary fragments of a sentence.

## Markers

Each run is prefixed with an id marker before sending. The syntax is
provider-specific because survival is not:

| Provider | Marker | Endpoint behaviour |
| --- | --- | --- |
| Google (`translateHtml`) | `<x id="N"></x>` | Parses markup; preserved paired empty unknown tags in every real sample tried. |
| Microsoft, Imp, OpenAI | `⟦N⟧` | Plain-text endpoints pass it through. |

Measured on real prose, one Wikipedia article kept only 2 of 21 `⟦N⟧` markers.
Synthetic inputs (`word1 word2 …`) survive reliably, which is exactly why an
earlier synthetic-only spike produced a confident wrong answer. Do not validate
marker survival on synthetic text.

Two constraints follow from the Google row:

- **Escaping must be selective.** `escapeHtml`-ing the whole source turns
  `<x id="1"></x>` into inert text and no markers come back. Only run text is
  escaped — see `toGoogleMarkupSource` in `lib/align.ts`.
- **Empty paired tags only.** `<span>`, `<div>`, `<font>` and self-closing forms
  all lost the markers; `div` failed 0/5.

## Canonical form

`buildMarkedSource` always emits `⟦N⟧`, never `<x id>`, because that string is
also the `data-imp-text` staleness token and the idb cache key. The Google wire
form is produced per request by `toGoogleMarkupSource`. Keeping one canonical
form means the token and the cache key stay provider-independent.

`splitTranslation` parses **both** syntaxes in a single ordered scan. This is
required, not defensive: the cache key is `lang:text` and carries no provider,
so a response cached from Google is still readable after the user switches to a
plain-text provider. Reading only `⟦N⟧` would send those blocks straight to the
fallback and reintroduce the original bug.

## When markers are lost

`splitTranslation` returns `exact: false` and falls back to cutting the
translation proportionally by run codepoint length. This keeps every character
but cuts at offsets unrelated to the real boundaries.

For a block whose run boundaries are visible — any descendant element, which
covers links and inline styling — that is not safe. `replaceWithTranslation` in
`lib/render.ts` therefore skips the write and keeps the source:

```ts
if (!exact && element.querySelector('*') !== null) continue
```

The block silently stays in its original language with no error chip. A missing
translation is better than a clickable link leading somewhere meaningless.

The `data-imp-text` token is deliberately left untouched on this path, so the
recheck pass sees an unchanged block and does not retry in a loop.

Blocks with no element boundaries still get the proportional split — nothing
visible can be broken there, so dropping the translation would be a pure loss.

The same real-prose measurement that settled run markers also decided how a
glossary reaches Google: an index-based text sentinel, neither a tag nor the
term itself. See [`glossary.md`](glossary.md).

## Invariants worth preserving

- Once settled, translation-only writes into the **existing** text nodes. It
  never clones, reparents, or replaces elements, which is what keeps listeners,
  attributes, and CSS animations intact. The in-flight window appends the
  loading ring (and, on short blocks, its spacer) *after* the source rather
  than replacing anything, so that window is purely additive too.
- The staleness token must equal what the block would compute *now* that the
  runs hold translated text. Writing the pre-translation value breaks recheck.
- `restoreTextNodes` only reverts a node whose current content still equals what
  we last wrote. If the page rewrote it, the page's content is the truth.
- Sanitising run text of marker syntax is load-bearing: after a Google
  round-trip, decoded page text can contain a literal `<x id="1"></x>`, and
  without stripping it the next translation would parse a phantom run id.

## Code map

| File | Symbol | Role |
| --- | --- | --- |
| `lib/align.ts` | `buildMarkedSource` | Runs → canonical `⟦N⟧` source; strips forged markers. |
| `lib/align.ts` | `toGoogleMarkupSource` | Canonical source → Google wire form, escaping run text only. |
| `lib/align.ts` | `splitTranslation` | Response → per-run pieces, both marker syntaxes, with fallback. |
| `lib/translator.ts` | `translateGoogle` | Chooses `toGoogleMarkupSource(text, escapeHtml)` per request. |
| `lib/render.ts` | `replaceWithTranslation` | Writes pieces, or keeps the source when alignment is unverified. |
| `lib/dom.ts` | `getTranslatableRuns` | The runs themselves; same inclusion rules as visible-text extraction. |

## Tests

`lib/align.unit.test.ts` covers both syntaxes, including the "stateless across
calls" case that guards the shared-regex `lastIndex` reset. `lib/render.test.ts`
covers the skip-on-unverified-alignment path and asserts the token stays
untouched, so a future change that writes the token will fail the test rather
than loop forever in production.

`e2e/` exercises the openai mock provider, which takes the `⟦N⟧` path. The
Google `<x id>` path has no e2e coverage because the mock provider is
openai-based; it is covered by unit tests and by manual smoke against the real
endpoint, which is where the bug was found in the first place.
