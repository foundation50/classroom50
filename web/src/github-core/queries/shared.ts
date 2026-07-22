import { GitHubAPIError } from "../errors"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_QUERIES } from "@/lib/logScopes"

// Shared leaf primitives for the read sub-modules: the scoped logger, the
// fresh-repo retry loop, and the per-repo read concurrency cap. Kept in a leaf
// (imports only ../errors + lib) so every read module can depend on it without
// forming a cycle.
export const log = logger.scope(LOG_SCOPE_QUERIES)

// Max simultaneous per-repo reads. Bounded so a large class doesn't fan out
// into hundreds of concurrent requests (GitHub secondary-rate-limit territory)
// while still beating a strictly-sequential loop.
export const REPO_READ_CONCURRENCY = 8

// A small FIFO counting semaphore. Independent per-repo fan-outs (the live
// submissions hook and the group-member hook) can run on the same page load;
// each capping *itself* at REPO_READ_CONCURRENCY still lets their union burst to
// 2x, which is exactly the secondary-rate-limit shape we're avoiding. Sharing
// one semaphore across every per-repo read makes the cap apply to the aggregate
// in-flight requests, not per-pool. FIFO so no waiter starves.
class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.available = Math.max(1, permits)
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.available++
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

// The single gate every per-repo GitHub read passes through, so concurrent
// fan-outs share one budget. mapWithConcurrency still shapes each caller's task
// list; this bounds the aggregate wire concurrency underneath it.
const githubReadSemaphore = new Semaphore(REPO_READ_CONCURRENCY)

export function withGithubReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  return githubReadSemaphore.run(fn)
}

// Retry-After ceiling: a real secondary-limit backoff is usually ~60s, but a
// client fan-out shouldn't hang a page that long. Cap the wait so one throttled
// repo can't stall the batch; beyond this the read surfaces as an error the UI
// reports rather than an indefinite spinner.
const MAX_RATE_LIMIT_WAIT_MS = 8000

// Run a GitHub read, retrying ONCE if it fails with a rate-limit (429, or a 403
// carrying Retry-After / remaining:0). Waits the server's Retry-After (bounded),
// falling back to a short delay when the header is absent. Non-rate-limit errors
// propagate immediately. One retry only — a persistent throttle should surface,
// not loop.
export async function retryOnRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isRateLimited) {
      const retryAfterMs =
        err.rateLimit.retryAfter !== null
          ? err.rateLimit.retryAfter * 1000
          : 1000
      await sleep(Math.min(retryAfterMs, MAX_RATE_LIMIT_WAIT_MS))
      return await fn()
    }
    throw err
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isGitRepositoryEmptyError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("git repository is empty")
  )
}

function isNotFoundError(error: unknown) {
  return (
    error instanceof Error && error.message.toLowerCase().includes("not found")
  )
}

// A freshly-generated repo's git-data APIs lag the 200 from POST .../generate:
// reads 404 and the first write 409s "Git Repository is empty" while GitHub
// seeds. A bare 409 (no empty-repo message) is a real conflict (e.g.
// non-fast-forward updateRef), so the 409 branch is gated on the message.
export function isFreshRepoLagError(error: unknown) {
  if (error instanceof GitHubAPIError) {
    if (error.status === 404) {
      return true
    }
    if (error.status === 409) {
      return isGitRepositoryEmptyError(error)
    }
  }
  return isGitRepositoryEmptyError(error) || isNotFoundError(error)
}

export type FreshRepoRetryOptions = {
  attempts?: number
  baseDelayMs?: number
  // Backoff multiplier between retries. 1 = fixed delay. Default 2.
  backoffFactor?: number
  // Which errors count as retryable lag. Default isFreshRepoLagError.
  shouldRetry?: (error: unknown) => boolean
}

// Retry `fn` while it hits fresh-repo lag. `fn` must re-read its own state each
// attempt and may throw a synthetic error to signal non-HTTP lag (e.g. a 200
// with a blank SHA).
export async function withFreshRepoRetry<T>(
  fn: () => Promise<T>,
  options: FreshRepoRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 6
  const baseDelayMs = options.baseDelayMs ?? 500
  const backoffFactor = options.backoffFactor ?? 2
  const shouldRetry = options.shouldRetry ?? isFreshRepoLagError

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!shouldRetry(err) || attempt === attempts) {
        throw err
      }
      log.debug("fresh-repo lag, retrying read", { attempt })
      await sleep(baseDelayMs * backoffFactor ** (attempt - 1))
    }
  }

  throw lastError
}
