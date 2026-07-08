import { describe, expect, it, vi } from "vitest"

import { listWorkflowRunsPage, workflowRunsPageKey } from "./activityRuns"
import { GitHubAPIError } from "./errors"
import type { GitHubClient } from "./client"
import type { GitHubWorkflowRun } from "./types"

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/repos/acme/classroom50/actions/runs",
    message: status === 404 ? "Not Found" : `boom ${status}`,
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

const run = (id: number): GitHubWorkflowRun =>
  ({
    id,
    status: "completed",
    conclusion: "success",
    created_at: "2026-07-08T00:00:00Z",
    html_url: `https://github.com/acme/classroom50/actions/runs/${id}`,
    event: "workflow_dispatch",
  }) as GitHubWorkflowRun

describe("workflowRunsPageKey", () => {
  it("keys by org and page, distinct from the banner's active-and-recent key", () => {
    expect(workflowRunsPageKey("acme", 2)).toEqual([
      "github",
      "repo-actions-runs",
      "acme",
      "page",
      2,
    ])
  })
})

describe("listWorkflowRunsPage", () => {
  it("unwraps workflow_runs and sorts newest-first", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ workflow_runs: [run(1), run(3), run(2)] })
    const runs = await listWorkflowRunsPage(
      { request } as unknown as GitHubClient,
      "acme",
      1,
    )
    expect(runs.map((r) => r.id)).toEqual([3, 2, 1])
  })

  it("returns [] on 404 (uninitialized org)", async () => {
    const request = vi.fn().mockRejectedValue(apiError(404))
    await expect(
      listWorkflowRunsPage({ request } as unknown as GitHubClient, "acme", 1),
    ).resolves.toEqual([])
  })

  it("rethrows a non-404", async () => {
    const request = vi.fn().mockRejectedValue(apiError(403))
    await expect(
      listWorkflowRunsPage({ request } as unknown as GitHubClient, "acme", 1),
    ).rejects.toThrow()
  })

  it("sends per_page and page params", async () => {
    const request = vi.fn().mockResolvedValue({ workflow_runs: [] })
    await listWorkflowRunsPage(
      { request } as unknown as GitHubClient,
      "acme",
      3,
      25,
    )
    expect(request).toHaveBeenCalledWith(
      "/repos/acme/classroom50/actions/runs?per_page=25&page=3",
      expect.objectContaining({ method: "GET" }),
    )
  })
})
