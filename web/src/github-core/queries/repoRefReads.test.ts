import { describe, it, expect, vi } from "vitest"

import { getOldestCommitShaForPath } from "./repoRefReads"
import type { GitHubClient } from "../client"

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
