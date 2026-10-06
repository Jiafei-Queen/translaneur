# Thunderbird port — bug log

Each entry: a diagnosed issue found during the port, with root cause, evidence,
and fix direction. Fixed entries move to a "Fixed" section once verified.

## TB-1 — plain-text mail does not translate at all

**Status — fixed, verified live (TB 157; see also TB-2's verification).**
`lib/dom.ts`
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

## TB-3 — mail state machine regression after the messageDisplay drive

**Status — fixed, verified live (TB 157).** Two root
causes behind three symptoms, both introduced by 5240e1b ("drive mail
translation from messageDisplay events"):

1. the trigger chain moved to background → content-script messaging — the one
   direction the spike never validated on mail surfaces — while the
   executeScript + auto-init chain it replaced was the part that worked;
2. `onMessagesDisplayed` treated every message switch as a page reload and
   cleared `tab_translating_${tabId}`, designing out the expected
   "translating persists across messages" behaviour.

**Found**: real-mail testing after 5240e1b + a57ba9d. Reported by the user:

- Alt+T starts translation but can never stop it;
- starting on the current message translates nothing — yet switching to the
  next message translates *that* one, while the state already reads off;
- translation turns off on every message switch (expected: stays on and
  translates the new message).

**Root cause 1 — the current document never hears the command.**
`startTranslationForTab` skips `executeScript` for mail surfaces and sends
`startTranslation` via `tabs.sendMessage`. Two ways that message never lands:
the registered message-display script only covers messages displayed *after*
`registerScripts` ran (the message already open at startup or at temporary
add-on load has no script at all), and background → displayed-message
delivery is itself unverified — spike probe 3 proved `executeScript` hangs
on mail surfaces and probe 4 proved the two injection paths don't even share
a JS world, but the spike only ever reported *from* the document
(`runtime.sendMessage`), never *to* it. `getState` fails the same way, and
`isPageTranslating` swallows the failure as "idle", so the toggle always
takes the start branch — Alt+T can never stop.

**Root cause 2 — the switch-as-reload clear races the next document.**
The `onMessagesDisplayed` handler cleared the key on every display. That
alone is the reported "switching turns translation off": in the web model a
navigation keeps translating and only `transitionType === 'reload'` clears,
so a switch should keep the run alive and let the fresh document's auto-init
translate the new message. Worse, the clear raced that auto-init (both hop
through `storage.session`): when auto-init read the key first, the new
message translated and the clear then flipped icon and state to off — the
reported "translated but state reads off". The `stopTranslation` backstop
could not close the race: it rides the same broken direction, and even when
delivered it can land before auto-init's late start and be overwritten.

**Fix**:

- toggling decides from the session key (`isTabActivelyTranslating`), which
  needs no content script at all; the content-script probe stays as a
  web-only second chance;
- a message switch keeps translating: `onMessagesDisplayed` clears nothing
  (it only re-applies the icon), and each new message document's auto-init
  picks the same session key up;
- commands reach a displayed message over storage: `ringTabWakeup` writes
  `tab_wakeup_${tabId}` in `storage.local` — the only area content scripts
  can observe; `storage.session` is not exposed to them — next to the direct
  message, both stamped with one revision so a double delivery applies once
  (a forced start would otherwise re-walk and re-bill the page). A wake-up is
  a command, not state: the truth stays `tab_translating_${tabId}` in
  `storage.session`;
- `startTranslationForTab` now fires `executeScript` at mail surfaces without
  awaiting it (its promise may never settle) so a message displayed before
  registration can still get the script. The per-window guard in `inject.js`
  cannot dedupe that from the registered script's copy (different JS worlds),
  so `inject.js` marks its document with `data-imp-script` in the shared DOM.

**Verification list**:

- Alt+T on the current message translates it; Alt+T again restores it — on
  all three reading surfaces, including a message that was already displayed
  when the add-on loaded
- translating on + switch message → icon stays and the new message
  translates; translating off + switch → stays off
- toolbar icon and popup agree with the real state at every step
- forced re-translate re-walks once, not twice (revision de-duplication)
- web tabs unchanged: toggle, reload-clears, sub-frame continuation —
  `pnpm e2e` stays green

**Open questions**: none blocking. If a wake-up is ever missed, check TB's
`storage.onChanged` delivery for `storage.local` in display scripts first;
the direct message and auto-init cover that case in the meantime.
