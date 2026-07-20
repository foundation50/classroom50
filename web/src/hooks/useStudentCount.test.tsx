// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

import type { RoleCounts } from "@/util/classroomRoleUI"
import type { UseTeamRosterResult } from "@/hooks/useTeamRoster"

const getStudents = vi.fn()
const teamRoster = vi.fn()

vi.mock("@/hooks/useGetStudents", () => ({
  default: (...args: unknown[]) => getStudents(...args),
}))
vi.mock("@/hooks/useTeamRoster", () => ({
  useTeamRoster: (...args: unknown[]) => teamRoster(...args),
}))

import useStudentCount from "./useStudentCount"

const roleCounts = (student: number): RoleCounts => ({
  teacher: 0,
  instructor: 0,
  hta: 0,
  ta: 0,
  student,
})

// Minimal team-roster result: only the fields useStudentCount reads.
const rosterResult = (
  overrides: Partial<UseTeamRosterResult>,
): UseTeamRosterResult =>
  ({
    roleCounts: roleCounts(0),
    isLoading: false,
    isError: false,
    ...overrides,
  }) as UseTeamRosterResult

beforeEach(() => {
  getStudents.mockReset()
  teamRoster.mockReset()
  getStudents.mockReturnValue({ students: [], isLoading: false })
})

describe("useStudentCount", () => {
  it("returns roleCounts.student, not the total roster row count", () => {
    // A roster with staff rows; team membership resolves 11 student-role members.
    getStudents.mockReturnValue({
      students: new Array(14).fill({}),
      isLoading: false,
    })
    teamRoster.mockReturnValue(rosterResult({ roleCounts: roleCounts(11) }))

    const { result } = renderHook(() => useStudentCount("org", "cs101"))
    expect(result.current.studentCount).toBe(11)
  })

  it("counts a student-who-is-also-staff once (roleCounts already unions)", () => {
    // roleCounts.student tallies every row carrying the student role, including
    // student+teacher, exactly once — the wrapper passes it through.
    teamRoster.mockReturnValue(rosterResult({ roleCounts: roleCounts(3) }))

    const { result } = renderHook(() => useStudentCount("org", "cs101"))
    expect(result.current.studentCount).toBe(3)
  })

  it("is undefined while the team roster is loading", () => {
    teamRoster.mockReturnValue(
      rosterResult({ roleCounts: roleCounts(5), isLoading: true }),
    )

    const { result } = renderHook(() => useStudentCount("org", "cs101"))
    expect(result.current.studentCount).toBeUndefined()
    expect(result.current.isLoading).toBe(true)
  })

  it("surfaces isError without returning a wrong numeric count", () => {
    teamRoster.mockReturnValue(
      rosterResult({ roleCounts: roleCounts(0), isError: true }),
    )

    const { result } = renderHook(() => useStudentCount("org", "cs101"))
    expect(result.current.isError).toBe(true)
    // Not undefined-from-loading (loading is false); the caller keys on isError
    // rather than trusting the 0 as a real count.
    expect(result.current.isLoading).toBe(false)
  })

  it("returns 0 (not undefined) for a resolved staff-only classroom", () => {
    teamRoster.mockReturnValue(rosterResult({ roleCounts: roleCounts(0) }))

    const { result } = renderHook(() => useStudentCount("org", "cs101"))
    expect(result.current.studentCount).toBe(0)
  })

  it("passes roster students through to useTeamRoster as the metadata arg", () => {
    const students = [{ username: "octocat" }]
    getStudents.mockReturnValue({ students, isLoading: false })
    teamRoster.mockReturnValue(rosterResult({ roleCounts: roleCounts(1) }))

    renderHook(() => useStudentCount("org", "cs101"))
    expect(teamRoster).toHaveBeenCalledWith("org", "cs101", students)
  })
})
