import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError } from "@/github-core/errors"

import {
  failedAndDeferredSections,
  outcomeSection,
  ownerDisplayName,
  partitionOutcomes,
  runBulkFanOut,
} from "./fanOut"

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

describe("runBulkFanOut", () => {
  it("records ok, failed and progress in input order", async () => {
    const seen: [number, string][] = []
    const { outcomes, rateLimited } = await runBulkFanOut({
      owners: ["a", "b", "c"],
      isMounted: () => true,
      onProgress: (n, owner) => seen.push([n, owner]),
      t,
      perOwner: async (owner) => {
        if (owner === "b") throw new Error("nope")
      },
    })
    expect(rateLimited).toBe(false)
    expect(outcomes).toEqual([
      { owner: "a", status: "ok" },
      { owner: "b", status: "failed", detail: "nope" },
      { owner: "c", status: "ok" },
    ])
    expect(seen.map(([n]) => n).sort()).toEqual([1, 2, 3])
  })

  it("stops launching after a rate limit and defers the rest", async () => {
    const perOwner = vi.fn(async (owner: string) => {
      if (owner === "a") throw apiError(429)
    })
    const { outcomes, rateLimited } = await runBulkFanOut({
      owners: ["a", "b", "c"],
      concurrency: 1,
      isMounted: () => true,
      onProgress: () => {},
      t,
      perOwner,
    })
    expect(rateLimited).toBe(true)
    expect(outcomes.map((o) => o.status)).toEqual([
      "deferred",
      "deferred",
      "deferred",
    ])
    // Only the first write was ever attempted.
    expect(perOwner).toHaveBeenCalledTimes(1)
  })

  it("honours a caller stop condition and unmount without calling perOwner", async () => {
    let stop = false
    const perOwner = vi.fn(async (owner: string) => {
      if (owner === "a") stop = true
    })
    const { outcomes } = await runBulkFanOut({
      owners: ["a", "b"],
      concurrency: 1,
      shouldStop: () => stop,
      isMounted: () => true,
      onProgress: () => {},
      t,
      perOwner,
    })
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "deferred"])
    expect(perOwner).toHaveBeenCalledTimes(1)

    const onProgress = vi.fn()
    const { outcomes: unmounted } = await runBulkFanOut({
      owners: ["a"],
      isMounted: () => false,
      onProgress,
      t,
      perOwner,
    })
    expect(unmounted[0].status).toBe("deferred")
    // No progress reported to a component that is gone.
    expect(onProgress).not.toHaveBeenCalled()
  })

  it("lets perOwner return a custom outcome", async () => {
    type O =
      | { owner: string; status: "ok" | "deferred" | "failed"; detail?: string }
      | { owner: string; status: "skipped" }
    const { outcomes } = await runBulkFanOut<O>({
      owners: ["a"],
      isMounted: () => true,
      onProgress: () => {},
      t,
      perOwner: async (owner) => ({ owner, status: "skipped" }),
    })
    expect(outcomes).toEqual([{ owner: "a", status: "skipped" }])
  })

  it("describes a non-rate-limit GitHub error by status", async () => {
    const { outcomes } = await runBulkFanOut({
      owners: ["a"],
      isMounted: () => true,
      onProgress: () => {},
      t,
      perOwner: async () => {
        throw apiError(500)
      },
    })
    expect(outcomes[0]).toEqual({
      owner: "a",
      status: "failed",
      detail: "components.modals.groupCollaborators.failure.httpStatus",
    })
  })
})

describe("partitionOutcomes", () => {
  it("splits into the three result sections and keeps failure details typed", () => {
    const { succeeded, deferred, failed } = partitionOutcomes([
      { owner: "a", status: "ok" as const },
      { owner: "b", status: "deferred" as const },
      { owner: "c", status: "failed" as const, detail: "x" },
    ])
    expect(succeeded.map((o) => o.owner)).toEqual(["a"])
    expect(deferred.map((o) => o.owner)).toEqual(["b"])
    expect(failed[0].detail).toBe("x")
  })
})

// Mirrors t(key, { count }) closely enough to assert the count is threaded.
const tCount = ((key: string, opts?: { count?: number }) =>
  opts?.count === undefined ? key : `${key}:${opts.count}`) as never

describe("outcomeSection", () => {
  it("yields no section for an empty group", () => {
    expect(outcomeSection(tCount, "x.failedSection", [], (l) => l)).toEqual([])
  })

  it("titles with the row count and prefers a row's own detail", () => {
    const rows = [
      { owner: "ann", status: "failed", detail: "403" },
      { owner: "bob", status: "failed" },
    ]
    expect(
      outcomeSection(tCount, "x.failedSection", rows, (l) => l, "fallback"),
    ).toEqual([
      {
        title: "x.failedSection:2",
        rows: [
          { key: "ann", label: "ann", detail: "403" },
          { key: "bob", label: "bob", detail: "fallback" },
        ],
      },
    ])
  })
})

describe("failedAndDeferredSections", () => {
  it("emits failed then deferred under the prefix, skipping empty groups", () => {
    const groups = partitionOutcomes([
      { owner: "ann", status: "ok" },
      { owner: "bob", status: "deferred" },
    ])
    expect(
      failedAndDeferredSections(
        tCount,
        {
          failed: "submissions.bulkX.failedSection",
          deferred: "submissions.bulkX.deferredSection",
          deferredDetail: "submissions.bulkX.deferredDetail",
        },
        groups,
        (l) => l,
      ),
    ).toEqual([
      {
        title: "submissions.bulkX.deferredSection:1",
        rows: [
          {
            key: "bob",
            label: "bob",
            detail: "submissions.bulkX.deferredDetail",
          },
        ],
      },
    ])
  })
})

describe("ownerDisplayName", () => {
  it("uses the roster name when known and falls back to the login", () => {
    const displayFor = ownerDisplayName([
      {
        username: "ann",
        first_name: "Ann",
        last_name: "Lee",
        email: "",
        section: "",
        github_id: "",
        role: "",
      },
    ])
    expect(displayFor("ann")).toBe("Ann Lee")
    expect(displayFor("zed")).toBe("zed")
  })
})
