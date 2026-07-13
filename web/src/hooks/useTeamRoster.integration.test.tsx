// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { GitHubAPIError } from "@/hooks/github/errors"

// Drive each GitHub request by URL: student + instructor members succeed; the TA
// members endpoint is switchable (fail -> recover) so we can assert isError
// folds in a STAFF-team failure and that refetch() re-runs the staff query.
let taMembersShouldFail = true
const request = vi.fn((url: string) => {
  if (url.includes("/teams/") && url.includes("/members")) {
    if (url.includes("-ta/members") && taMembersShouldFail) {
      return Promise.reject(
        new GitHubAPIError({
          status: 500,
          url,
          message: "boom 500",
          body: null,
          rateLimit: {
            limit: null,
            remaining: null,
            used: null,
            reset: null,
            resource: null,
            retryAfter: null,
          },
        }),
      )
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

// The invitations read, overridable per test. Default: readable (owner) with no
// pending and no error. A test sets `invitesOverride` to simulate a transient
// 5xx (isError) or a non-owner forbidden (pendingHidden).
type InvitesShape = {
  invitations: unknown[]
  failedInvitations: unknown[]
  isLoading: boolean
  isError: boolean
  isForbidden: boolean
}
const invitesDefault: InvitesShape = {
  invitations: [],
  failedInvitations: [],
  isLoading: false,
  isError: false,
  isForbidden: false,
}
let invitesOverride: InvitesShape | null = null

vi.mock("@/hooks/useGetOrgInvitations", () => ({
  default: () => invitesOverride ?? invitesDefault,
}))

// Imported AFTER the mocks so the hook picks up the mocked dependencies.
import { useTeamRoster } from "./useTeamRoster"

const wrapper = ({ children }: PropsWithChildren) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return createElement(QueryClientProvider, { client }, children)
}

describe("useTeamRoster — staff-team failure surfacing and recovery", () => {
  beforeEach(() => {
    taMembersShouldFail = true
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

// A readable (owner) invitations read failing on a transient 5xx must surface
// isError rather than render an authoritative "zero pending" — a non-owner's
// definitive 403 is `pendingHidden`, not an error.
describe("useTeamRoster — invitations transient failure surfacing", () => {
  beforeEach(() => {
    taMembersShouldFail = false
    request.mockClear()
  })

  it("folds a readable invitations transient error into isError", async () => {
    invitesOverride = {
      invitations: [],
      failedInvitations: [],
      isLoading: false,
      isError: true,
      isForbidden: false, // owner: readable, so not pendingHidden
    }
    const { result } = renderHook(() => useTeamRoster("acme", "cs101", []), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    invitesOverride = null
  })

  it("does NOT treat a non-owner's forbidden invitations as an error (pendingHidden)", async () => {
    invitesOverride = {
      invitations: [],
      failedInvitations: [],
      isLoading: false,
      isError: true,
      isForbidden: true, // non-owner: pending hidden by design, not an error
    }
    const { result } = renderHook(() => useTeamRoster("acme", "cs101", []), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.pendingHidden).toBe(true)
    invitesOverride = null
  })
})
