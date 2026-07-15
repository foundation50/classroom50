// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

const useQueriesMock = vi.fn()
const getClassesMock = vi.fn()

vi.mock("@tanstack/react-query", () => ({
  useQueries: (arg: unknown) => useQueriesMock(arg),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "teacher1" } }),
}))
vi.mock("@/hooks/useGetClasses", () => ({
  default: (org: string | undefined) => getClassesMock(org),
}))
vi.mock("@/hooks/useClassroomRole", () => ({
  teamMembershipQuery: () => ({}),
}))

import { useOrgStaff } from "./useOrgStaff"
import { GitHubAPIError } from "@/github-core/errors"

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/orgs/acme/teams/x/memberships/teacher1",
    message: `boom ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })

// react-query result stubs for the per-team probes.
const member = {
  isSuccess: true,
  error: null,
  fetchStatus: "idle",
  isError: false,
  refetch: () => {},
}
const nonMember = {
  isSuccess: false,
  error: apiError(404),
  fetchStatus: "idle",
  isError: false,
  refetch: () => {},
}
const erroredProbe = {
  isSuccess: false,
  error: apiError(500),
  fetchStatus: "idle",
  isError: true,
  refetch: () => {},
}

const classes = (over: Record<string, unknown>) => ({
  classes: [],
  isSuccess: false,
  isLoading: false,
  isError: false,
  refetch: () => {},
  ...over,
})

beforeEach(() => {
  useQueriesMock.mockReset()
  getClassesMock.mockReset()
})

describe("useOrgStaff — class-list state gates the verdict", () => {
  it("holds unresolved while the class list is still loading (no premature non-staff)", () => {
    // The bug this guards: useGetClasses returns classes=[] while loading, so a
    // naive classesResolved=true would flash a definitive non-staff.
    getClassesMock.mockReturnValue(
      classes({ classes: [], isLoading: true, isSuccess: false }),
    )
    useQueriesMock.mockReturnValue([])
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
    expect(result.current.isStaff).toBe(false)
    expect(result.current.isLoading).toBe(true)
  })

  it("surfaces isError (not non-staff) when the class-list read fails", () => {
    getClassesMock.mockReturnValue(
      classes({
        classes: [],
        isLoading: false,
        isSuccess: false,
        isError: true,
      }),
    )
    useQueriesMock.mockReturnValue([])
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
    expect(result.current.isError).toBe(true)
  })

  it("resolves non-staff for an org with a successfully-loaded empty class list", () => {
    getClassesMock.mockReturnValue(classes({ classes: [], isSuccess: true }))
    useQueriesMock.mockReturnValue([])
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current).toMatchObject({
      isStaff: false,
      isNonStaff: true,
      roleResolved: true,
      isError: false,
    })
  })

  it("is staff when a probe confirms membership on a loaded class list", () => {
    getClassesMock.mockReturnValue(
      classes({ classes: [{ name: "cs101" }], isSuccess: true }),
    )
    // instructor probe = member, ta probe = non-member.
    useQueriesMock.mockReturnValue([member, nonMember])
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.isStaff).toBe(true)
    expect(result.current.roleResolved).toBe(true)
  })

  it("holds unresolved on a transient probe error even after the class list loaded", () => {
    getClassesMock.mockReturnValue(
      classes({ classes: [{ name: "cs101" }], isSuccess: true }),
    )
    useQueriesMock.mockReturnValue([nonMember, erroredProbe])
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isError).toBe(true)
  })

  it("holds (unresolved, loading) with no org/user known", () => {
    getClassesMock.mockReturnValue(classes({ classes: [], isSuccess: true }))
    useQueriesMock.mockReturnValue([])
    const { result } = renderHook(() => useOrgStaff(undefined))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isLoading).toBe(true)
  })
})
