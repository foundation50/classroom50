import { describe, expect, it, vi } from "vitest"
import type { GitHubClient } from "@/github-core/client"
import {
  resolveRepoFeaturesPatch,
  explicitRepoFeaturesPatch,
  patchRepoSurface,
} from "./permissions"

describe("resolveRepoFeaturesPatch", () => {
  it("templated + no override + no template read -> omit all (GitHub defaults)", () => {
    expect(
      resolveRepoFeaturesPatch(undefined, {
        templated: true,
        templateFeatures: null,
      }),
    ).toEqual({})
  })

  it("templated + no override inherits the template's live has_* values", () => {
    expect(
      resolveRepoFeaturesPatch(undefined, {
        templated: true,
        templateFeatures: {
          has_issues: false,
          has_wiki: true,
          has_projects: false,
          has_pull_requests: false,
        },
      }),
    ).toEqual({
      has_issues: false,
      has_wiki: true,
      has_projects: false,
      has_pull_requests: false,
    })
  })

  it("template-less + no override resolves to all-off", () => {
    expect(resolveRepoFeaturesPatch(undefined, { templated: false })).toEqual({
      has_issues: false,
      has_wiki: false,
      has_projects: false,
      has_pull_requests: false,
    })
  })

  it("explicit override wins over the template; absent keys inherit template", () => {
    expect(
      resolveRepoFeaturesPatch(
        { issues: false },
        {
          templated: true,
          templateFeatures: {
            has_issues: true,
            has_wiki: true,
            has_projects: true,
            has_pull_requests: true,
          },
        },
      ),
    ).toEqual({
      has_issues: false,
      has_wiki: true,
      has_projects: true,
      has_pull_requests: true,
    })
  })

  it("template-less honors explicit-on and defaults the rest off", () => {
    expect(
      resolveRepoFeaturesPatch({ wiki: true }, { templated: false }),
    ).toEqual({
      has_issues: false,
      has_wiki: true,
      has_projects: false,
      has_pull_requests: false,
    })
  })
})

describe("patchRepoSurface", () => {
  it("skips the request entirely for an empty patch (inherit)", async () => {
    const request = vi.fn()
    const client = { request } as unknown as GitHubClient
    await patchRepoSurface(client, "org", "repo", {})
    expect(request).not.toHaveBeenCalled()
  })

  it("PATCHes exactly the resolved body when non-empty", async () => {
    const request = vi.fn().mockResolvedValue({})
    const client = { request } as unknown as GitHubClient
    await patchRepoSurface(client, "org", "repo", { has_issues: false })
    expect(request).toHaveBeenCalledWith("/repos/org/repo", {
      method: "PATCH",
      body: { has_issues: false },
    })
  })

  it("fails open: a PATCH error is swallowed, not thrown", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error("422 projects disabled"))
    const client = { request } as unknown as GitHubClient
    await expect(
      patchRepoSurface(client, "org", "repo", { has_projects: true }),
    ).resolves.toBeUndefined()
  })

  it("retries with the forced-only body when the full PATCH is rejected", async () => {
    // Full body inherits has_projects:true (org-banned) plus a forced
    // has_issues:false; the first PATCH 422s, the retry sends only the forced
    // key and lands, so the teacher's override is not silently dropped.
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("422 projects disabled"))
      .mockResolvedValueOnce({})
    const client = { request } as unknown as GitHubClient
    await patchRepoSurface(
      client,
      "org",
      "repo",
      { has_issues: false, has_projects: true },
      { has_issues: false },
    )
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith("/repos/org/repo", {
      method: "PATCH",
      body: { has_issues: false },
    })
  })

  it("does not retry when the explicit subset equals the full body", async () => {
    const request = vi.fn().mockRejectedValue(new Error("422"))
    const client = { request } as unknown as GitHubClient
    // explicit == full (all keys forced), so a retry would be identical -> skip.
    await patchRepoSurface(
      client,
      "org",
      "repo",
      { has_issues: false },
      { has_issues: false },
    )
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe("explicitRepoFeaturesPatch", () => {
  it("returns only the teacher-forced keys, omitting inherited/default ones", () => {
    expect(
      explicitRepoFeaturesPatch({ issues: false, pull_requests: true }),
    ).toEqual({ has_issues: false, has_pull_requests: true })
  })

  it("returns an empty patch when nothing is forced", () => {
    expect(explicitRepoFeaturesPatch(undefined)).toEqual({})
  })
})
