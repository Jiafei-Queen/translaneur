# Changelog

All notable changes to Translaneur, from the fork point of
[imp-translate](https://github.com/rxliuli/imp-translate) onward. Follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0] - 2026-10-06

### Added

- Thunderbird support: a dedicated build target installs as an `.xpi` and
  translates opened mail, including the mail subject.
- Translate the current tab title along with the page.

### Fixed

- Mail bodies wrapped in a bare `<pre>` now translate.
- The mail translation state machine no longer gets stuck mid-pass.
- Mail extraction skips the message header chrome.

## [0.2.4] - 2026-10-05

### Fixed

- A clipped container only unclips when the clip would hide the translation.

## [0.2.3] - 2026-10-05

### Added

- Translate page chrome and input placeholders.
- Options: the OpenAI prompt and extra params collapse into sections.

### Fixed

- Translation-only mode keeps working on CJK source text.
- Run sanitising no longer deletes page text.
- The toolbar icon stays legible on a light toolbar.
- The Google wire form uses a known inline tag.

## [0.2.2] - 2026-10-04

### Added

- Configurable OpenAI request params and limits.
- Glossary terms stay pinned across OpenAI and Google renderings.
- Force re-translate a page, bypassing the cache.
- `Alt+R` re-translates the page from scratch.
- The OpenAI prompt tells the model its blocks are one document.

### Fixed

- Both display modes share one cache payload.
- The popup button no longer reads the loading state as translated.

## [0.2.1] - 2026-10-04

### Added

- Configurable toggle shortcut from the options page.
- The brand icon appears in the popup and settings header.

### Fixed

- The short-block spacer is tagged in translation-only mode.

## [0.2.0] - 2026-10-04

### Added

- Translation-only display mode with run alignment.

### Changed

- The fork is rebranded to Translaneur.

### Fixed

- Main-frame commit is ordered before sub-frame init.
