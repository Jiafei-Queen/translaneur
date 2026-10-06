import { describe, it, expect, vi, beforeEach } from 'vitest'

const localStore = new Map<string, unknown>()

vi.stubGlobal('browser', {
  storage: {
    local: {
      get: async (key: string) => {
        const val = localStore.get(key)
        return val !== undefined ? { [key]: val } : {}
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) {
          localStore.set(k, v)
        }
      },
    },
  },
})

describe('storage', () => {
  beforeEach(() => {
    localStore.clear()
    vi.resetModules()
  })

  it('getSettings returns defaults when nothing stored', async () => {
    const { getSettings } = await import('./storage')
    const settings = await getSettings()
    expect(settings.provider).toBe('google')
    expect(settings.targetLang).toBeTruthy()
    expect(settings.openai.model).toBe('gpt-6-luna')
  })

  it('saveSettings only persists provided fields', async () => {
    const { saveSettings } = await import('./storage')
    await saveSettings({ targetLang: 'ja' })
    const raw = localStore.get('settings') as Record<string, unknown>
    expect(raw).toEqual({ targetLang: 'ja' })
  })

  it('unmodified fields still fallback to defaults', async () => {
    const { saveSettings, getSettings } = await import('./storage')
    await saveSettings({ targetLang: 'ja' })
    const settings = await getSettings()
    expect(settings.targetLang).toBe('ja')
    expect(settings.provider).toBe('google')
    expect(settings.openai.model).toBe('gpt-6-luna')
  })

  it('multiple partial saves accumulate without overwriting', async () => {
    const { saveSettings, getSettings } = await import('./storage')
    await saveSettings({ targetLang: 'ja' })
    await saveSettings({ provider: 'google' })
    const raw = localStore.get('settings') as Record<string, unknown>
    expect(raw).toEqual({ targetLang: 'ja', provider: 'google' })
    const settings = await getSettings()
    expect(settings.targetLang).toBe('ja')
    expect(settings.provider).toBe('google')
  })

  it('the toggle hotkey defaults to Alt+T for new and pre-existing installs', async () => {
    const { getSettings } = await import('./storage')
    expect((await getSettings()).toggleHotkey).toBe('Alt+T')

    // A profile stored before the hotkey existed has no such key and must
    // still read back as the new default, not undefined.
    localStore.set('settings', { provider: 'google' })
    expect((await getSettings()).toggleHotkey).toBe('Alt+T')
  })

  it('the re-translate hotkey defaults to Alt+R', async () => {
    const { getSettings } = await import('./storage')
    expect((await getSettings()).retranslateHotkey).toBe('Alt+R')

    localStore.set('settings', { provider: 'google' })
    expect((await getSettings()).retranslateHotkey).toBe('Alt+R')
  })

  it('title translation defaults to on and an explicit off round-trips', async () => {
    const { getSettings, saveSettings } = await import('./storage')
    expect((await getSettings()).translateTitle).toBe(true)

    // A profile stored before the setting existed has no such key and must
    // still read back as the new default, not undefined.
    localStore.set('settings', { provider: 'google' })
    expect((await getSettings()).translateTitle).toBe(true)

    await saveSettings({ translateTitle: false })
    expect((await getSettings()).translateTitle).toBe(false)
  })

  it('migrates a stored hotkey into toggleHotkey', async () => {
    // Pre-0.2.2 profiles have one shortcut under `hotkey`. It is the user's own
    // binding, so the upgrade must carry it across rather than drop it back to
    // the default — and must not leave the old key behind to be read as a
    // second source of truth.
    localStore.set('settings', { provider: 'google', hotkey: 'Alt+K' })

    const { getSettings } = await import('./storage')
    expect((await getSettings()).toggleHotkey).toBe('Alt+K')

    const raw = localStore.get('settings') as Record<string, unknown>
    expect(raw.hotkey).toBeUndefined()
    expect(raw.toggleHotkey).toBe('Alt+K')
  })

  it('an empty hotkey means off and round-trips instead of falling back', async () => {
    const { saveSettings, getSettings } = await import('./storage')
    await saveSettings({ toggleHotkey: '' })
    expect((await getSettings()).toggleHotkey).toBe('')

    await saveSettings({ toggleHotkey: 'Alt+Shift+K' })
    expect((await getSettings()).toggleHotkey).toBe('Alt+Shift+K')
  })

  it('the two shortcuts are stored independently', async () => {
    const { saveSettings, getSettings } = await import('./storage')
    await saveSettings({ retranslateHotkey: '' })
    expect((await getSettings()).toggleHotkey).toBe('Alt+T')
    expect((await getSettings()).retranslateHotkey).toBe('')
  })

  it('saving nested openai config persists correctly', async () => {
    const { saveSettings, getSettings } = await import('./storage')
    const openai = {
      apiKey: 'sk-test',
      baseUrl: 'https://custom.api/v1',
      model: 'gpt-4o',
      systemPrompt: 'Translate to {{targetLang}}.',
      extraBody: {},
      maxRequestsPerSecond: 0,
      maxTextsPerRequest: 8,
      maxCharsPerRequest: 1000,
    }
    await saveSettings({ openai })
    const settings = await getSettings()
    expect(settings.openai).toMatchObject(openai)
    expect(settings.provider).toBe('google')
  })

  it('fills in openai fields a stored config predates', async () => {
    localStore.set('settings', {
      openai: {
        apiKey: 'sk-old',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        systemPrompt: 'Translate.',
      },
    })
    const { getSettings } = await import('./storage')
    const { openai } = await getSettings()

    expect(openai.extraBody).toEqual({
      temperature: 0,
      reasoning: { effort: 'none' },
    })
    expect(openai.maxRequestsPerSecond).toBe(5)
    expect(openai.maxTextsPerRequest).toBe(8)
    expect(openai.maxCharsPerRequest).toBe(4096)
  })

  it('a later partial save keeps the openai keys it did not mention', async () => {
    const { saveSettings, getSettings } = await import('./storage')
    const base = await getSettings()
    await saveSettings({
      openai: { ...base.openai, extraBody: { temperature: 0 } },
    })
    await saveSettings({ targetLang: 'ja' })

    const settings = await getSettings()
    expect(settings.openai.extraBody).toEqual({ temperature: 0 })
    expect(settings.openai.model).toBe('gpt-6-luna')
    expect(settings.targetLang).toBe('ja')
  })

  it('peekSettings reports what getSettings last resolved', async () => {
    const { getSettings, peekSettings } = await import('./storage')
    await getSettings()
    expect(peekSettings().openai.maxTextsPerRequest).toBe(8)
  })
})

describe('legacy endpoint migration', () => {
  beforeEach(() => {
    localStore.clear()
    vi.resetModules()
  })

  const legacyOpenAI = {
    apiKey: 'sk-test',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    systemPrompt: 'Translate.',
  }

  it('getSettings strips /chat/completions into baseUrl and persists', async () => {
    localStore.set('settings', { openai: legacyOpenAI })
    const { getSettings } = await import('./storage')
    const settings = await getSettings()
    expect(settings.openai.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(settings.openai).not.toHaveProperty('endpoint')
    const raw = localStore.get('settings') as { openai: Record<string, unknown> }
    expect(raw.openai.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(raw.openai).not.toHaveProperty('endpoint')
  })

  it('keeps a legacy endpoint without the standard suffix verbatim', async () => {
    localStore.set('settings', {
      openai: { ...legacyOpenAI, endpoint: 'https://gateway.local/openai' },
    })
    const { getSettings } = await import('./storage')
    const settings = await getSettings()
    expect(settings.openai.baseUrl).toBe('https://gateway.local/openai')
  })

  it('strips trailing slash left after removing the suffix', async () => {
    localStore.set('settings', {
      openai: { ...legacyOpenAI, endpoint: 'https://api.example.com/v1/chat/completions/' },
    })
    const { getSettings } = await import('./storage')
    const settings = await getSettings()
    expect(settings.openai.baseUrl).toBe('https://api.example.com/v1')
  })

  it('saveSettings migrates the stored legacy value before merging', async () => {
    localStore.set('settings', { openai: legacyOpenAI })
    const { saveSettings } = await import('./storage')
    await saveSettings({ targetLang: 'ja' })
    const raw = localStore.get('settings') as { openai: Record<string, unknown> }
    expect(raw.openai.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(raw.openai).not.toHaveProperty('endpoint')
  })

  it('does not rewrite storage when nothing to migrate', async () => {
    const setSpy = vi.fn()
    localStore.set('settings', {
      openai: {
        apiKey: 'sk-test',
        baseUrl: 'https://a.b/v1',
        model: 'gpt-4o',
        systemPrompt: 'Translate.',
      },
    })
    const { getSettings } = await import('./storage')
    const orig = (globalThis as any).browser.storage.local.set
    ;(globalThis as any).browser.storage.local.set = setSpy
    try {
      await getSettings()
    } finally {
      ;(globalThis as any).browser.storage.local.set = orig
    }
    expect(setSpy).not.toHaveBeenCalled()
  })
})
