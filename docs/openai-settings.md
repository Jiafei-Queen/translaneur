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

Every other `{{placeholder}}` is removed before the prompt is sent. The file is shared
with Immersive Translate and carries placeholders (`title_prompt`, `summary_prompt`,
`terms_prompt`, `imt_style_guide`) that this extension has no producer for; a model that
sees a literal placeholder tends to echo it back.

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

## Options page layout

The page is split into two sections behind the switcher under the Translaneur wordmark:

- **General** — target language, display mode, toggle shortcut, developer mode and custom
  skip rules.
- **Provider** — the provider picker and the configuration for whichever provider is
  selected.

The switch opens on General each time and is not persisted.