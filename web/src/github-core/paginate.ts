import type { GitHubClient } from "./client"
import { GitHubAPIError, isDefinitiveGitHubStatus } from "./errors"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_QUERIES } from "@/lib/logScopes"
import { mapWithConcurrency } from "@/util/concurrency"

const log = logger.scope(LOG_SCOPE_QUERIES)

// Hard cap (100 pages x 100/page = 10k items) so a server that ignores the
// page param and keeps returning full pages can't loop unbounded.
const MAX_PAGES = 100

// Pages fetched at once after page 1 reveals the count. Separate from
// REPO_READ_CONCURRENCY on purpose: a listing walk shouldn't starve the per-repo
// fan-outs that share that semaphore, and vice versa.
export const PAGE_FETCH_CONCURRENCY = 8

// Per-page retry: a single 15s timeout or 5xx on page 40 of 90 used to fail the
// whole query and React Query re-walked every page from 1.
const PAGE_RETRY_ATTEMPTS = 3
const PAGE_RETRY_BASE_MS = 500
const MAX_RATE_LIMIT_WAIT_MS = 8000

export type PaginateOptions = {
  signal?: AbortSignal
  concurrency?: number
  // Retry a page that fails transiently (5xx, rate limit, timeout) instead of
  // failing the walk. Off by default: most callers surface a failure at once
  // and let the user retry; a long walk opts in so one late page out of ninety
  // doesn't send the whole listing back to page 1.
  retryPages?: boolean
}

// Page 1 of a list endpoint plus the page count its `Link: rel="last"` names
// (null when the header names none: a single page, or a cursor-paginated
// endpoint). Lets a caller size the rest of the walk before paying for it.
export type FirstPage<T> = { items: T[]; lastPage: number | null }

// Walk a GitHub list endpoint to exhaustion, 100 items per page. `makePath`
// receives the 1-based page number.
//
// Page 1 is read alone; its `Link: rel="last"` names the page count and the
// remaining pages are fetched concurrently (an org with 9,000 repos is 90
// pages: sequentially that is minutes, in parallel it is seconds). When the
// header names no last page, the walk proceeds one page at a time and stops on
// a short page.
export async function paginateAll<T>(
  client: GitHubClient,
  makePath: (page: number) => string,
  options: PaginateOptions = {},
): Promise<T[]> {
  const first = await paginateFirstPage<T>(client, makePath, options)
  return paginateRemaining(client, makePath, first, options)
}

export async function paginateFirstPage<T>(
  client: GitHubClient,
  makePath: (page: number) => string,
  options: PaginateOptions = {},
): Promise<FirstPage<T>> {
  let linkHeader: string | null = null
  const items = await fetchPage<T>(client, makePath(1), options, (headers) => {
    linkHeader = headers.get("link")
  })
  return { items, lastPage: lastPageNumber(linkHeader) }
}

// Pages 2..last after paginateFirstPage: concurrent when the count is known,
// one at a time (stopping on a short page) when it is not.
export async function paginateRemaining<T>(
  client: GitHubClient,
  makePath: (page: number) => string,
  first: FirstPage<T>,
  options: PaginateOptions = {},
): Promise<T[]> {
  const { concurrency = PAGE_FETCH_CONCURRENCY } = options

  if (first.lastPage === null) {
    return paginateSequentially(client, makePath, first.items, options)
  }

  const lastPage = Math.min(first.lastPage, MAX_PAGES)
  if (first.lastPage > MAX_PAGES) {
    log.warn("pagination hit MAX_PAGES cap, results may be truncated", {
      maxPages: MAX_PAGES,
      lastPage: first.lastPage,
    })
  }

  const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2)
  const rest = await mapWithConcurrency(pages, concurrency, (page) =>
    fetchPage<T>(client, makePath(page), options),
  )
  return first.items.concat(...rest)
}

async function paginateSequentially<T>(
  client: GitHubClient,
  makePath: (page: number) => string,
  first: T[],
  options: PaginateOptions,
): Promise<T[]> {
  const all = [...first]
  let page = 1
  let batch = first

  while (batch.length >= 100 && page < MAX_PAGES) {
    page++
    batch = await fetchPage<T>(client, makePath(page), options)
    all.push(...batch)
  }

  if (batch.length >= 100) {
    log.warn("pagination hit MAX_PAGES cap, results may be truncated", {
      maxPages: MAX_PAGES,
    })
  }

  return all
}

function fetchPage<T>(
  client: GitHubClient,
  path: string,
  options: PaginateOptions,
  onHeaders?: (headers: Headers) => void,
): Promise<T[]> {
  const { signal, retryPages = false } = options
  const read = () =>
    client.request<T[]>(path, { method: "GET", signal, onHeaders })
  return retryPages ? withPageRetry(read, signal) : read()
}

// The page number of the `rel="last"` URL in a `Link` header, or null when the
// header names none (absent, a single page, or a cursor-paginated endpoint).
export function lastPageNumber(linkHeader: string | null): number | null {
  if (!linkHeader) return null
  const match = /<([^>]+)>\s*;\s*[^,]*rel="last"/.exec(linkHeader)
  if (!match) return null
  let page: string | null
  try {
    page = new URL(match[1]).searchParams.get("page")
  } catch {
    return null
  }
  if (!page || !/^\d+$/.test(page)) return null
  return Number(page)
}

// Retry one page on transient failures (5xx, rate limit, timeout, network).
// Definitive statuses (401/403/404) and caller aborts propagate at once.
async function withPageRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < PAGE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (signal?.aborted || !isTransientPageError(err)) throw err
      if (attempt === PAGE_RETRY_ATTEMPTS - 1) break
      const waitMs =
        err instanceof GitHubAPIError && err.isRateLimited
          ? Math.min(
              (err.rateLimit.retryAfter ?? 1) * 1000,
              MAX_RATE_LIMIT_WAIT_MS,
            )
          : PAGE_RETRY_BASE_MS * 2 ** attempt
      log.debug("retrying page", { attempt, waitMs })
      await sleep(waitMs, signal)
    }
  }
  throw lastError
}

function isTransientPageError(err: unknown): boolean {
  if (err instanceof GitHubAPIError) {
    return err.isRateLimited || !isDefinitiveGitHubStatus(err.status)
  }
  // A timeout (`TimeoutError` DOMException) or network failure.
  return !(err instanceof DOMException && err.name === "AbortError")
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
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
