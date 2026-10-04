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

**Correction (second round).** The id remap is right, and the *output order* is
what gets written — see
[the second round](#second-round-the-marker-has-to-carry-its-run). "Wrong for a
renderer that writes into fixed slots" was true of the renderer that refused to
move anything; the shipped one writes whatever order the provider returned, so
filling by appearance order is exactly what it does. What survives from this
section is the measurement: Google preserves the `id` attribute, and the ids are
a **validity check** on a response (every sent id exactly once), not a slot
assignment.

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
multi-run blocks.

**Correction (second round).** The ceiling belongs to *id-keyed* write-back, not
to in-place writing. Writing the pieces in the provider's output order
reassembles the sentence correctly inside the same fixed slots; what it cannot do
is keep each inline element on the words it started with, measured at 12–50% of
inline-bearing blocks. That drift is accepted deliberately — see
[the second round](#second-round-the-marker-has-to-carry-its-run). The
"performance trade at the price of holding source word order" framing below is
therefore superseded: the mode keeps the *words*, not the slot-to-word mapping.

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

Current symbols; the names used by earlier rounds are in the sections above.

| File | Symbol | Role |
| --- | --- | --- |
| `lib/align.ts` | `toGoogleMarkupSource` | Google wire tag: `<i id="N">run text</i>` per tagged run, passthrough runs bare. |
| `lib/align.ts` | `isPassthroughRun` | Runs with no words: untagged on the wire, unwritten on the page. |
| `lib/align.ts` | `splitTranslation` | Pieces in the provider's output order; the ids are a validity check on the response, not a slot map. |
| `lib/dom.ts` | `swapTextNodes` | The fixed slots; the inline-boundary drift happens here. |
| `lib/render.ts` | `replaceWithTranslation` | Writes the pieces in output order; the `!exact` guard is the one remaining skip. |
| `lib/cache.ts` | `PROMPT_REVISION` | One revision for four providers; bumped for the wire form. |

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

**The wire form and the `reordered` signal recorded below were superseded by
[the second round](#second-round-the-marker-has-to-carry-its-run).** What still
holds from this round: the tag-class rule, the pair-capturing parse, and the
`!exact`-only fallback guard.

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

## Second round: the marker has to carry its run

Measured on 2026-10-05, after the wire form above had shipped, on **CJK source**.
The empty `<i id="N"></i>` is not inert-but-present there. It is dropped.

### The finding

Live `translateHtml`, five CJK blocks, the shipped form against the candidates:

| Marker | ids returned (ZH source) | `exact` |
| --- | --- | --- |
| `<i id="N"></i>` empty, quoted (shipped) | `[1]` | false |
| `<x id="N"></x>` empty pair | `[1,2,3]` | true, but fragment translation |
| `<span id="N"></span>` empty | `[1,2,3]` | true, but fragment translation (and inert) |
| `⟦N⟧` plain text | `[1,2,3]` | true, in order |
| `<i id="N">text</i>` wrapping | `[1,3,2]` … | true, reordered |

The discriminator is the **source script**, not the target: ZH→EN, ZH→JA,
ZH→FR and JA→EN all return ids `[1]`, while EN→DE and EN→JA return every id.
That is how the earlier round measured clean — every capture in this document is
Latin source.

The chain: only `id="1"` comes back → `splitTranslation` reports `exact: false`
→ `replaceWithTranslation` refuses an unverified write into a block with any
descendant element → that block keeps its source. Blocks with no descendant
element still take the proportional fallback and are written. That is exactly
the reported symptom: *only some headings came out translated*.

Live proof, five CJK blocks × en/ja/fr/de, `exact` after splitting the real
response: empty prefix form **0/20**, wrapping form **20/20**.

### The passthrough rule

Sending a whitespace-only run as a tagged segment makes Google nest the next tag
inside it — `<i id=2><i id=3>part</i></i>` — losing id 3. Sent bare, the ids come
back intact (`1,2,4,6`) with no nesting: the endpoint needs the separator, not
the tag. Translation quality is identical across all-tagged, bare and filtered.

So `isPassthroughRun` (whitespace, brackets, digits, quotes) is the single
definition both sides of the wire use. `toGoogleMarkupSource` leaves those runs
bare, `splitTranslation` drops any piece that belongs to one, and
`replaceWithTranslation` hands those nodes their own text back so nothing is
written into them.

The canonical `⟦N⟧` payload still marks every run, because a model handed a
payload with holes in it fills them in. A response is therefore complete with
either the wire form's tagged ids or every run id, once each — see
[`translation-only-alignment.md`](translation-only-alignment.md). Ids stay the
canonical run numbers, so the wire form's are sparse — no renumbering layer, and
no id list plumbed between encode and decode.

### Output order, and what it supersedes

Strict source order holds for only 1/5–3/5 of CJK→X blocks; the rest come back
in the target language's order. With the wrapping form in place a reorder is
routine rather than rare, so `SplitResult.reordered`, the `if (reordered)`
guard, and the "fixed slots cannot hold reordered text" framing all go: the
pieces come back in the provider's output order and are written in document
order.

- `SplitResult` is `{ pieces, plain, exact }`. `pieces` holds one entry per run
  that gets written, so `pieces.length` is not `runTexts.length`; `plain` is the
  whole response with its markers removed, which is what the block-level
  (bilingual) renderer shows. Joining `pieces` no longer reconstructs the block
  — it lacks the passthrough runs' text, and that text can be content, not just
  separation (a digits-only run). See
  [`translation-only-alignment.md`](translation-only-alignment.md).
- Superseded here: "Google wire form is `<i id="N"></i>`", "`PROMPT_REVISION`
  → 2", "`SplitResult.reordered`", the `<x id>` golden fixture (that shape no
  longer parses), and `WIRE_RESIDUE_RE`'s "a response cached before the change
  still parses" — the revision bump retires those entries. `WIRE_RESIDUE_RE`
  keeps covering the `<x id>` shape and `MARK_TAG_RE` keeps consuming the
  opener, because page text can still carry either.
- `stripMarkers` now reads the canonical `⟦N⟧` form only. Sharing `ANY_MARK_RE`
  with the wire tag made it delete the run text that lives *inside* the tag —
  the exact text it exists to preserve.
- `PROMPT_REVISION` → 3: the cache stores the provider's raw response, and the
  new parser reads an old empty-tag response as a mismatched id set.

Accepted cost, and the reason this is a decision rather than a bug fix: inline
boundaries drift in 12–50% of inline-bearing blocks — a link keeps its own
`href` and shows a neighbouring run's words. The alternative was a scrambled
sentence or an untranslated block.

### Not measured

Whether Microsoft or Imp lose the `⟦N⟧` markers on CJK source the way the empty
`<i>` did. They never see a wire tag, and the bracket form came back in order on
CJK, but that was only exercised against Google.
