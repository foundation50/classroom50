import { describe, it, expect, vi } from "vitest"

import { lastPageNumber, PAGE_FETCH_CONCURRENCY, paginateAll } from "./paginate"
import type { GitHubClient, GitHubRequestOptions } from "./client"
import { GitHubAPIError } from "./errors"

const BASE = "https://api.github.com/orgs/acme/repos?per_page=100"

function linkHeader(last: number) {
  return `<${BASE}&page=2>; rel="next", <${BASE}&page=${last}>; rel="last"`
}

function pageOf(page: number, size = 100) {
  return Array.from({ length: size }, (_, i) => ({ id: page * 1000 + i }))
}

// A client whose page 1 carries `Link` (when `last` is given) and which
// records the order pages were REQUESTED and the peak concurrency.
function fakeClient(opts: {
  pages: Record<number, unknown[]>
  last?: number
  failures?: Record<number, unknown[]>
}) {
  const requested: number[] = []
  let inFlight = 0
  let peak = 0
  const failures = { ...(opts.failures ?? {}) }
  const request = vi.fn(
    async (path: string, options?: GitHubRequestOptions) => {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1)
      requested.push(page)
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      const queued = failures[page]
      if (queued?.length) throw queued.shift()
      if (page === 1 && opts.last !== undefined) {
        options?.onHeaders?.(new Headers({ link: linkHeader(opts.last) }))
      }
      return opts.pages[page] ?? []
    },
  )
  return {
    client: { request } as unknown as GitHubClient,
    requested,
    peak: () => peak,
  }
}

const apiError = (status: number, retryAfter: number | null = null) =>
  new GitHubAPIError({
    status,
    url: BASE,
    message: `HTTP ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter,
    },
  })

describe("paginateAll", () => {
  const makePath = (page: number) => `${BASE}&page=${page}`

  it("fetches pages 2..last concurrently when a bulk listing opts in", async () => {
    const pages = {
      1: pageOf(1),
      2: pageOf(2),
      3: pageOf(3),
      4: pageOf(4, 7),
    }
    const { client, requested, peak } = fakeClient({ pages, last: 4 })
    const all = await paginateAll<{ id: number }>(client, makePath, {
      concurrency: PAGE_FETCH_CONCURRENCY,
    })
    expect(all).toHaveLength(307)
    // Page order survives the parallel fetch.
    expect(all.map((r) => r.id).filter((id) => id % 1000 === 0)).toEqual([
      1000, 2000, 3000, 4000,
    ])
    expect(requested[0]).toBe(1)
    expect([...requested].sort()).toEqual([1, 2, 3, 4])
    expect(peak()).toBeGreaterThan(1)
  })

  it("reads one page at a time by default (callers may sit inside a read slot)", async () => {
    const pages = { 1: pageOf(1), 2: pageOf(2), 3: pageOf(3, 1) }
    const { client, requested, peak } = fakeClient({ pages, last: 3 })
    await paginateAll(client, makePath)
    expect(requested).toEqual([1, 2, 3])
    expect(peak()).toBe(1)
  })

  it("honours the concurrency option", async () => {
    const pages = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [i + 1, pageOf(i + 1)]),
    )
    const { client, peak } = fakeClient({ pages, last: 10 })
    await paginateAll(client, makePath, { concurrency: 2 })
    expect(peak()).toBe(2)
  })

  it("walks one page at a time when the header names no last page", async () => {
    const { client, requested } = fakeClient({
      pages: { 1: pageOf(1), 2: pageOf(2), 3: pageOf(3, 1) },
    })
    const all = await paginateAll(client, makePath)
    expect(all).toHaveLength(201)
    expect(requested).toEqual([1, 2, 3])
  })

  it("returns a short first page in one request", async () => {
    const { client, requested } = fakeClient({ pages: { 1: pageOf(1, 3) } })
    expect(await paginateAll(client, makePath)).toHaveLength(3)
    expect(requested).toEqual([1])
  })

  it("stops at the page cap when a server keeps returning full pages", async () => {
    const request = vi.fn().mockResolvedValue(pageOf(0))
    const client = { request } as unknown as GitHubClient
    const all = await paginateAll(client, makePath)
    expect(request).toHaveBeenCalledTimes(100)
    expect(all).toHaveLength(10_000)
  })

  it("clamps a rel=last beyond the cap instead of fanning out unbounded", async () => {
    const pages = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [i + 1, pageOf(i + 1, 1)]),
    )
    const { client, requested } = fakeClient({ pages, last: 5000 })
    await paginateAll(client, makePath)
    expect(requested).toHaveLength(100)
  })

  it("fails fast on a transient page error unless asked to retry", async () => {
    const { client, requested } = fakeClient({
      pages: { 1: pageOf(1) },
      last: 2,
      failures: { 2: [apiError(502)] },
    })
    await expect(paginateAll(client, makePath)).rejects.toMatchObject({
      status: 502,
    })
    expect(requested.filter((p) => p === 2)).toHaveLength(1)
  })

  it("retries a transient page failure without restarting the walk", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const pages = { 1: pageOf(1), 2: pageOf(2), 3: pageOf(3, 1) }
      const { client, requested } = fakeClient({
        pages,
        last: 3,
        failures: { 2: [apiError(502)] },
      })
      const all = await paginateAll(client, makePath, { retryPages: true })
      expect(all).toHaveLength(201)
      expect(requested.filter((p) => p === 1)).toHaveLength(1)
      expect(requested.filter((p) => p === 2)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits out a short rate limit on one page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const pages = { 1: pageOf(1), 2: pageOf(2, 1) }
      const { client, requested } = fakeClient({
        pages,
        last: 2,
        failures: { 2: [apiError(429, 1)] },
      })
      const all = await paginateAll(client, makePath, { retryPages: true })
      expect(all).toHaveLength(101)
      expect(requested.filter((p) => p === 2)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails at once on a rate limit longer than a page load can absorb", async () => {
    // A real secondary limit asks for ~60s; re-requesting after 8s would only
    // burn requests while GitHub is still refusing.
    const { client, requested } = fakeClient({
      pages: { 1: pageOf(1) },
      last: 2,
      failures: { 2: [apiError(403, 60)] },
    })
    await expect(
      paginateAll(client, makePath, { retryPages: true }),
    ).rejects.toMatchObject({ status: 403 })
    expect(requested.filter((p) => p === 2)).toHaveLength(1)
  })

  it("fails at once on a rate limit with no Retry-After", async () => {
    const primaryLimit = new GitHubAPIError({
      status: 403,
      url: BASE,
      message: "API rate limit exceeded",
      body: null,
      rateLimit: {
        limit: 5000,
        remaining: 0,
        used: 5000,
        reset: null,
        resource: null,
        retryAfter: null,
      },
    })
    const { client, requested } = fakeClient({
      pages: { 1: pageOf(1) },
      last: 2,
      failures: { 2: [primaryLimit] },
    })
    await expect(
      paginateAll(client, makePath, { retryPages: true }),
    ).rejects.toMatchObject({ status: 403 })
    expect(requested.filter((p) => p === 2)).toHaveLength(1)
  })

  it("aborts the sibling pages once one page fails for good", async () => {
    const seenSignals: AbortSignal[] = []
    let inFlight = 0
    const request = vi.fn(
      async (path: string, options?: GitHubRequestOptions) => {
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1)
        if (page === 1) {
          options?.onHeaders?.(new Headers({ link: linkHeader(4) }))
          return pageOf(1)
        }
        if (options?.signal) seenSignals.push(options.signal)
        if (page === 2) throw apiError(404)
        // Pages 3 and 4 are slow; they should be aborted, not completed.
        inFlight++
        await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        })
        return []
      },
    )
    await expect(
      paginateAll({ request } as unknown as GitHubClient, makePath, {
        concurrency: PAGE_FETCH_CONCURRENCY,
      }),
    ).rejects.toMatchObject({ status: 404 })
    expect(inFlight).toBe(2)
    expect(seenSignals.every((s) => s.aborted)).toBe(true)
  })

  it("does not retry a definitive status", async () => {
    const { client, requested } = fakeClient({
      pages: { 1: pageOf(1) },
      last: 2,
      failures: { 2: [apiError(404)] },
    })
    await expect(
      paginateAll(client, makePath, { retryPages: true }),
    ).rejects.toMatchObject({ status: 404 })
    expect(requested.filter((p) => p === 2)).toHaveLength(1)
  })

  it("gives up after the retry budget", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { client, requested } = fakeClient({
        pages: { 1: pageOf(1) },
        last: 2,
        failures: { 2: [apiError(500), apiError(500), apiError(500)] },
      })
      await expect(
        paginateAll(client, makePath, { retryPages: true }),
      ).rejects.toMatchObject({ status: 500 })
      expect(requested.filter((p) => p === 2)).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("forwards the caller's abort to every page", async () => {
    const seen: AbortSignal[] = []
    const controller = new AbortController()
    const request = vi.fn(
      async (path: string, options?: GitHubRequestOptions) => {
        if (options?.signal) seen.push(options.signal)
        if (/page=1\b/.test(path)) {
          options?.onHeaders?.(new Headers({ link: linkHeader(2) }))
          return pageOf(1)
        }
        // The caller gives up while page 2 is in flight.
        controller.abort()
        return pageOf(2, 1)
      },
    )
    await paginateAll({ request } as unknown as GitHubClient, makePath, {
      signal: controller.signal,
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(controller.signal)
    // Later pages get the walk's own signal, linked to the caller's.
    expect(seen[1]).not.toBe(controller.signal)
    expect(seen[1].aborted).toBe(true)
  })

  it("does not retry once aborted", async () => {
    const controller = new AbortController()
    const request = vi.fn(async (path: string) => {
      if (/page=1\b/.test(path)) {
        controller.abort()
        throw new DOMException("Aborted", "AbortError")
      }
      return []
    })
    await expect(
      paginateAll({ request } as unknown as GitHubClient, makePath, {
        signal: controller.signal,
        retryPages: true,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe("lastPageNumber", () => {
  it("reads the page param of the rel=last URL", () => {
    expect(lastPageNumber(linkHeader(90))).toBe(90)
  })

  it("is null without a header, without rel=last, or with a non-numeric page", () => {
    expect(lastPageNumber(null)).toBeNull()
    expect(lastPageNumber("")).toBeNull()
    expect(lastPageNumber(`<${BASE}&page=2>; rel="next"`)).toBeNull()
    expect(lastPageNumber(`<${BASE}&page=abc>; rel="last"`)).toBeNull()
    expect(lastPageNumber(`<not a url>; rel="last"`)).toBeNull()
  })
})
