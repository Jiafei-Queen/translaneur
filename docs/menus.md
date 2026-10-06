# Context menu

Three right-click actions, available on web pages and in Thunderbird
messages alike:

| Menu item | Context | Behaviour |
| --- | --- | --- |
| Translate page | `page` | Same toggle as the toolbar / `Alt+T`: start translating, or restore a translating page. |
| Translate selection | `selection` | Translates the selected text and shows the result in an in-page bubble. Whether it follows the selection while scrolling is the "keep the translation bubble following the selection" setting (on by default). |
| Edit translations | `page` | Enters a page-wide edit mode: every translation becomes an inline editable area, with a floating Save/Cancel bar. |

Implementation: `lib/menus.ts` (namespace normalisation), the menu setup and
click handlers in `entrypoints/background.ts`, the overlays in
`lib/overlay.ts`, the edit mode in `lib/edit-mode.ts`, and the overrides store
in `lib/overrides.ts`.

## Permission, per engine

The manifest permission differs by engine and cannot be shared: Chromium and
Safari spell it `contextMenus`, Gecko (Firefox, Thunderbird) `menus`, and
Thunderbird has **no** `contextMenus` alias. `wxt.config.ts` picks the name
from `env.browser`; `lib/menus.ts` feature-detects the matching runtime
namespace (`browser.menus ?? browser.contextMenus`), so one code path serves
all three.

## Thunderbird

The context-menu click is delivered in the **background** on every surface,
including the 3-pane preview pane, a message tab, and a stand-alone message
window. Two consequences:

- **Selection text needs no page round-trip.** `menus.onClicked` carries
  `info.selectionText` (available with `messagesRead`), and the background
  translates it directly. The page is only used to *show* the result.
- **The result still has to reach the page.** Displaying the bubble/editor is
  the one part that rides `background → displayed message`, which is
  unreliable on mail surfaces (see `thunderbird/bugs.md` TB-3). The command
  therefore uses the same dual delivery as page commands: the direct
  `menuCommand` message plus the `tab_wakeup_${tabId}` storage wake-up
  (`lib/message.ts`), stamped with one revision so a double delivery applies
  once. `inject.js` is injected on menu click first, so its listeners exist.

Known limits:

- A selection made inside an iframe has no anchor (the wake-up listener is
  top-frame only); the bubble still appears, centred near the top.
- The very first selection/edit on an already-open message that never had
  `inject.js` injected may miss the script if Thunderbird's `executeScript`
  hang quirk applies. Switching messages and back re-injects it.

## Editing translations

"Edit translations" is page-wide, not per-block: it auto-switches to bilingual
mode (truthful inline editing is only possible there because each translation
is its own wrapper), makes **every** translation on the page a contenteditable
area, and shows a floating bar with Save / Cancel.

- Wrappers created while edit mode is on (lazy scroll, a language change) are
  made editable too, via a decorator seam in `lib/render.ts`.
- `render.ts` refuses to overwrite a wrapper carrying the edit marker
  (`data-imp-editing`), so a live re-translation never clobbers the text under
  the caret.
- Every wrapper is editable, including translations inside links and buttons.
  While edit mode is on the page goes quiet (`lib/edit-mode.ts`): a scoped
  stylesheet pauses CSS animations and transitions and makes controls (links,
  buttons, inputs, selects, ARIA-styled controls) hit-test inert, and a
  capture-phase guard swallows pointer events on an editable wrapper so the
  control's own handlers never fire — editing never navigates, submits, or
  trips a hover state. Caret placement is unaffected (it is mousedown's
  default action, which stopping propagation preserves), and the stylesheet
  re-enables `user-select: text` on the wrapper, which controls like
  `<button>` would otherwise suppress. Leaving edit mode restores everything.
- Pasting pastes plain text; saving reads `textContent`.
- On Thunderbird the translated subject quote block joins in: it carries the
  standard block identity and wrapper, so it edits and saves like body text
  (see `mail-subject.md`).

Save records **only the translations that actually changed**, as overrides
keyed by site (or mail sender domain), target language, and the block's source
payload. The background consults overrides before the cache and provider
(`background.ts`, the `translate` handler), so a hand-corrected block survives
re-translation, scroll rechecks, and cache eviction (the override store is
`storage.local`, separate from the 30-day idb cache).

- **Site key**: resolved by the background from the sender tab — registrable
  web domain via tldts, or the mail sender's domain via
  `messageDisplay.getDisplayedMessages`. The content script fetches it once
  (`getSiteKey`) and stamps it on every `translate` request.
- **State restore**: the page returns to exactly what it was before — the
  previous render mode if it was translating, or fully untranslated if it was
  not. Overrides persist either way.

## Selection bubble

The bubble shows only the translation (Copy/Close only), with no original
text. It is a grab handle: dragging moves it anywhere so it never has to sit on
top of what is being read.

Whether it tracks the page at all is the **"keep the translation bubble
following the selection"** setting (`selectionBubbleFollow`, on by default):

- **Follow on**: the bubble keeps a fixed relative offset to the selection's
  anchor and re-anchors on `scroll`/`resize`, using the live `Range` captured
  when the context menu opened. The anchor is rigid: no viewport clamping, so
  the bubble moves with the selection 1:1. Dragging re-freezes the offset at
  the dropped spot, so even a moved bubble keeps its relative position as the
  page scrolls. Whether the bubble is on screen is its own business, not the
  selection's: it hides (`visibility: hidden` — the box stays laid out so
  re-anchoring reads the real size) only when its anchored position is fully
  carried off screen (parked far from the selection, or the selection itself
  scrolled away), and returns the moment any part of it is back. Before the
  first anchor exists it parks neutrally (top-centre) instead of judging.
- **Follow off**: the bubble is placed once next to the selection and stays
  where it is put; drags just move it.

## Verification

The `selection` / `page` contexts are documented to work in Thunderbird
message display tabs (Thunderbird "Supported UI Elements"). The implementation
does not depend on `menus.getTargetElement` / `targetElementId` (TB 151+, above
the 140 ESR floor): the selection bubble's anchor is a content-script
`contextmenu` listener, and page-wide edit mode needs no target element at all.

The one manual check — that the items appear in the preview pane, message tab
and stand-alone window, and that `selectionText` is populated — lives in
`spike/tb-menu-spike/` (gitignored); fill in its results table on a real TB
build before trusting the mail surfaces.
