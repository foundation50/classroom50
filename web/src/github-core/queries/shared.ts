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
