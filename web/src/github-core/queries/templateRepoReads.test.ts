import { describe, it, expect, vi } from "vitest"

import {
  filterTemplateRepos,
  listOrgTemplateRepos,
  type TemplateRepoItem,
} from "./templateRepoReads"
import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  full_name: `cs50/${name}`,
  private: false,
  is_template: true,
  ...extra,
})

// GitHub's search API can't be called from the browser (it serves a malformed
// `Access-Control-Allow-Origin: *;` then 502s), so the picker lists the org and
// filters locally. These pin the bounded walk and the filter's ranking.
describe("listOrgTemplateRepos", () => {
  function fakeClient(pages: unknown[][]) {
    const urls: string[] = []
    const request = vi.fn(async (url: string) => {
      urls.push(url)
      const page = Number(
        new URL(url, "https://api.github.com").searchParams.get("page"),
      )
      return pages[page - 1] ?? []
    })
    return { client: { request } as unknown as GitHubClient, urls }
  }

  it("requests the org's repos most-recently-updated first", async () => {
    const { client, urls } = fakeClient([[repo("starter")]])

    await listOrgTemplateRepos(client, { org: "cs50" })

    expect(urls[0]).toContain("/orgs/cs50/repos")
    expect(urls[0]).toContain("per_page=100")
    expect(urls[0]).toContain("sort=updated")
    expect(urls[0]).toContain("direction=desc")
    expect(urls[0]).toContain("type=all")
  })

  it("keeps only template repos", async () => {
    const { client } = fakeClient([
      [repo("starter"), repo("not-a-template", { is_template: false })],
    ])

    const result = await listOrgTemplateRepos(client, { org: "cs50" })

    expect(result.items.map((item) => item.name)).toEqual(["starter"])
  })

  it("maps an item to the shape the picker renders", async () => {
    const { client } = fakeClient([
      [
        repo("starter", {
          description: "Problem set starter",
          private: true,
          updated_at: "2026-08-01T00:00:00Z",
        }),
      ],
    ])

    const result = await listOrgTemplateRepos(client, { org: "cs50" })

    expect(result.items[0]).toEqual({
      fullName: "cs50/starter",
      name: "starter",
      description: "Problem set starter",
      private: true,
      updatedAt: "2026-08-01T00:00:00Z",
    })
  })

  it("stops on a short page without requesting another", async () => {
    const { client, urls } = fakeClient([[repo("a"), repo("b")]])

    await listOrgTemplateRepos(client, { org: "cs50" })

    expect(urls).toHaveLength(1)
  })

  it("follows pagination while pages come back full", async () => {
    // Non-template filler: a page of 100 templates would satisfy the panel and
    // legitimately stop the walk early (covered separately below).
    const full = Array.from({ length: 100 }, (_, i) =>
      repo(`r${i}`, { is_template: false }),
    )
    const { client, urls } = fakeClient([full, [repo("last")]])

    const result = await listOrgTemplateRepos(client, { org: "cs50" })

    expect(urls).toHaveLength(2)
    expect(result.items).toHaveLength(1)
    expect(result.scanned).toBe(101)
    expect(result.truncated).toBe(false)
  })

  it("stops at the page budget and reports truncation", async () => {
    // A huge org must not turn the picker into hundreds of sequential requests.
    const full = Array.from({ length: 100 }, (_, i) =>
      repo(`r${i}`, { is_template: false }),
    )
    const { client, urls } = fakeClient([full, full, full])

    const result = await listOrgTemplateRepos(client, {
      org: "cs50",
      maxPages: 2,
    })

    expect(urls).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.scanned).toBe(200)
  })

  it("does not report truncation when the last page is short", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      repo(`r${i}`, { is_template: false }),
    )
    const { client } = fakeClient([full, [repo("last")]])

    const result = await listOrgTemplateRepos(client, {
      org: "cs50",
      maxPages: 2,
    })

    expect(result.truncated).toBe(false)
  })

  it("offers every repo when the host omits is_template entirely", async () => {
    // Better an unfiltered list than an empty picker the teacher can't explain.
    const { client } = fakeClient([
      [
        { name: "a", full_name: "cs50/a", private: false },
        { name: "b", full_name: "cs50/b", private: false },
      ],
    ])

    const result = await listOrgTemplateRepos(client, { org: "cs50" })

    expect(result.templateFlagPresent).toBe(false)
    expect(result.items).toHaveLength(2)
  })

  it("filters normally when at least one repo carries the flag", async () => {
    const { client } = fakeClient([
      [
        repo("tmpl"),
        { name: "plain", full_name: "cs50/plain", private: false },
      ],
    ])

    const result = await listOrgTemplateRepos(client, { org: "cs50" })

    expect(result.templateFlagPresent).toBe(true)
    expect(result.items.map((item) => item.name)).toEqual(["tmpl"])
  })

  it("encodes the org segment instead of interpolating it raw", async () => {
    const { client, urls } = fakeClient([[repo("starter")]])

    await listOrgTemplateRepos(client, { org: "a b/c" })

    expect(urls[0]).toContain("/orgs/a%20b%2Fc/repos")
  })

  it("keeps the repos already fetched when a later page fails", async () => {
    // A late failure must not turn a usable list into an empty picker.
    const full = Array.from({ length: 100 }, (_, i) => repo(`r${i}`))
    let call = 0
    const request = vi.fn(async () => {
      call += 1
      if (call === 1) return full
      throw new Error("boom")
    })

    const result = await listOrgTemplateRepos(
      { request } as unknown as GitHubClient,
      { org: "cs50" },
    )

    expect(result.items).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  it("stops once it has collected enough templates to fill the panel", async () => {
    // A template-rich org shouldn't pay the full page budget.
    const templates = Array.from({ length: 100 }, (_, i) => repo(`t${i}`))
    const { client, urls } = fakeClient([templates, templates, templates])

    const result = await listOrgTemplateRepos(client, { org: "cs50" })

    expect(urls.length).toBeLessThan(3)
    expect(result.truncated).toBe(true)
  })

  it("keeps paging past non-template repos to find the templates", async () => {
    // The realistic large-org shape: recency-sorted pages are mostly student
    // assignment repos, and the templates are deeper in.
    const students = Array.from({ length: 100 }, (_, i) =>
      repo(`hw1-student${i}`, { is_template: false }),
    )
    const { client, urls } = fakeClient([students, students, [repo("starter")]])

    const result = await listOrgTemplateRepos(client, { org: "cs50" })

    expect(urls).toHaveLength(3)
    expect(result.items.map((item) => item.name)).toEqual(["starter"])
    expect(result.scanned).toBe(201)
  })

  it("propagates an API error instead of reporting an empty org", async () => {
    const request = vi.fn(async () => {
      throw new GitHubAPIError({
        status: 403,
        url: "https://api.github.com/orgs/cs50/repos",
        message: "Forbidden",
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
    })

    await expect(
      listOrgTemplateRepos({ request } as unknown as GitHubClient, {
        org: "cs50",
      }),
    ).rejects.toBeInstanceOf(GitHubAPIError)
  })
})

describe("filterTemplateRepos", () => {
  const items: TemplateRepoItem[] = [
    { fullName: "cs50/ap-cs", name: "ap-cs", private: false },
    { fullName: "cs50/starter", name: "starter", private: false },
    { fullName: "cs50/python-starter", name: "python-starter", private: false },
  ]

  it("returns everything (to the limit) for an empty query", () => {
    expect(filterTemplateRepos(items, "")).toHaveLength(3)
    expect(filterTemplateRepos(items, "   ")).toHaveLength(3)
  })

  it("matches a substring of the name", () => {
    expect(filterTemplateRepos(items, "start").map((i) => i.name)).toEqual([
      "starter",
      "python-starter",
    ])
  })

  it("ranks an earlier name match first", () => {
    // "starter" starts with the needle; "python-starter" only contains it.
    expect(filterTemplateRepos(items, "starter")[0].name).toBe("starter")
  })

  it("is case-insensitive", () => {
    expect(filterTemplateRepos(items, "AP-CS").map((i) => i.name)).toEqual([
      "ap-cs",
    ])
  })

  it("matches against owner/repo so a pasted prefix still narrows", () => {
    expect(filterTemplateRepos(items, "cs50/ap").map((i) => i.name)).toEqual([
      "ap-cs",
    ])
  })

  it("returns nothing when there is no match", () => {
    expect(filterTemplateRepos(items, "nope")).toEqual([])
  })

  it("caps the result at the limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      fullName: `cs50/r${i}`,
      name: `r${i}`,
      private: false,
    }))
    expect(filterTemplateRepos(many, "r", 5)).toHaveLength(5)
  })
})
