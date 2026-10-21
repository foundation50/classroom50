import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"

// Write-path tests for teams.json; the pure helpers live in teamsFile.test.ts.

const readConfigRepoHeadAt = vi.fn(async () => ({
  configBranch: "main",
  headSha: "HEAD",
  baseTreeSha: "BASETREE",
}))
const commitConfigRepoFiles = vi.fn(async () => ({
  newTreeSha: "NEWTREE",
  newCommitSha: "NEWCOMMIT",
  updatedRef: { ref: "refs/heads/main" },
}))
vi.mock("../configRepoWrite", () => ({
  readConfigRepoHeadAt: (...a: unknown[]) => readConfigRepoHeadAt(...(a as [])),
  commitConfigRepoFiles: (...a: unknown[]) =>
    commitConfigRepoFiles(...(a as [])),
  jsonFileEntry: (path: string, doc: unknown) => ({
    path,
    content: JSON.stringify(doc),
  }),
}))
vi.mock("@/github-core/configRepoReads", () => ({
  getConfigRepoBranch: vi.fn(async () => "main"),
}))

let stored: unknown
const listTeamMembers = vi.fn(async () => [
  { login: "alice" },
  { login: "Bob" },
])
// Partial: withGitConflictRetry reaches withRetry through this same module.
vi.mock("@/github-core/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/github-core/queries")>()
  return {
    ...actual,
    readConfigJson: async () => stored,
    listTeamMembers: (...a: unknown[]) => listTeamMembers(...(a as [])),
  }
})
vi.mock("./groupTeams", () => ({
  listAssignmentGroupTeams: vi.fn(async () => [
    { slug: "classroom50-group-1", id: 11, name: "Sharks" },
  ]),
}))

import {
  saveTeamsSnapshot,
  syncTeamsSnapshot,
  writeTeamsFile,
  TEAMS_SCHEMA_V1,
  type TeamsFile,
} from "./teamsFile"

const client = {} as GitHubClient
const ORG = "acme"
const CLASSROOM = "cs50"

// The document the single tree write carried, parsed back out.
const committedFile = () => {
  const [, , , entries] = commitConfigRepoFiles.mock.calls[0] as unknown as [
    unknown,
    unknown,
    unknown,
    { path: string; content: string }[],
  ]
  return JSON.parse(entries[0].content) as TeamsFile
}

beforeEach(() => {
  readConfigRepoHeadAt.mockClear()
  commitConfigRepoFiles.mockClear()
  stored = {
    schema: TEAMS_SCHEMA_V1,
    assignments: {
      hw1: {
        teams: [{ slug: "old", id: 1, members: [], formation: "teacher" }],
      },
    },
    note: "hand-added",
  }
})

describe("writeTeamsFile", () => {
  // What the hooks seed the read cache with must be byte-for-byte what landed,
  // or the drift badge compares live membership against the wrong baseline.
  it("returns the file it committed", async () => {
    const returned = await writeTeamsFile(client, {
      org: ORG,
      classroom: CLASSROOM,
      message: "Update teams",
      update: (file) => ({ ...file, assignments: {} }),
    })

    expect(commitConfigRepoFiles).toHaveBeenCalledTimes(1)
    expect(returned.teamsFile).toEqual(committedFile())
    expect(returned.teamsFile.assignments).toEqual({})
    // Unknown top-level fields ride along, as the read-modify-write promises.
    expect(returned.teamsFile.note).toBe("hand-added")
    // The commit chain the seed is ordered by.
    expect(returned.previousCommitSha).toBe("HEAD")
    expect(returned.newCommitSha).toBe("NEWCOMMIT")
  })

  // A 409 re-runs the whole read-modify-write; the returned file must be the
  // one the winning attempt committed, built on the re-read, not the first.
  it("returns the file from the attempt that landed after a conflict", async () => {
    const conflict = new GitHubAPIError({
      status: 409,
      url: "/repos/acme/classroom50/git/refs/heads/main",
      message: "Conflict",
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
    commitConfigRepoFiles
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        newTreeSha: "TREE2",
        newCommitSha: "COMMIT2",
        updatedRef: { ref: "refs/heads/main" },
      })
    readConfigRepoHeadAt
      .mockResolvedValueOnce({
        configBranch: "main",
        headSha: "HEAD1",
        baseTreeSha: "T1",
      })
      .mockResolvedValueOnce({
        configBranch: "main",
        headSha: "HEAD2",
        baseTreeSha: "T2",
      })
    let reads = 0
    const returned = await writeTeamsFile(client, {
      org: ORG,
      classroom: CLASSROOM,
      message: "Update teams",
      update: (file) => ({ ...file, note: `attempt-${++reads}` }),
    })

    expect(commitConfigRepoFiles).toHaveBeenCalledTimes(2)
    expect(returned.teamsFile.note).toBe("attempt-2")
    expect(returned.previousCommitSha).toBe("HEAD2")
    expect(returned.newCommitSha).toBe("COMMIT2")
    const [, , , entries] = commitConfigRepoFiles.mock.calls[1] as unknown as [
      unknown,
      unknown,
      unknown,
      { path: string; content: string }[],
    ]
    expect(JSON.parse(entries[0].content).note).toBe("attempt-2")
  })
})

describe("saveTeamsSnapshot", () => {
  it("returns the committed file with the assignment's bucket replaced", async () => {
    const teams = [
      {
        slug: "classroom50-group-1",
        id: 11,
        members: ["alice"],
        formation: "teacher" as const,
      },
    ]
    const returned = await saveTeamsSnapshot(client, {
      org: ORG,
      classroom: CLASSROOM,
      assignment: "hw1",
      teams,
    })

    expect(returned.teamsFile).toEqual(committedFile())
    expect(returned.teamsFile.assignments.hw1.teams).toEqual(teams)
  })
})

describe("syncTeamsSnapshot", () => {
  it("returns the committed file built from live team state", async () => {
    const returned = await syncTeamsSnapshot(client, {
      org: ORG,
      classroom: CLASSROOM,
      assignment: "hw1",
      formation: "teacher",
    })

    expect(returned.teamsFile).toEqual(committedFile())
    expect(returned.teamsFile.assignments.hw1.teams).toEqual([
      {
        slug: "classroom50-group-1",
        id: 11,
        name: "Sharks",
        members: ["alice", "Bob"],
        formation: "teacher",
      },
    ])
  })
})
