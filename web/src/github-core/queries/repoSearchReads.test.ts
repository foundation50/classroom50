import { describe, it, expect, vi } from "vitest"

import { searchOrgTemplateRepos } from "./repoSearchReads"
import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"

// The picker's whole scaling story is server-side search: an org with tens of
// thousands of repos can't be listed, and `GET /orgs/{org}/repos` doesn't even
// return `is_template`. These pin the query we send and how we read the reply.
describe("searchOrgTemplateRepos", () => {
  function fakeClient(
    payload: unknown = { total_count: 0, incomplete_results: false, items: [] },
  ) {
    const urls: string[] = []
    const request = vi.fn(async (url: string) => {
      urls.push(url)
      if (typeof payload === "function") (payload as () => never)()
      return payload
    })
    return { client: { request } as unknown as GitHubClient, urls }
  }

  // The `q` value is URL-encoded in the path, so assertions read it back out
  // rather than matching encoded bytes.
  function queryOf(url: string): string {
    return new URL(url, "https://api.github.com").searchParams.get("q") ?? ""
  }

  it("scopes the search to the org's template repos, forks included", async () => {
    const { client, urls } = fakeClient()

    await searchOrgTemplateRepos(client, { org: "cs50", query: "starter" })

    const q = queryOf(urls[0])
    expect(q).toContain("org:cs50")
    expect(q).toContain("template:true")
    // Search excludes forks by default, and a forked template is a real case.
    expect(q).toContain("fork:true")
    expect(q).toContain("starter in:name")
  })

  it("omits the name filter and sorts by recency when there is no query", async () => {
    const { client, urls } = fakeClient()

    await searchOrgTemplateRepos(client, { org: "cs50", query: "" })

    expect(queryOf(urls[0])).not.toContain("in:name")
    expect(urls[0]).toContain("sort=updated")
    expect(urls[0]).toContain("order=desc")
  })

  it("encodes a query containing characters that would break the URL", async () => {
    const { client, urls } = fakeClient()

    await searchOrgTemplateRepos(client, { org: "cs50", query: "a b&c" })

    expect(urls[0]).not.toContain(" ")
    expect(queryOf(urls[0])).toContain("a b&c in:name")
  })

  it("requests the caller's page size", async () => {
    const { client, urls } = fakeClient()

    await searchOrgTemplateRepos(client, {
      org: "cs50",
      query: "x",
      perPage: 12,
    })

    expect(urls[0]).toContain("per_page=12")
  })

  it("maps items to the trimmed shape the picker renders", async () => {
    const { client } = fakeClient({
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          name: "starter",
          full_name: "cs50/starter",
          description: "Problem set starter",
          private: true,
          is_template: true,
          updated_at: "2026-08-01T00:00:00Z",
          html_url: "https://github.com/cs50/starter",
        },
      ],
    })

    const result = await searchOrgTemplateRepos(client, {
      org: "cs50",
      query: "starter",
    })

    expect(result.items).toEqual([
      {
        fullName: "cs50/starter",
        name: "starter",
        description: "Problem set starter",
        private: true,
        updatedAt: "2026-08-01T00:00:00Z",
        htmlUrl: "https://github.com/cs50/starter",
      },
    ])
  })

  it("drops a non-template item so a host that ignores template:true can't leak one", async () => {
    const { client } = fakeClient({
      total_count: 2,
      incomplete_results: false,
      items: [
        { name: "a", full_name: "cs50/a", is_template: true },
        { name: "b", full_name: "cs50/b", is_template: false },
      ],
    })

    const result = await searchOrgTemplateRepos(client, {
      org: "cs50",
      query: "",
    })

    expect(result.items.map((item) => item.name)).toEqual(["a"])
  })

  it("drops an item with no usable full_name", async () => {
    const { client } = fakeClient({
      total_count: 1,
      incomplete_results: false,
      items: [{ name: "a", is_template: true }],
    })

    const result = await searchOrgTemplateRepos(client, {
      org: "cs50",
      query: "",
    })

    expect(result.items).toEqual([])
  })

  it("surfaces total_count so the caller can say how many matches were narrowed", async () => {
    const { client } = fakeClient({
      total_count: 4213,
      incomplete_results: false,
      items: [{ name: "a", full_name: "cs50/a", is_template: true }],
    })

    const result = await searchOrgTemplateRepos(client, {
      org: "cs50",
      query: "",
    })

    expect(result.totalCount).toBe(4213)
  })

  it("surfaces incomplete_results (a timed-out search index)", async () => {
    const { client } = fakeClient({
      total_count: 1,
      incomplete_results: true,
      items: [],
    })

    const result = await searchOrgTemplateRepos(client, {
      org: "cs50",
      query: "",
    })

    expect(result.incomplete).toBe(true)
  })

  it("propagates a rate-limit error instead of swallowing it", async () => {
    // Search has its own 30/min bucket; the caller must be able to tell a
    // throttle apart from an empty result so it can stop retrying.
    const { client } = fakeClient(() => {
      throw new GitHubAPIError({
        status: 403,
        url: "https://api.github.com/search/repositories",
        message: "API rate limit exceeded",
        body: { message: "API rate limit exceeded" },
        rateLimit: {
          limit: 30,
          remaining: 0,
          used: 30,
          reset: null,
          resource: "search",
          retryAfter: null,
        },
        acceptedScopes: null,
        oauthScopes: null,
      })
    })

    await expect(
      searchOrgTemplateRepos(client, { org: "cs50", query: "" }),
    ).rejects.toBeInstanceOf(GitHubAPIError)
  })
})
