import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, unknown>()

vi.stubGlobal('browser', {
  storage: {
    local: {
      get: async (key: string | null) => {
        if (key === null) return Object.fromEntries(store)
        const val = store.get(key)
        return val !== undefined ? { [key]: val } : {}
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v)
      },
    },
  },
})

describe('overrides', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('returns undefined when nothing is stored', async () => {
    const { getOverride } = await import('./overrides')
    expect(await getOverride('example.com', 'zh', 'hello')).toBeUndefined()
  })

  it('round-trips an override and persists it', async () => {
    const { getOverride, setOverrides } = await import('./overrides')
    await setOverrides('example.com', 'zh', [{ source: 'hello', translated: '你好' }])
    expect(await getOverride('example.com', 'zh', 'hello')).toBe('你好')
    expect([...store.keys()].some((k) => k.startsWith('override:'))).toBe(true)
  })

  it('scopes overrides by domain, language, and source', async () => {
    const { getOverride, setOverrides } = await import('./overrides')
    await setOverrides('example.com', 'zh', [{ source: 'hello', translated: '你好' }])
    expect(await getOverride('other.com', 'zh', 'hello')).toBeUndefined()
    expect(await getOverride('example.com', 'ja', 'hello')).toBeUndefined()
    expect(await getOverride('example.com', 'zh', 'hi')).toBeUndefined()
  })

  it('ignores non-override keys when loading the mirror', async () => {
    store.set('settings', { provider: 'google' })
    store.set('override:not-json', 42)
    const { getOverride } = await import('./overrides')
    expect(await getOverride('example.com', 'zh', 'hello')).toBeUndefined()
  })
})
