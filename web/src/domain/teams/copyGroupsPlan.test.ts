import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import {
  applyGroupsPlan,
  buildCopyPlan,
  planIssues,
  usedLogins,
  type PlannedGroup,
} from "./copyGroupsPlan"
import { addGroupTeamMember, createGroupTeam } from "./groupTeams"
import { syncTeamsSnapshot } from "./teamsFile"

vi.mock("./groupTeams", () => ({
  createGroupTeam: vi.fn(),
  addGroupTeamMember: vi.fn(),
}))
vi.mock("./teamsFile", () => ({
  syncTeamsSnapshot: vi.fn(),
}))

const mockedCreate = vi.mocked(createGroupTeam)
const mockedAdd = vi.mocked(addGroupTeamMember)
const mockedSync = vi.mocked(syncTeamsSnapshot)

const client = {} as GitHubClient
const ORG = "cs50"
const CLASSROOM = "cs-fall"
const ASSIGNMENT = "hw2"

const APPLY_BASE = {
  classroom: CLASSROOM,
  assignment: ASSIGNMENT,
  formation: "teacher" as const,
  creatorLogin: "teacher",
}

describe("buildCopyPlan", () => {
  const teams = [
    { slug: "src-1", name: "The Sharks" },
    { slug: "src-2" },
    { slug: "src-3", name: "Jets" },
  ]

  it("plans one group per source team, carrying name and members", () => {
    const members = new Map([
      ["src-1", [{ login: "alice" }, { login: "bob" }]],
      ["src-2", [{ login: "carol" }]],
    ])
    expect(buildCopyPlan(teams, members)).toEqual([
      { key: "src-1", name: "The Sharks", members: ["alice", "bob"] },
      { key: "src-2", members: ["carol"] },
      // Unresolved members plan as empty rather than blocking the whole copy.
      { key: "src-3", name: "Jets", members: [] },
    ])
  })

  it("omits `name` for an unnamed source group (numbered fallback = no name)", () => {
    const plan = buildCopyPlan([{ slug: "src-2" }], new Map())
    expect("name" in plan[0]).toBe(false)
  })

  it("keeps a login only in its first group (case-insensitive)", () => {
    const members = new Map([
      ["src-1", [{ login: "Alice" }]],
      ["src-2", [{ login: "alice" }, { login: "bob" }]],
    ])
    expect(buildCopyPlan(teams.slice(0, 2), members)).toEqual([
      { key: "src-1", name: "The Sharks", members: ["Alice"] },
      { key: "src-2", members: ["bob"] },
    ])
  })
})

describe("usedLogins", () => {
  it("collects every planned login, lowercased", () => {
    const plan: PlannedGroup[] = [
      { key: "a", members: ["Alice", "bob"] },
      { key: "b", members: ["Carol"] },
    ]
    expect(usedLogins(plan)).toEqual(new Set(["alice", "bob", "carol"]))
  })
})

describe("planIssues", () => {
  it("flags a group over the CURRENT assignment's cap", () => {
    const plan: PlannedGroup[] = [
      { key: "a", members: ["alice", "bob", "carol"] },
      { key: "b", members: ["dave"] },
    ]
    expect(planIssues(plan, { maxGroupSize: 2 })).toEqual([
      { key: "a", overCapacity: { count: 3, max: 2 } },
    ])
  })

  it("flags members already on one of the current assignment's teams", () => {
    const plan: PlannedGroup[] = [{ key: "a", members: ["Alice", "bob"] }]
    expect(planIssues(plan, { takenLogins: new Set(["alice"]) })).toEqual([
      { key: "a", takenMembers: ["Alice"] },
    ])
  })

  it("returns [] for a clean plan (no cap = never over capacity)", () => {
    const plan: PlannedGroup[] = [{ key: "a", members: ["alice", "bob"] }]
    expect(planIssues(plan, {})).toEqual([])
    expect(
      planIssues(plan, { maxGroupSize: 2, takenLogins: new Set() }),
    ).toEqual([])
  })
})

describe("applyGroupsPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    let n = 0
    mockedCreate.mockImplementation(async () => {
      n++
      return { slug: `team-${n}`, id: n, n }
    })
    mockedAdd.mockResolvedValue(undefined)
    mockedSync.mockResolvedValue(undefined)
  })

  const plan: PlannedGroup[] = [
    { key: "src-1", name: "Sharks", members: ["alice", "bob"] },
    { key: "src-2", members: ["carol"] },
  ]

  it("creates each group then its members, and syncs the snapshot once", async () => {
    const progress: number[] = []
    const result = await applyGroupsPlan(client, ORG, {
      ...APPLY_BASE,
      plan,
      maxGroupSize: 3,
      onProgress: ({ current }) => progress.push(current),
    })

    expect(result.created).toEqual([
      { key: "src-1", slug: "team-1" },
      { key: "src-2", slug: "team-2" },
    ])
    expect(result.memberWarnings).toEqual([])
    expect(result.createFailure).toBeUndefined()
    expect(progress).toEqual([1, 2])

    expect(mockedCreate).toHaveBeenNthCalledWith(1, client, ORG, {
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      displayName: "Sharks",
      creatorLogin: "teacher",
      formation: "teacher",
    })
    // The unnamed group creates with no display name (numbered fallback).
    expect(mockedCreate.mock.calls[1][2].displayName).toBeUndefined()
    // Sequential member counts feed the domain size gate.
    expect(mockedAdd.mock.calls.map((call) => call[2])).toMatchObject([
      { teamSlug: "team-1", username: "alice", currentMemberCount: 0 },
      { teamSlug: "team-1", username: "bob", currentMemberCount: 1 },
      { teamSlug: "team-2", username: "carol", currentMemberCount: 0 },
    ])
    expect(mockedSync).toHaveBeenCalledTimes(1)
  })

  it("stops at the first failed create and reports created vs remaining", async () => {
    const boom = new Error("403")
    mockedCreate
      .mockImplementationOnce(async () => ({ slug: "team-1", id: 1, n: 1 }))
      .mockRejectedValueOnce(boom)

    const result = await applyGroupsPlan(client, ORG, { ...APPLY_BASE, plan })

    expect(result.created).toEqual([{ key: "src-1", slug: "team-1" }])
    expect(result.createFailure).toEqual({
      key: "src-2",
      error: boom,
      remaining: ["src-2"],
    })
    // The partial reality still lands in teams.json.
    expect(mockedSync).toHaveBeenCalledTimes(1)
  })

  it("records a failed member add as a warning and continues", async () => {
    const boom = new Error("blocked")
    mockedAdd.mockImplementation(async (_client, _org, input) => {
      if (input.username === "alice") throw boom
    })

    const result = await applyGroupsPlan(client, ORG, { ...APPLY_BASE, plan })

    expect(result.created).toHaveLength(2)
    expect(result.memberWarnings).toEqual([
      { key: "src-1", username: "alice", error: boom },
    ])
    expect(result.createFailure).toBeUndefined()
    // bob still lands, with the count reflecting alice's failure.
    expect(mockedAdd.mock.calls[1][2]).toMatchObject({
      username: "bob",
      currentMemberCount: 0,
    })
  })

  it("skips the snapshot sync when nothing was created", async () => {
    mockedCreate.mockRejectedValue(new Error("403"))
    const result = await applyGroupsPlan(client, ORG, { ...APPLY_BASE, plan })
    expect(result.created).toEqual([])
    expect(result.createFailure?.remaining).toEqual(["src-1", "src-2"])
    expect(mockedSync).not.toHaveBeenCalled()
  })

  it("tolerates a failed final sync (drift badge catches it)", async () => {
    mockedSync.mockRejectedValue(new Error("conflict"))
    const result = await applyGroupsPlan(client, ORG, { ...APPLY_BASE, plan })
    expect(result.created).toHaveLength(2)
    expect(result.createFailure).toBeUndefined()
  })
})
