import { GitHubAPIError } from "../errors"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_QUERIES } from "@/lib/logScopes"

// Shared leaf primitives for github-core reads (the query sub-modules and
// paginate): the scoped logger, the retry loop with its fresh-repo and
// rate-limit policies, and the per-repo read slot. Kept in a leaf (imports only
// ../errors + lib) so every read module can depend on it without forming a
// cycle.
export const log = logger.scope(LOG_SCOPE_QUERIES)

// Max simultaneous per-repo reads. Bounded so a large class doesn't fan out
// into hundreds of concurrent requests (GitHub secondary-rate-limit territory)
// while still beating a strictly-sequential loop.
export const REPO_READ_CONCURRENCY = 8

// Max simultaneous per-repo CONTENT WRITES (tree/commit/ref chains). GitHub's
// secondary-rate-limit guidance is to avoid concurrent content writes — the
// CLI's retrofit loop is serial for the same reason — so bulk write fan-outs
// (e.g. the submission-trigger retrofit) stay effectively sequential while
// still reusing the mapWithConcurrency progress plumbing.
export const REPO_WRITE_CONCURRENCY = 1

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
// client fan-out shouldn't hang a page that long. retryOnRateLimit clamps its
// one wait to this and retries anyway; withTransientRetry (paginate.ts) gives
// the page up instead, so the UI reports an error rather than an indefinite
// spinner.
export const MAX_RATE_LIMIT_WAIT_MS = 8000

export type RetryOptions = {
  // Total attempts, including the first.
  attempts: number
  // Whether `err` is worth another attempt at all.
  shouldRetry: (err: unknown) => boolean
  // How long to wait before attempt `attempt + 1` (0-based `attempt` just
  // failed), or null to give up on this error even though it is retryable
  // (a rate limit longer than a page load can absorb).
  waitMs: (err: unknown, attempt: number) => number | null
  // Aborts the wait and stops retrying once aborted.
  signal?: AbortSignal
  onRetry?: (attempt: number, waitMs: number) => void
}

// The one retry loop under every github-core read retry: fresh-repo lag, a
// rate limit, a transient page failure. Each caller supplies only its policy.
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { attempts, shouldRetry, waitMs, signal, onRetry } = options
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (signal?.aborted || !shouldRetry(err)) throw err
      if (attempt === attempts - 1) break
      const wait = waitMs(err, attempt)
      if (wait === null) throw err
      onRetry?.(attempt, wait)
      await sleep(wait, signal)
    }
  }
  throw lastError
}

// Run a GitHub read, retrying ONCE if it fails with a rate-limit (429, or a 403
// carrying Retry-After / remaining:0). Waits the server's Retry-After (bounded),
// falling back to a short delay when the header is absent. Non-rate-limit errors
// propagate immediately. One retry only — a persistent throttle should surface,
// not loop.
export function retryOnRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    attempts: 2,
    shouldRetry: (err) => err instanceof GitHubAPIError && err.isRateLimited,
    waitMs: (err) => {
      const retryAfter = (err as GitHubAPIError).rateLimit.retryAfter
      const retryAfterMs = retryAfter !== null ? retryAfter * 1000 : 1000
      return Math.min(retryAfterMs, MAX_RATE_LIMIT_WAIT_MS)
    },
  })
}

// Resolve after `ms`, or reject with the signal's reason if it aborts first.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
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
// attempt and may throw a synthetic error to signal non-HTTP lag (e.g., a 200
// with a blank SHA).
export function withFreshRepoRetry<T>(
  fn: () => Promise<T>,
  options: FreshRepoRetryOptions = {},
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500
  const backoffFactor = options.backoffFactor ?? 2
  return withRetry(fn, {
    attempts: options.attempts ?? 6,
    shouldRetry: options.shouldRetry ?? isFreshRepoLagError,
    waitMs: (_err, attempt) => baseDelayMs * backoffFactor ** attempt,
    onRetry: (attempt) =>
      log.debug("fresh-repo lag, retrying read", { attempt: attempt + 1 }),
  })
}
