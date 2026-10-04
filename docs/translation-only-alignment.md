# Run alignment

How a translated block is mapped back onto the individual text nodes it came
from, and what it does when it cannot.

Maintainer-facing. For what the modes promise the user, see the Features
section of [`README.md`](../README.md). For what the payload is used for beyond
this — the cache key — see [`cache.md`](cache.md). For what the endpoints were
measured doing with these markers, and the corrections that follow, see
[`marker-behaviour.md`](marker-behaviour.md).

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
| Google (`translateHtml`) | `<i id="N">text</i>` | Parses markup; a known inline tag survives as an anchor and comes back wrapping its run, ids intact but possibly relocated. |
| Microsoft, Imp, OpenAI | `⟦N⟧` | Plain-text endpoints pass it through; a model reinterprets it and may move the text. |

Measured on real prose, one Wikipedia article kept only 2 of 21 `⟦N⟧` markers.
Synthetic inputs (`word1 word2 …`) survive reliably, which is exactly why an
earlier synthetic-only spike produced a confident wrong answer. Do not validate
marker survival on synthetic text.

**Correction.** Two things decide survival, and neither of them is the provider.

The **tag class** decides whether the endpoint can move the tag. An unknown
empty tag — `<x id="N"></x>` — survives and is inert: Google cannot reorder
across it, so every run comes back translated as an isolated fragment
(`extension` → 扩大, the expansion of something) while the ids return in source
order and alignment reports a perfect match. That is why this table once
specified it for Google: it was chosen on survival evidence alone, and survival
was the wrong thing to measure.

The **marker has to carry its run**. An empty tag, known or not, is dropped
outright when the source is CJK — Google returns one merged translation with
only the first id — while the same tag on a Latin source keeps every one. The
empty `<i id="N"></i>` therefore looked correct on the English samples this
table was built from, and silently lost every marker on Chinese and Japanese
pages. `<i id="N">text</i>` is an anchor under either source script. See
[`marker-behaviour.md`](marker-behaviour.md) for the captures and the survival
matrix.

Two constraints follow from the Google row:

- **Escaping must be selective.** `escapeHtml`-ing the whole source turns
  `<i id="1">` into inert text and no markers come back. Only run text is
  escaped — see `toGoogleMarkupSource` in `lib/align.ts`.
- **The tag must be one the endpoint knows.** An unknown tag is inert. Earlier
  notes here recorded "empty paired tags only" from a comparison in which every
  candidate — `<span>`, `<div>`, `<font>`, self-closing forms — was unknown to
  the endpoint and lost the markers. A *known* inline tag is not in that class.

### Runs with no words

A run that holds nothing but whitespace, brackets, digits or quotes
(`isPassthroughRun`) is sent as **bare text, with no tag**, and nothing is ever
written back into it. It has no translation of its own, and tagging it is worse
than useless: Google answers `<i id="3"> </i>` by nesting the next tag inside it,
`<i id="2"><i id="3">part</i></i>`, which loses id 2 and sends the block to the
fallback.

The bare characters still reach the endpoint as the separator between the runs
around them, and the node keeps exactly what the page had it holding — so a
provider that drops the space cannot lose it. `head`/`tail` re-attachment skips
those nodes for the same reason.

Ids stay the canonical run numbers, so the wire form's ids are **sparse**
(`1,2,4,6`) when runs are skipped. The endpoint returns them unchanged — no
renumbering, and no index-mapping layer.

The canonical `⟦N⟧` payload is *not* sparse: it marks every run, because a model
handed a payload with holes in it fills them in. So `splitTranslation` calls a
response complete when it carries **either** the ids the wire form tagged **or**
every run id, exactly once each, and either way drops the pieces belonging to
passthrough runs. That also means a model that mislays the marker around a
whitespace run — the one it has least reason to preserve — does not push the
whole block to the fallback.

## Canonical form

`buildMarkedSource` always emits `⟦N⟧`, never a wire tag, because that string is
also the `data-imp-text` staleness token and the idb cache key. The Google wire
form is produced per request by `toGoogleMarkupSource`. Keeping one canonical
form means the token and the cache key stay provider-independent.

It is the canonical form for **every** block, not just the ones that render in
translation-only. The cache key is the reason: if the two display modes derived
the payload differently, switching between them would miss every entry and
re-translate the page. See [`cache.md`](cache.md). Bilingual pays the marker
cost back by writing the response with its markers removed, so the page never
sees them.

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

## Writing the pieces back

`exact: true` is a statement about structure, not quality. Every marker can be
present exactly once and the translation can still be a pile of fragments (see
[`marker-behaviour.md`](marker-behaviour.md)) — and the ids can arrive in the
target language's word order with a perfectly good translation attached to each.

That second case is the normal one, not the exception: a measured 38–75% of
inline-bearing blocks come back with their tags in an order other than the
source's, because that is where the target language puts them. So
`splitTranslation` returns the pieces in the **provider's output order**, and
`replaceWithTranslation` writes them into the runs in document order:

```ts
let piece = 0
const writes = nodes.map((node, k) =>
  isPassthroughRun(texts[k]!) ? node.data : (pieces[piece++] ?? node.data),
)
```

The sentence is the provider's, reassembled correctly. A piece is the text
between its own mark and the next mark in appearance order, so text the provider
pushed outside the tags lands with the piece it follows.

The cost is inline boundaries. Runs are fixed slots, so when the word order
moves, the words an inline element carries move with it: the link still points
at its own `href`, and the text inside it is now a neighbouring run's. Measured
at 12–50% of blocks. That is a real behaviour change, and it is deliberate —
the alternatives were holding source order and showing a scrambled sentence, or
skipping the block and leaving it in the original language. A sentence whose
bold word is one word off beats both.

Like the fallback path, a skipped write leaves the `data-imp-text` token
untouched, so recheck sees an unchanged block rather than retrying forever.

This is also the honest scope of the mode. `buildMarkedSource` skips marking
single-run blocks, and a single-run block needs no alignment, so the blocks
where translation-only is visibly *different* from bilingual are exactly the
multi-run blocks. Translation-only is a performance trade — no clone, no
reparent, no rebuild — at the price of holding each inline element to the words
it started with. For a language whose order resembles the source's that is
nearly invisible; for SOV it is not.

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
- Sanitising run text of marker syntax is load-bearing for **multi-run** blocks:
  after a Google round-trip, decoded page text can contain a literal wire tag,
  and without stripping it the next translation would parse a phantom run id. It
  is now also the only defence between the two modes, since bilingual writes a
  response that translation-only will later read and split. Single-run blocks
  skip it — `splitTranslation` never parses them, so there is nothing to forge
  against, and sanitising only destroys page text (`⟦a, b⟧` is how Wikipedia
  writes a closed interval).
- `PROMPT_REVISION` covers the marker wire form, not just the prompt. The cache
  stores the provider's raw response, so every entry written under an older wire
  form is not merely stale — it is a response the current parser reads wrongly —
  and would otherwise be served as a hit for 30 days. It sits at 3 as of the
  wrapped wire form.
- A run that holds no words is never tagged and never written. Tagging one makes
  Google emit the *next* tag nested inside it and lose that id; writing one puts
  the provider's text into a node holding pure layout. Both sides of the wire
  derive the tagged set from `isPassthroughRun`, so neither has to carry the
  other's list of ids and the payload's ids stay sparse.
- The payload a block is sent as, compared as `data-imp-text`, and rebuilt after
  a translation-only swap must all come from one function. Divergence here is
  what made a mode switch re-translate the page.

## Code map

| File | Symbol | Role |
| --- | --- | --- |
| `lib/align.ts` | `buildMarkedSource` | Runs → canonical `⟦N⟧` source; strips forged markers from multi-run blocks. |
| `lib/align.ts` | `stripMarkers` | Canonical source → the visible text underneath. Reads the canonical form only — the wire tag carries its run's text, so matching it here would delete the text it is meant to keep. |
| `lib/align.ts` | `isPassthroughRun` | A run with no words of its own: untagged on the wire, unwritten on the page. |
| `lib/align.ts` | `toGoogleMarkupSource` | Canonical source → Google wire form: one wrapping tag per tagged run, passthrough runs bare, run text escaped. |
| `lib/align.ts` | `splitTranslation` | Response → per-run pieces in the provider's output order, both marker syntaxes, with a proportional fallback. |
| `lib/translator.ts` | `translateGoogle` | Chooses `toGoogleMarkupSource(text, escapeHtml)` per request. |
| `lib/render.ts` | `replaceWithTranslation` | Writes pieces in output order (translation-only) or the response's plain text (bilingual), or keeps the source when alignment is unverified. |
| `lib/dom.ts` | `getTranslatableRuns` | The runs themselves; same inclusion rules as visible-text extraction. |
| `lib/dom.ts` | `buildBlockSource` | The runs as one payload, edge-whitespace-trimmed. |

## Tests

`lib/align.unit.test.ts` covers both syntaxes and the passthrough ids, including
the "stateless across calls" case that guards the shared-regex `lastIndex`
reset. Its marker fixtures are **captured responses**, not hand-written shapes:
the wrapped `<i id>` one whose ids come back as `1,5,6,2,3,4,7`, and a model
response whose `⟦N⟧` come back as `1,6,7,2,3,4,5`.

`lib/render.test.ts` pins the one remaining skip — an unverifiable cut inside a
block with visible boundaries — and asserts the token stays untouched there, so
a future change that writes the token fails a test instead of looping forever in
production. It also pins output-order write-back including the boundary drift it
causes, and that a passthrough node keeps its own text.

`e2e/cache.spec.ts` pins the consequence of one payload for both modes: a
Display switch adds nothing to the provider log. `e2e/content.spec.ts` drives a
reordered response through the whole mock → service → renderer path, which is
the only place the write-back is proven reachable rather than merely present.

`e2e/` exercises the openai mock provider, which takes the `⟦N⟧` path. The
Google wire form has no e2e coverage because the mock provider is openai-based;
it is covered by unit tests and by manual smoke against the real endpoint, which
is where the bug was found in the first place.
