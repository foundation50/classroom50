// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

const useStudentClassroomsMock = vi.fn()
const orgReposMock = vi.fn()

vi.mock("@/hooks/useStudentClassrooms", () => ({
  useStudentClassrooms: () => useStudentClassroomsMock(),
}))
vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: () => orgReposMock(),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "student1" } }),
}))

import { useStudentClassroomSummaries } from "./useStudentClassroomSummaries"

const repo = (name: string, push = true) => ({
  id: name,
  name,
  full_name: `acme/${name}`,
  permissions: {
    push,
    admin: false,
    pull: true,
    maintain: false,
    triage: false,
  },
})

beforeEach(() => {
  useStudentClassroomsMock.mockReset()
  orgReposMock.mockReset()
})

describe("useStudentClassroomSummaries", () => {
  it("counts accepted repos per classroom by name prefix", () => {
    useStudentClassroomsMock.mockReturnValue({
      classrooms: [
        { classroom: "cs101", name: "Intro CS" },
        { classroom: "ml", name: "ML", secret: "a1b2c3d4" },
      ],
      isLoading: false,
      isError: false,
      roleResolved: true,
      refetch: () => {},
    })
    orgReposMock.mockReturnValue({
      data: [
        repo("cs101-hw1-student1"),
        repo("cs101-hw2-student1"),
        repo("ml-project-student1"),
      ],
    })
    const { result } = renderHook(() => useStudentClassroomSummaries("acme"))
    expect(result.current.summaries).toEqual([
      { classroom: "cs101", name: "Intro CS", acceptedCount: 2 },
      { classroom: "ml", name: "ML", secret: "a1b2c3d4", acceptedCount: 1 },
    ])
  })

  it("counts only the student's OWN repos, excluding unrelated and other-owner repos", () => {
    useStudentClassroomsMock.mockReturnValue({
      classrooms: [{ classroom: "ml", name: "ML" }],
      isLoading: false,
      isError: false,
      roleResolved: true,
      refetch: () => {},
    })
    orgReposMock.mockReturnValue({
      data: [
        repo("ml-project-student1"), // the student's own accepted repo -> counts
        repo("ml-notes"), // personal writable repo under the prefix -> excluded
        repo("ml-project-otherstudent"), // a peer's / group founder's repo -> excluded
      ],
    })
    const { result } = renderHook(() => useStudentClassroomSummaries("acme"))
    expect(result.current.summaries[0].acceptedCount).toBe(1)
  })

  it("does not miscount a sibling classroom whose name extends this one", () => {
    useStudentClassroomsMock.mockReturnValue({
      classrooms: [{ classroom: "cs" }, { classroom: "cs101" }],
      isLoading: false,
      isError: false,
      roleResolved: true,
      refetch: () => {},
    })
    // A cs101 repo must not count toward "cs" (prefix boundary on the "-").
    orgReposMock.mockReturnValue({
      data: [repo("cs101-hw1-student1"), repo("cs-intro-student1")],
    })
    const { result } = renderHook(() => useStudentClassroomSummaries("acme"))
    const cs = result.current.summaries.find((s) => s.classroom === "cs")
    const cs101 = result.current.summaries.find((s) => s.classroom === "cs101")
    expect(cs?.acceptedCount).toBe(1)
    expect(cs101?.acceptedCount).toBe(1)
  })

  it("ignores repos without push access", () => {
    useStudentClassroomsMock.mockReturnValue({
      classrooms: [{ classroom: "cs101" }],
      isLoading: false,
      isError: false,
      roleResolved: true,
      refetch: () => {},
    })
    orgReposMock.mockReturnValue({
      data: [
        repo("cs101-hw1-student1", false),
        repo("cs101-hw2-student1", true),
      ],
    })
    const { result } = renderHook(() => useStudentClassroomSummaries("acme"))
    expect(result.current.summaries[0].acceptedCount).toBe(1)
  })

  it("gives an unaccepted classroom a zero count while keeping its record", () => {
    useStudentClassroomsMock.mockReturnValue({
      classrooms: [
        { classroom: "cs101", name: "Intro CS", secret: "a1b2c3d4" },
      ],
      isLoading: false,
      isError: false,
      roleResolved: true,
      refetch: () => {},
    })
    orgReposMock.mockReturnValue({ data: [] })
    const { result } = renderHook(() => useStudentClassroomSummaries("acme"))
    expect(result.current.summaries[0]).toEqual({
      classroom: "cs101",
      name: "Intro CS",
      secret: "a1b2c3d4",
      acceptedCount: 0,
    })
  })

  it("passes through the enumeration loading/error/resolved state", () => {
    useStudentClassroomsMock.mockReturnValue({
      classrooms: [],
      isLoading: true,
      isError: false,
      roleResolved: false,
      refetch: () => {},
    })
    orgReposMock.mockReturnValue({ data: undefined })
    const { result } = renderHook(() => useStudentClassroomSummaries("acme"))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.summaries).toEqual([])
  })
})
