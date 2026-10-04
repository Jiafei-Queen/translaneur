# OpenAI-compatible provider settings

Translaneur can send translation requests to any endpoint that speaks the OpenAI
chat-completions API — OpenAI itself, DeepSeek, Gemini's compatibility layer, or a
local server. Its settings live under **Provider** on the options page, alongside the
provider picker.

## Fields

| Field | Default | Notes |
| --- | --- | --- |
| Base URL | `https://api.openai.com/v1` | `/chat/completions` is appended at request time. |
| API Key | empty | Sent as a bearer token. |
| Model | `gpt-6-luna` | Any model the endpoint accepts. |
| System Prompt | [`prompt.md`](../prompt.md) | See [Placeholders](#placeholders). |
| Extra Request Parameters | `{"temperature": 0, "reasoning": {"effort": "none"}}` | See [Extra request parameters](#extra-request-parameters). |
| Max requests per second | `5` | Client-side rate cap; `0` removes it. |
| Max characters per request | `4096` | `0` falls back to the provider default (1000). |
| Max texts per request | `8` | `0` falls back to the provider default (8). |

A stored configuration that predates one of these fields resolves to that field's
default rather than `undefined`: settings are merged field-by-field against the
defaults, so adding a setting never invalidates an existing one.

## Placeholders

`prompt.md` is the shipped default prompt and stays the editable source of truth — it is
imported at build time, so editing it changes the default for every install.

Two placeholders are substituted with the target language:

- `{{targetLang}}`
- `{{to}}`

A third, `{{terms_prompt}}`, is where the [Glossary](#glossary) section is inserted. If the
system prompt does not contain the placeholder, the section is appended to the end anyway —
see below for why.

Every other `{{placeholder}}` is removed before the prompt is sent. The file is shared
with Immersive Translate and carries placeholders (`title_prompt`, `summary_prompt`,
`imt_style_guide`) that this extension has no producer for; a model that sees a literal
placeholder tends to echo it back.

## Glossary

The glossary is a General option and reaches this provider as instructions in
the system prompt. Google gets the same terms by a different mechanism — see
[glossary.md](glossary.md) for the syntax, the per-provider behaviour, and the
sentinel measurements.

Two consequences specific to this path:

- **A custom system prompt cannot switch it off.** Deleting `{{terms_prompt}}`
  moves the section to the end; it does not remove it. Treating the placeholder
  as opt-in would mean a user who edits the prompt and removes the one line they
  were told was optional silently loses every term, while the options page still
  listed them all as active.
- **It costs tokens on every request**, proportional to its length. It is a
  small list by design.

## Extra request parameters

The shipped default is:

```json
{
  "temperature": 0,
  "reasoning": {
    "effort": "none"
  }
}
```

**Parameter names and shapes are provider-specific.** `reasoning.effort` above is one
spelling of "don't think"; other endpoints spell the same idea differently, and some reject
keys they do not recognise. Check your provider's documentation for what its
`/chat/completions` endpoint accepts before adding keys.

Ordering is deliberate. The built-in interceptors in `lib/interceptors.ts` guess a
`reasoning_effort` from the endpoint's hostname and model name, and the extension's own
defaults are applied first — so anything set here wins. Filling
`{"reasoning_effort": "low"}` overrides the `none` that would otherwise be sent to
`api.openai.com` for a reasoning model. Note that this only overrides `reasoning_effort`;
a nested `reasoning` object is a different key and leaves the interceptors' value alone.

Three keys are owned by the extension and rejected in the textarea:

- `model` and `messages` already have dedicated fields above.
- `stream: true` would break response parsing, which expects a single JSON body.

Settings can also be written straight to extension storage, so the merge step skips these
keys as a second line of defence rather than trusting the textarea.

While the JSON is invalid the last valid value stays in effect and an inline message
explains why — a half-typed object never reaches the request path. **Reset** restores the
stored value.

## Request limits

`Max characters per request` and `Max texts per request` cap how much goes into one
request: when a batch would exceed either, the pending texts are flushed and a new request
starts. Lower them for models with small context windows or for endpoints that charge per
request; raise them to cut the number of round trips on long pages.

`Max requests per second` caps how fast requests leave the extension, which is the lever
for endpoints that return HTTP 429 under load.

`0` means different things per field. For the two batch caps it means "use the provider
default", which keeps a single source of truth in `entrypoints/background.ts`'s
`BATCH_PARAMS` — 1000 characters and 8 texts per request for OpenAI. For
`Max requests per second` there is no provider default, so `0` means no cap at all.

There is no encoding for "no batch cap": the only way to get one is a large number. Limits
are read per queued text, not captured when the extension starts, so a change on the
options page takes effect immediately without reloading the extension.

The rate-limit window lives in memory and is lost when the browser suspends the service
worker. That is deliberate: the cap exists to avoid 429s, and a cold worker has at most one
request of its own to lose.

## Batch context

A multi-text request is not a bag of unrelated strings. The blocks in one request
are consecutive segments of a single document, in reading order, and the system
prompt says so:

> The blocks are consecutive segments of a single document, in reading order.
> Translate them as one coherent whole: keep terminology consistent across
> blocks, and disambiguate polysemous words using the surrounding blocks.

This is the cheapest disambiguation available and it is nearly free — the
neighbours are already in the request, so nothing extra is sent per block. It
matters most for short blocks (headings, nav items, captions), where the segment
alone rarely settles a polysemous word: `Non-goal` is 非目标 beside the rest of a
design document and 未进球 beside a match report.

Two consequences:

- **It applies to batches only.** A single-block request has no neighbours, so
  the instruction is omitted rather than sent as something the model cannot act
  on.
- **It makes a promise the batching layer has to keep.** Two documents must
  never share a request, or the model is told that blocks which are not adjacent
  are. The batch queue is therefore keyed by scope — one frame of one tab —
  rather than by language alone. A page and its ad iframe, or two tabs
  translating at once, now cost two requests instead of one; with one tab and
  one frame, batching is unchanged.

No per-page context block is sent. A hostname or page-title hint was considered
and left out deliberately: it is a guess rather than evidence, and it buys least
on hosted-app surfaces where every document shares one hostname. Adding one later
means extending `translateOpenAI` to take a hint, and the cache-key and
queue-scope work above is already what such a feature would build on.

Changing this instruction retires every cached translation, on every provider
rather than just this one — see [cache.md](cache.md#prompt-revision).

## Options page layout

The page is split into two sections behind the switcher under the Translaneur wordmark:

- **General** — target language, display mode, toggle shortcut, glossary, developer mode
  and custom skip rules.
- **Provider** — the provider picker and the configuration for whichever provider is
  selected.

The switch opens on General each time and is not persisted.