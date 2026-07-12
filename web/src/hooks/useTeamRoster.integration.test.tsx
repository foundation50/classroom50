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

vi.mock("@/hooks/useGetOrgInvitations", () => ({
  default: () => ({
    invitations: [],
    failedInvitations: [],
    isLoading: false,
    isForbidden: false,
  }),
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
