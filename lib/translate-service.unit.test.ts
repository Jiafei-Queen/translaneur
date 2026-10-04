import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTranslateService } from './translate-service'

interface Harness {
  cache: Map<string, string>
  translator: ReturnType<typeof vi.fn>
  setCached: ReturnType<typeof vi.fn>
  service: ReturnType<typeof createTranslateService>
}

function createHarness(opts?: {
  batchWindowMs?: number
  maxBatchSize?: number
  maxBatchChars?: number
  translator?: (texts: string[], lang: string) => Promise<string[]>
  getLimits?: () => {
    batchWindowMs: number
    maxBatchSize: number
    maxBatchChars?: number
  }
}): Harness {
  const cache = new Map<string, string>()
  const setCached = vi.fn(async (text: string, lang: string, translated: string) => {
    cache.set(`${lang}::${text}`, translated)
  })
  const translator = vi.fn(
    opts?.translator ?? (async (texts: string[]) => texts.map((t) => `[${t}]`)),
  )
  const service = createTranslateService({
    getCached: async (text, lang) => cache.get(`${lang}::${text}`),
    setCached,
    translator,
    getLimits:
      opts?.getLimits ??
      (() => ({
        batchWindowMs: opts?.batchWindowMs ?? 50,
        maxBatchSize: opts?.maxBatchSize ?? 10,
        maxBatchChars: opts?.maxBatchChars,
      })),
  })
  return { cache, translator, setCached, service }
}

describe('translate-service', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cache hit resolves without advancing the batch window timer', async () => {
    const h = createHarness()
    h.cache.set('en::hello', 'CACHED')

    const result = await h.service.translate('hello', 'en')

    expect(result).toBe('CACHED')
    expect(h.translator).not.toHaveBeenCalled()
  })

  it('uncached request does not resolve before the batch window elapses', async () => {
    const h = createHarness({ batchWindowMs: 50 })
    let resolved = false
    const promise = h.service.translate('hello', 'en').then((v) => {
      resolved = true
      return v
    })

    await vi.advanceTimersByTimeAsync(49)
    expect(resolved).toBe(false)
    expect(h.translator).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toBe('[hello]')
    expect(h.translator).toHaveBeenCalledOnce()
  })

  it('cache hit short-circuits even when an uncached request is pending in the same window', async () => {
    const h = createHarness({ batchWindowMs: 50 })
    h.cache.set('en::cached-text', 'CACHED')

    const uncachedPromise = h.service.translate('uncached-text', 'en')
    const cachedPromise = h.service.translate('cached-text', 'en')

    await expect(cachedPromise).resolves.toBe('CACHED')
    expect(h.translator).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    await expect(uncachedPromise).resolves.toBe('[uncached-text]')
    expect(h.translator).toHaveBeenCalledOnce()
    expect(h.translator).toHaveBeenCalledWith(['uncached-text'], 'en')
  })

  it('batches multiple uncached requests within the window into one translator call', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const p1 = h.service.translate('a', 'en')
    const p2 = h.service.translate('b', 'en')
    const p3 = h.service.translate('c', 'en')

    await vi.advanceTimersByTimeAsync(50)

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['[a]', '[b]', '[c]'])
    expect(h.translator).toHaveBeenCalledOnce()
    expect(h.translator).toHaveBeenCalledWith(['a', 'b', 'c'], 'en')
  })

  it('dedupes identical texts within the same batch', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const p1 = h.service.translate('same', 'en')
    const p2 = h.service.translate('same', 'en')
    const p3 = h.service.translate('other', 'en')

    await vi.advanceTimersByTimeAsync(50)

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['[same]', '[same]', '[other]'])
    expect(h.translator).toHaveBeenCalledOnce()
    expect(h.translator).toHaveBeenCalledWith(['same', 'other'], 'en')
  })

  it('flushes immediately when maxBatchSize is reached', async () => {
    const h = createHarness({ batchWindowMs: 50, maxBatchSize: 3 })

    const p1 = h.service.translate('a', 'en')
    const p2 = h.service.translate('b', 'en')
    const p3 = h.service.translate('c', 'en')

    await vi.advanceTimersByTimeAsync(0)
    expect(h.translator).toHaveBeenCalledOnce()

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['[a]', '[b]', '[c]'])
  })

  it('flushes existing batch when next item would exceed maxBatchChars', async () => {
    const h = createHarness({
      batchWindowMs: 50,
      maxBatchSize: 100,
      maxBatchChars: 10,
    })

    const p1 = h.service.translate('hello', 'en')
    const p2 = h.service.translate('world', 'en')
    const p3 = h.service.translate('foo', 'en')

    await vi.advanceTimersByTimeAsync(0)
    expect(h.translator).toHaveBeenCalledOnce()
    expect(h.translator).toHaveBeenCalledWith(['hello', 'world'], 'en')

    await vi.advanceTimersByTimeAsync(50)
    expect(h.translator).toHaveBeenCalledTimes(2)
    expect(h.translator).toHaveBeenNthCalledWith(2, ['foo'], 'en')

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
      '[hello]',
      '[world]',
      '[foo]',
    ])
  })

  it('single oversized text still goes through alone', async () => {
    const h = createHarness({
      batchWindowMs: 50,
      maxBatchSize: 100,
      maxBatchChars: 5,
    })

    const huge = 'x'.repeat(50)
    const p = h.service.translate(huge, 'en')

    await vi.advanceTimersByTimeAsync(50)
    await expect(p).resolves.toBe(`[${huge}]`)
    expect(h.translator).toHaveBeenCalledOnce()
    expect(h.translator).toHaveBeenCalledWith([huge], 'en')
  })

  it('separate languages flush independently', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const en = h.service.translate('hi', 'en')
    const ja = h.service.translate('hi', 'ja')

    await vi.advanceTimersByTimeAsync(50)

    await expect(en).resolves.toBe('[hi]')
    await expect(ja).resolves.toBe('[hi]')
    expect(h.translator).toHaveBeenCalledTimes(2)
    expect(h.translator).toHaveBeenCalledWith(['hi'], 'en')
    expect(h.translator).toHaveBeenCalledWith(['hi'], 'ja')
  })

  it('writes results to cache via setCached after a successful flush', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const p = h.service.translate('hello', 'en')
    await vi.advanceTimersByTimeAsync(50)
    await p

    expect(h.setCached).toHaveBeenCalledWith('hello', 'en', '[hello]')
    expect(h.cache.get('en::hello')).toBe('[hello]')
  })

  it('subsequent identical request is served from cache without translator call', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const p1 = h.service.translate('hello', 'en')
    await vi.advanceTimersByTimeAsync(50)
    await p1
    expect(h.translator).toHaveBeenCalledOnce()

    const second = await h.service.translate('hello', 'en')
    expect(second).toBe('[hello]')
    expect(h.translator).toHaveBeenCalledOnce()
  })

  it('rejects all pending in the batch when translator throws', async () => {
    const h = createHarness({
      batchWindowMs: 50,
      translator: async () => {
        throw new Error('upstream down')
      },
    })

    const p1 = h.service.translate('a', 'en')
    const p2 = h.service.translate('b', 'en')
    const r1 = expect(p1).rejects.toThrow('upstream down')
    const r2 = expect(p2).rejects.toThrow('upstream down')

    await vi.advanceTimersByTimeAsync(50)

    await r1
    await r2
  })

  it('does not cache result when translation equals original text', async () => {
    const h = createHarness({
      batchWindowMs: 50,
      translator: async (texts) => texts.map((t) => t),
    })

    const p = h.service.translate('hello', 'en')
    await vi.advanceTimersByTimeAsync(50)
    await p

    expect(h.setCached).not.toHaveBeenCalled()
    expect(h.cache.has('en::hello')).toBe(false)
  })

  it('does not cache empty or whitespace-only translation results', async () => {
    const h = createHarness({
      batchWindowMs: 50,
      translator: async (texts) => texts.map(() => ''),
    })

    const p = h.service.translate('hello', 'en')
    await vi.advanceTimersByTimeAsync(50)
    await p

    expect(h.setCached).not.toHaveBeenCalled()
    expect(h.cache.has('en::hello')).toBe(false)
  })

  it('does not cache result when translation differs only in case', async () => {
    const h = createHarness({
      batchWindowMs: 50,
      translator: async (texts) => texts.map((t) => t.toUpperCase()),
    })

    const p = h.service.translate('hello', 'en')
    await vi.advanceTimersByTimeAsync(50)
    await p

    expect(h.setCached).not.toHaveBeenCalled()
  })

  it('requests arriving after a flush form a new batch', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const p1 = h.service.translate('first', 'en')
    await vi.advanceTimersByTimeAsync(50)
    await p1

    const p2 = h.service.translate('second', 'en')
    await vi.advanceTimersByTimeAsync(50)
    await p2

    expect(h.translator).toHaveBeenCalledTimes(2)
    expect(h.translator).toHaveBeenNthCalledWith(1, ['first'], 'en')
    expect(h.translator).toHaveBeenNthCalledWith(2, ['second'], 'en')
  })

  it('force skips the cache read and asks the translator again', async () => {
    const { service, translator } = createHarness()

    const first = service.translate('hello', 'zh')
    await vi.advanceTimersByTimeAsync(50)
    await expect(first).resolves.toBe('[hello]')
    expect(translator).toHaveBeenCalledTimes(1)

    // Cached now, so no translator call.
    await expect(service.translate('hello', 'zh')).resolves.toBe('[hello]')
    expect(translator).toHaveBeenCalledTimes(1)

    // Forced: the read is skipped, so this one goes to the translator.
    const forced = service.translate('hello', 'zh', { force: true })
    await vi.advanceTimersByTimeAsync(50)
    await expect(forced).resolves.toBe('[hello]')
    expect(translator).toHaveBeenCalledTimes(2)
  })

  // A forced pass is a refresh, not a one-off: the fresh answer has to land in
  // the cache, or every later pass would keep paying for the same text.
  it('force overwrites the cache entry with the fresh translation', async () => {
    const cache = new Map<string, string>([['zh::hello', '[old]']])
    const setCached = vi.fn(async (text: string, lang: string, translated: string) => {
      cache.set(`${lang}::${text}`, translated)
    })
    const translator = vi.fn(async (texts: string[]) => texts.map((t) => `[new] ${t}`))
    const service = createTranslateService({
      getCached: async (text, lang) => cache.get(`${lang}::${text}`),
      setCached,
      translator,
      getLimits: () => ({ batchWindowMs: 50, maxBatchSize: 10 }),
    })

    const forced = service.translate('hello', 'zh', { force: true })
    await vi.advanceTimersByTimeAsync(50)
    await expect(forced).resolves.toBe('[new] hello')
    expect(setCached).toHaveBeenCalledWith('hello', 'zh', '[new] hello')

    // …and the next normal request reads that value rather than the stale one.
    await expect(service.translate('hello', 'zh')).resolves.toBe('[new] hello')
    expect(translator).toHaveBeenCalledTimes(1)
  })

  // The system prompt tells the model a batch is one document in reading
  // order. That claim is only true if two documents never share a request.
  it('keeps texts from different scopes out of the same batch', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const p1 = h.service.translate('a', 'en', { scope: '1:0' })
    const p2 = h.service.translate('b', 'en', { scope: '2:0' })

    await vi.advanceTimersByTimeAsync(50)

    await expect(p1).resolves.toBe('[a]')
    await expect(p2).resolves.toBe('[b]')
    expect(h.translator).toHaveBeenCalledTimes(2)
    expect(h.translator).toHaveBeenCalledWith(['a'], 'en')
    expect(h.translator).toHaveBeenCalledWith(['b'], 'en')
  })

  it('still batches normally within one scope', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const p1 = h.service.translate('a', 'en', { scope: '1:0' })
    const p2 = h.service.translate('b', 'en', { scope: '1:0' })

    await vi.advanceTimersByTimeAsync(50)

    await expect(Promise.all([p1, p2])).resolves.toEqual(['[a]', '[b]'])
    expect(h.translator).toHaveBeenCalledOnce()
    expect(h.translator).toHaveBeenCalledWith(['a', 'b'], 'en')
  })

  // A frame is a document, but a string is still a string: the same sentence
  // on two pages is one cache entry. Scope partitions the queue only.
  it('still serves the cache across scopes', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const first = h.service.translate('hello', 'en', { scope: '1:0' })
    await vi.advanceTimersByTimeAsync(50)
    await first
    expect(h.translator).toHaveBeenCalledOnce()

    await expect(h.service.translate('hello', 'en', { scope: '2:0' })).resolves.toBe('[hello]')
    expect(h.translator).toHaveBeenCalledOnce()
  })

  // The per-frame cost: same document, different frames, so two requests. The
  // page and its ad iframe must not be taught to share terminology.
  it('separates frames of the same tab', async () => {
    const h = createHarness({ batchWindowMs: 50 })

    const main = h.service.translate('article', 'en', { scope: '7:0' })
    const iframe = h.service.translate('ad', 'en', { scope: '7:1' })

    await vi.advanceTimersByTimeAsync(50)

    await expect(main).resolves.toBe('[article]')
    await expect(iframe).resolves.toBe('[ad]')
    expect(h.translator).toHaveBeenCalledTimes(2)
  })

  it('picks up a changed maxBatchSize without recreating the service', async () => {
    // The background memoises one service per provider, so limits captured at
    // construction would ignore a change saved on the options page. The batch
    // window is far longer than this test, so only a live read can flush.
    let maxBatchSize = 100
    const h = createHarness({
      getLimits: () => ({ batchWindowMs: 10_000, maxBatchSize }),
    })

    const p1 = h.service.translate('a', 'en')
    const p2 = h.service.translate('b', 'en')
    // translate() awaits the cache lookup before enqueuing, so let the first
    // two land under the old limit before lowering it.
    await vi.advanceTimersByTimeAsync(0)
    maxBatchSize = 2
    const p3 = h.service.translate('c', 'en')

    await vi.advanceTimersByTimeAsync(0)
    expect(h.translator).toHaveBeenCalledOnce()
    expect(h.translator).toHaveBeenCalledWith(['a', 'b', 'c'], 'en')

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
      '[a]',
      '[b]',
      '[c]',
    ])
  })
})
