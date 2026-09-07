// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

const useQueryMock = vi.fn()

vi.mock("@tanstack/react-query", () => ({
  useQuery: (arg: unknown) => useQueryMock(arg),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "student1" } }),
}))
vi.mock("@/github-core/queries", () => ({
  myTeamsQuery: () => ({ queryKey: ["my-teams"] }),
}))

import {
  useStudentClassrooms,
  useClassroomSecret,
} from "./useStudentClassrooms"
import type { MyTeam } from "@/github-core/types"

const team = (
  slug: string,
  opts: { orgLogin?: string; description?: string | null } = {},
): MyTeam =>
  ({
    id: 1,
    name: slug,
    slug,
    privacy: "secret",
    description: opts.description ?? null,
    organization: { login: opts.orgLogin ?? "acme", id: 1 },
  }) as MyTeam

const teams = (over: Record<string, unknown> = {}) => ({
  data: undefined as MyTeam[] | undefined,
  isSuccess: false,
  isError: false,
  fetchStatus: "idle",
  refetch: () => {},
  ...over,
})

const desc = (fields: Record<string, unknown>) =>
  JSON.stringify({ schema: "classroom50/team/v1", ...fields })

beforeEach(() => {
  useQueryMock.mockReset()
})

describe("useStudentClassrooms", () => {
  it("enumerates student classrooms in this org with their bootstrap records", () => {
    useQueryMock.mockReturnValue(
      teams({
        data: [
          team("classroom50-cs101", {
            description: desc({ name: "Intro CS" }),
          }),
          team("classroom50-ml", {
            description: desc({ name: "Machine Learning", secret: "a1b2c3d4" }),
          }),
        ],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.roleResolved).toBe(true)
    expect(result.current.classrooms).toEqual([
      {
        classroom: "cs101",
        name: "Intro CS",
        term: undefined,
        active: undefined,
        secret: undefined,
      },
      {
        classroom: "ml",
        name: "Machine Learning",
        term: undefined,
        active: undefined,
        secret: "a1b2c3d4",
      },
    ])
  })

  it("filters out teams in a different org", () => {
    useQueryMock.mockReturnValue(
      teams({
        data: [team("classroom50-cs101", { orgLogin: "other-org" })],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.classrooms).toEqual([])
  })

  it("dedups a classroom held via both student and staff teams, preferring the student record", () => {
    useQueryMock.mockReturnValue(
      teams({
        data: [
          team("classroom50-cs101-ta"),
          team("classroom50-cs101", {
            description: desc({ name: "Intro CS" }),
          }),
        ],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.classrooms).toEqual([
      {
        classroom: "cs101",
        name: "Intro CS",
        term: undefined,
        active: undefined,
        secret: undefined,
      },
    ])
  })

  it("still lists a classroom known only via a staff team (no student team)", () => {
    useQueryMock.mockReturnValue(
      teams({ data: [team("classroom50-cs101-teacher")], isSuccess: true }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.classrooms).toEqual([{ classroom: "cs101" }])
  })

  it("disambiguates a role-suffixed classroom's student team by its bootstrap record", () => {
    // `classroom50-ml-ta` is byte-identical to the TA team of `ml`, but a
    // classroom50/team/v1 record proves it's the STUDENT team of classroom
    // `ml-ta` (staff teams carry no record). Trust the record: classroom is
    // `ml-ta`, and its name/secret are lifted (not dropped as a phantom `ml`).
    useQueryMock.mockReturnValue(
      teams({
        data: [
          team("classroom50-ml-ta", {
            description: desc({ name: "ML for TAs", secret: "a1b2c3d4" }),
          }),
        ],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.classrooms).toEqual([
      {
        classroom: "ml-ta",
        name: "ML for TAs",
        term: undefined,
        active: undefined,
        secret: "a1b2c3d4",
      },
    ])
  })

  it("keeps treating a genuine staff team (no record) as a staff membership", () => {
    // Same slug shape, but NO bootstrap record => a real TA team of classroom
    // `ml`; the staff parse stands.
    useQueryMock.mockReturnValue(
      teams({ data: [team("classroom50-ml-ta")], isSuccess: true }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.classrooms).toEqual([{ classroom: "ml" }])
  })

  it("yields no secret for a pre-schema team (plain-text description)", () => {
    useQueryMock.mockReturnValue(
      teams({
        data: [team("classroom50-cs101", { description: "Students of CS101" })],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.classrooms[0]).toMatchObject({
      classroom: "cs101",
      secret: undefined,
      name: undefined,
    })
  })

  it("returns an empty resolved list when the viewer is on no classroom teams", () => {
    useQueryMock.mockReturnValue(
      teams({ data: [team("some-other-team")], isSuccess: true }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.roleResolved).toBe(true)
    expect(result.current.classrooms).toEqual([])
  })

  it("holds loading while the teams read is in flight", () => {
    useQueryMock.mockReturnValue(teams({ fetchStatus: "fetching" }))
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.classrooms).toEqual([])
  })

  it("surfaces isError on a settled failed read (held, not empty-resolved)", () => {
    useQueryMock.mockReturnValue(
      teams({ data: undefined, isSuccess: false, isError: true }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.isError).toBe(true)
    expect(result.current.roleResolved).toBe(false)
  })

  it("sorts by display name (falling back to slug)", () => {
    useQueryMock.mockReturnValue(
      teams({
        data: [
          team("classroom50-zeta", {
            description: desc({ name: "Alpha Course" }),
          }),
          team("classroom50-alpha", {
            description: desc({ name: "Zeta Course" }),
          }),
        ],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useStudentClassrooms("acme"))
    expect(result.current.classrooms.map((c) => c.classroom)).toEqual([
      "zeta",
      "alpha",
    ])
  })
})

describe("useClassroomSecret", () => {
  it("returns the matching classroom's secret when enabled", () => {
    useQueryMock.mockReturnValue(
      teams({
        data: [
          team("classroom50-ml", {
            description: desc({ name: "ML", secret: "a1b2c3d4" }),
          }),
        ],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useClassroomSecret("acme", "ml"))
    expect(result.current).toEqual({
      secret: "a1b2c3d4",
      pagesBaseUrl: undefined,
      isLoading: false,
      isError: false,
    })
  })

  it("returns undefined for a classroom with no matching team", () => {
    useQueryMock.mockReturnValue(
      teams({ data: [team("classroom50-cs101")], isSuccess: true }),
    )
    const { result } = renderHook(() => useClassroomSecret("acme", "ml"))
    expect(result.current.secret).toBeUndefined()
  })

  it("skips the GET /user/teams read when disabled", () => {
    useQueryMock.mockReturnValue(teams())
    const { result } = renderHook(() => useClassroomSecret("acme", "ml", false))
    // The read is gated off: org is passed as undefined, so useStudentClassrooms
    // disables the query rather than issuing a network round-trip.
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    )
    expect(result.current).toEqual({
      secret: undefined,
      pagesBaseUrl: undefined,
      isLoading: false,
      isError: false,
    })
  })

  it("reports isLoading while the enabled read is in flight", () => {
    useQueryMock.mockReturnValue(teams({ fetchStatus: "fetching" }))
    const { result } = renderHook(() => useClassroomSecret("acme", "ml"))
    expect(result.current).toEqual({
      secret: undefined,
      pagesBaseUrl: undefined,
      isLoading: true,
      isError: false,
    })
  })

  it("never reports isLoading when disabled, even mid-flight", () => {
    useQueryMock.mockReturnValue(teams({ fetchStatus: "fetching" }))
    const { result } = renderHook(() => useClassroomSecret("acme", "ml", false))
    expect(result.current.isLoading).toBe(false)
  })

  it("returns undefined without a match when classroom is absent", () => {
    useQueryMock.mockReturnValue(
      teams({
        data: [
          team("classroom50-ml", {
            description: desc({ secret: "a1b2c3d4" }),
          }),
        ],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useClassroomSecret("acme", undefined))
    expect(result.current.secret).toBeUndefined()
  })
})
