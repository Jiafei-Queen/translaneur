# Translaneur

An open-source, cross-platform browser extension for bilingual web page translation. Minimal by design.

A fork of [rxliuli/imp-translate](https://github.com/rxliuli/imp-translate), rebranded and modified. The original author is not affiliated with and does not endorse this fork.

```
Translaneur — bilingual page translation browser extension
Copyright (C) 2026 Jiafei

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

Copyright (C) 2026 rxliuli (original Imp Translate). Full license text in [LICENSE](LICENSE).

## Goals

- Full-page translation with bilingual display by default — original text stays visible; an optional translation-only mode replaces text in place, keeping every original style, link, and animation
- Zero overhead by default — no code is injected into any page until you ask for translation
- Minimal — do one thing well, resist feature creep
- Cross-platform — Chrome, Edge, Firefox, Safari, including mobile

## Non-Goals

- Auto-injected UI (floating buttons, popups on hover, etc.)
- Word or sentence-level translation (selection, lookup, dictionaries)
- Input box translation (Discord, Slack, etc.)
- Video subtitle translation (YouTube, Netflix, etc.)
- Custom translation styling — will never be considered
- Document translation of any format (Docs, PDF, etc.)
- Compatibility with every website via custom rules — only the world's top 50 most-visited sites are prioritized
- Support for every LLM API provider — only OpenAI-compatible APIs are supported (many tools exist to convert other providers)

## Features

- Two render modes, switchable with a two-button toggle from the popup, options page, or mobile toast bar: bilingual (translation below the original text) and translation-only (translation replaces the text in place, preserving size, colors, clickable links, and animations)
- Translation-only replaces text in the original text nodes, so styles, listeners, and animations survive untouched. A block whose translated segments cannot be reliably mapped back keeps its original text rather than splitting a link's wording — see [docs/translation-only-alignment.md](docs/translation-only-alignment.md)
- Supports Google, Microsoft, Imp Credits, and OpenAI-compatible translation providers
- A user glossary pins the rendering of a term everywhere it appears, so proper nouns and product names stop drifting between blocks — see [docs/glossary.md](docs/glossary.md)
- Smart DOM walker: only translates visible content, handles SPAs, lazy-loaded content, and dynamic text changes
- Translations are cached per text and language, so a second pass over the same page costs nothing; "Re-translate" in the popup (↻ in the mobile bar) forces a fresh pass on demand — see [docs/cache.md](docs/cache.md)
- Site-specific rules for skipping or targeting content areas
- Configurable shortcuts from the options page: `Alt+T` toggles translation, `Alt+R` re-translates the page from scratch (ignoring the cache) — see [docs/hotkey.md](docs/hotkey.md)
- Shadow DOM isolation for injected UI

## Development

```sh
pnpm i
pnpm dev          # Chrome
pnpm dev:firefox  # Firefox
```

## Build

```sh
pnpm zip            # Chrome / Edge
pnpm zip:firefox    # Firefox
pnpm build:safari   # Safari (macOS + Xcode required)
```

## Test

```sh
pnpm test   # unit tests (vitest, browser mode)
pnpm e2e    # end-to-end tests (playwright + real extension)
```

## Site Rules

Built-in rules live in `lib/rules.txt` using uBlock Origin-inspired syntax:

```
domain##selector    — skip (do not translate) matching elements
domain#+#selector   — include (only translate inside) matching elements
entity.*            — match any TLD via Public Suffix List (e.g. google.* covers google.com, google.com.hk, google.co.uk)
```

Users can add custom rules via Developer Mode in the options page.

For per-site coverage status (which top-50 sites have explicit rules vs rely on the default DOM walker), see [`COMPATIBILITY.md`](./COMPATIBILITY.md).

### Contributing rules for a new site

If you use [Claude Code](https://claude.com/claude-code), this repo ships a project-scoped skill that automates the workflow: open the page, inspect the DOM, find the missing selectors, and append them to `lib/rules.txt`.

```
/add-site-rules https://example.com/some/page
```

Without Claude Code, the same workflow is documented step-by-step in `.claude/skills/add-site-rules/SKILL.md` — you can follow it manually with browser DevTools.
