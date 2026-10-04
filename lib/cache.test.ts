import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { openDB } from 'idb'
import { getCached, setCached, evictOldEntries, clearCache } from './cache'

describe('cache', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01'))
    await clearCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return undefined for uncached text', async () => {
    expect(await getCached('hello', 'zh')).toBeUndefined()
  })

  it('should return cached translation', async () => {
    await setCached('hello', 'zh', '你好')
    expect(await getCached('hello', 'zh')).toBe('你好')
  })

  it('should separate cache by target language', async () => {
    await setCached('hello', 'zh', '你好')
    await setCached('hello', 'ja', 'こんにちは')
    expect(await getCached('hello', 'zh')).toBe('你好')
    expect(await getCached('hello', 'ja')).toBe('こんにちは')
  })

  it('should return undefined for expired entries', async () => {
    await setCached('hello', 'zh', '你好')
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000)
    expect(await getCached('hello', 'zh')).toBeUndefined()
  })

  it('should evict expired entries by timestamp index', async () => {
    await setCached('old1', 'zh', '旧1')
    await setCached('old2', 'zh', '旧2')

    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000)
    await setCached('new1', 'zh', '新1')

    await evictOldEntries()

    expect(await getCached('old1', 'zh')).toBeUndefined()
    expect(await getCached('old2', 'zh')).toBeUndefined()
    expect(await getCached('new1', 'zh')).toBe('新1')
  })

  it('should keep fresh entries when evicting', async () => {
    await setCached('a', 'zh', '甲')
    await setCached('b', 'zh', '乙')
    await evictOldEntries()
    expect(await getCached('a', 'zh')).toBe('甲')
    expect(await getCached('b', 'zh')).toBe('乙')
  })

  // A pre-revision entry was keyed `${lang}:${text}`. It must be unreadable
  // now: reusing it would hand back a translation produced under the old
  // prompt and make the new one look like it changed nothing. The DB name is
  // spelled out rather than imported because DB_NAME is module-private.
  it('should not read entries written under an older prompt revision', async () => {
    const db = await openDB('imp-translate', 1)
    await db.put('translations', {
      key: 'zh:hello',
      text: '旧提示词下的译文',
      ts: Date.now(),
    })
    db.close()

    expect(await getCached('hello', 'zh')).toBeUndefined()
  })

  // The previous revision's key is hard-coded rather than derived from the
  // constant: this must fail the day the wire form changes again and nobody
  // bumps the revision, which is when every cached entry starts serving the
  // previous wire form's translation for 30 days. The stored value is the
  // `扩大` fragment translation the `<x id>` era produced — wrong, not stale.
  it('should not read entries written under the previous wire form', async () => {
    const db = await openDB('imp-translate', 1)
    await db.put('translations', {
      key: '1:zh:hello',
      text: '<x id="1"></x>扩大',
      ts: Date.now(),
    })
    db.close()

    expect(await getCached('hello', 'zh')).toBeUndefined()
  })
})
