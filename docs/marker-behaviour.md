# Marker behaviour

Measured on 2026-10-05 against the endpoints this extension actually calls.
Complements [`translation-only-alignment.md`](translation-only-alignment.md),
which records the alignment design; this records what the endpoints were
measured doing, and the corrections that follow from it.

## Method

Two sources of evidence, deliberately kept apart:

- **Google**, via `translate-pa.googleapis.com/v1/translateHtml` with the key
  shipped in `lib/translator.ts`. One multi-run English paragraph, four tag
  classes (`x`, `i`, `b`, `a`), two target languages — 8 requests. The
  paragraph is fixed across tag classes, so the tag class is the only variable.
- **OpenAI**, via OpenRouter `openai/gpt-6-luna` at the shipped defaults
  (`reasoning.effort: none`, `temperature: 0`), using `prompt.md` and
  `MULTI_TEXT_INSTRUCTION` as `lib/translator.ts` sends them.

The Google sample is small. It is reported here because the tag-class control
is clean, not because eight requests settle a general law. Re-run before
treating any single row as settled.

## The tag class decides, not the provider

`translation-only-alignment.md` attributes marker behaviour to the provider.
Measured, it is the **tag class**: whether the tag carries semantic weight that
a translator can use as an anchor for reordering.

| Tag class | Provider | Marks survive | Reordered | Translation |
| --- | --- | --- | --- | --- |
| Unknown empty (`<x id>`) | Google | 7/7 | never | **broken** |
| Known inline (`<i>`, `<b>`, `<a>`) | Google | 7/7 | yes | correct |
| `⟦N⟧` | `gpt-6-luna` | 7/7 | yes | correct |

Source, one paragraph, seven runs:

```
Translaneur is a / cross-platform /  browser / extension /  for reading / foreign /  pages.
```

| | `extension` | `pages` | whole line, EN→ZH |
| --- | --- | --- | --- |
| `<x id>` | 扩大 | 页数 | `Translaneur 是一家跨平台浏览器扩大供阅读外国的页数。` |
| `<i id>` | 扩展程序 | 外文网页的 | `Translaneur 是一款跨平台浏览器扩展程序用于阅读外文网页。` |

An unknown empty tag has no semantic weight, so Google has no basis to move it
and no basis to read across it. Every run is then translated as an isolated
fragment, and `extension` — a noun that needs its sentence — comes back as
扩大, the expansion of something. The markers all come back and the order is
untouched, so `splitTranslation` reports `exact: true`. **Perfect alignment is
the symptom of the failure, not evidence against it.**

A known inline tag is an anchor. Google moves it to where the target language
wants it, and the translation becomes ordinary.

## Id remapping survives reordering

Google preserves the `id` attribute on a real inline tag — `<i id="5">` returns
as `id="5"`, just somewhere else. So `splitTranslation`'s id-keyed write-back
(`lib/align.ts:221-229`) is already correct under reordering and needs no
change. Filling by appearance order instead would be **wrong**: it would assign
Google's `1,5,6,2,3,4,7` output to source slots 1–7 positionally.

This corrects an earlier reading of `imp/lib/segments.ts`, which fills by
output order. That is right for a renderer that rebuilds the block, and wrong
for one that writes into fixed slots. See below.

## LLM providers reorder too

`gpt-6-luna` was asked to keep `⟦N⟧` intact and did so on every request — 7/7 on
the single-block paragraph, 4/4 `<t id>` on a four-block batch, 2/2 on a
two-block batch. It also **reordered** them, to the target language's word
order:

```
sent  ⟦1⟧…⟦2⟧…⟦3⟧…⟦4⟧…⟦5⟧…⟦6⟧…⟦7⟧…
got   ⟦1⟧ ⟦6⟧ ⟦7⟧ ⟦2⟧ ⟦3⟧ ⟦4⟧ ⟦5⟧      (EN→JA, SOV)
```

So the `⟦N⟧` row in `translation-only-alignment.md` conflates two different
things. A plain-text endpoint passes the marker through; a model reinterprets
it. Both survive, but only the second one moves the text — and the measured
2-of-21 loss that row cites is a plain-text-endpoint result, not an LLM one.

## The limit: fixed slots cannot hold reordered text

`swapTextNodes` writes `Text.data` into nodes whose positions are fixed at
source order. Reordering the marker sequence reorders the *translation*, and
there is nowhere in the block to put it. The id remap is correct; the
reassembly that follows is not:

```
run1 <- 'Translaneurは、'          run5 <- 'です。'
run2 <- 'クロスプラットフォーム対応'   run6 <- '外国語'
run3 <- 'ブラウザー'               run7 <- 'のページを読むための'
run4 <- '拡張機能'

exact = true
page shows:
  Translaneurは、クロスプラットフォーム対応ブラウザー拡張機能です。外国語のページを読むための
```

This is provider-independent. Google with a real tag hits it, and so does any
model that translates well. It is not a Google defect and not a marker defect;
it is the ceiling of an in-place write.

Which is also the honest scope of this mode. `buildMarkedSource` skips marking
single-run blocks, and a single-run block needs no alignment — so the blocks
where translation-only is visibly *different* from bilingual are exactly the
multi-run blocks, which are exactly the blocks that cannot express reordering.
The mode is a performance trade: no clone, no reparent, no rebuild, at the
price of holding source word order. For a language whose order resembles the
source's that is nearly invisible; for SOV it is not.

## Proposed changes

Ordered by value per unit of risk.

### 1. Use a known inline tag for the Google wire form

`googleRunMarker` in `lib/align.ts`, plus `MARK_TAG_RE` and `ANY_MARK_RE` (and the
`MARK_TAG_RE` and `WIRE_RESIDUE_RE` uses in `buildMarkedSource` and the fallback
branch). The marker tags never reach the page — `swapTextNodes` keeps only the
split text — so reusing `<i>` twice is free. This alone recovers the whole
`扩展程序` / `扩大` difference above.

`splitTranslation` needs no change. Per the id section, it is already right.

### 2. Surface reordering, and guard on it

`marks` is collected in appearance order, so the signal is free:

```ts
export interface SplitResult {
  pieces: string[]
  exact: boolean
  /** True when the provider emitted run markers out of source order. */
  reordered: boolean
}
```

```ts
if (valid) {
  const pieces: string[] = Array.from({ length: n }, () => '')
  marks.forEach((mark, k) => { /* unchanged */ })
  const reordered = marks.some((m, k) => m.id !== k + 1)
  return { pieces, exact: true, reordered }
}
// fallback: the cut is arbitrary, so treat it as reordered too
```

Then widen the existing guard in `replaceWithTranslation`:

```ts
const { pieces, exact, reordered } = splitTranslation(translated, runs.map((r) => r.data))
if ((!exact || reordered) && element.querySelector('*') !== null) continue
```

`exact: true` with `reordered: true` is currently a silent scramble. This turns
it into a silent skip, which is the failure mode
`translation-only-alignment.md` already argues for. It ships without a rewrite
path.

Log the rate in `debugMode` before building anything else. That rate decides
whether a rewrite path is worth its cost, or whether holding source order is
the right permanent answer.

### 3. Golden tests from real responses

`align.unit.test.ts` hand-writes a reordered response. No shipped provider
produces that for the default configuration, and the response the default
provider *does* produce — in-order, `exact: true`, already-scrambled text — has
no coverage. Both, verbatim:

```ts
// Google + <x id>, EN→ZH. Marks all present, order untouched, translation dead.
// Locks in "an inert tag means fragment translation".
'<x id="1"></x>Translaneur 是一家<x id="2"></x>跨平台<x id="3"></x>浏览器' +
'<x id="4"></x>扩大<x id="5"></x>供阅读<x id="6"></x>外国的<x id="7"></x>页数。'

// Same source, same target, <i id> instead. Ids survive reordering to
// 1,5,6,2,3,4,7 and the text is a normal translation. Locks in that
// id-keyed write-back is correct under reordering.
'<i id="1">Translaneur 是一款</i><i id="5">用于阅读</i><i id="6">外文</i>网页的' +
'<i id="2">跨平台</i><i id="3">浏览器</i><i id="4">扩展程序</i><i id="7">。</i>'

// gpt-6-luna, ⟦N⟧ reordered to 1,6,7,2,3,4,5. Locks in the reordered
// detection and the claim that a model reorders rather than passes through.
'⟦1⟧Translaneurは、⟦6⟧外国語⟦7⟧のページを読むための⟦2⟧クロスプラットフォーム対応' +
'⟦3⟧ブラウザー⟦4⟧拡張機能⟦5⟧です。'
```

The `⟦N⟧` fixture is worth wiring into the e2e mock too: the mock is
openai-based (`translation-only-alignment.md`, Tests), so it is the only way a
reorder ever reaches an end-to-end test.

### 4. Merge the two behavioural claims

`align.ts:18-20` says Google holds markers in source order;
`imp/lib/segments.ts:17-19` says Google moves tags to target word order. Both
are right, about different tag classes. State it as one rule in `align.ts` so
the next reader does not read one row, conclude the other is wrong, and try to
fix it by switching provider.

> **Shipped, with a caveat.** The second citation does not exist in this
> repository — `imp/lib/segments.ts` has never appeared in its history and looks
> like it belongs to another project. The rule itself landed in the `align.ts`
> header, now stated as one tag-class rule covering both classes.

### 5. Scope `PROMPT_REVISION`

`lib/cache.ts` keys the cache on a single `PROMPT_REVISION`. Only the OpenAI
prompt changes bump it, but all four providers are invalidated — a Google user
is re-billed 30 days for an edit that cannot affect their requests. Two
constants, or put the provider in the key. The key is already
provider-independent, which `align.ts:26-27` notes as a requirement of the
single-payload design, so this is a decision to revisit rather than a free
change.

### 6. Reproduce the batch-context failure before trusting it

`611c65e` added the cross-block document instruction and re-keyed the queue per
frame. A follow-up test could not measure a difference, but could not reach the
failure condition either: the Chinese source already said 比赛报告 and 进了两球,
so the ambiguity was resolved before the request. The motivating case is an
ambiguous *English* source with no in-block context. Build that sample and
A/B the instruction against it. Until then the change is plausible, not
verified, and it costs a per-frame queue and a cache reset.

## Code map

| File | Symbol | Role |
| --- | --- | --- |
| `lib/align.ts` | `googleRunMarker` | Google wire tag; the class here decides reorder. |
| `lib/align.ts` | `splitTranslation` | Id-keyed write-back; correct under reordering, and the source of the `reordered` signal. |
| `lib/dom.ts` | `swapTextNodes` | The ceiling: fixed slots, source order. |
| `lib/render.ts` | `replaceWithTranslation` | Where `reordered` would extend the skip guard. |
| `lib/cache.ts` | `PROMPT_REVISION` | One revision for four providers. |

## Not covered

- Microsoft and Imp were not exercised. Both take `⟦N⟧`, and whether they
  reorder like the LLM path or pass through like a plain-text endpoint is
  untested.
- `⟦N⟧` survival on a real Wikipedia-length article was not re-measured. The
  7/7 single-block and 4/4 batch figures above are short blocks; they do not
  contradict the 2-of-21 figure in `translation-only-alignment.md`, which is a
  different provider and a different length.
- `reasoning.effort` was pinned to `none` throughout, matching the shipped
  default. A model given budget to think may reorder more or less.

## Outcome

Proposals 1–4 shipped; 5 and 6 were deferred, as proposed. Three of the
proposals needed correction on the way in.

### What shipped

- **Google wire form is `<i id="N"></i>`.** `MARK_TAG_RE` (openers, used by
  `buildMarkedSource`) and `WIRE_RESIDUE_RE` (tags and closers, used by the
  fallback branch) together cover both the `<x id>` era's tags and the current
  form, so a response cached before the change still parses.
- **`PROMPT_REVISION` → 2.** The cache stores the provider's raw response, so
  every entry written under `<x id>` holds the broken fragment translation and
  would otherwise be served as a hit for 30 days. This also makes proposal 5
  urgent rather than optional.
- **`SplitResult.reordered`**, and `if (reordered) continue` in
  `replaceWithTranslation`.
- **Golden fixtures**, verbatim as captured above, plus the `<x id>` one — which
  still parses, and which is what makes the old form's behaviour legible
  rather than merely gone.
- **`e2e/content.spec.ts`** drives a reordered response end to end. It fails
  against a pre-change build and passes against the current one.

### Correction 1 — the new tag is not free to parse

"Reusing `<i>` twice is free" holds for the page and not for the parser. The
endpoint answers a known inline tag by *wrapping* the run,
`<i id="N">translated</i>`, where `<x id="N"></x>` left an empty mark followed
by the text. `ANY_MARK_RE` matching the opening tag alone yields a piece ending
in a literal `</i>`, and changing only the wire form parses as **zero** markers
→ fallback → tag soup on the page. Worse than 扩大.

The parse therefore matches the whole pair and takes the run's text from the
capture, keeping the trailing text after `</i>` — which is where inter-run text
lives, and is assigned to the preceding run, as before:

```
<i id="6">外文</i>网页的<i id="2">…
```

Capturing the pair rather than stripping `</i>` also matters for page text:
`decodeHTML` collapses `&lt;/i&gt;` back to `</i>`, so a page that quotes HTML
source has a literal `</i>` in its run, and stripping closers would delete it.
It does not, because the closer inside the pair is consumed as part of the
match and the page's own text is carried across it whole. Both cases are pinned
by tests.

### Correction 2 — the two guards must not share a condition

Merging them as `(!exact || reordered) && element.querySelector('*') !== null`
leaves a hole. `collectText` pushes every non-empty text node as its own run and
never merges adjacent ones, while `querySelector('*')` sees only elements — so a
block split by a comment node has several runs and no descendants, and a
reordered response is written into it anyway. Separate lines, because the harms
differ: `!exact` makes the *cut* arbitrary, which only a visible boundary
exposes; `reordered` scrambles *every* run regardless.

### Correction 3 — fallback is not reordering

"fallback: the cut is arbitrary, so treat it as reordered too" would have
regressed a shipped behaviour, and an existing test said so. A marker-less
response on a block with no element boundaries is *deliberately* split
proportionally and written — that fallback exists precisely to lose no text,
and `render.test.ts` pins it as "falls back to proportional splitting without
markers, losing no text". Treating it as reordered would drop those
translations entirely.

`reordered` is therefore a claim about marker order, which only the exact path
can make; after fallback there are no trustworthy markers left. The `!exact`
guard alone governs that path, as it did before.

### Deferred

- **5 (`PROMPT_REVISION` scoping)** — the revision is now bumped for a wire-form
  reason, which is exactly the over-invalidation the proposal describes. Worth
  revisiting as a provider-scoped key; the single-payload design still requires
  the key to stay provider-independent, so this is a decision, not a fix.
- **6 (batch-context A/B)** — unchanged, still unverified.
- **Reorder-rate logging** — the `reordered` skip is currently silent in
  production, so the rate that decides whether a rewrite path is worth its cost
  cannot be read. The `debugMode` flag and `debugTime` are already available in
  `entrypoints/inject.ts`; nothing was added in this change.
