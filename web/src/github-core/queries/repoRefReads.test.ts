import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  getAssignmentRepos,
  getMarkerBaseline,
  baselineSource,
  getOrgRepos,
  getRootCommitSha,
} from "./repoRefReads"
import type { GitHubClient, GitHubRequestOptions } from "../client"
import { GitHubAPIError } from "../errors"
import {
  commitSubject,
  isShimBackfillCommit,
  SHIM_BACKFILL_COMMIT_MESSAGE,
} from "@/util/commit"

// The Feedback-PR base must be frozen at the commit the autograde runner's
// baseline_sha() resolves — the OLDEST commit touching the accept marker. A
// wrong SHA makes the runner refuse to maintain the PR for the repo's whole
// life, so these pin the resolution rule and its pagination.
describe("getMarkerBaseline", () => {
  type Commit = { sha: string; commit?: { message: string } }
  function fakeClient(pages: Array<Array<Commit>>) {
    const urls: string[] = []
    const request = vi.fn(async (url: string) => {
      urls.push(url)
      const page = Number(new URL(url, "https://x").searchParams.get("page"))
      return pages[page - 1] ?? []
    })
    return { client: { request } as unknown as GitHubClient, urls }
  }

  it("returns the oldest commit from a newest-first single page", async () => {
    const { client, urls } = fakeClient([[{ sha: "newer" }, { sha: "accept" }]])
    await expect(getMarkerBaseline(client, "o", "r")).resolves.toEqual({
      sha: "accept",
      backfilled: false,
    })
    expect(urls[0]).toContain("path=.classroom50.yaml")
  })

  it("paginates past a full page instead of returning a newer commit", async () => {
    const full = Array.from({ length: 100 }, () => ({ sha: "newer" }))
    const { client, urls } = fakeClient([full, [{ sha: "accept" }]])
    await expect(getMarkerBaseline(client, "o", "r")).resolves.toMatchObject({
      sha: "accept",
    })
    expect(urls).toHaveLength(2)
  })

  it("resolves null when nothing touches the marker", async () => {
    const { client } = fakeClient([[]])
    await expect(getMarkerBaseline(client, "o", "r")).resolves.toBeNull()
  })

  // A marker the enable-autograder backfill introduced belongs to a repo
  // accepted without one (no_autograder), whose baseline is the root commit.
  // Anchoring on the backfill would strand a Feedback PR frozen at the root.
  it("flags a marker the shim backfill introduced", async () => {
    const { client } = fakeClient([
      [
        { sha: "edit", commit: { message: "tweak" } },
        { sha: "backfill", commit: { message: SHIM_BACKFILL_COMMIT_MESSAGE } },
      ],
    ])
    await expect(getMarkerBaseline(client, "o", "r")).resolves.toEqual({
      sha: "backfill",
      backfilled: true,
    })
  })
})

// The one place the marker -> backfilled -> root rule lives; every reader
// decides through it, so these cases pin the table for all of them.
describe("baselineSource", () => {
  it("prefers a real marker commit whatever the shape says", () => {
    const marker = { sha: "accept", backfilled: false }
    expect(baselineSource(marker)).toBe("marker")
    expect(baselineSource(marker, { rootIsBaseline: true })).toBe("marker")
  })

  it("moves a backfilled marker to the root, even for a built-in shape", () => {
    const marker = { sha: "backfill", backfilled: true }
    expect(baselineSource(marker)).toBe("root")
    expect(baselineSource(marker, { rootIsBaseline: false })).toBe("root")
  })

  it("uses the root with no marker only when the shape says the root is the seed", () => {
    expect(baselineSource(null, { rootIsBaseline: true })).toBe("root")
    expect(baselineSource(null)).toBe("none")
    expect(baselineSource(null, { rootIsBaseline: false })).toBe("none")
  })

  // The web half of the baseline lockstep: the same golden cases Go
  // contract.ResolveBaselineSource and the Python readers assert. A drift on
  // any side fails its fixture test instead of shipping (regrade_repos.py once
  // shipped without the backfill check because nothing pinned it).
  describe("shared fixture parity", () => {
    const fixtureUrl = new URL(
      "../../../../cli/shared/testdata/baseline_source_cases.json",
      import.meta.url,
    )
    const doc = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
      backfill_subject: string
      cases: {
        name: string
        marker_message: string | null
        root_is_baseline: boolean
        expected: "marker" | "root" | "none"
      }[]
    }

    it("pins the same backfill subject the writer uses", () => {
      expect(doc.cases.length).toBeGreaterThan(0)
      expect(doc.backfill_subject).toBe(
        commitSubject(SHIM_BACKFILL_COMMIT_MESSAGE),
      )
    })

    it.each(doc.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
      const marker =
        c.marker_message === null
          ? null
          : { sha: "x", backfilled: isShimBackfillCommit(c.marker_message) }
      expect(
        baselineSource(marker, { rootIsBaseline: c.root_is_baseline }),
      ).toBe(c.expected)
    })
  })
})

// Only the oldest commit matters, so the walk reads page 1 for the page count
// and jumps straight to the last page.
describe("getRootCommitSha", () => {
  function pagedClient(pages: Array<Array<{ sha: string }>>) {
    const urls: string[] = []
    const request = vi.fn(
      async (url: string, options?: GitHubRequestOptions) => {
        urls.push(url)
        const page = Number(new URL(url, "https://x").searchParams.get("page"))
        if (page === 1 && pages.length > 1) {
          const base = `https://api.github.com${url.replace(/&page=\d+/, "")}`
          options?.onHeaders?.(
            new Headers({
              link: `<${base}&page=2>; rel="next", <${base}&page=${pages.length}>; rel="last"`,
            }),
          )
        }
        return pages[page - 1] ?? []
      },
    )
    return { client: { request } as unknown as GitHubClient, urls }
  }

  it("jumps to the last page and returns its last commit", async () => {
    const full = Array.from({ length: 100 }, () => ({ sha: "newer" }))
    const { client, urls } = pagedClient([
      full,
      full,
      [{ sha: "c" }, { sha: "root" }],
    ])
    await expect(getRootCommitSha(client, "o", "r", "main")).resolves.toBe(
      "root",
    )
    expect(
      urls.map((u) => new URL(u, "https://x").searchParams.get("page")),
    ).toEqual(["1", "3"])
  })

  it("returns the last commit of a single page", async () => {
    const { client, urls } = pagedClient([[{ sha: "work" }, { sha: "root" }]])
    await expect(getRootCommitSha(client, "o", "r", "main")).resolves.toBe(
      "root",
    )
    expect(urls).toHaveLength(1)
  })

  it("resolves null on a commitless branch", async () => {
    const { client } = pagedClient([[]])
    await expect(getRootCommitSha(client, "o", "r", "main")).resolves.toBeNull()
  })
})

// The org listing is the submissions dashboard's "accepted" signal. In a large
// org it is dozens of pages, so when the caller names the repos it will look up
// and there are no more of them than pages left, each is read directly instead.
describe("getOrgRepos / getAssignmentRepos", () => {
  const LIST = "https://api.github.com/orgs/acme/repos?per_page=100"
  const apiError = (status: number) =>
    new GitHubAPIError({
      status,
      url: "x",
      message: `HTTP ${status}`,
      body: null,
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: null,
      },
    })
  const notFound = () => apiError(404)

  // `lastPage` pages of listing, each holding the repos in `pages[n]`;
  // `existing` names answer a direct GET /repos read, anything else 404s.
  // `probeFailures` queues errors a named probe throws before succeeding.
  function fakeOrg(opts: {
    pages: Record<number, string[]>
    lastPage?: number
    existing?: string[]
    probeFailures?: Record<string, unknown[]>
  }) {
    const listed: number[] = []
    const probed: string[] = []
    const urls: string[] = []
    const failures = { ...(opts.probeFailures ?? {}) }
    const request = vi.fn(
      async (path: string, options?: GitHubRequestOptions) => {
        urls.push(path)
        const page = /[?&]page=(\d+)/.exec(path)
        if (page) {
          const n = Number(page[1])
          listed.push(n)
          if (n === 1 && opts.lastPage && opts.lastPage > 1) {
            options?.onHeaders?.(
              new Headers({
                link: `<${LIST}&page=2>; rel="next", <${LIST}&page=${opts.lastPage}>; rel="last"`,
              }),
            )
          }
          return (opts.pages[n] ?? []).map((name) => ({ name, private: true }))
        }
        const name = decodeURIComponent(path.split("/").pop() ?? "")
        probed.push(name)
        const queued = failures[name]
        if (queued?.length) throw queued.shift()
        if (opts.existing?.includes(name)) return { name, private: false }
        throw notFound()
      },
    )
    return {
      client: { request } as unknown as GitHubClient,
      listed,
      probed,
      urls,
    }
  }

  it("walks the whole listing oldest first", async () => {
    const { client, listed, probed, urls } = fakeOrg({
      pages: { 1: ["a"], 2: ["b"], 3: ["c"] },
      lastPage: 3,
    })
    const repos = await getOrgRepos(client, "acme")
    expect(repos?.map((r) => r.name)).toEqual(["a", "b", "c"])
    expect(listed.sort()).toEqual([1, 2, 3])
    expect(probed).toEqual([])
    // A repo created mid-walk lands after the pages in flight, not before.
    expect(urls[0]).toContain("sort=created&direction=asc")
  })

  it("probes the candidates when they are fewer than the pages left", async () => {
    const { client, listed, probed } = fakeOrg({
      pages: { 1: ["cs-hw1-Alice", "other"] },
      lastPage: 10,
      existing: ["cs-hw1-bob"],
    })
    const { repos, complete } = await getAssignmentRepos(client, "acme", [
      "cs-hw1-alice",
      "cs-hw1-bob",
      "cs-hw1-carol",
    ])
    // Page 1 answered alice; bob and carol were read directly; only bob exists.
    expect(listed).toEqual([1])
    expect(probed.sort()).toEqual(["cs-hw1-bob", "cs-hw1-carol"])
    expect(repos?.map((r) => r.name).sort()).toEqual([
      "cs-hw1-Alice",
      "cs-hw1-bob",
      "other",
    ])
    expect(complete).toBe(false)
  })

  it("probes when the candidates equal the pages left", async () => {
    const { client, listed, probed } = fakeOrg({
      pages: { 1: ["a"] },
      lastPage: 3,
    })
    await getAssignmentRepos(client, "acme", ["cs-hw1-bob", "cs-hw1-carol"])
    expect(listed).toEqual([1])
    expect(probed).toHaveLength(2)
  })

  it("lists the rest when the candidates outnumber the pages left", async () => {
    const { client, listed, probed } = fakeOrg({
      pages: { 1: ["a"], 2: ["cs-hw1-bob"] },
      lastPage: 2,
    })
    const { repos, complete } = await getAssignmentRepos(client, "acme", [
      "cs-hw1-bob",
      "cs-hw1-carol",
    ])
    expect(listed.sort()).toEqual([1, 2])
    expect(probed).toEqual([])
    expect(repos?.map((r) => r.name)).toEqual(["a", "cs-hw1-bob"])
    expect(complete).toBe(true)
  })

  it("lists when the page count is unknown", async () => {
    const { client, listed, probed } = fakeOrg({ pages: { 1: ["a"] } })
    const { repos, complete } = await getAssignmentRepos(client, "acme", [
      "cs-hw1-bob",
    ])
    expect(listed).toEqual([1])
    expect(probed).toEqual([])
    expect(repos?.map((r) => r.name)).toEqual(["a"])
    expect(complete).toBe(true)
  })

  it("retries a probe that fails transiently", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { client, probed } = fakeOrg({
        pages: { 1: ["a"] },
        lastPage: 10,
        existing: ["cs-hw1-bob"],
        probeFailures: { "cs-hw1-bob": [apiError(502)] },
      })
      const { repos } = await getAssignmentRepos(client, "acme", ["cs-hw1-bob"])
      expect(probed).toEqual(["cs-hw1-bob", "cs-hw1-bob"])
      expect(repos?.map((r) => r.name)).toEqual(["a", "cs-hw1-bob"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("never reads a probe that keeps failing as absent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { client } = fakeOrg({
        pages: { 1: ["a"] },
        lastPage: 10,
        probeFailures: {
          "cs-hw1-bob": [apiError(502), apiError(502), apiError(502)],
        },
      })
      await expect(
        getAssignmentRepos(client, "acme", ["cs-hw1-bob"]),
      ).rejects.toMatchObject({ status: 502 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("aborts the sibling probes once one fails for good", async () => {
    const seenSignals: AbortSignal[] = []
    const request = vi.fn(
      async (path: string, options?: GitHubRequestOptions) => {
        if (/[?&]page=1\b/.test(path)) {
          options?.onHeaders?.(
            new Headers({
              link: `<${LIST}&page=2>; rel="next", <${LIST}&page=10>; rel="last"`,
            }),
          )
          return [{ name: "a", private: true }]
        }
        if (options?.signal) seenSignals.push(options.signal)
        if (path.endsWith("/cs-hw1-bob")) throw apiError(401)
        // carol's probe is slow; it should be aborted, not completed.
        await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        })
        return { name: "cs-hw1-carol", private: true }
      },
    )
    await expect(
      getAssignmentRepos({ request } as unknown as GitHubClient, "acme", [
        "cs-hw1-bob",
        "cs-hw1-carol",
      ]),
    ).rejects.toMatchObject({ status: 401 })
    expect(seenSignals).toHaveLength(2)
    expect(seenSignals.every((s) => s.aborted)).toBe(true)
  })

  it("resolves null when the org itself 404s", async () => {
    const request = vi.fn().mockRejectedValue(notFound())
    await expect(
      getOrgRepos({ request } as unknown as GitHubClient, "acme"),
    ).resolves.toBeNull()
    await expect(
      getAssignmentRepos({ request } as unknown as GitHubClient, "acme", ["x"]),
    ).resolves.toEqual({ repos: null, complete: false })
  })
})
