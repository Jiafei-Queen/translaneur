export interface RateLimiter {
  /** Resolves once the caller is allowed to issue a request. */
  acquire(): Promise<void>
  setLimit(perSecond: number): void
}

const WINDOW_MS = 1000

/**
 * Sliding-window limiter, one in-flight `acquire` chain at a time so callers
 * keep FIFO order.
 *
 * The window is in-memory and dies with the MV3 service worker. That is fine:
 * the cap exists to avoid 429s, and a cold worker has at most one request of
 * its own to lose.
 */
export function createRateLimiter(initialPerSecond: number): RateLimiter {
  let perSecond = initialPerSecond > 0 ? initialPerSecond : 0
  let admitted: number[] = []
  let chain: Promise<void> = Promise.resolve()
  let wake: (() => void) | null = null

  function setLimit(next: number): void {
    perSecond = next > 0 ? next : 0
    if (perSecond === 0) {
      admitted = []
      // A parked waiter would otherwise sit out its full sleep after the user
      // has already lifted the cap.
      wake?.()
    }
  }

  async function wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    })
  }

  function acquire(): Promise<void> {
    if (perSecond === 0) return Promise.resolve()
    const turn = chain.then(async () => {
      for (;;) {
        if (perSecond === 0) break
        const now = Date.now()
        admitted = admitted.filter((t) => now - t < WINDOW_MS)
        if (admitted.length < perSecond) break
        await wait(WINDOW_MS - (now - admitted[0]))
      }
      if (perSecond > 0) admitted.push(Date.now())
    })
    // Keep the queue alive when one waiter rejects; the caller still sees it.
    chain = turn.then(
      () => {},
      () => {},
    )
    return turn
  }

  return { acquire, setLimit }
}