import { describe, expect, it, vi } from "vitest"

import {
  getPagesDeploymentStatus,
  isPagesDeploymentInProgress,
  type PagesDeploymentStatus,
} from "./pagesDeploymentReads"
import { GitHubAPIError } from "../errors"
import type { GitHubClient } from "../client"

const SHA = "656e8d140b36230c9ccfe14584b9a81fa8c9c8d0"

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: `/repos/acme/classroom50/pages/deployments/${SHA}`,
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
}

function makeClient(outcome: unknown) {
  const request = vi.fn<(url: string) => Promise<unknown>>(async () => {
    if (outcome instanceof GitHubAPIError) throw outcome
    return outcome
  })
  return { client: { request } as unknown as GitHubClient, request }
}

describe("getPagesDeploymentStatus", () => {
  it("reads the deployment by the sha GitHub named in its refusal", async () => {
    const { client, request } = makeClient({ status: "updating_pages" })
    expect(await getPagesDeploymentStatus(client, "acme", SHA)).toBe(
      "updating_pages",
    )
    expect(request.mock.calls[0][0]).toBe(
      `/repos/acme/classroom50/pages/deployments/${SHA}`,
    )
  })

  it("reads a 404 as gone (the lock has cleared)", async () => {
    const { client } = makeClient(apiError(404))
    expect(await getPagesDeploymentStatus(client, "acme", SHA)).toBeNull()
  })

  it("rethrows other failures", async () => {
    const { client } = makeClient(apiError(500))
    await expect(
      getPagesDeploymentStatus(client, "acme", SHA),
    ).rejects.toThrow()
  })
})

describe("isPagesDeploymentInProgress", () => {
  it("treats every pre-final status, including a scheduled retry, as holding the lock", () => {
    const held: PagesDeploymentStatus[] = [
      "deployment_in_progress",
      "syncing_files",
      "finished_file_sync",
      "updating_pages",
      "purging_cdn",
      "deployment_attempt_error",
    ]
    for (const status of held) {
      expect(isPagesDeploymentInProgress(status)).toBe(true)
    }
  })

  it("treats final statuses as released", () => {
    const released: PagesDeploymentStatus[] = [
      "succeed",
      "deployment_cancelled",
      "deployment_failed",
      "deployment_content_failed",
      "deployment_lost",
    ]
    for (const status of released) {
      expect(isPagesDeploymentInProgress(status)).toBe(false)
    }
  })
})
