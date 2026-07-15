// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

const useQueryMock = vi.fn()
let githubOrgRoleMock = "member"

vi.mock("@tanstack/react-query", () => ({
  useQuery: (arg: unknown) => useQueryMock(arg),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "teacher1" } }),
}))
vi.mock("@/context/githubOrgRole/GitHubOrgRoleProvider", () => ({
  useGitHubOrgRole: () => ({ githubOrgRole: githubOrgRoleMock }),
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
  githubOrgRoleMock = "member"
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

  it("treats an org owner as staff even with no teams (fresh org)", () => {
    githubOrgRoleMock = "owner"
    // Empty successful listing: no classroom staff team at all.
    useQueryMock.mockReturnValue(teams({ data: [], isSuccess: true }))
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current).toMatchObject({
      isStaff: true,
      isNonStaff: false,
      roleResolved: true,
      isError: false,
    })
  })

  it("resolves an owner immediately, without waiting on the teams read", () => {
    githubOrgRoleMock = "owner"
    // Teams read still in flight — the owner should resolve as staff anyway,
    // never pinned on the spinner.
    useQueryMock.mockReturnValue(teams({ fetchStatus: "fetching" }))
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.isStaff).toBe(true)
    expect(result.current.roleResolved).toBe(true)
    expect(result.current.isNonStaff).toBe(false)
    // A resolved owner is not "loading" even while an irrelevant teams read is
    // in flight — ClassesPage gates its whole render on isLoading.
    expect(result.current.isLoading).toBe(false)
  })

  it("holds fail-closed while the org role is unresolved (no owner flash)", () => {
    githubOrgRoleMock = "unresolved"
    // Org read in flight AND teams read in flight: not yet staff via the owner
    // path, falls back to the team-based hold rather than flashing staff.
    useQueryMock.mockReturnValue(teams({ fetchStatus: "fetching" }))
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.isStaff).toBe(false)
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
  })

  it("keeps a non-owner on a staff team as staff regardless of org role", () => {
    githubOrgRoleMock = "member"
    useQueryMock.mockReturnValue(
      teams({ data: [team("classroom50-cs101-ta")], isSuccess: true }),
    )
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.isStaff).toBe(true)
    expect(result.current.isNonStaff).toBe(false)
  })
})
