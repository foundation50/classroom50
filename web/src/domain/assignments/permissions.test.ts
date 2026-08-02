import { describe, expect, it, vi } from "vitest"
import type { GitHubClient } from "@/github-core/client"
import { resolveRepoFeaturesPatch, patchRepoSurface } from "./permissions"

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
})
