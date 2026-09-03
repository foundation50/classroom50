// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

import type { UseTeamRosterResult } from "@/hooks/useTeamRoster"
import type { TeamRosterRow } from "@/util/teamRoster"

const getStudents = vi.fn()
const teamRoster = vi.fn()

vi.mock("@/hooks/useGetStudents", () => ({
  default: (...args: unknown[]) => getStudents(...args),
}))
vi.mock("@/hooks/useTeamRoster", () => ({
  useTeamRoster: (...args: unknown[]) => teamRoster(...args),
}))

import useFunnelRoster, { unionLogins } from "./useFunnelRoster"

const row = (over: Partial<TeamRosterRow>): TeamRosterRow =>
  ({
    key: over.username ?? "",
    state: "enrolled",
    roles: ["student"],
    username: "",
    github_id: "",
    first_name: "",
    last_name: "",
    section: "",
    email: "",
    avatar_url: "",
    ...over,
  }) as TeamRosterRow

// Minimal team-roster result: only the fields useFunnelRoster reads.
const rosterResult = (
  overrides: Partial<UseTeamRosterResult>,
): UseTeamRosterResult =>
  ({
    rows: [],
    isLoading: false,
    isError: false,
    studentRosterKnown: true,
    ...overrides,
  }) as UseTeamRosterResult

beforeEach(() => {
  getStudents.mockReset()
  teamRoster.mockReset()
  getStudents.mockReturnValue({ students: [], isLoading: false })
})

describe("useFunnelRoster", () => {
  it("splits enrolled rows into student and staff login sets, lowercased", () => {
    teamRoster.mockReturnValue(
      rosterResult({
        rows: [
          row({ username: "Alice", roles: ["student"] }),
          row({ username: "bob", roles: ["student"] }),
          row({ username: "Prof", roles: ["teacher"] }),
          row({ username: "ta1", roles: ["ta"] }),
        ],
      }),
    )
    const { result } = renderHook(() => useFunnelRoster("org", "cs101"))
    expect([...(result.current.studentLogins ?? [])]).toEqual(["alice", "bob"])
    expect([...(result.current.staffLogins ?? [])]).toEqual(["prof", "ta1"])
  })

  it("puts a student who is also staff in both sets so a union counts them once", () => {
    teamRoster.mockReturnValue(
      rosterResult({
        rows: [
          row({ username: "dual", roles: ["ta", "student"] }),
          row({ username: "solo", roles: ["student"] }),
        ],
      }),
    )
    const { result } = renderHook(() => useFunnelRoster("org", "cs101"))
    expect(result.current.studentLogins?.has("dual")).toBe(true)
    expect(result.current.staffLogins?.has("dual")).toBe(true)
    expect(
      unionLogins(
        result.current.studentLogins ?? new Set(),
        result.current.staffLogins ?? new Set(),
      ).size,
    ).toBe(2)
  })

  it("ignores pending and needs-attention rows and email-only rows", () => {
    teamRoster.mockReturnValue(
      rosterResult({
        rows: [
          row({ username: "invited", state: "pending" }),
          row({ username: "gone", state: "needs_attention_not_in_org" }),
          row({ username: "", email: "x@example.com" }),
          row({ username: "here" }),
        ],
      }),
    )
    const { result } = renderHook(() => useFunnelRoster("org", "cs101"))
    expect([...(result.current.studentLogins ?? [])]).toEqual(["here"])
  })

  it("is undefined while the team roster is loading", () => {
    teamRoster.mockReturnValue(
      rosterResult({ rows: [row({ username: "a" })], isLoading: true }),
    )
    const { result } = renderHook(() => useFunnelRoster("org", "cs101"))
    expect(result.current.studentLogins).toBeUndefined()
    expect(result.current.staffLogins).toBeUndefined()
    expect(result.current.isLoading).toBe(true)
  })

  it("reports an unknown roster as settled and setless, not as loading or empty", () => {
    teamRoster.mockReturnValue(rosterResult({ studentRosterKnown: false }))
    const { result } = renderHook(() => useFunnelRoster("org", "cs101"))
    expect(result.current.isUnknown).toBe(true)
    expect(result.current.studentLogins).toBeUndefined()
    expect(result.current.isLoading).toBe(false)
  })

  it("returns empty sets (not undefined) for a resolved empty classroom", () => {
    teamRoster.mockReturnValue(rosterResult({}))
    const { result } = renderHook(() => useFunnelRoster("org", "cs101"))
    expect(result.current.studentLogins?.size).toBe(0)
    expect(result.current.isUnknown).toBe(false)
  })

  it("surfaces isError", () => {
    teamRoster.mockReturnValue(rosterResult({ isError: true }))
    const { result } = renderHook(() => useFunnelRoster("org", "cs101"))
    expect(result.current.isError).toBe(true)
  })

  it("passes roster students through to useTeamRoster as the metadata arg", () => {
    const students = [{ username: "octocat" }]
    getStudents.mockReturnValue({ students, isLoading: false })
    teamRoster.mockReturnValue(rosterResult({}))
    renderHook(() => useFunnelRoster("org", "cs101"))
    expect(teamRoster).toHaveBeenCalledWith("org", "cs101", students)
  })
})
