import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import { fetchRepoArchive } from "./repoArchiveReads"
import type { GitHubClient } from "./client"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: noRateLimit,
  })

const clientWith = (
  impl: (path: string) => Promise<{ bytes: ArrayBuffer; filename?: string }>,
): GitHubClient => ({ requestBinary: vi.fn(impl) }) as unknown as GitHubClient

describe("fetchRepoArchive", () => {
  it("returns bytes and the header filename on success", async () => {
    const bytes = new Uint8Array([80, 75]).buffer
    const client = clientWith(() =>
      Promise.resolve({ bytes, filename: "owner-repo-sha.zip" }),
    )

    const result = await fetchRepoArchive(client, "org", "cs101-hw1-alice")
    expect(result).toEqual({ bytes, filename: "owner-repo-sha.zip" })
  })

  it("falls back to <repo>.zip when the header has no filename", async () => {
    const bytes = new Uint8Array([1]).buffer
    const client = clientWith(() => Promise.resolve({ bytes }))

    const result = await fetchRepoArchive(client, "org", "cs101-hw1-alice")
    expect(result?.filename).toBe("cs101-hw1-alice.zip")
  })

  it("hits the zipball endpoint for the given owner/repo", async () => {
    const client = clientWith(() =>
      Promise.resolve({ bytes: new Uint8Array([1]).buffer }),
    )

    await fetchRepoArchive(client, "org", "cs101-hw1-alice")
    expect(client.requestBinary).toHaveBeenCalledWith(
      "/repos/org/cs101-hw1-alice/zipball",
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("returns null when the repo 404s (missing/empty)", async () => {
    const client = clientWith(() => Promise.reject(apiError(404)))

    const result = await fetchRepoArchive(client, "org", "cs101-hw1-nobody")
    expect(result).toBeNull()
  })

  it("rethrows a non-tolerated error (e.g. 500)", async () => {
    const client = clientWith(() => Promise.reject(apiError(500)))

    await expect(
      fetchRepoArchive(client, "org", "cs101-hw1-alice"),
    ).rejects.toMatchObject({ status: 500 })
  })
})
