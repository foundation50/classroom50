import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"

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
    expect(returned).toEqual(committedFile())
    expect(returned.assignments).toEqual({})
    // Unknown top-level fields ride along, as the read-modify-write promises.
    expect(returned.note).toBe("hand-added")
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

    expect(returned).toEqual(committedFile())
    expect(returned.assignments.hw1.teams).toEqual(teams)
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

    expect(returned).toEqual(committedFile())
    expect(returned.assignments.hw1.teams).toEqual([
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
