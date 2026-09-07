// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

import type { GitHubFileListing } from "@/github-core/types"

const useQueriesMock = vi.fn()
vi.mock("@tanstack/react-query", () => ({
  useQueries: (arg: unknown) => useQueriesMock(arg),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/github-core/queries", () => ({
  jsonFileQuery: () => ({}),
}))

import useClassroomSummaries, {
  classroomOptionLabels,
  type ClassroomSummary,
} from "./useClassroomSummaries"

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

describe("classroomOptionLabels", () => {
  const summary = (path: string, name?: string): ClassroomSummary => ({
    path,
    name,
    archived: false,
    loading: false,
  })

  it("labels by display name and falls back to the slug", () => {
    const labels = classroomOptionLabels([
      summary("cs101-f26", "CS 101"),
      summary("cs102"),
    ])
    expect(labels.get("cs101-f26")).toBe("CS 101")
    expect(labels.get("cs102")).toBe("cs102")
  })

  // Two terms of one course share a name; only then is the slug worth the room.
  it("appends the slug only where a display name is shared", () => {
    const labels = classroomOptionLabels([
      summary("cs101-f25", "CS 101"),
      summary("cs101-f26", "CS 101"),
      summary("cs102", "CS 102"),
    ])
    expect(labels.get("cs101-f25")).toBe("CS 101 (cs101-f25)")
    expect(labels.get("cs101-f26")).toBe("CS 101 (cs101-f26)")
    expect(labels.get("cs102")).toBe("CS 102")
  })

  it("does not repeat a slug that already is the label", () => {
    const labels = classroomOptionLabels([summary("cs101"), summary("cs101")])
    expect(labels.get("cs101")).toBe("cs101")
  })
})
