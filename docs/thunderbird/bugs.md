# Thunderbird port — bug log

Each entry: a diagnosed issue found during the port, with root cause, evidence,
and fix direction. Fixed entries move to a "Fixed" section once verified.

## TB-1 — plain-text mail does not translate at all

**Status — fix implemented, pending live verification.** `lib/dom.ts`
`ExtractOptions` gained `allowSelectors` (un-skips a pruned tag when the
element matches; site-rule and element-gate skips still apply), and the
inject entry computes `allowSelectors: ['pre.moz-quote-pre']` once per
document — the class exists only in TB's mail rendering, so web pages are
unaffected. Splitting needs no extra work: with the `pre` un-pruned, the
walker's existing blank-line segmentation (`preservesNewlines`) handles
`\n\n` paragraphs. Quoted reply blocks nest another `moz-quote-pre` inside
`blockquote[type=cite]`, which currently stays behind the blockquote leaf
gate (`isBlockTag` excludes `pre`) — same path a web page's
`blockquote > pre` takes; whether mail quotes should translate is the open
question below, not part of this fix.

**Found**: after the Step 2 gate, first real-mail testing (TB 157, temporary
add-on). Reported by the user: translation, hotkeys, and both modes work on
HTML mail; certain mails silently do nothing — confirmed independent of the
reading surface (preview pane / message tab / stand-alone window) and
dependent only on content type: they are **text/plain (non-flowed) mails**.

**Symptom**: trigger produces no visible reaction — no loading ring, no
result, no status. In code, `extractBlocks` yields 0 blocks and
`translateBlocks` bails silently (`blocks.length === 0` returns, no state
change), so there is genuinely "nothing" to surface.

**Root cause**: Thunderbird renders text/plain display documents as

```html
<div class="moz-text-plain" wrap=... graphical-quote=...>
  <pre wrap class="moz-quote-pre">
    …the entire message body lives inside this <pre>…
  </pre>
</div>
```

(comm-central `mailnews/mime/src/mimetpla.cpp` writes
`<div class="moz-text-plain" …><pre wrap class="moz-quote-pre"></div>` and
closes the `</pre>` at `parse_eof`; nested quoted prefaces use the same
`<pre wrap class="moz-quote-pre">`). `lib/dom.ts` `SKIP_TAGS` contains
`'pre'` (for web code blocks, asserted by `dom.test.ts` "should skip pre
elements"), and `shouldSkip` prunes the whole subtree on hit — so the
extractor skips exactly the element holding 100% of the text. HTML mail
renders as `div.moz-text-html` with normal markup, hence unaffected.

**Why the spike missed it**: spike Probe 1 recorded only the *body child*
shape — `div.moz-text-plain (not <pre>)` — and never dug one level deeper;
the element holding the text is the `pre` *inside* the div. The spike spec
itself had anticipated the risk ("For plain text, the body is a `<pre>`").

**Fix direction** (assign to Step 4, or pull forward — it blocks real-mail
 usefulness): teach the TB injection adapter to treat
`div.moz-text-plain > pre.moz-quote-pre` as translatable content. The
generic hook is an `ExtractOptions` escape for the `pre` skip in this
shape (web pages keep skipping code blocks; `dom.test.ts` must stay
green). Paragraph splitting needs no extra work: once the `pre` is no
longer pruned, `preservesNewlines` (white-space `pre`) +
`hasBlankLineSeparator` segments on the literal `\n\n` blank lines
normally.

**Verification list**:

- plain-text mail translates on all three reading surfaces; paragraphs split
  on blank lines; both bilingual and translation-only modes
- HTML mail and long threads unchanged; web pages unchanged — code blocks
  and ordinary `<pre>` content still skipped
- inline attachments: comm-central warns the `moz-text-plain` class also
  appears on attachment wrappers — confirm the fix shapes in on `> pre` only

**Open questions**:

- does "translate a quote block" match user expectation for mail, or should
  quoted regions be excluded like web page chrome?
- `format=flowed` mail renders as `div.moz-text-flowed` with no inner
  `<pre>` (`mimetpfl.cpp`) — verify whether those mails already translate.

## TB-2 — some HTML mail does not translate (body wrapped in a bare `<pre>`)

**Status — fixed and verified live.** `entrypoints/inject.ts` widens the
`allowSelectors` escape to `['pre.moz-quote-pre', 'div.moz-text-html > pre']`,
so the walker un-prunes a mail body that is a bare `<pre>` inside
`div.moz-text-html`. The selector is Thunderbird-only, so web pages keep
skipping `<pre>`; `dom.test.ts` covers both.

**Found**: continued real-mail testing after TB-1's fix. A "small subset" of
mails still translated to nothing — e.g. Broadcom's transactional
"Portal Password Reset" mail. Confirmed independent of reading surface; all
are HTML mails (`contentType: text/html`).

**Symptom**: identical to TB-1 — trigger produces no reaction, `extractBlocks`
yields 0 blocks, `translateBlocks` returns silently.

**Root cause**: the sender ships its whole body as a bare `<pre>` inside the
message container, with no `moz-quote-pre` class:

```html
<div class="moz-text-html"><pre>…the entire message…</pre></div>
```

`lib/dom.ts` `SKIP_TAGS` contains `'pre'`, and TB-1's `allowSelectors` only
matched `pre.moz-quote-pre`, so this shape was still pruned. The surrounding
text nodes even carry literal newlines with computed `white-space: pre`, so
the body renders correctly but is invisible to the walker.

**Evidence** (TB 157.0.1, `[imp-diag]` from `lib/diag.ts`):

```
contentType=text/html
tb[plain=false html=true flowed=false quotePre=false pre=1 blockquote=0]
blocks=0
pre elements:
  <pre> ws=pre len=602 path=div.moz-text-html > pre
text-holders:
  <div> ws=pre 578x576 len=297 path=div.moz-text-html > pre > div
```

**Verification** (live, after the fix): the Broadcom mail now renders its
Chinese translation in translation-only mode; the plain-text (TB-1) path and
`dom.test.ts` "should skip pre elements" remain green.

**Open questions**: same as TB-1 — whether a bare `<pre>` that is *not* the
whole body (a code sample a newsletter embeds directly under
`div.moz-text-html`) should be translated. The selector is exact enough in
practice; revisit if a false positive shows up.
