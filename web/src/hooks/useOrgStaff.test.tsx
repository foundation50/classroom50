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
  useGithubAuth: () => ({ user: { login: "teacher1" } }),
}))
// myTeamsQuery is a pure options factory; the mock returns a marker the mocked
// useQuery ignores (it returns whatever useQueryMock is set to).
vi.mock("@/github-core/queries", () => ({
  myTeamsQuery: () => ({ queryKey: ["my-teams"] }),
}))

import { useOrgStaff } from "./useOrgStaff"
import type { MyTeam } from "@/github-core/types"

const team = (slug: string, orgLogin = "acme"): MyTeam =>
  ({
    id: 1,
    name: slug,
    slug,
    privacy: "secret",
    description: null,
    organization: { login: orgLogin, id: 1 },
  }) as MyTeam

// The single teams query the hook runs.
const teams = (over: Record<string, unknown> = {}) => ({
  data: undefined as MyTeam[] | undefined,
  isSuccess: false,
  isError: false,
  fetchStatus: "idle",
  refetch: () => {},
  ...over,
})

beforeEach(() => {
  useQueryMock.mockReset()
})

describe("useOrgStaff — team-based org-staff signal", () => {
  it("is staff when the viewer is on a classroom staff team in this org", () => {
    useQueryMock.mockReturnValue(
      teams({ data: [team("classroom50-cs101-instructor")], isSuccess: true }),
    )
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current).toMatchObject({
      isStaff: true,
      isNonStaff: false,
      roleResolved: true,
      isError: false,
    })
  })

  it("is non-staff when the viewer is on no staff team (successful empty-ish listing)", () => {
    // A student: on some non-classroom team + the students team, but no
    // instructor/ta team. Cleanly non-staff, no 404 (self-scoped read).
    useQueryMock.mockReturnValue(
      teams({
        data: [team("classroom50-cs101"), team("some-other-team")],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current).toMatchObject({
      isStaff: false,
      isNonStaff: true,
      roleResolved: true,
    })
  })

  it("ignores a staff team in a DIFFERENT org", () => {
    useQueryMock.mockReturnValue(
      teams({
        data: [team("classroom50-cs101-instructor", "other-org")],
        isSuccess: true,
      }),
    )
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.isStaff).toBe(false)
    expect(result.current.isNonStaff).toBe(true)
  })

  it("holds unresolved (loading) while the teams read is fetching", () => {
    useQueryMock.mockReturnValue(teams({ fetchStatus: "fetching" }))
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
  })

  it("holds unresolved + surfaces isError when the teams read settles in error", () => {
    // Fail-closed: a transient failure must not demote a real staffer.
    useQueryMock.mockReturnValue(
      teams({ data: undefined, isSuccess: false, isError: true }),
    )
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
    expect(result.current.isError).toBe(true)
  })

  it("holds (unresolved, loading) with no org/user known", () => {
    useQueryMock.mockReturnValue(teams({ fetchStatus: "fetching" }))
    const { result } = renderHook(() => useOrgStaff(undefined))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isLoading).toBe(true)
  })

  it("refetch re-runs the teams query", () => {
    const refetch = vi.fn()
    useQueryMock.mockReturnValue(teams({ data: [], isSuccess: true, refetch }))
    const { result } = renderHook(() => useOrgStaff("acme"))
    result.current.refetch()
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
