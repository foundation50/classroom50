import { describe, expect, it, vi } from "vitest"
import type { GitHubClient } from "@/github-core/client"
import {
  resolveRepoFeaturesPatch,
  explicitRepoFeaturesPatch,
  patchRepoSurface,
  applyRepoAboutTopics,
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

  it("template-less + no override omits every key (GitHub create defaults)", () => {
    expect(resolveRepoFeaturesPatch(undefined, { templated: false })).toEqual(
      {},
    )
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

  it("template-less honors explicit-on and omits the rest (GitHub defaults)", () => {
    expect(
      resolveRepoFeaturesPatch({ wiki: true }, { templated: false }),
    ).toEqual({
      has_wiki: true,
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

describe("applyRepoAboutTopics (issue #569)", () => {
  it("sends no request when nothing is set", async () => {
    const request = vi.fn()
    const client = { request } as unknown as GitHubClient
    await applyRepoAboutTopics(client, "org", "repo", {})
    expect(request).not.toHaveBeenCalled()
  })

  it("PATCHes the description for About", async () => {
    const request = vi.fn().mockResolvedValue({})
    const client = { request } as unknown as GitHubClient
    await applyRepoAboutTopics(client, "org", "repo", {
      description: "A nice starter",
    })
    expect(request).toHaveBeenCalledWith("/repos/org/repo", {
      method: "PATCH",
      body: { description: "A nice starter" },
    })
  })

  it("PUTs the topics as { names }", async () => {
    const request = vi.fn().mockResolvedValue({})
    const client = { request } as unknown as GitHubClient
    await applyRepoAboutTopics(client, "org", "repo", {
      topics: ["python", "hw"],
    })
    expect(request).toHaveBeenCalledWith("/repos/org/repo/topics", {
      method: "PUT",
      body: { names: ["python", "hw"] },
    })
  })

  it("applies both independently in one call", async () => {
    const request = vi.fn().mockResolvedValue({})
    const client = { request } as unknown as GitHubClient
    await applyRepoAboutTopics(client, "org", "repo", {
      description: "d",
      topics: ["t"],
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("fails open: an About PATCH rejection is swallowed and does not block topics", async () => {
    // The description PATCH 422s; the topics PUT still runs and the call
    // resolves (accept must never be stranded by a best-effort copy).
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("422"))
      .mockResolvedValueOnce({})
    const client = { request } as unknown as GitHubClient
    await expect(
      applyRepoAboutTopics(client, "org", "repo", {
        description: "d",
        topics: ["t"],
      }),
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith("/repos/org/repo/topics", {
      method: "PUT",
      body: { names: ["t"] },
    })
  })

  it("fails open: a topics PUT rejection is swallowed", async () => {
    const request = vi.fn().mockRejectedValue(new Error("403 topics blocked"))
    const client = { request } as unknown as GitHubClient
    await expect(
      applyRepoAboutTopics(client, "org", "repo", { topics: ["t"] }),
    ).resolves.toBeUndefined()
  })
})
