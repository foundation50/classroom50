// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

import type { GitHubFileListing } from "@/hooks/github/types"

// Drive classroom.json reads: each dir resolves to a minimal classroom.
const useQueriesMock = vi.fn()
vi.mock("@tanstack/react-query", () => ({
  useQueries: (arg: unknown) => useQueriesMock(arg),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/hooks/github/queries", () => ({
  jsonFileQuery: () => ({}),
}))

// Per-classroom authoritative count, keyed by classroom path so each dir can
// resolve to a distinct student count.
const countByPath: Record<string, number | undefined> = {}
const studentCountMock = vi.fn(
  (_org: string | undefined, classroom: string | undefined) => ({
    studentCount: classroom ? countByPath[classroom] : undefined,
    isLoading: false,
    isError: false,
  }),
)
vi.mock("@/hooks/useStudentCount", () => ({
  default: (...a: [string | undefined, string | undefined]) =>
    studentCountMock(...a),
}))

import useClassroomSummaries from "./useClassroomSummaries"

const dir = (path: string): GitHubFileListing =>
  ({ path, type: "dir", name: path }) as GitHubFileListing

beforeEach(() => {
  useQueriesMock.mockReset()
  studentCountMock.mockClear()
  for (const k of Object.keys(countByPath)) delete countByPath[k]
})

describe("useClassroomSummaries student-count sort", () => {
  it("uses the role-aware count, not the total roster length", () => {
    // classroom.json resolves for both dirs.
    useQueriesMock.mockReturnValue([
      { data: { name: "CS 101" }, isPending: false },
      { data: { name: "CS 202" }, isPending: false },
    ])
    countByPath["cs101"] = 11 // 11 students even if roster.csv has 14 rows
    countByPath["cs202"] = 3

    const { result } = renderHook(() =>
      useClassroomSummaries("acme", [dir("cs101"), dir("cs202")], true),
    )
    expect(result.current[0].studentCount).toBe(11)
    expect(result.current[1].studentCount).toBe(3)
  })

  it("keeps studentCount undefined for an unresolved count", () => {
    useQueriesMock.mockReturnValue([{ data: { name: "CS 101" }, isPending: false }])
    countByPath["cs101"] = undefined // team roster not resolved yet

    const { result } = renderHook(() =>
      useClassroomSummaries("acme", [dir("cs101")], true),
    )
    expect(result.current[0].studentCount).toBeUndefined()
  })

  it("does not fetch counts when the sort is inactive", () => {
    useQueriesMock.mockReturnValue([{ data: { name: "CS 101" }, isPending: false }])

    const { result } = renderHook(() =>
      useClassroomSummaries("acme", [dir("cs101")], false),
    )
    expect(result.current[0].studentCount).toBeUndefined()
    // useStudentCount is still called (hook rules), but with undefined args so
    // its internal queries stay disabled — no team-count fan-out.
    expect(studentCountMock).toHaveBeenCalledWith(undefined, undefined)
  })
})
