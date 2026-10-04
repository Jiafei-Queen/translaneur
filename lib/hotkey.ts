// WebExtension shortcut-string rules, shared by the options page (which
// records a combination) and the background (which applies it).
//
// Why the browser's `commands` channel and not a page keydown listener: the
// extension injects nothing into a page until translation starts, so a
// content-script hotkey could not work on a cold tab. See docs/hotkey.md.

// The two manifest commands. Their names are the ones in wxt.config.ts, and
// `commands.onCommand` reports them verbatim.
export const TOGGLE_COMMAND = 'toggle-translate'
export const RETRANSLATE_COMMAND = 'retranslate-page'

export const DEFAULT_TOGGLE_HOTKEY = 'Alt+T'
export const DEFAULT_RETRANSLATE_HOTKEY = 'Alt+R'

// Grammar order is fixed by the WebExtension shortcut parser: Ctrl/Alt first,
// then Shift, then the key. MacCtrl appears because macOS normalizes a
// shortcut's "Ctrl" to Command — the browser reports a real Control binding as
// "MacCtrl", so getAll() round-trips must validate. Command stays absent:
// hotkeyFromEvent rejects Meta, so no recorded value can carry it.
const PRIMARY_MODIFIERS: Record<string, true> = {
  Ctrl: true,
  Alt: true,
  MacCtrl: true,
}

// Keys the shortcut grammar accepts as the non-modifier half. Kept explicit
// rather than pattern-matched so a typo in stored data fails validation
// instead of being pushed to browser.commands.update().
const NAMED_KEYS: Record<string, true> = {
  Comma: true,
  Period: true,
  Home: true,
  End: true,
  PageUp: true,
  PageDown: true,
  Space: true,
  Insert: true,
  Delete: true,
  Up: true,
  Down: true,
  Left: true,
  Right: true,
  MediaNextTrack: true,
  MediaPlayPause: true,
  MediaPrevTrack: true,
  MediaStop: true,
}

function isKeyToken(key: string): boolean {
  if (/^[A-Z0-9]$/.test(key)) return true
  if (/^F([1-9]|1[0-2])$/.test(key)) return true
  return NAMED_KEYS[key] === true
}

// True when `raw` is a shortcut string the browser would actually accept.
// Requires Alt or Ctrl so a recording can never swallow plain typing, and
// rejects Ctrl+Alt because Chrome forbids it outright. '' is the "off" state:
// a valid setting, but not a bindable key, so it reports false.
export function isBindableHotkey(raw: string): boolean {
  const parts = raw.split('+').map((p) => p.trim())
  if (parts.length < 2) return false
  if (!isKeyToken(parts[parts.length - 1])) return false

  const mods = parts.slice(0, -1)
  const primary = mods.filter((m) => PRIMARY_MODIFIERS[m] === true)
  const shift = mods.filter((m) => m === 'Shift')
  // Any unrecognized token means this was not a shortcut string we produced.
  if (primary.length + shift.length !== mods.length) return false
  if (primary.length !== 1) return false

  return true
}

// Physical keys, so a non-QWERTY layout still records the letter the user
// pressed. Pure modifiers fire their own keydown first and must be ignored.
// Judged by e.code, never e.key: on macOS Option+E reports e.key === 'Dead'
// and Option+A reports 'å', so a character-level check discarded the only
// event carrying the real key and Alt+<letter> looked unbindable. e.code is
// layout- and compose-independent and always names the key pressed.
const MODIFIER_CODES: Record<string, true> = {
  ShiftLeft: true,
  ShiftRight: true,
  ControlLeft: true,
  ControlRight: true,
  AltLeft: true,
  AltRight: true,
  MetaLeft: true,
  MetaRight: true,
  AltGraph: true,
  CapsLock: true,
  NumLock: true,
  ScrollLock: true,
  OSLeft: true,
  OSRight: true,
}

const CODE_TO_NAMED_KEY: Record<string, string> = {
  Comma: 'Comma',
  Period: 'Period',
  NumpadDecimal: 'Period',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Space: 'Space',
  Insert: 'Insert',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  MediaNextTrack: 'MediaNextTrack',
  MediaPlayPause: 'MediaPlayPause',
  MediaPrevTrack: 'MediaPrevTrack',
  MediaStop: 'MediaStop',
}

function keyTokenFromEvent(e: KeyboardEvent): string | null {
  const code = e.code
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)
  if (digit) return digit[1]
  const f = /^F(\d{1,2})$/.exec(code)
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return `F${f[1]}`
  return CODE_TO_NAMED_KEY[code] ?? null
}

// Records a keypress as a shortcut string, or null when the combination must
// be rejected: no modifier at all, Ctrl+Alt together, or Meta (Command+T is
// reserved by the browser's own menu on macOS, so it can never be bound).
export function hotkeyFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES[e.code] === true) return null
  const key = keyTokenFromEvent(e)
  if (!key) return null
  if (e.ctrlKey && e.altKey) return null
  if (e.metaKey) return null

  const primary: string[] = []
  if (e.ctrlKey) primary.push('Ctrl')
  if (e.altKey) primary.push('Alt')
  if (primary.length === 0) return null
  if (e.shiftKey) primary.push('Shift')

  const shortcut = [...primary, key].join('+')
  return isBindableHotkey(shortcut) ? shortcut : null
}

// The browser reports the *active* binding in its own notation, and macOS
// collapses modifiers into a single glyph-prefixed token: "⌥T", not
// "Alt+T" or "⌥+T". Expand the glyphs so the same shortcut reads the same way
// wherever it is shown.
const GLYPH_MODIFIERS: Record<string, string> = {
  '⌃': 'Ctrl',
  '⌥': 'Alt',
  '⌘': 'Command',
  '⇧': 'Shift',
}

// Display only; the stored and API-facing value stays 'Alt+T'.
export function formatHotkey(shortcut: string): string {
  // Two notations reach here: the extension's own "Alt+T", and the glyph form
  // macOS reports for a binding ("⌥T"), where every modifier and the key form
  // one unsplit token. Branch rather than merge — splitting the glyph form on
  // '+' yields the whole token as one part, so a blind concatenation would
  // duplicate the modifiers.
  if ([...shortcut].some((c) => GLYPH_MODIFIERS[c])) {
    const modifiers: string[] = []
    let key = ''
    for (const c of shortcut) {
      const name = GLYPH_MODIFIERS[c]
      if (name) modifiers.push(name)
      else key += c
    }
    return [...modifiers, key].join(' + ')
  }
  return shortcut.split('+').join(' + ')
}

// Runtime platform check. Build-time constants are wrong here: BROWSER names
// the target engine, not the OS, and a build-time check is exactly what
// stripped the Firefox command listener from the bundle. The Control-key
// rewrite is an OS-level rule shared by every engine.
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  // userAgentData.platform is Chromium-only and absent in Firefox; the legacy
  // platform string is the one signal both engines still expose.
  return /mac/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform,
  )
}

// Storage and UI speak the platform-neutral dialect ("Ctrl+K"); the browser
// speaks its own, where macOS spells a real Control binding "MacCtrl+K".
// Both directions are needed: submitting without the rewrite binds Command on
// macOS, and reading back without it would print "MacCtrl + K" next to a
// stored "Ctrl + K" and read as a bug.
const MAC_CTRL_TOKEN = 'MacCtrl'

// The glyph form a macOS browser reports ("⌃K") carries no "MacCtrl" token and
// is left alone — it is already the platform's own notation, and formatHotkey
// expands it to the same "Ctrl + K" the token form becomes.
function swapCtrlToken(hotkey: string, from: string, to: string): string {
  if (!isMacPlatform()) return hotkey
  return hotkey
    .split('+')
    .map((part) => (part.trim() === from ? to : part))
    .join('+')
}

export function toBrowserShortcut(hotkey: string): string {
  return swapCtrlToken(hotkey, 'Ctrl', MAC_CTRL_TOKEN)
}

export function toStoredShortcut(shortcut: string): string {
  return swapCtrlToken(shortcut, MAC_CTRL_TOKEN, 'Ctrl')
}
