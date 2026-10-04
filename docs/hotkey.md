# Shortcuts

The extension exposes two keyboard commands, both handled by the browser's
`commands` channel rather than by a listener injected into the page:

| Command | Default | Action |
| --- | --- | --- |
| `toggle-translate` | `Alt+T` | Translates the current page, or restores the original text |
| `retranslate-page` | `Alt+R` | Translates the current page again from scratch, ignoring the cache |

Re-translating is what `docs/cache.md` calls a forced pass: the page is walked
again and every block skips the cache read, so a corrected glossary term or a
provider switch takes effect without waiting out the cache's 30-day life. It acts
whether or not the page is already translating — on a cold page a forced pass is
simply the first translation, and refusing there would make the key look broken
instead of doing the obvious thing.

The browser owns the keys it dispatches, and reports them back in its own
notation. On macOS an active binding reads as `⌥T` rather than `Alt+T`; both
mean the same physical combination.

## Defaults

`Alt+T` and `Alt+R`.

Both are declared as their command's `suggested_key` in `wxt.config.ts`, so the
browser seeds the bindings on install. A browser profile that already has a
binding from an earlier install keeps it — the manifest default only applies on
first install or when the extension is reloaded.

## Changing them

Open the options page, stay on **General**, and scroll to **Shortcuts**. Each
command has its own field; recording one never touches the other.

Recording is only available on browsers that can apply the result, which today
means Firefox. On Chrome the fields are read-only — see
[Chrome cannot apply the shortcut for you](#chrome-cannot-apply-the-shortcut-for-you).

On a browser that supports it:

1. Click the field showing the current shortcut. It turns into `Press keys…`.
2. Press the combination you want.
3. The recorded value is saved against that field's command and shown as e.g.
   `Alt + Shift + K`.

While recording:

- `Escape` cancels and leaves the stored shortcut unchanged.
- `Backspace` or `Delete` clears the shortcut, turning that hotkey off.
- An invalid combination is rejected with an inline reason, and recording stays
  open so you can try again.

The **Clear** button next to a shortcut turns that hotkey off without entering
recording mode. When the shortcut is off the button reads `Not set`, and the
command stops being bound.

### Rules a combination must follow

- It must include `Alt` or `Ctrl`. A bare key would intercept that key on every
  page you visit, so it is refused.
- `Ctrl`+`Alt` together is refused. Chrome does not accept it at all, and
  keeping recordings portable is worth more than the extra combination.
- `Command`/`Meta` is refused. On macOS the browser's own menu consumes
  `Cmd`+letter before extension shortcuts are consulted, so such a binding
  could never fire.

Recording is keyed off `KeyboardEvent.code`, never `KeyboardEvent.key`. On
macOS, `Option`+letter often reports a composed character (`Option`+`A` is
`å`) or a dead key — `Option`+`E`, `+I`, `+N` and `+U` all report `key` as
`Dead`. Reading the character would discard the only event carrying the real
key and make those combinations look unbindable, even though the browser
accepts all of them. `code` names the physical key and is stable across
layouts and compose state.

## Control on macOS

On macOS the WebExtension shortcut grammar does not mean what the keycaps say:
`Ctrl` is an alias for `Command`, and a real Control binding has to be spelled
`MacCtrl`. Both engines apply the same rule, in opposite directions when they
report a shortcut back — Chrome's `NormalizeShortcutSuggestion` and Firefox's
`chromeModifierKeyMap` each map `Ctrl` onto the platform's command key. A
`Ctrl`+letter shortcut on macOS therefore binds `Cmd`+letter, silently and
successfully, and never fires when the user presses Control.

The extension keeps one dialect and translates at the boundary:

- `settings.toggleHotkey` and `settings.retranslateHotkey`, the recorder and
  every piece of display text speak the platform-neutral form, `Ctrl+T`.
- `toBrowserShortcut()` rewrites `Ctrl` to `MacCtrl` on macOS only, just before
  `commands.update()`.
- `toStoredShortcut()` rewrites it back on the way out of `getAll()`, so the
  active-binding line reads `Ctrl + T` instead of leaking `MacCtrl + T`.

Keeping the stored value platform-neutral is what lets one profile's shortcut
mean the same thing on Windows and Linux, where `MacCtrl` is not a valid token
at all. Only the two browser-facing values differ, and they differ only on macOS.

`MacCtrl` is accepted by validation for the same reason: it is the token a
browser reports back, so a `getAll()` result has to survive `isBindableHotkey`.
`Command` remains refused, because the recorder rejects `Meta` and no stored
value can carry it.

Both engines map `MacCtrl` to a real Control key, so the rewrite is safe on
either: Firefox's `chromeModifierKeyMap` lists `MacCtrl: "control"` alongside
`Ctrl: "accel"`, and Chromium normalizes the same way. Firefox's
`commands.update()` does not even validate the shortcut — it stores the string
after trimming it — so a `MacCtrl` binding is accepted there rather than
silently ignored.

## Chrome cannot apply the shortcut for you

Chrome's `commands` API exposes only `getAll()` — there is no `update()` and no
`reset()`. An extension therefore cannot assign its own shortcut on Chrome; the
binding lives in the browser's preferences and only you can change it.

The options page reflects this rather than pretending otherwise: on Chrome the
shortcut fields are read-only, the page shows **Chrome does not let extensions
assign shortcuts**, and a button opens `chrome://extensions/shortcuts`, which
is where you type the combination to actually activate it. Each field displays
the binding its own command really has — read via `getAll()`, which Chrome does
support — not a stored preference, so the two can never be confused. When the
browser has no binding at all the field reads `Not set`; it never falls back to
the stored preference, because `getSettings()` merges the defaults and that
fallback would invent a shortcut with nothing behind it. The recorders are
disabled on Chrome, because saving a preference that can never fire is how the
previous "Saved!" lie happened.

The bindings also change outside the page: they live in browser preferences, and
`storage.onChanged` cannot observe those. The options page therefore re-reads
them on mount and again whenever the tab becomes visible or regains focus, which
covers the user's path back from `chrome://extensions/shortcuts` — otherwise
the fields kept showing whatever was bound when the page first loaded.

Firefox does implement `commands.update()`, so there the combination is
recorded as usual, applied immediately, and reported as the binding the
browser actually has (for example `Currently active: Alt + T`).

The capability is feature-detected rather than sniffed from the browser name, so
if Chrome ever ships `update()` this limitation disappears with no code change.

## Why not a page-level key listener

A content script that listens for keypresses would be simpler to control, and
would let a binding work regardless of what the browser reserves. It is
deliberately not used here:

- The extension injects nothing into a page until translation starts, in order
  to keep the default experience free of any per-page overhead. A key listener
  would mean injecting into every page, all the time.
- A listener only exists on tabs that are already translating, so the hotkey
  could not start a translation in the first place — only undo one. The
  `commands` channel is the only way to toggle from a cold tab.

## Implementation notes

- `lib/hotkey.ts` owns the shortcut-string rules: validation and formatting for
  display, and conversion from a `KeyboardEvent` to a shortcut string. Both the
  options page and the background use it so they cannot disagree. It also names
  the two commands and their defaults.
- Each shortcut is stored as a plain string, `settings.toggleHotkey` and
  `settings.retranslateHotkey`. `''` means off. Profiles written before the
  second command existed stored the toggle's binding as `hotkey`; `getSettings()`
  and `saveSettings()` migrate that key to `toggleHotkey` and drop it, so the
  user's own binding survives the upgrade instead of reverting to the default.
- `lib/message.ts` carries `setHotkey` and `getHotkeyState` between the options
  page and the background, both taking the command they apply to. `getHotkeyState`
  returns only `active` and `canApply`; `getAll()` can report either command, so
  a field reads exactly its own binding. It once also returned `saved`, the
  stored preference, which the options page read from `settings` anyway and
  never displayed.
- On browsers that cannot bind shortcuts, a field shows `active` alone. The
  `getSettings()` call merges the defaults, so treating the stored value as a
  fallback would show a shortcut the browser has no binding for.
- The background re-applies both stored shortcuts on install and on browser
  startup, because a service worker restart does not reset the bindings on
  browsers that support `update()`. The two applies are independent: a browser
  that rejects one command's shortcut must not leave the other unbound.
- The background registers `commands.onCommand` whenever that API exists. It is
  feature-detected rather than gated on the build target: an
  `import.meta.env.BROWSER !== 'firefox'` guard was a build-time constant, so
  the bundler stripped the listener out of the Firefox build and the hotkey did
  nothing there while the options page still claimed it was active. Only Firefox
  Android lacks `commands`, and it has no keyboard to bind.
