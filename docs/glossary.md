# Glossary

A glossary pins the rendering of a term everywhere it appears. It is the fix
for terminology drift: the same product name coming back as 库伯内特斯 in one
block and -kubernetes in the next, or 山寨 / 仿冒 / 盗版 for one idea.

It is a **General** option, not a provider one, because two of the four
providers can apply it — by two different mechanisms.

## Syntax

One term per line, `source = target`, with `!` comments and blank lines skipped —
the same syntax as the custom skip rules in `lib/rules.txt`, because it is the
same gesture of typing a list into a textarea:

```
! One term per line
Transformer = 变换器
Kubernetes = 库伯内特斯
```

- A repeated `source` takes the last mapping, so the bottom line of a duplicate
  pair wins.
- Up to **200 entries**. The bound is reported, never silently applied.
- Parsing is case-insensitive and matches anywhere in the text, with no word
  boundaries — a user writing `AI` means the acronym, not a judgement about
  which words `AI` sits inside. Chinese terms have no spaces to bound on, and a
  boundary rule tuned for English would stop matching half the list.

One unparseable line fails the whole parse. The options page names the line, and
translation continues without terms rather than failing — half a term list is
not a term list.

## How each provider applies it

### OpenAI-compatible — instructions in the prompt

The terms are rendered as a `## Glossary` section of the system prompt. This is
the stronger of the two mechanisms: a glossary that only rewrote the source text
would fix the terms it matched, whereas one in the prompt also governs how the
model renders them in sentences around them.

Placement is controlled by `{{terms_prompt}}` in the system prompt. **A custom
system prompt cannot switch the glossary off** — deleting the placeholder moves
the section to the end rather than removing it. The alternative would mean a
user who edits the prompt and removes the one line they were told was optional
silently loses every term, while this page and the options page still list them
all as active. See [openai-settings.md](openai-settings.md#placeholders).

### Google Translate — a sentinel inside the text

`translateHtml` takes no instructions, so a term is replaced by an opaque
sentinel before the request and swapped for its target rendering after the
response comes back.

The sentinel is an **index**, not the term, and that is measured rather than
stylistic. Against the live endpoint on real Wikipedia prose:

| Sentinel | Survived | Why |
| --- | --- | --- |
| `⟦<term>⟧` | 3/6 | The provider *translates* the payload: `⟦Shanzhai⟧` returns as `⟦山寨⟧` — structurally intact, and matching nothing. |
| `<x id="<term>"></x>` | 4/6 | Same failure, same cause. |
| `ZQX<term>QXZ` | 6/6 | Survives only because the term is echoed back byte-for-byte. A term the provider chose to localise would not match — and the term is the thing most likely to be localised. |
| `ZQX<index>QXZ` | 6/6 | No such dependency. The payload carries no source language in it, so there is nothing to translate. |

Real prose is the only valid substrate here. An earlier spike in this repo
validated marker survival on synthetic input and got a confident wrong answer;
see [translation-only-alignment.md](translation-only-alignment.md).

If a sentinel comes back mangled, the block is resent unmasked and the
provider's own rendering is used. A lost sentinel leaves no trace in the
response, so the loss is detected by comparing the bindings against what came
back rather than by looking for a leftover.

### Microsoft and Imp Credits — not applied

Bing's token is bound to the IP that scraped it, so the sentinel survival rate
could not be measured from a build machine; the shape is the one the run
markers already rely on there, but treat it as **unproven** until someone
measures it from a browser session. Imp Credits is a server-side black box with
a 1:1 contract. Neither is passed terms rather than being passed terms that may
or may not survive.

## Caching

Translations are cached per text and language, not per glossary. Editing the
glossary changes the request but not the cache key, so a term you just
corrected will keep serving the cached translation of a text translated before
the edit. Entries expire after 30 days; there is no clear-cache action in the
options page.

## Code map

| File | Symbol | Role |
| --- | --- | --- |
| `lib/glossary.ts` | `parseGlossary` | The textarea's text → entries, with the line-level error. |
| `lib/glossary.ts` | `renderGlossary` | Entries → the prompt section. |
| `lib/prompt.ts` | `renderSystemPrompt` | Places that section at `{{terms_prompt}}`, or at the end. |
| `lib/term-sentinel.ts` | `maskTerms` / `restoreTerms` | The Google mechanism, and the loss detection. |
| `lib/translator.ts` | `translate` | Parses once, hands terms to each provider by its own route. |
