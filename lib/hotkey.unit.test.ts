import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  formatHotkey,
  isBindableHotkey,
  hotkeyFromEvent,
  toBrowserShortcut,
  toStoredShortcut,
} from './hotkey'

function onMac() {
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
}

function offMac() {
  vi.stubGlobal('navigator', { platform: 'Win32' })
}

afterEach(() => vi.unstubAllGlobals())

function keyEvent(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: 't',
    code: 'KeyT',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...over,
  } as KeyboardEvent
}

describe('hotkeyFromEvent', () => {
  it('records Alt+T', () => {
    expect(hotkeyFromEvent(keyEvent({ altKey: true }))).toBe('Alt+T')
  })

  it('records Ctrl+Shift+K in grammar order', () => {
    expect(
      hotkeyFromEvent(
        keyEvent({ ctrlKey: true, shiftKey: true, key: 'K', code: 'KeyK' }),
      ),
    ).toBe('Ctrl+Shift+K')
  })

  it('rejects a bare key so typing is never swallowed', () => {
    expect(hotkeyFromEvent(keyEvent({}))).toBeNull()
  })

  it('rejects Ctrl+Alt, which Chrome refuses outright', () => {
    expect(hotkeyFromEvent(keyEvent({ ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('ignores the bare modifier keydown that precedes the real combo', () => {
    expect(
      hotkeyFromEvent(keyEvent({ key: 'Alt', code: 'AltLeft', altKey: true })),
    ).toBeNull()
    expect(hotkeyFromEvent(keyEvent({ key: 'Shift', code: 'ShiftLeft' }))).toBeNull()
  })

  it('rejects Meta, which the browser menu consumes on macOS', () => {
    expect(hotkeyFromEvent(keyEvent({ metaKey: true, altKey: true }))).toBeNull()
  })

  it('maps physical keys so the recorded letter ignores the layout', () => {
    expect(
      hotkeyFromEvent(
        keyEvent({ altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' }),
      ),
    ).toBe('Alt+Left')
  })

  // macOS Option combinations report a dead key or a composed character in
  // e.key while e.code still names the physical key the browser binds. E,
  // I, N and U all produced 'Dead' and were refused as if unbindable, even
  // though Chrome's own shortcut page assigns them without complaint.
  it('records Alt+E even though macOS reports a dead key', () => {
    expect(
      hotkeyFromEvent(keyEvent({ altKey: true, key: 'Dead', code: 'KeyE' })),
    ).toBe('Alt+E')
  })

  it('records Alt+N, whose e.key is also a dead key on macOS', () => {
    expect(
      hotkeyFromEvent(keyEvent({ altKey: true, key: 'Dead', code: 'KeyN' })),
    ).toBe('Alt+N')
  })

  it('records Alt+A even though Option composes a different character', () => {
    expect(
      hotkeyFromEvent(keyEvent({ altKey: true, key: 'å', code: 'KeyA' })),
    ).toBe('Alt+A')
  })
})

describe('isBindableHotkey', () => {
  it('separates the off state from a real binding', () => {
    expect(isBindableHotkey('')).toBe(false)
    expect(isBindableHotkey('Alt+T')).toBe(true)
  })

  it('refuses combinations the browser would not accept', () => {
    expect(isBindableHotkey('T')).toBe(false)
    expect(isBindableHotkey('Ctrl+Alt+T')).toBe(false)
    expect(isBindableHotkey('Alt+Q!')).toBe(false)
    expect(isBindableHotkey('Alt+F13')).toBe(false)
  })

  // macOS reports a real Control binding as "MacCtrl", so a getAll() value has
  // to survive validation or the options page cannot display it.
  it('accepts the MacCtrl token the browser reports back on macOS', () => {
    expect(isBindableHotkey('MacCtrl+T')).toBe(true)
  })

  // Admitting MacCtrl must not loosen the one-primary-modifier rule: MacCtrl
  // counts as a primary, so this is still two and the recorder cannot produce
  // it either.
  it('still refuses MacCtrl+Alt as two primary modifiers', () => {
    expect(isBindableHotkey('MacCtrl+Alt+T')).toBe(false)
  })
})

describe('shortcut dialect translation', () => {
  it('rewrites Ctrl to MacCtrl on macOS only', () => {
    onMac()
    expect(toBrowserShortcut('Ctrl+T')).toBe('MacCtrl+T')

    offMac()
    expect(toBrowserShortcut('Ctrl+T')).toBe('Ctrl+T')
  })

  it('leaves Alt alone, which means the same thing everywhere', () => {
    onMac()
    expect(toBrowserShortcut('Alt+T')).toBe('Alt+T')
  })

  it('translates a browser binding back to the stored dialect', () => {
    onMac()
    expect(toStoredShortcut('MacCtrl+T')).toBe('Ctrl+T')
  })

  // Storage is the only value shared with a non-mac profile, so a save/apply
  // cycle must not accumulate rewrites.
  it('round-trips a stored shortcut unchanged', () => {
    onMac()
    expect(toStoredShortcut(toBrowserShortcut('Ctrl+Shift+T'))).toBe(
      'Ctrl+Shift+T',
    )
  })

  it('keeps the off state empty', () => {
    onMac()
    expect(toBrowserShortcut('')).toBe('')
    expect(toStoredShortcut('')).toBe('')
  })

  // Verified against Chrome on macOS: a manifest MacCtrl+T binding comes back
  // from getAll() as the glyph "⌃T", not the MacCtrl token. The two read-back
  // notations must land on the same display, or the active-binding line would
  // change shape depending on the browser.
  it('converges on one display for both read-back notations', () => {
    onMac()
    expect(formatHotkey(toStoredShortcut('MacCtrl+T'))).toBe('Ctrl + T')
    expect(formatHotkey(toStoredShortcut('⌃T'))).toBe('Ctrl + T')
  })
})

describe('formatHotkey', () => {
  it('spaces out the form the extension stores', () => {
    expect(formatHotkey('Alt+T')).toBe('Alt + T')
    expect(formatHotkey('Ctrl+Shift+K')).toBe('Ctrl + Shift + K')
  })

  // macOS reports a binding as one unsplit glyph token, not "⌥+T", so the
  // glyphs and the key have to be separated by hand. Merging the two
  // notations instead duplicated the modifiers and rendered "⌥T + Alt".
  it('expands the glyph form macOS reports for the active binding', () => {
    expect(formatHotkey('⌥T')).toBe('Alt + T')
    expect(formatHotkey('⌃⇧K')).toBe('Ctrl + Shift + K')
    // A user can bind Cmd directly in the browser even though the recorder
    // refuses Meta, so the glyph has to stay readable.
    expect(formatHotkey('⌘T')).toBe('Command + T')
  })
})
