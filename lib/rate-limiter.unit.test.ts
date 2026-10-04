import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRateLimiter } from './rate-limiter'

describe('createRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves immediately and schedules nothing when unlimited', async () => {
    vi.useFakeTimers()
    const limiter = createRateLimiter(0)

    await limiter.acquire()
    await limiter.acquire()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds the third acquire in a two-per-second window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = createRateLimiter(2)

    await limiter.acquire()
    await limiter.acquire()

    let settled = false
    const third = limiter.acquire().then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1000)
    await third
    expect(settled).toBe(true)
  })

  it('admits immediately once the window has slid past', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = createRateLimiter(1)

    await limiter.acquire()
    await vi.advanceTimersByTimeAsync(1001)

    await limiter.acquire()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a parked waiter as soon as the cap is lifted', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = createRateLimiter(1)

    await limiter.acquire()

    let settled = false
    const parked = limiter.acquire().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    limiter.setLimit(0)
    await vi.advanceTimersByTimeAsync(0)
    await parked
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})