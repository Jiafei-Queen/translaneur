import { describe, it, expect, vi, afterEach } from 'vitest'
import { menusApi } from './menus'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('menusApi', () => {
  it('prefers the Gecko menus namespace', () => {
    const api = { create: () => {}, onClicked: { addListener: () => {} } }
    vi.stubGlobal('browser', { menus: api })
    expect(menusApi()).toBe(api)
  })

  it('falls back to Chromium/Safari contextMenus', () => {
    const api = { create: () => {}, onClicked: { addListener: () => {} } }
    vi.stubGlobal('browser', { contextMenus: api })
    expect(menusApi()).toBe(api)
  })

  it('returns undefined when neither namespace exists', () => {
    vi.stubGlobal('browser', {})
    expect(menusApi()).toBeUndefined()
  })

  it('ignores a namespace missing create or onClicked', () => {
    vi.stubGlobal('browser', { menus: { create: () => {} } })
    expect(menusApi()).toBeUndefined()
  })
})
