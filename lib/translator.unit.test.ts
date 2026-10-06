import { describe, it, expect, vi, beforeEach } from 'vitest'
import { splitTranslation } from './align'
import { chatCompletionsUrl, decodeHTML } from './translator'
import type { Settings } from './storage'

describe('chatCompletionsUrl', () => {
  it('appends /chat/completions to the base URL', () => {
    expect(chatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  it('works with bare domains (DeepSeek style)', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/chat/completions',
    )
  })

  it('ignores trailing slashes', () => {
    expect(chatCompletionsUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })
})

describe('decodeHTML', () => {
  it('decodes the named entities Google Translate emits', () => {
    expect(decodeHTML('Tom &amp; Jerry')).toBe('Tom & Jerry')
    expect(decodeHTML('&lt;b&gt;bold&lt;/b&gt;')).toBe('<b>bold</b>')
    expect(decodeHTML('&quot;hi&quot;')).toBe('"hi"')
    expect(decodeHTML('it&apos;s')).toBe("it's")
    expect(decodeHTML('a&nbsp;b')).toBe('a b')
  })

  it('decodes decimal numeric entities', () => {
    expect(decodeHTML('it&#39;s')).toBe("it's")
    expect(decodeHTML('&#8364;')).toBe('€')
  })

  it('decodes hex numeric entities (lower and upper case)', () => {
    expect(decodeHTML('&#x27;')).toBe("'")
    expect(decodeHTML('&#X27;')).toBe("'")
    expect(decodeHTML('&#x1F600;')).toBe('😀')
  })

  it('leaves unknown named entities untouched', () => {
    expect(decodeHTML('&nosuch;')).toBe('&nosuch;')
  })

  it('leaves out-of-range numeric entities untouched', () => {
    expect(decodeHTML('&#9999999;')).toBe('&#9999999;')
  })

  it('handles mixed content', () => {
    expect(decodeHTML('A &amp; B &lt; C &#8364; D')).toBe('A & B < C € D')
  })

  it('returns input unchanged when no entities present', () => {
    expect(decodeHTML('plain text 中文')).toBe('plain text 中文')
  })
})

const openaiSettings: Settings = {
  provider: 'openai',
  targetLang: 'zh',
  renderMode: 'bilingual',
  developerMode: false,
  debugMode: false,
  customRules: '',
  glossary: '',
  toggleHotkey: 'Alt+T',
  retranslateHotkey: 'Alt+R',
  translateTitle: false,
  openai: {
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    systemPrompt: 'You are a translator. Translate the following text to {{targetLang}}. Return only the translation, no explanations.',
    extraBody: {},
    maxRequestsPerSecond: 0,
    maxTextsPerRequest: 8,
    maxCharsPerRequest: 1000,
  },
}

function mockOpenAIResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  }
}

describe('OpenAI response parsing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('single text skips XML tags', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好世界'))

    const { translate } = await import('./translator')
    const result = await translate(['Hello world'], 'zh', openaiSettings)

    expect(result.texts).toEqual(['你好世界'])
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[1].content).toBe('Hello world')
    expect(body.messages[0].content).not.toContain('<t id=')
  })

  it('batch with all tags closed parses correctly', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockOpenAIResponse('<t id="0">你好</t>\n<t id="1">世界</t>'),
    )

    const { translate } = await import('./translator')
    const result = await translate(['Hello', 'World'], 'zh', openaiSettings)

    expect(result.texts).toEqual(['你好', '世界'])
  })

  it('batch with missing closing tag on last item', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockOpenAIResponse('<t id="0">你好</t>\n<t id="1">世界'),
    )

    const { translate } = await import('./translator')
    const result = await translate(['Hello', 'World'], 'zh', openaiSettings)

    expect(result.texts).toEqual(['你好', '世界'])
  })

  it('batch with missing closing tag on long translation', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockOpenAIResponse(
        '<t id="0">架构与PPA</t>\n<t id="1">麒麟9030属于进化级迭代，并非全新架构设计。',
      ),
    )

    const { translate } = await import('./translator')
    const result = await translate(
      ['Architecture and PPA', 'The Kirin 9030 is an evolutionary step.'],
      'zh',
      openaiSettings,
    )

    expect(result.texts).toEqual([
      '架构与PPA',
      '麒麟9030属于进化级迭代，并非全新架构设计。',
    ])
  })
})

describe('OpenAI batch coherence instruction', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  // The whole point of the instruction: a short block gets disambiguated by
  // the blocks around it instead of guessed at in isolation.
  it('tells the model the blocks are one document in reading order', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockOpenAIResponse('<t id="0">非目标</t>\n<t id="1">世界</t>'),
    )

    const { translate } = await import('./translator')
    await translate(['Non-goal', 'World'], 'zh', openaiSettings)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const system = body.messages[0].content
    expect(system).toContain('consecutive segments of a single document')
    expect(system).toContain('disambiguate polysemous words using the surrounding blocks')
    // The pre-existing format contract has to survive alongside it.
    expect(system).toContain('Keep the XML tags intact')
  })

  it('omits it for a single text, which has no neighbours to be coherent with', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好世界'))

    const { translate } = await import('./translator')
    await translate(['Hello world'], 'zh', openaiSettings)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].content).not.toContain('consecutive segments')
  })

  it('leaves the user message wrapping untouched', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockOpenAIResponse('<t id="0">非目标</t>\n<t id="1">世界</t>'),
    )

    const { translate } = await import('./translator')
    await translate(['Non-goal', 'World'], 'zh', openaiSettings)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[1].content).toBe('<t id="0">Non-goal</t>\n<t id="1">World</t>')
  })
})

describe('OpenAI custom request body params', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  function settingsWith(overrides: Partial<Settings['openai']>): Settings {
    return { ...openaiSettings, openai: { ...openaiSettings.openai, ...overrides } }
  }

  it('lets an explicit reasoning_effort win over the built-in guess', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好'))

    const { translate } = await import('./translator')
    await translate(
      ['Hello'],
      'zh',
      settingsWith({
        baseUrl: 'https://api.openai.com/v1',
        model: 'o3-mini',
        extraBody: { reasoning_effort: 'low' },
      }),
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    // disableOpenAIReasoning writes 'none' for this model+host; the user's
    // value is applied afterwards and must survive.
    expect(body.reasoning_effort).toBe('low')
  })

  it('sends arbitrary params and leaves messages untouched', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好'))

    const { translate } = await import('./translator')
    await translate(
      ['Hello'],
      'zh',
      settingsWith({
        extraBody: { temperature: 0, thinking: { type: 'disabled' } },
      }),
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.temperature).toBe(0)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages).toHaveLength(2)
  })

  it('ignores reserved keys written straight into storage', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好'))

    const { translate } = await import('./translator')
    await translate(
      ['Hello'],
      'zh',
      settingsWith({
        model: 'real-model',
        extraBody: { model: 'hijacked', stream: true },
      }),
    )

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.model).toBe('real-model')
    expect(body).not.toHaveProperty('stream')
  })
})

describe('LLM explanation detection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('single text: returns original when LLM explains instead of translating', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockOpenAIResponse('抱歉，您提供的信息 "rxliuli" 似乎是一个用户名或特定标识，无法直接翻译为中文。'),
    )

    const { translate } = await import('./translator')
    const result = await translate(['rxliuli'], 'zh', openaiSettings)
    expect(result.texts).toEqual(['rxliuli'])
  })

  it('single text: keeps valid translation for short text', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好'))

    const { translate } = await import('./translator')
    const result = await translate(['Hello'], 'zh', openaiSettings)
    expect(result.texts).toEqual(['你好'])
  })

  it('batch: returns original for explained items', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      mockOpenAIResponse(
        '<t id="0">抱歉，rxliuli 是一个用户名，无法翻译为中文。如果您有其他需要翻译的内容，请告诉我。</t>\n<t id="1">你好世界</t>',
      ),
    )

    const { translate } = await import('./translator')
    const result = await translate(['rxliuli', 'Hello world'], 'zh', openaiSettings)
    expect(result.texts).toEqual(['rxliuli', '你好世界'])
  })
})

const cacheStore = new Map<string, string>()
vi.mock('./cache', () => ({
  getCached: async (text: string, lang: string) => cacheStore.get(`${text}:${lang}`),
  setCached: async (text: string, lang: string, value: string) => {
    cacheStore.set(`${text}:${lang}`, value)
  },
  evictOldEntries: async () => {},
  clearCache: async () => cacheStore.clear(),
}))

const msSettings: Settings = {
  provider: 'microsoft',
  targetLang: 'zh',
  renderMode: 'bilingual',
  developerMode: false,
  debugMode: false,
  customRules: '',
  glossary: '',
  toggleHotkey: 'Alt+T',
  retranslateHotkey: 'Alt+R',
  translateTitle: false,
  openai: {
    apiKey: '',
    baseUrl: '',
    model: '',
    systemPrompt: '',
    extraBody: {},
    maxRequestsPerSecond: 0,
    maxTextsPerRequest: 8,
    maxCharsPerRequest: 1000,
  },
}

const BING_PAGE = `
<html><body data-iid="translator.5023"><script>
var params_AbusePreventionHelper = [123456,"test-token",3600000];
_G={IG:"TESTIG123"};
</script></body></html>
`

function mockBingPageResponse(delay = 0) {
  return async () => {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    return { ok: true, text: async () => BING_PAGE }
  }
}

// Echo mock: translates each newline-joined line of the request text
function mockBingTranslateResponse(text: string) {
  return {
    ok: true,
    json: async () => [
      {
        translations: [
          {
            text: text
              .split('\n')
              .map((l) => `[翻译] ${l}`)
              .join('\n'),
          },
        ],
        detectedLanguage: { language: 'en' },
      },
    ],
  }
}

describe('Bing session dedup', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('concurrent translate calls should fetch the session page only once', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let pageCallCount = 0
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u === 'https://www.bing.com/translator') {
        pageCallCount++
        return mockBingPageResponse(50)()
      }
      const body = new URLSearchParams(init?.body as string)
      return mockBingTranslateResponse(body.get('text')!)
    })

    const { translate } = await import('./translator')

    await Promise.all([
      translate(['hello'], 'zh', msSettings),
      translate(['world'], 'zh', msSettings),
      translate(['foo'], 'zh', msSettings),
      translate(['bar'], 'zh', msSettings),
    ])

    expect(pageCallCount).toBe(1)
  })

  it('cached session skips the page fetch entirely', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let pageCallCount = 0
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u === 'https://www.bing.com/translator') {
        pageCallCount++
        return mockBingPageResponse(0)()
      }
      const body = new URLSearchParams(init?.body as string)
      return mockBingTranslateResponse(body.get('text')!)
    })

    const { translate } = await import('./translator')

    await translate(['first'], 'zh', msSettings)
    expect(pageCallCount).toBe(1)

    await translate(['second'], 'zh', msSettings)
    expect(pageCallCount).toBe(1)
  })

  it('session page failure rejects all waiters', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = url.toString()
      if (u === 'https://www.bing.com/translator') {
        await new Promise((r) => setTimeout(r, 30))
        return { ok: false, status: 500 }
      }
      return { ok: true, json: async () => [] }
    })

    const { translate } = await import('./translator')

    const results = await Promise.allSettled([
      translate(['a'], 'zh', msSettings),
      translate(['b'], 'zh', msSettings),
    ])

    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('rejected')
  })

  it('maps the bare zh code to zh-Hans for Bing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let seenTo = ''
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u === 'https://www.bing.com/translator') {
        return mockBingPageResponse(0)()
      }
      const body = new URLSearchParams(init?.body as string)
      seenTo = body.get('to')!
      return mockBingTranslateResponse(body.get('text')!)
    })

    const { translate } = await import('./translator')
    await translate(['hello'], 'zh', msSettings)

    expect(seenTo).toBe('zh-Hans')
  })

  it('splits a text over the request limit on sentence boundaries', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const sentTexts: string[] = []
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u === 'https://www.bing.com/translator') {
        return mockBingPageResponse(0)()
      }
      const body = new URLSearchParams(init?.body as string)
      sentTexts.push(body.get('text')!)
      return mockBingTranslateResponse(body.get('text')!)
    })

    const { translate } = await import('./translator')
    const sentence = 'This is a fairly long sentence used for testing purposes. '
    const longText = sentence.repeat(30).trim() // ~1700 chars
    const result = await translate([longText], 'zh', msSettings)

    expect(sentTexts.length).toBeGreaterThan(1)
    for (const t of sentTexts) {
      expect(t.length).toBeLessThanOrEqual(950)
    }
    expect(result.texts[0]).toContain('[翻译]')
  })
})

describe('chunked concurrent translation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('large batch is split into chunks with correct results', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let maxConcurrent = 0
    let currentConcurrent = 0

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u === 'https://www.bing.com/translator') {
        return mockBingPageResponse(0)()
      }
      currentConcurrent++
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
      await new Promise((r) => setTimeout(r, 50))
      currentConcurrent--

      const body = new URLSearchParams(init?.body as string)
      return mockBingTranslateResponse(body.get('text')!)
    })

    const { translate } = await import('./translator')
    cacheStore.clear()

    const texts = Array.from({ length: 17 }, (_, i) => `text ${i}`)

    const results = new Array<string>(texts.length)
    const uncachedIndices = texts.map((_, i) => i)

    const CHUNK_SIZE = 5
    const MAX_CONCURRENCY = 4
    const chunks: number[][] = []
    for (let i = 0; i < uncachedIndices.length; i += CHUNK_SIZE) {
      chunks.push(uncachedIndices.slice(i, i + CHUNK_SIZE))
    }

    let next = 0
    async function worker() {
      while (next < chunks.length) {
        const chunkIndices = chunks[next++]
        const chunkTexts = chunkIndices.map((i) => texts[i])
        const translated = await translate(chunkTexts, 'zh', msSettings)
        for (let j = 0; j < chunkIndices.length; j++) {
          results[chunkIndices[j]] = translated.texts[j]
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENCY, chunks.length) }, () => worker()),
    )

    expect(chunks).toHaveLength(4)
    for (let i = 0; i < texts.length; i++) {
      expect(results[i]).toBe(`[翻译] text ${i}`)
    }
    expect(maxConcurrent).toBeLessThanOrEqual(MAX_CONCURRENCY)
    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('cached texts skip API calls', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u === 'https://www.bing.com/translator') {
        return mockBingPageResponse(0)()
      }
      const body = new URLSearchParams(init?.body as string)
      return mockBingTranslateResponse(body.get('text')!)
    })

    const { translate } = await import('./translator')
    const { getCached } = await import('./cache')
    cacheStore.clear()

    cacheStore.set('text 0:zh', '[缓存] text 0')
    cacheStore.set('text 2:zh', '[缓存] text 2')

    const texts = ['text 0', 'text 1', 'text 2', 'text 3']
    const results = new Array<string>(texts.length)
    const uncachedIndices: number[] = []

    await Promise.all(
      texts.map(async (text, i) => {
        const cached = await getCached(text, 'zh')
        if (cached !== undefined) {
          results[i] = cached
        } else {
          uncachedIndices.push(i)
        }
      }),
    )

    if (uncachedIndices.length > 0) {
      const chunkTexts = uncachedIndices.map((i) => texts[i])
      const translated = await translate(chunkTexts, 'zh', msSettings)
      for (let j = 0; j < uncachedIndices.length; j++) {
        results[uncachedIndices[j]] = translated.texts[j]
      }
    }

    expect(results[0]).toBe('[缓存] text 0')
    expect(results[1]).toBe('[翻译] text 1')
    expect(results[2]).toBe('[缓存] text 2')
    expect(results[3]).toBe('[翻译] text 3')

    const translateCalls = fetchMock.mock.calls.filter(
      (c) => c[0].toString().includes('ttranslatev3'),
    )
    expect(translateCalls).toHaveLength(1)
    const body = new URLSearchParams(translateCalls[0][1]?.body as string)
    expect(body.get('text')!.split('\n')).toHaveLength(2)
  })
})

const impSettings: Settings = {
  provider: 'imp',
  targetLang: 'zh',
  renderMode: 'bilingual',
  developerMode: false,
  debugMode: false,
  customRules: '',
  glossary: '',
  toggleHotkey: 'Alt+T',
  retranslateHotkey: 'Alt+R',
  translateTitle: false,
  openai: {
    apiKey: '',
    baseUrl: '',
    model: '',
    systemPrompt: '',
    extraBody: {},
    maxRequestsPerSecond: 0,
    maxTextsPerRequest: 8,
    maxCharsPerRequest: 1000,
  },
  imp: {
    apiKey: 'imp-key',
    baseUrl: 'https://imp.rxliuli.com/api/v1',
    model: 'imp-standard',
  },
}

function mockImpResponse(texts: string[], from = 'en') {
  return {
    ok: true,
    json: async () => ({
      texts,
      from,
      usage: { inputTokens: 40, outputTokens: 30, upstreamRequests: 1 },
    }),
  }
}

describe('Imp Credits translate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('POSTs {to, from, texts} to {baseUrl}/translate and returns 1:1 texts', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockImpResponse(['你好', '世界']))

    const { translate } = await import('./translator')
    const result = await translate(['Hello', 'World'], 'zh', impSettings)

    expect(result.texts).toEqual(['你好', '世界'])
    expect(result.detectedLang).toBe('en')
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://imp.rxliuli.com/api/v1/translate',
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ to: 'zh', from: 'auto', texts: ['Hello', 'World'] })
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.Authorization).toBe('Bearer imp-key')
  })

  it('throws when the Imp api key is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { translate } = await import('./translator')
    const noKey = { ...impSettings, imp: { ...impSettings.imp!, apiKey: '' } }
    await expect(translate(['Hello'], 'zh', noKey)).rejects.toThrow(
      'Connect your Imp account',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on cardinality mismatch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockImpResponse(['only one']))

    const { translate } = await import('./translator')
    await expect(
      translate(['Hello', 'World'], 'zh', impSettings),
    ).rejects.toThrow(/mismatched number/)
  })

  it('maps 402 to a plain message with NO external link (App Store 3.1.1)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // The real imp-credits server embeds an external top-up URL in the 402
    // body — that must never reach the user.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({
        error: 'insufficient balance — top up at https://imp.rxliuli.com/buy',
      }),
    })

    const { translate } = await import('./translator')
    await expect(translate(['Hello'], 'zh', impSettings)).rejects.toThrow(
      'Insufficient credits — top up on the Imp website',
    )
    const caught = await translate(['Hello'], 'zh', impSettings).catch((e: Error) => e)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).not.toMatch(/http|\/buy|imp\.rxliuli\.com/)
  })

  it('maps 401 to a reconnect message', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })

    const { translate } = await import('./translator')
    await expect(translate(['Hello'], 'zh', impSettings)).rejects.toThrow(
      'connection has expired',
    )
  })

  it('maps 429 to a rate-limit message', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: 'rate limit' }) })

    const { translate } = await import('./translator')
    await expect(translate(['Hello'], 'zh', impSettings)).rejects.toThrow(
      'Rate limited',
    )
  })
})

const googleSettings: Settings = { ...msSettings, provider: 'google' }

// Module scope, not scoped to the Google describe below: the glossary block
// needs it too, to prove a glossary never reaches a provider that cannot act
// on it.
function mockGoogleResponse(texts: string[]) {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [texts, ['en']],
  })
  return fetchMock
}

/** The text payload of the nth Google request (0 = the first). */
function sentTexts(
  fetchMock: ReturnType<typeof mockGoogleResponse>,
  call = 0,
): string[] {
  return JSON.parse(fetchMock.mock.calls[call]![1].body as string)[0][0]
}

// Two mechanisms, one feature. OpenAI takes the glossary as prompt
// instructions; Google takes it as sentinels in the text, because it has no
// prompt to put it in. Both are asserted here so neither can be "simplified"
// into the other.
describe('glossary injection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  const systemOf = (fetchMock: ReturnType<typeof vi.fn>) =>
    JSON.parse(fetchMock.mock.calls[0][1].body as string).messages[0].content as string

  it('sends no glossary section when the field is empty', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好'))

    const { translate } = await import('./translator')
    await translate(['Hello'], 'zh', openaiSettings)

    expect(systemOf(fetchMock)).not.toContain('Glossary')
  })

  it('sends each parsed term in the system prompt', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好'))

    const { translate } = await import('./translator')
    await translate(['Hello'], 'zh', {
      ...openaiSettings,
      glossary: 'Transformer = 变换器\n! a comment\nKubernetes = 库伯内特斯',
    })

    const sys = systemOf(fetchMock)
    expect(sys).toContain('- "Transformer" → "变换器"')
    expect(sys).toContain('- "Kubernetes" → "库伯内特斯"')
    expect(sys).not.toContain('a comment')
  })

  // A half-typed line is normal while editing. The options page reports it;
  // the request path must still translate, just without the terms.
  it('degrades to no glossary when the text does not parse', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(mockOpenAIResponse('你好'))

    const { translate } = await import('./translator')
    const result = await translate(['Hello'], 'zh', {
      ...openaiSettings,
      glossary: 'good = 好\nbroken line',
    })

    expect(result.texts).toEqual(['你好'])
    expect(systemOf(fetchMock)).not.toContain('Glossary')
  })

  // Google takes no prompt, so a term reaches it as a sentinel in the text
  // rather than as an instruction. Asserted here because the two paths are
  // deliberately different mechanisms, and the Google one is easy to break by
  // "simplifying" the prompt path to match.
  it('sends terms to Google as sentinels, not as a prompt section', async () => {
    const fetchMock = mockGoogleResponse(['汞是一种化学元素。'])
    const { translate } = await import('./translator')

    const result = await translate(['Mercury is a chemical element.'], 'zh', {
      ...googleSettings,
      glossary: 'Mercury = 汞',
    })

    const sent = sentTexts(fetchMock)
    expect(sent[0]).toMatch(/ZQX\d{1,4}QXZ/)
    expect(sent[0]).not.toContain('Mercury')
    expect(result.texts).toEqual(['汞是一种化学元素。'])
  })

  it('sends no sentinel when the text has no glossary term', async () => {
    const fetchMock = mockGoogleResponse(['你好'])
    const { translate } = await import('./translator')

    await translate(['Hello'], 'zh', { ...googleSettings, glossary: 'Mercury = 汞' })

    expect(sentTexts(fetchMock)).toEqual(['Hello'])
  })

  // A dropped sentinel means the block was translated with the term hidden and
  // reads fine but is missing the term. Redoing it unmasked yields the
  // provider's own rendering, which is a real translation rather than a hole.
  it('resends a block unmasked when the provider drops the sentinel', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // First call: sentinel gone. Second: the unmasked retry.
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [['是一种化学元素。'], ['en']] })
      .mockResolvedValueOnce({ ok: true, json: async () => [['汞是一种化学元素。'], ['en']] })

    const { translate } = await import('./translator')
    const result = await translate(['Mercury is a chemical element.'], 'zh', {
      ...googleSettings,
      glossary: 'Mercury = 汞',
    })

    expect(result.texts).toEqual(['汞是一种化学元素。'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentTexts(fetchMock, 1)[0]).toContain('Mercury')
  })

  it('does not retry when every sentinel came back', async () => {
    // The response has to echo the sentinel, which is what a real provider
    // does — a mock that returns finished text without it is describing a
    // dropped sentinel, and is the previous test's scenario.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string)[0][0][0] as string
      const m = /ZQX\d{1,4}QXZ/.exec(sent)
      return {
        ok: true,
        // Echo only the sentinel back, as a real provider does; the rest of
        // the sentence comes back translated.
        json: async () => [[m![0] + '是一种化学元素。'], ['en']],
      }
    })

    const { translate } = await import('./translator')
    const result = await translate(['Mercury is a chemical element.'], 'zh', {
      ...googleSettings,
      glossary: 'Mercury = 汞',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.texts).toEqual(['汞是一种化学元素。'])
  })
})

describe('Google translateHtml marker passthrough', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    cacheStore.clear()
  })

  it('sends run markers as raw markup and escapes only run text', async () => {
    // The endpoint answers a known inline tag by wrapping the run in it, ids
    // intact but possibly relocated — see docs/marker-behaviour.md.
    const fetchMock = mockGoogleResponse(['<i id="1">甲</i><i id="2">乙</i>'])
    const { translate } = await import('./translator')

    const result = await translate(['⟦1⟧a <b>⟦2⟧b'], 'zh', googleSettings)

    expect(sentTexts(fetchMock)).toEqual([
      '<i id="1">a &lt;b&gt;</i><i id="2">b</i>',
    ])
    expect(result.texts).toEqual(['<i id="1">甲</i><i id="2">乙</i>'])
  })

  it('escapes unmarked bilingual text exactly as before', async () => {
    const fetchMock = mockGoogleResponse(['Tom &amp; Jerry'])
    const { translate } = await import('./translator')

    const result = await translate(['Tom & <b>Jerry'], 'zh', googleSettings)

    expect(sentTexts(fetchMock)).toEqual(['Tom &amp; &lt;b&gt;Jerry'])
    expect(result.texts).toEqual(['Tom & Jerry'])
  })

  it('falls back to proportional cuts when the endpoint drops markers', async () => {
    // Real Google zh response for the Wikipedia tagline: 5 marked runs in, 4
    // markers back. Aligning by source length is what cut "免费百科全书" into
    // "免" | "费百" | "科全书" across the link boundary — the content script
    // now refuses those pieces for blocks with visible run boundaries.
    const fetchMock = mockGoogleResponse([
      '⟦1⟧免费⟦2⟧百科全书，⟦3⟧任何人⟦4⟧都可以编辑。',
    ])
    const { translate } = await import('./translator')

    const result = await translate(
      ['⟦1⟧the ⟦2⟧free⟦3⟧ encyclopedia that ⟦4⟧anyone⟦5⟧ can edit.'],
      'zh',
      googleSettings,
    )

    expect(sentTexts(fetchMock)).toEqual([
      '<i id="1">the </i><i id="2">free</i><i id="3"> encyclopedia that </i><i id="4">anyone</i><i id="5"> can edit.</i>',
    ])
    const runs = ['the ', 'free', ' encyclopedia that ', 'anyone', ' can edit.']
    const split = splitTranslation(result.texts[0]!, runs)
    expect(split.exact).toBe(false)
    expect(split.pieces).toEqual(['免', '费百', '科全书，任何人', '都可', '以编辑。'])
  })
})
