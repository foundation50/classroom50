import { describe, expect, it, vi } from "vitest"

import { runBulkRepoAccess } from "./repoAccessFanOut"
import { GitHubAPIError } from "@/github-core/errors"

const t = ((key: string) => key) as never

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "/repos/o/r",
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

describe("runBulkRepoAccess progress tracking", () => {
  it("reports onStart before each write and onProgress up to the full count", async () => {
    const events: string[] = []
    const progressCounts: number[] = []
    const setCollaborator = vi.fn().mockResolvedValue({ effective: undefined })

    const { outcomes, rateLimited } = await runBulkRepoAccess({
      owners: ["alice", "bob"],
      org: "o",
      classroom: "cs",
      assignment: "hw1",
      permission: "pull",
      setCollaborator,
      treatRequestedAsFloor: false,
      t,
      isMounted: () => true,
      onStart: (owner) => events.push(`start:${owner}`),
      onProgress: (processed, owner) => {
        events.push(`progress:${processed}:${owner}`)
        progressCounts.push(processed)
      },
    })

    expect(outcomes.every((o) => o.status === "ok")).toBe(true)
    expect(rateLimited).toBe(false)
    // Both owners are started before the run resolves.
    expect(events.filter((e) => e.startsWith("start:")).sort()).toEqual([
      "start:alice",
      "start:bob",
    ])
    // The processed count is monotonically increasing and reaches N (no
    // stuck-at-0): the last progress tick reports every owner completed.
    expect(progressCounts).toEqual([1, 2])
  })

  it("still advances progress to N when a write fails", async () => {
    const progressCounts: number[] = []
    const setCollaborator = vi.fn().mockRejectedValue(apiError(500))

    const { outcomes } = await runBulkRepoAccess({
      owners: ["alice"],
      org: "o",
      classroom: "cs",
      assignment: "hw1",
      permission: "pull",
      setCollaborator,
      treatRequestedAsFloor: false,
      t,
      isMounted: () => true,
      onProgress: (processed) => progressCounts.push(processed),
    })

    expect(outcomes[0].status).toBe("failed")
    // A failed write still ticks progress so the bar never sticks below N.
    expect(progressCounts.at(-1)).toBe(1)
  })

  it("does not push new-write progress after unmount but leaves no partial tick", async () => {
    const setCollaborator = vi.fn().mockResolvedValue({ effective: undefined })

    const { outcomes } = await runBulkRepoAccess({
      owners: ["alice", "bob"],
      org: "o",
      classroom: "cs",
      assignment: "hw1",
      permission: "pull",
      setCollaborator,
      treatRequestedAsFloor: false,
      t,
      // Unmounted for the whole run: no writes launch, all deferred.
      isMounted: () => false,
      onProgress: () => {},
    })

    expect(outcomes.every((o) => o.status === "deferred")).toBe(true)
    expect(setCollaborator).not.toHaveBeenCalled()
  })
})
