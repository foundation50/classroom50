// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { GitHubAPIError } from "@/github-core/errors"

const apiError = (status: number, url: string) =>
  new GitHubAPIError({
    status,
    url,
    message: status === 404 ? "Not Found" : `boom ${status}`,
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

// Drive each GitHub request by URL. Members: student + instructor succeed; the
// TA members endpoint is switchable (fail -> recover) so we can assert isError
// folds in a STAFF-team failure and that refetch() re-runs the staff query.
// Invitations: the STUDENT team's pending endpoint is switchable to a transient
// 500 to assert the readable-owner error path. Failed invitations default [].
let taMembersShouldFail = true
let studentInvitesShouldFail = false
let studentFailedInvitesShouldFail = false
const request = vi.fn((url: string): Promise<unknown[]> => {
  if (url.includes("/teams/") && url.includes("/invitations")) {
    // Student team pending invitations (classroom50-cs101/invitations).
    if (url.includes("/teams/classroom50-cs101/invitations")) {
      if (studentInvitesShouldFail) {
        return Promise.reject(apiError(500, url))
      }
    }
    return Promise.resolve([]) // no pending invites for any team
  }
  if (url.includes("/failed_invitations")) {
    if (studentFailedInvitesShouldFail) {
      return Promise.reject(apiError(500, url))
    }
    return Promise.resolve([])
  }
  if (url.includes("/teams/") && url.includes("/members")) {
    if (url.includes("-ta/members") && taMembersShouldFail) {
      return Promise.reject(apiError(500, url))
    }
    return Promise.resolve([]) // empty member list for the other teams
  }
  return Promise.resolve([])
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

vi.mock("@/hooks/useGetClassroom", () => ({
  default: () => ({ data: undefined }),
}))

// Ownership gates the (now team-scoped) invitation reads. Default owner so the
// student pending/failed reads fire; a test flips to "member" for the
// non-owner pendingHidden path.
let githubOrgRole = "owner"
vi.mock("@/context/githubOrgRole/GitHubOrgRoleProvider", () => ({
  useGitHubOrgRole: () => ({ githubOrgRole, isError: false, retry: () => {} }),
}))

// Imported AFTER the mocks so the hook picks up the mocked dependencies.
import { useTeamRoster } from "./useTeamRoster"

const wrapper = ({ children }: PropsWithChildren) => {
  const client = new QueryClient({
    // retryDelay 0 so a query that DOES retry (teamInvitationsQuery uses
    // retryTransientGitHubError) settles within the test instead of leaving
    // backed-off retries in flight that pollute a later test's request calls.
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  })
  return createElement(QueryClientProvider, { client }, children)
}

describe("useTeamRoster — staff-team failure surfacing and recovery", () => {
  beforeEach(() => {
    githubOrgRole = "owner"
    taMembersShouldFail = true
    studentInvitesShouldFail = false
    request.mockClear()
  })

  it("folds a non-404 STAFF-team member fetch failure into isError", async () => {
    const { result } = renderHook(() => useTeamRoster("acme", "cs101", []), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    // A staff-team failure is a real error, not an empty roster.
    expect(result.current.isEmpty).toBe(false)
  })

  it("refetch() re-runs the staff query so a recovered failure clears isError", async () => {
    const { result } = renderHook(() => useTeamRoster("acme", "cs101", []), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    // The failure heals; refetch must re-run the STAFF query (not just the
    // student one) for isError to clear.
    taMembersShouldFail = false
    result.current.refetch()

    await waitFor(() => expect(result.current.isError).toBe(false))
  })
})

// A readable (owner) student pending read failing on a transient 5xx must
// surface isError rather than render an authoritative "zero pending" — a
// non-owner's definitive not-owner state is `pendingHidden`, not an error.
describe("useTeamRoster — invitations transient failure surfacing", () => {
  beforeEach(() => {
    githubOrgRole = "owner"
    taMembersShouldFail = false
    studentInvitesShouldFail = false
    studentFailedInvitesShouldFail = false
    request.mockClear()
  })

  it("folds a readable student pending transient error into isError", async () => {
    studentInvitesShouldFail = true
    const { result } = renderHook(() => useTeamRoster("acme", "cs101", []), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  it("folds a readable failed-invitations transient error into isError", async () => {
    // Symmetric with pending: a transient 5xx on the failed read must not
    // render an authoritative "zero failed invites" for an owner who has them.
    studentFailedInvitesShouldFail = true
    const { result } = renderHook(() => useTeamRoster("acme", "cs101", []), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  it("does NOT treat a non-owner as an error (pendingHidden, no invite reads)", async () => {
    githubOrgRole = "member"
    const { result } = renderHook(() => useTeamRoster("acme", "cs101", []), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.pendingHidden).toBe(true)
    // A non-owner never fires the owner-only invitation endpoints (pending or
    // failed). `/failed_invitations` has no `/invitations` prefix, so match the
    // team pending path explicitly.
    const calledInvites = request.mock.calls.some(
      ([url]) =>
        String(url).includes("/invitations") ||
        String(url).includes("/failed_invitations"),
    )
    expect(calledInvites).toBe(false)
  })
})

// The core #236 regression: a pending invite present on ONE classroom's team
// must not leak onto a sibling classroom whose team does not list it. Since the
// read is now team-scoped by URL, a pending invite only appears for the team
// slug that returns it.
describe("useTeamRoster — pending scoped to the classroom team (#236)", () => {
  beforeEach(() => {
    githubOrgRole = "owner"
    taMembersShouldFail = false
    studentInvitesShouldFail = false
    studentFailedInvitesShouldFail = false
    request.mockClear()
  })

  it("shows a pending invite for the team that lists it, not a sibling", async () => {
    const scoped = vi.fn((url: string): Promise<unknown[]> => {
      if (url.includes("/teams/classroom50-cs101/invitations")) {
        return Promise.resolve([
          { id: 7, login: "pat", email: null, role: "direct_member" },
        ])
      }
      if (url.includes("/teams/") && url.includes("/invitations")) {
        return Promise.resolve([]) // other teams (incl. sibling classroom) list none
      }
      if (url.includes("/failed_invitations")) return Promise.resolve([])
      return Promise.resolve([])
    })
    request.mockImplementation(scoped)

    const cs101 = renderHook(() => useTeamRoster("acme", "cs101", []), {
      wrapper,
    })
    await waitFor(() => expect(cs101.result.current.isLoading).toBe(false))
    expect(cs101.result.current.counts.pending).toBe(1)

    const cs201 = renderHook(() => useTeamRoster("acme", "cs201", []), {
      wrapper,
    })
    await waitFor(() => expect(cs201.result.current.isLoading).toBe(false))
    expect(cs201.result.current.counts.pending).toBe(0)

    // The read is genuinely per-team: each classroom hit its OWN team-scoped
    // pending URL. This is what closes #236 — a single shared (org-wide) read
    // could not distinguish the two, so distinct per-slug requests prove scope.
    const requested = (u: string) =>
      scoped.mock.calls.some(([url]) => String(url).includes(u))
    expect(requested("/teams/classroom50-cs101/invitations")).toBe(true)
    expect(requested("/teams/classroom50-cs201/invitations")).toBe(true)
  })
})
