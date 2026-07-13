// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { GitHubAPIError } from "@/hooks/github/errors"

// Drive each team-membership request by team slug. `<classroom>-instructor` and
// `<classroom>-ta` are the elevation teams; `<classroom>` (no role suffix) is
// the students team. Each responder is switchable so we can compose the
// instructor/ta/student verdicts the hook reduces.
type Resp = "active" | "inactive" | "404" | "500"
let instructorResp: Resp = "404"
let taResp: Resp = "404"
let studentResp: Resp = "404"

const err = (status: number, url: string) =>
  new GitHubAPIError({
    status,
    url,
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

const respond = (url: string, r: Resp) => {
  if (r === "active") return Promise.resolve({ state: "active" })
  if (r === "inactive") return Promise.resolve({ state: "pending" })
  return Promise.reject(err(r === "404" ? 404 : 500, url))
}

const request = vi.fn((url: string) => {
  // .../teams/classroom50-cs101-instructor/memberships/...
  if (url.includes("-instructor/memberships/"))
    return respond(url, instructorResp)
  if (url.includes("-ta/memberships/")) return respond(url, taResp)
  if (url.includes("/memberships/")) return respond(url, studentResp)
  return Promise.resolve({})
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))
vi.mock("@/context/roleView/RoleViewProvider", () => ({
  useRoleView: () => ({ viewAs: null, setViewAs: () => {} }),
}))

// Imported AFTER the mocks so the hook picks up the mocked dependencies.
import { useClassroomRole, teamMembershipQuery } from "./useClassroomRole"

const wrapper = ({ children }: PropsWithChildren) => {
  const client = new QueryClient({
    // Keep the query's own `retry` predicate (retryTransientGitHubError) but
    // make retries instant so a transient-500 read settles within the test.
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } },
  })
  return createElement(QueryClientProvider, { client }, children)
}

const renderRole = (username: string | undefined = "u") =>
  renderHook(() => useClassroomRole("acme", "cs101", username), { wrapper })

beforeEach(() => {
  instructorResp = "404"
  taResp = "404"
  studentResp = "404"
  request.mockClear()
})

describe("teamMembershipQuery queryFn (synthetic-404 for inactive membership)", () => {
  const fakeClient = {
    request: vi.fn(),
  } as unknown as Parameters<typeof teamMembershipQuery>[0]

  it("resolves true for an active membership", async () => {
    ;(fakeClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      state: "active",
    })
    const q = teamMembershipQuery(fakeClient, "acme", "team", "u")
    await expect(q.queryFn()).resolves.toBe(true)
  })

  it("throws a synthetic 404 for a non-active (pending/inactive) membership", async () => {
    ;(fakeClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      state: "pending",
    })
    const q = teamMembershipQuery(fakeClient, "acme", "team", "u")
    await expect(q.queryFn()).rejects.toMatchObject({
      name: "GitHubAPIError",
      status: 404,
    })
  })
})

describe("useClassroomRole — three-team resolution wiring", () => {
  it("resolves instructor when the instructor membership is active", async () => {
    instructorResp = "active"
    const { result } = renderRole()
    await waitFor(() => expect(result.current.role).toBe("instructor"))
  })

  it("resolves ta when only the ta membership is active", async () => {
    taResp = "active"
    const { result } = renderRole()
    await waitFor(() => expect(result.current.role).toBe("ta"))
  })

  it("resolves student positively from the students team", async () => {
    studentResp = "active"
    const { result } = renderRole()
    await waitFor(() => expect(result.current.role).toBe("student"))
  })

  it("fails OPEN to student when instructor/ta are 404 and the students read errors non-404", async () => {
    // The composed asymmetric fail-open: elevation reads definitive non-member,
    // students read a transient 500 -> role must resolve to student, not hold.
    instructorResp = "404"
    taResp = "404"
    studentResp = "500"
    const { result } = renderRole()
    await waitFor(
      () => {
        expect(result.current.role).toBe("student")
        expect(result.current.isLoading).toBe(false)
        expect(result.current.isError).toBe(false)
      },
      { timeout: 5000 },
    )
  })

  it("surfaces isError (does not strand) when an elevation read settles in a non-404 error", async () => {
    instructorResp = "500"
    taResp = "404"
    studentResp = "404"
    const { result } = renderRole()
    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false)
        expect(result.current.role).toBe("unresolved")
        expect(result.current.isError).toBe(true)
      },
      { timeout: 5000 },
    )
  })

  it("does not pin isLoading when the reads are disabled (no username)", async () => {
    const { result } = renderRole(undefined)
    // Disabled queries are idle (fetchStatus 'idle'), not fetching — the
    // isLoading derivation must not pin the guard's spinner.
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })
})
