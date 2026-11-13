import { describe, expect, it, vi } from "vitest"

import {
  isNotApplied,
  runBulkGroupRepoAccess,
  runBulkRepoAccess,
} from "./repoAccessFanOut"
import { GitHubAPIError } from "@/github-core/errors"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"

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
  it("reports onProgress up to the full count", async () => {
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
      onProgress: (processed) => {
        progressCounts.push(processed)
      },
    })

    expect(outcomes.every((o) => o.status === "ok")).toBe(true)
    expect(rateLimited).toBe(false)
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

  it("marks a silently-ignored downgrade as notApplied, unlike a hard failure", async () => {
    const setCollaborator = vi.fn().mockImplementation(({ username }) =>
      username === "alice"
        ? Promise.resolve({
            effective: { permission: "admin", role_name: "admin" },
          })
        : Promise.reject(apiError(500)),
    )

    const { outcomes } = await runBulkRepoAccess({
      owners: ["alice", "bob"],
      org: "o",
      classroom: "cs",
      assignment: "hw1",
      permission: "pull",
      setCollaborator,
      treatRequestedAsFloor: false,
      t,
      isMounted: () => true,
      onProgress: () => {},
    })

    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed"])
    expect(isNotApplied(outcomes[0])).toBe(true)
    expect(isNotApplied(outcomes[1])).toBe(false)
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

describe("runBulkGroupRepoAccess", () => {
  const base = {
    org: "o",
    permission: "pull" as const,
    treatRequestedAsFloor: false,
    t,
    isMounted: () => true,
    onProgress: () => {},
  }
  const legacy = (owner: string, repoName: string) =>
    ({ kind: "group", owner, repoName }) as const
  const team = (owner: string, repoName: string, teamSlug?: string) =>
    ({ kind: "team", owner, repoName, teamSlug }) as const

  it("sets the team (when there is one) and every direct collaborator", async () => {
    const setCollaborator = vi.fn().mockResolvedValue({ effective: undefined })
    const setTeamPermission = vi.fn().mockResolvedValue(undefined)
    const listCollaborators = vi.fn(async (_org: string, repo: string) =>
      repo === "r-team"
        ? [{ login: "dana" }]
        : [{ login: "alice" }, { login: "bob" }],
    )

    const { outcomes } = await runBulkGroupRepoAccess({
      ...base,
      targets: [team("group-1", "r-team", "t-1"), legacy("alice", "r-legacy")],
      setCollaborator,
      setTeamPermission,
      listCollaborators,
    })

    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok"])
    expect(setTeamPermission).toHaveBeenCalledTimes(1)
    expect(setTeamPermission).toHaveBeenCalledWith({
      org: "o",
      teamSlug: "t-1",
      repo: "r-team",
      permission: "pull",
    })
    expect(
      setCollaborator.mock.calls
        .map(([p]) => `${p.repo}:${p.username}`)
        .toSorted(),
    ).toEqual(["r-legacy:alice", "r-legacy:bob", "r-team:dana"])
  })

  it("awaits the team write before reading or writing collaborators", async () => {
    let releaseTeam!: () => void
    const setTeamPermission = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseTeam = resolve
        }),
    )
    const listCollaborators = vi.fn(async () => [{ login: "dana" }])
    const setCollaborator = vi.fn().mockResolvedValue({ effective: undefined })

    const run = runBulkGroupRepoAccess({
      ...base,
      targets: [team("group-1", "r", "t-1")],
      setCollaborator,
      setTeamPermission,
      listCollaborators,
    })
    await Promise.resolve()
    // The collaborator read-back must observe the lowered team role, so
    // nothing touches collaborators until the team PUT has settled.
    expect(setTeamPermission).toHaveBeenCalledTimes(1)
    expect(listCollaborators).not.toHaveBeenCalled()
    expect(setCollaborator).not.toHaveBeenCalled()

    releaseTeam()
    const { outcomes } = await run
    expect(outcomes[0].status).toBe("ok")
    expect(setCollaborator).toHaveBeenCalledTimes(1)
  })

  it("fails a team repo closed when its team is unresolved, touching nothing", async () => {
    const setTeamPermission = vi.fn()
    const listCollaborators = vi.fn()
    const setCollaborator = vi.fn()

    const { outcomes } = await runBulkGroupRepoAccess({
      ...base,
      targets: [team("group-1", "r", undefined)],
      setCollaborator,
      setTeamPermission,
      listCollaborators,
    })

    expect(outcomes[0].status).toBe("failed")
    expect(isNotApplied(outcomes[0])).toBe(false)
    expect(outcomes[0]).toMatchObject({
      detail: "components.modals.repoAccess.teamMissing",
    })
    expect(setTeamPermission).not.toHaveBeenCalled()
    expect(listCollaborators).not.toHaveBeenCalled()
    expect(setCollaborator).not.toHaveBeenCalled()
  })

  it("skips staff logins and lets permissionFor pick a per-login role", async () => {
    const setCollaborator = vi.fn().mockResolvedValue({ effective: undefined })

    const { outcomes } = await runBulkGroupRepoAccess({
      ...base,
      permission: "push",
      treatRequestedAsFloor: true,
      targets: [legacy("alice", "r")],
      setCollaborator,
      setTeamPermission: vi.fn(),
      listCollaborators: async () => [
        { login: "Alice" },
        { login: "bob" },
        { login: "ta-tom" },
      ],
      skipLogins: new Set(["ta-tom"]),
      permissionFor: (target, login) =>
        login.toLowerCase() === target.owner ? "admin" : "push",
    })

    expect(outcomes[0].status).toBe("ok")
    expect(
      setCollaborator.mock.calls.map(([p]) => `${p.username}:${p.permission}`),
    ).toEqual(["Alice:admin", "bob:push"])
  })

  it("reports a group whose only misses are kept roles as notApplied, naming them", async () => {
    const setCollaborator = vi.fn().mockImplementation(({ username }) =>
      Promise.resolve({
        effective:
          username === "alice"
            ? { permission: "admin", role_name: "admin" }
            : undefined,
      }),
    )

    const { outcomes } = await runBulkGroupRepoAccess({
      ...base,
      targets: [legacy("alice", "r")],
      setCollaborator,
      setTeamPermission: vi.fn(),
      listCollaborators: async () => [{ login: "alice" }, { login: "bob" }],
    })

    expect(outcomes[0].status).toBe("failed")
    expect(isNotApplied(outcomes[0])).toBe(true)
    expect(isNotApplied(outcomes[0]) && outcomes[0].members).toEqual([
      "alice (admin)",
    ])
    // The other member was still set: a kept role doesn't stop the group.
    expect(setCollaborator).toHaveBeenCalledTimes(2)
  })

  it("a transient member failure fails the group as retryable, not notApplied", async () => {
    const setCollaborator = vi.fn().mockImplementation(({ username }) =>
      username === "bob"
        ? Promise.reject(apiError(500))
        : Promise.resolve({
            effective: { permission: "admin", role_name: "admin" },
          }),
    )

    const { outcomes } = await runBulkGroupRepoAccess({
      ...base,
      targets: [legacy("alice", "r")],
      setCollaborator,
      setTeamPermission: vi.fn(),
      listCollaborators: async () => [{ login: "alice" }, { login: "bob" }],
    })

    expect(outcomes[0].status).toBe("failed")
    expect(isNotApplied(outcomes[0])).toBe(false)
  })

  it("a rate-limited team write stops launching and defers the unstarted groups", async () => {
    const setTeamPermission = vi.fn().mockRejectedValue(apiError(429))
    const setCollaborator = vi.fn()
    // More groups than the fan-out launches at once, so some are still
    // unstarted when the first 429 lands and must be deferred, not attempted.
    const targets = Array.from({ length: REPO_READ_CONCURRENCY + 4 }, (_, i) =>
      team(`group-${i}`, `r${i}`, `t-${i}`),
    )

    const { outcomes, rateLimited } = await runBulkGroupRepoAccess({
      ...base,
      targets,
      setCollaborator,
      setTeamPermission,
      listCollaborators: async () => [],
    })

    expect(rateLimited).toBe(true)
    expect(outcomes.every((o) => o.status === "deferred")).toBe(true)
    expect(setTeamPermission.mock.calls.length).toBeLessThan(targets.length)
    expect(setCollaborator).not.toHaveBeenCalled()
  })
})
