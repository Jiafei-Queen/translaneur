# Clipping and style overrides

When a translated block would be cut off, the extension lifts the clip. This
records when it does that, when it deliberately does not, and how the page is
put back afterwards.

Maintainer-facing. For what the modes promise the user, see the Features section
of [`README.md`](../README.md). For how the translation is written back into the
page, see [`translation-only-alignment.md`](translation-only-alignment.md).

## The two failure modes

`injectLoading` (`lib/render.ts`) has to put a translation somewhere. When the
injection point is a clipped box, the translation can land outside the clip and
be invisible. The fix has been to write `overflow: visible` on the element — but
that is the page's declaration, not ours, and lifting it has two costs.

**It breaks decorations that rely on the clip.** `overflow: hidden` is the
standard way to hide a `::before`/`::after` parked outside the box. spring.io's
`.button.is-spring` parks its hover fill at `transform: translateX(-101%)` and
has no rule hiding it — the button's own clip is the only thing keeping it
invisible. Lift the clip and the fill renders as a stray block beside the
button, in the page's colours. Measured on the real page, the fill sits at
`x = -139px` for a 138px-wide button, so it is entirely outside.

**It was never undone.** `clearTranslations` removed injected nodes and
`data-imp-*` attributes, but the inline `overflow` / `max-height` /
`-webkit-line-clamp` writes were one-way. Stopping translation left the page
visibly broken until reload.

## Only lift a clip that is actually cutting

`clipActuallyConstrains` (`lib/render.ts`) asks whether the box could grow if
the translation were appended:

```ts
function clipActuallyConstrains(el: HTMLElement): boolean {
  const s = getComputedStyle(el)
  if (s.maxHeight !== 'none') return true
  if (el.style.height !== '' && el.style.height !== 'auto') return true
  return el.scrollHeight > el.clientHeight
}
```

A box that fits its content is free to grow, so its clip never stood between the
user and the translation. A box pinned by a height, or one whose content already
overflows, cannot grow — that is where lifting is required.

The declared height has to be read from the **inline** style, not from
`getComputedStyle`. The computed value is always a used pixel length, so it
never says `auto` and cannot be compared; a spring.io-shaped button with
`height: auto` and a `height: 50px` box are indistinguishable through it. A
stylesheet `height: 3em` also pins the box, and is not caught by the inline
read — resolving which rule supplied the value is not worth the cost, and such a
box whose content already overflows is caught by the `scrollHeight` arm anyway.

The predicate separates cases a blunt "always lift" rule got wrong. Measured:

| Element | constraint | `scrollHeight` / `clientHeight` | Lift? |
| --- | --- | --- | --- |
| spring.io `.button.is-spring` (real page) | `height: auto` | 50 / 50 | **no** — was the bug |
| Discord reply preview parent (real page) | `max-height: 20px` | 24 / 20 | yes |
| `{height: 40px; width: 150px}` | `height: 40px` | 90 / 40 | yes — text already overflows |
| `{height: 40px; width: 400px}`, text fits | `height: 40px` | 40 / 40 | yes — pinned, translation lands outside |

The last row is the one a `maxHeight`-only rule gets wrong, and the one worth
stating: "the content fits today" says nothing about whether it will fit after
a translation is appended underneath. A height-pinned box that currently fits
was losing the whole translation, 100% of it clipped away.

The predicate reads geometry, not pseudo-elements. That is deliberate: a
displaced `::before` is a proxy for the bug, but the *reason* the clip is safe
to keep is that the box grows, and that holds whatever the decoration is. Sites
whose decorations never move are unaffected either way. On spring.io, github.com
and developer.mozilla.org the shape `clip + displaced pseudo-element` matched 3,
1 and 8 elements respectively — the first being the bug, the other two being
`position: fixed` or in-bounds `::after` rules the predicate never needs to know
about.

`-webkit-line-clamp` is **not** gated on this predicate. A clamp is by
definition content overflow, `hasLineClamp` already tests it precisely, and its
override is reverted along with the rest.

`clippingAncestors` collects at most three levels up from the target, and stops
below `<html>`. That bound is a correctness requirement, not a cost saving:
`clearTranslations` runs on `document.body`, so a write to `<html>` lands
outside every cleanup scope and would outlive a stop. A real page with
`html { overflow: hidden }` and a tall document satisfies
`clipActuallyConstrains` — `scrollHeight` exceeds `clientHeight` — so the walk
would otherwise lift the document scroller and leave it unclipped until reload.

## Restoring

Every override records what it replaced, in the DOM, under
`data-imp-style-orig` (`lib/dom.ts`):

```json
{"overflow": "hidden", "max-height": "20px"}
```

Properties carry only their **inline** value. A property absent from the map had
no inline value — the usual case, since the page sets `overflow: hidden` in a
stylesheet — and restoring it means `removeProperty`, not writing a value, so the
cascade shows through again. This is why a lift followed by a restore returns
the element to `hidden` rather than to whatever the map happened to name.

The record lives in the DOM for the same reason `data-imp-attr-orig` does: a
stop must still be able to undo a write if the content script was reinjected in
between. `rememberInlineStyle` is guarded by `hasAttribute`, so re-injecting
keeps the *first* original rather than recording our own `visible` — the rule
`runOriginals` follows for text.

`restoreInlineStyles` runs inside `clearTranslations`, so the
`retranslateElement` path (`entrypoints/inject.ts`) gets it too, clearing a
block before re-walking it. The record is gone by then, so the re-walk
captures the page's real values again.

`OVERRIDDEN_PROPS` is exported from `lib/dom.ts` and imported by
`lib/render.ts`, so the writer and the restorer cannot disagree about which
properties are restorable. It carries `overflow-x` and `overflow-y` alongside
the `overflow` shorthand: the lift writes the shorthand, which sets both
longhands, so a page that declared only `overflow-y: hidden` inline would
otherwise lose it for good — reading the shorthand back does not return it, and
restoring the shorthand to `''` removes the longhand too.

The record is a DOM attribute, so page script can overwrite it with anything.
`restoreInlineStyles` therefore drops an unreadable record instead of throwing:
a `JSON.parse` failure escaping into `clearTranslations` would abort the rest of
the teardown and leave the page half-cleared — blocks still marked
`data-imp-translated`, carrying a stale `data-imp-text` that the recheck pass
keeps re-processing. The element keeps its inline style in that one case, which
is a page the user can fix with a reload; a stuck teardown they cannot.

What this mechanism does **not** cover is the sheet `ensureShadowStyles` adopts
into a shadow root that receives a translation. `removeStyles` only deletes
`#imp-translate-style` from `document.head`, so a shadow root keeps the adopted
sheet — and its `*:has(.imp-translate-result)` un-clamp rule — after a stop.
That predates this change and is recorded here rather than fixed, because the
scope of this mechanism is the extension's **inline** overrides.

## Invariants worth preserving

- The predicate is about the box growing, never about the decoration's shape.
  Adding a check on `::before`/`::after` would couple the clip logic to
  whatever a site happens to draw.
- "The content fits today" is not evidence that the box can grow. A declared
  height pins it regardless, and the appended translation lands outside. This is
  the arm a `max-height`-only rule was missing.
- A restore must `removeProperty` a property that had no inline value. Writing
  the stylesheet's value inline would pin it and defeat a later site change.
- A shorthand write records its longhands too, or the page's own longhand-only
  declaration is destroyed permanently.
- Any new `style.*` write in `injectLoading` needs a `rememberInlineStyle` call.
  A write without one is the original bug, and no test fails.
- Every write must land somewhere `clearTranslations` can reach. That is why the
  ancestor walk stops below `<html>`: a stop scopes to `document.body`, so a
  record on `<html>` is never replayed. A new write to an element outside the
  body subtree needs either that bound or a wider clear scope.
- `clipActuallyConstrains` runs only where `hasOverflowClip` already matched, so
  it costs one extra `getComputedStyle` per clipped element, never per element.
  `injectLoading`'s layout-thrash budget test is the sentinel for this.
- Every arm of the predicate needs a test that fails when that arm is deleted.
  "The lift happened" and "the translation is visible" are different claims, and
  a test asserting the first will happily pass on an implementation that hides
  the text.

## Code map

| File | Symbol | Role |
| --- | --- | --- |
| `lib/render.ts` | `clipActuallyConstrains` | Whether a declared clip is cutting content (a height, a max-height, or content taller than the box). |
| `lib/render.ts` | `hasOverflowClip` | Whether a clip is declared at all. Paired with the predicate above. |
| `lib/render.ts` | `rememberInlineStyle` | Captures the inline values an override is about to destroy. |
| `lib/render.ts` | `applyLineClampOverride` | Line-clamp override; records first. |
| `lib/render.ts` | `clippingAncestors` loop | Up to three levels, stopping below `<html>`. |
| `lib/dom.ts` | `STYLE_ORIG_ATTR` / `OVERRIDDEN_PROPS` | The DOM record, and the shared restorable-property list. |
| `lib/dom.ts` | `restoreInlineStyles` | Puts the recorded values back, removing what was not there before. |
| `lib/dom.ts` | `clearTranslations` | Calls the above for the whole tree and for `root` itself. |

## Tests

`lib/render.test.ts` covers the predicate in both directions — a spring.io-shaped
button keeps its clip, a fixed-height container still loses it, and a
height-pinned box whose content currently fits also loses it. The two lift cases
assert the translation is **hit-testable**, not merely laid out: a clipped node
keeps a non-zero box, so only a hit test at the bottom of the settled text
distinguishes "visible" from "cut off". The restore half covers a
stylesheet-sourced clip, an inline `overflow-y` longhand, an inline line-clamp,
a non-constraining clipping ancestor left alone, and `<html>` never lifted.

`lib/dom.test.ts` covers the teardown half: that a page-corrupted record does
not abort `clearTranslations` partway.

`e2e/overflow-clip.spec.ts` drives the real extension against a page with
spring.io's DOM shape and CSS, and asserts the clip survives translation, the
translation renders inside the button, and the page returns to its original
state after stopping.
