import type { GitHubClient } from "./client"
import { GitHubAPIError } from "./errors"
import { log, MAX_RATE_LIMIT_WAIT_MS, withRetry } from "./queries/shared"
import { mapWithConcurrency } from "@/util/concurrency"

// Hard cap (100 pages x 100/page = 10k items) so a server that ignores the
// page param and keeps returning full pages can't loop unbounded.
const MAX_PAGES = 100

// Pages fetched at once by a bulk listing that opts in via `concurrency`.
// Separate from REPO_READ_CONCURRENCY on purpose: a listing walk shouldn't
// starve the per-repo fan-outs that share that semaphore, and vice versa.
export const PAGE_FETCH_CONCURRENCY = 8

// Per-page retry: a single 15s timeout or 5xx on page 40 of 90 used to fail the
// whole query and React Query re-walked every page from 1. A rate limit whose
// Retry-After exceeds MAX_RATE_LIMIT_WAIT_MS is not waited out: the page fails
// at once rather than being re-requested while GitHub is still refusing.
const PAGE_RETRY_ATTEMPTS = 3
const PAGE_RETRY_BASE_MS = 500

export type PaginateOptions = {
  signal?: AbortSignal
  // Pages fetched at once after page 1 reveals the count. Defaults to 1
  // because many callers already run inside a per-repo read slot
  // (withGithubReadSlot); only top-level bulk listings pass
  // PAGE_FETCH_CONCURRENCY.
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
  const { concurrency = 1 } = options

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

  // One page failing definitively ends the walk; the sibling pages in flight
  // are aborted rather than left to finish (and retry) for nothing.
  const walk = new AbortController()
  const onCallerAbort = () => walk.abort(options.signal?.reason)
  if (options.signal?.aborted) onCallerAbort()
  options.signal?.addEventListener("abort", onCallerAbort, { once: true })
  const pageOptions = { ...options, signal: walk.signal }
  const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2)
  try {
    const rest = await mapWithConcurrency(pages, concurrency, (page) =>
      fetchPage<T>(client, makePath(page), pageOptions),
    )
    return first.items.concat(...rest)
  } catch (err) {
    walk.abort(err)
    throw err
  } finally {
    options.signal?.removeEventListener("abort", onCallerAbort)
  }
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
  return retryPages ? withTransientRetry(read, signal) : read()
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

// Retry one read on transient failures (5xx, short rate limit, timeout,
// network). Every other GitHub status (401/403/404, and a 409/422/451 a
// re-request cannot change), caller aborts, and a rate limit longer than
// MAX_RATE_LIMIT_WAIT_MS propagate at once.
export function withTransientRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  return withRetry(fn, {
    attempts: PAGE_RETRY_ATTEMPTS,
    shouldRetry: isTransientPageError,
    waitMs: retryWaitMs,
    signal,
    onRetry: (attempt, waitMs) =>
      log.debug("retrying page", { attempt, waitMs }),
  })
}

// How long to wait before retrying `err`, or null when the wait would exceed
// what a page load can absorb (a real secondary limit asks for ~60s).
function retryWaitMs(err: unknown, attempt: number): number | null {
  if (err instanceof GitHubAPIError && err.isRateLimited) {
    const retryAfter = err.rateLimit.retryAfter
    if (retryAfter === null) return null
    const waitMs = retryAfter * 1000
    return waitMs > MAX_RATE_LIMIT_WAIT_MS ? null : waitMs
  }
  return PAGE_RETRY_BASE_MS * 2 ** attempt
}

function isTransientPageError(err: unknown): boolean {
  if (err instanceof GitHubAPIError) {
    return err.isRateLimited || err.status >= 500
  }
  // A timeout (`TimeoutError` DOMException) or network failure.
  return !(err instanceof DOMException && err.name === "AbortError")
}
