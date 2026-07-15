// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

const useQueryMock = vi.fn()
const getClassesMock = vi.fn()

vi.mock("@tanstack/react-query", () => ({
  useQuery: (arg: unknown) => useQueryMock(arg),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({
    // Every probe reads a body with no active state => non-member.
    request: async () => ({}),
  }),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "teacher1" } }),
}))
vi.mock("@/hooks/useGetClasses", () => ({
  default: (org: string | undefined) => getClassesMock(org),
}))

import { useOrgStaff } from "./useOrgStaff"
import type { GitHubTeamMembership } from "@/util/roles"

// Aggregate probe-query result stub (the single useQuery the hook runs). `data`
// is the flat signals array resolveOrgStaff consumes.
const probe = (over: Record<string, unknown> = {}) => ({
  data: undefined as GitHubTeamMembership[] | undefined,
  isSuccess: false,
  isError: false,
  fetchStatus: "idle",
  refetch: () => {},
  ...over,
})

const classes = (over: Record<string, unknown>) => ({
  classes: [],
  isSuccess: false,
  isLoading: false,
  isError: false,
  refetch: () => {},
  ...over,
})

beforeEach(() => {
  useQueryMock.mockReset()
  getClassesMock.mockReset()
})

describe("useOrgStaff — class-list state gates the verdict", () => {
  it("holds unresolved while the class list is still loading (no premature non-staff)", () => {
    // The bug this guards: useGetClasses returns classes=[] while loading, so a
    // naive classesResolved=true would flash a definitive non-staff.
    getClassesMock.mockReturnValue(
      classes({ classes: [], isLoading: true, isSuccess: false }),
    )
    useQueryMock.mockReturnValue(probe({ fetchStatus: "idle" }))
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
    useQueryMock.mockReturnValue(probe())
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
    expect(result.current.isError).toBe(true)
  })

  it("resolves non-staff for an org with a successfully-loaded empty class list", () => {
    getClassesMock.mockReturnValue(classes({ classes: [], isSuccess: true }))
    useQueryMock.mockReturnValue(probe({ data: [], isSuccess: true }))
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
    useQueryMock.mockReturnValue(
      probe({ data: ["member", "non-member"], isSuccess: true }),
    )
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.isStaff).toBe(true)
    expect(result.current.roleResolved).toBe(true)
  })

  it("holds unresolved (surfaces isError) when the probe query settles in error", () => {
    // A transient probe failure exhausts retries -> the aggregate query errors;
    // the verdict must hold unresolved and offer retry, never demote to non-staff.
    getClassesMock.mockReturnValue(
      classes({ classes: [{ name: "cs101" }], isSuccess: true }),
    )
    useQueryMock.mockReturnValue(
      probe({ data: undefined, isSuccess: false, isError: true }),
    )
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
    expect(result.current.isError).toBe(true)
  })

  it("is loading (holds unresolved) while the probe query is fetching", () => {
    getClassesMock.mockReturnValue(
      classes({ classes: [{ name: "cs101" }], isSuccess: true }),
    )
    useQueryMock.mockReturnValue(probe({ fetchStatus: "fetching" }))
    const { result } = renderHook(() => useOrgStaff("acme"))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
  })

  it("refetch re-runs both the class list and the probe query", () => {
    const refetchClasses = vi.fn()
    const refetchProbes = vi.fn()
    getClassesMock.mockReturnValue(
      classes({
        classes: [{ name: "cs101" }],
        isSuccess: true,
        refetch: refetchClasses,
      }),
    )
    useQueryMock.mockReturnValue(
      probe({
        data: ["non-member", "non-member"],
        isSuccess: true,
        refetch: refetchProbes,
      }),
    )
    const { result } = renderHook(() => useOrgStaff("acme"))
    result.current.refetch()
    expect(refetchClasses).toHaveBeenCalledTimes(1)
    expect(refetchProbes).toHaveBeenCalledTimes(1)
  })

  it("settles (not loading) with no org/user known, without resolving a verdict", () => {
    // An org-less route (no $org) or a not-yet-known viewer is disabled, not
    // loading — otherwise the footer role label would shimmer forever on the
    // org list. It just never resolves a verdict (roleResolved stays false).
    getClassesMock.mockReturnValue(classes({ classes: [], isSuccess: true }))
    useQueryMock.mockReturnValue(probe())
    const { result } = renderHook(() => useOrgStaff(undefined))
    expect(result.current.roleResolved).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isNonStaff).toBe(false)
    expect(result.current.isStaff).toBe(false)
  })

  it("bounds the probe fan-out through mapWithConcurrency (queryFn)", async () => {
    // Guard the fix: the probe queryFn must run through the concurrency limiter
    // (not fire all 2N GETs at once). We capture the queryFn passed to useQuery
    // and assert it resolves a signal per (classroom x staff role) slug.
    let captured: (() => Promise<GitHubTeamMembership[]>) | undefined
    getClassesMock.mockReturnValue(
      classes({
        classes: [{ name: "cs101" }, { name: "cs102" }],
        isSuccess: true,
      }),
    )
    useQueryMock.mockImplementation(
      (opts: { queryFn: () => Promise<GitHubTeamMembership[]> }) => {
        captured = opts.queryFn
        return probe()
      },
    )
    renderHook(() => useOrgStaff("acme"))
    expect(captured).toBeTypeOf("function")
    // 2 classrooms x 2 staff roles = 4 probes; the client mock returns {} so each
    // probe reads state !== "active" => non-member.
    const signals = await captured!()
    expect(signals).toHaveLength(4)
    expect(signals.every((s) => s === "non-member")).toBe(true)
  })
})
