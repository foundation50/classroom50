import { describe, it, expect, vi } from "vitest"

import {
  getAssignmentRepos,
  getOldestCommitShaForPath,
  getOrgRepos,
} from "./repoRefReads"
import type { GitHubClient, GitHubRequestOptions } from "../client"
import { GitHubAPIError } from "../errors"

// The Feedback-PR base must be frozen at the commit the autograde runner's
// baseline_sha() resolves — the OLDEST commit touching the accept marker. A
// wrong SHA makes the runner refuse to maintain the PR for the repo's whole
// life, so these pin the resolution rule and its pagination.
describe("getOldestCommitShaForPath", () => {
  function fakeClient(pages: Array<Array<{ sha: string }>>) {
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
    await expect(
      getOldestCommitShaForPath(client, "o", "r", ".classroom50.yaml"),
    ).resolves.toBe("accept")
    expect(urls[0]).toContain("path=.classroom50.yaml")
  })

  it("paginates past a full page instead of returning a newer commit", async () => {
    const full = Array.from({ length: 100 }, () => ({ sha: "newer" }))
    const { client, urls } = fakeClient([full, [{ sha: "accept" }]])
    await expect(
      getOldestCommitShaForPath(client, "o", "r", ".classroom50.yaml"),
    ).resolves.toBe("accept")
    expect(urls).toHaveLength(2)
  })

  it("resolves null when nothing touches the path", async () => {
    const { client } = fakeClient([[]])
    await expect(
      getOldestCommitShaForPath(client, "o", "r", ".classroom50.yaml"),
    ).resolves.toBeNull()
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
