# Mail subject translation (Thunderbird)

On Thunderbird, translating a message also translates its subject, controlled
by the options page's "Translate mail subject" setting (on by default — the
same toggle is "Translate tab title" in the browser builds). The translation is
shown as a quote block at the top of the message body:

```
> 标题：使用 Langfuse 评估并优化智能体

Hey 费加,
…
```

Both render modes show the same block: the original subject stays visible in
Thunderbird's own header right above it, so there is nothing to re-state.

## Why a quote block and not the subject line itself

Thunderbird renders the visible subject line in its own privileged header
document (`about:message`'s `#expandedsubjectBox`) — a different document from
the message body that `scripting.messageDisplay.registerScripts` injects into.
Content scripts cannot touch it, and neither can the message-list subject
column. Rewriting the real header would need an Experiment API (a privileged
module); the quote block is the same feature with standard WebExtension APIs.

## Where the text comes from

The display document's `<title>` is the decoded `Subject` header — the MIME
HTML emitter writes it there (`nsMimeHtmlEmitter.cpp` in comm-central). That
is the translation source, and it doubles as the subject's identity on the
web (`lib/title.ts` translates `document.title` there). A blank, single
character, or bare-URL subject is skipped with the same gate as tab titles.

The label in the block — `标题：`, `件名：`, `Subject:`, … — follows the
target language, matching the wording Thunderbird localizes the Subject header
with. The table lives in `lib/mail-subject.ts` (`SUBJECT_LABELS`) and falls
back to English for languages it does not know.

## Placement and lifecycle

The block is inserted before the message body container (`div.moz-text-plain`,
`div.moz-text-flowed`, or `div.moz-text-html`), never inside it, so a
plain-text mail's `<pre>` keeps its structure. Attachment wrappers reuse the
same container classes and are skipped when picking the anchor.

Thunderbird rewrites the display document per message, so the subject is
static per document: translate once on start, drop the block on stop, and let
each new message's auto-init pick the run up again (a translating tab keeps
translating across message switches — see `docs/thunderbird/bugs.md` TB-3).
Forced re-translates and render-mode switches go through the same restart
path, which rebuilds the block.

The block carries `data-imp-subject`, which is also its skip selector in the
DOM walk — the body extractor and its delayed rescan never treat it as
message text. It also carries the standard translatable-block identity
(`data-imp-translated` plus `data-imp-text`, the subject as the source
payload) with the translation in a standard wrapper and the label kept
outside it, so page-wide edit mode can edit the subject line like body text
and save a per-domain override (see `docs/menus.md`).

The feature is Thunderbird-only: on web pages `isMailDisplayDocument` finds no
Thunderbird header table and the pipeline stays inert.
