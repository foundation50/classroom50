// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

import type { GitHubFileListing } from "@/hooks/github/types"

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

import useClassroomSummaries from "./useClassroomSummaries"

const dir = (path: string): GitHubFileListing =>
  ({ path, type: "dir", name: path }) as GitHubFileListing

beforeEach(() => {
  useQueriesMock.mockReset()
})

describe("useClassroomSummaries", () => {
  it("lifts classroom.json fields and does not compute a student count", () => {
    useQueriesMock.mockReturnValue([
      { data: { name: "CS 101", term: "F26" }, isPending: false },
    ])

    const { result } = renderHook(() =>
      useClassroomSummaries("acme", [dir("cs101")]),
    )
    expect(result.current[0]).toMatchObject({
      path: "cs101",
      name: "CS 101",
      term: "F26",
      archived: false,
      loading: false,
    })
    // Count is no longer sourced here — the type has no studentCount; it's
    // collected by ClassroomList's probes for the sort only.
    expect(result.current[0]).not.toHaveProperty("studentCount")
  })

  it("keeps a row (with {path}) when classroom.json is unreadable", () => {
    useQueriesMock.mockReturnValue([{ data: undefined, isPending: false }])

    const { result } = renderHook(() =>
      useClassroomSummaries("acme", [dir("cs404")]),
    )
    expect(result.current[0].path).toBe("cs404")
    expect(result.current[0].name).toBeUndefined()
  })
})
