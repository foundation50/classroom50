import { describe, it, expect, vi } from "vitest"

import { listDefaultBranchCommits, listRepoTags } from "./repoDetectionReads"
import type { GitHubClient } from "../client"
import { GitHubAPIError, type GitHubRateLimit } from "../errors"

// The detection reads back branch-mode push counting and tag-mode tag reading.
// They must paginate to exhaustion (a wrong count misleads the gradebook),
// tolerate a not-yet-accepted repo (404 -> empty), and NOT swallow other errors.

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

function fakeClient(pages: Array<Array<unknown>>) {
  const urls: string[] = []
  const request = vi.fn(async (url: string) => {
    urls.push(url)
    const page = Number(new URL(url, "https://x").searchParams.get("page"))
    return pages[page - 1] ?? []
  })
  return { client: { request } as unknown as GitHubClient, urls }
}

function notFound(): GitHubAPIError {
  return new GitHubAPIError({
    status: 404,
    url: "x",
    message: "not found",
    body: null,
    rateLimit: noRateLimit,
  })
}

function serverError(): GitHubAPIError {
  return new GitHubAPIError({
    status: 500,
    url: "x",
    message: "boom",
    body: null,
    rateLimit: noRateLimit,
  })
}

describe("listDefaultBranchCommits", () => {
  it("paginates the default-branch commit log to exhaustion", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ sha: `c${i}` }))
    const { client, urls } = fakeClient([full, [{ sha: "baseline" }]])
    const commits = await listDefaultBranchCommits(client, "o", "r", "main")
    expect(commits).toHaveLength(101)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain("sha=main")
    expect(urls[0]).toContain("/commits?")
  })

  it("treats a 404 (repo not accepted) as an empty log", async () => {
    const request = vi.fn(async () => {
      throw notFound()
    })
    const client = { request } as unknown as GitHubClient
    await expect(
      listDefaultBranchCommits(client, "o", "r", "main"),
    ).resolves.toEqual([])
  })

  it("rethrows a non-404 error instead of silently emptying", async () => {
    const request = vi.fn(async () => {
      throw serverError()
    })
    const client = { request } as unknown as GitHubClient
    await expect(
      listDefaultBranchCommits(client, "o", "r", "main"),
    ).rejects.toBeInstanceOf(GitHubAPIError)
  })
})

describe("listRepoTags", () => {
  it("returns the tag list", async () => {
    const { client, urls } = fakeClient([
      [
        { name: "v1", commit: { sha: "a" } },
        { name: "phase1", commit: { sha: "b" } },
      ],
    ])
    const tags = await listRepoTags(client, "o", "r")
    expect(tags.map((t) => t.name)).toEqual(["v1", "phase1"])
    expect(urls[0]).toContain("/tags?")
  })

  it("treats a 404 as an empty tag list", async () => {
    const request = vi.fn(async () => {
      throw notFound()
    })
    const client = { request } as unknown as GitHubClient
    await expect(listRepoTags(client, "o", "r")).resolves.toEqual([])
  })
})
