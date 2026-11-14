import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"

const readConfigRepoHeadAt = vi.fn(async (_c, _o, configBranch: string) => ({
  configBranch,
  headSha: "HEAD",
  baseTreeSha: "BASETREE",
}))
const commitConfigRepoFiles = vi.fn(async () => ({
  newTreeSha: "NEWTREE",
  newCommitSha: "NEWCOMMIT",
  updatedRef: { ref: "refs/heads/main" },
}))
vi.mock("../configRepoWrite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../configRepoWrite")>()),
  readConfigRepoHeadAt: (...a: unknown[]) =>
    readConfigRepoHeadAt(...(a as [GitHubClient, string, string])),
  commitConfigRepoFiles: (...a: unknown[]) =>
    commitConfigRepoFiles(...(a as [])),
}))
vi.mock("@/github-core/configRepoReads", () => ({
  getConfigRepoBranch: async () => "main",
}))
vi.mock("../classrooms", () => ({
  withGitConflictRetry: (fn: () => Promise<unknown>) => fn(),
}))

const teamsFile = vi.fn()
const assignmentsFile = vi.fn()
vi.mock("./teamsFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./teamsFile")>()),
  getTeamsFile: () => teamsFile(),
}))
vi.mock("../queries/assignments", () => ({
  getAssignmentsFile: () => assignmentsFile(),
}))

import {
  recordGroupTeamDeletion,
  retiredGroupCounters,
  withRetiredGroupCounter,
} from "./groupCounters"

const client = {} as GitHubClient

const entry = (overrides: Partial<Assignment> = {}): Assignment =>
  ({
    slug: "proj",
    name: "Project",
    mode: "team",
    autograder: "default",
    max_group_size: 3,
    team_formation: "student",
    ...overrides,
  }) as Assignment

describe("retiredGroupCounters", () => {
  it("reads the list, dropping anything that isn't a counter", () => {
    expect(
      retiredGroupCounters(
        entry({
          retired_group_counters: [3, 1, 0, -2, 1.5, "7", null] as never,
        }),
      ),
    ).toEqual(new Set([1, 3]))
  })

  it("absent or malformed reads as none", () => {
    expect(retiredGroupCounters(undefined)).toEqual(new Set())
    expect(retiredGroupCounters(entry())).toEqual(new Set())
    expect(
      retiredGroupCounters(entry({ retired_group_counters: "1,2" as never })),
    ).toEqual(new Set())
  })
})

describe("withRetiredGroupCounter", () => {
  it("appends sorted and deduped, preserving the rest of the entry", () => {
    const next = withRetiredGroupCounter(
      entry({ retired_group_counters: [3], locked: true }),
      1,
    )
    expect(next.retired_group_counters).toEqual([1, 3])
    expect(next.locked).toBe(true)
    expect(withRetiredGroupCounter(next, 3).retired_group_counters).toEqual([
      1, 3,
    ])
  })
})

describe("recordGroupTeamDeletion", () => {
  beforeEach(() => {
    commitConfigRepoFiles.mockClear()
    teamsFile.mockReset()
    assignmentsFile.mockReset()
  })

  it("drops the row and retires the counter in one commit", async () => {
    teamsFile.mockResolvedValue({
      schema: "classroom50/teams/v1",
      assignments: {
        proj: {
          teams: [
            {
              slug: "classroom50-group-aaaaaaaaaaaaaaaa-1",
              id: 1,
              members: [],
            },
            {
              slug: "classroom50-group-aaaaaaaaaaaaaaaa-2",
              id: 2,
              members: [],
            },
          ],
        },
      },
    })
    assignmentsFile.mockResolvedValue({
      schema: "classroom50/assignments/v1",
      assignments: [entry(), entry({ slug: "other" })],
    })

    await recordGroupTeamDeletion(client, {
      org: "org",
      classroom: "cs50",
      assignment: "proj",
      slug: "classroom50-group-aaaaaaaaaaaaaaaa-1",
      n: 1,
    })

    expect(commitConfigRepoFiles).toHaveBeenCalledTimes(1)
    const [, , , tree, message] = commitConfigRepoFiles.mock
      .calls[0] as unknown as [
      GitHubClient,
      string,
      unknown,
      { path: string; content: string }[],
      string,
    ]
    expect(message).toBe("Delete group 1: cs50/proj")
    expect(tree.map((e) => e.path)).toEqual([
      "cs50/teams.json",
      "cs50/assignments.json",
    ])
    const teams = JSON.parse(tree[0].content)
    expect(
      teams.assignments.proj.teams.map((t: { slug: string }) => t.slug),
    ).toEqual(["classroom50-group-aaaaaaaaaaaaaaaa-2"])
    const assignments = JSON.parse(tree[1].content)
    expect(assignments.assignments[0].retired_group_counters).toEqual([1])
    expect(assignments.assignments[1].retired_group_counters).toBeUndefined()
  })

  it("drops only the row when the assignment entry is gone", async () => {
    teamsFile.mockResolvedValue({
      schema: "classroom50/teams/v1",
      assignments: {
        proj: {
          teams: [
            {
              slug: "classroom50-group-aaaaaaaaaaaaaaaa-1",
              id: 1,
              members: [],
            },
          ],
        },
      },
    })
    assignmentsFile.mockRejectedValue(
      new GitHubAPIError({
        status: 404,
        url: "test",
        message: "Not Found",
        body: null,
        rateLimit: {
          limit: null,
          remaining: null,
          used: null,
          reset: null,
          resource: null,
          retryAfter: null,
        },
      }),
    )

    await recordGroupTeamDeletion(client, {
      org: "org",
      classroom: "cs50",
      assignment: "proj",
      slug: "classroom50-group-aaaaaaaaaaaaaaaa-1",
      n: 1,
    })

    const [, , , tree] = commitConfigRepoFiles.mock.calls[0] as unknown as [
      GitHubClient,
      string,
      unknown,
      { path: string }[],
    ]
    expect(tree.map((e) => e.path)).toEqual(["cs50/teams.json"])
  })
})
