// @vitest-environment happy-dom
// Regression for the infinite accept-spinner loop (#infinite-accept-spinner).
//
// The org layout gates its whole subtree behind a full-screen spinner while the
// membership query is loading, and the gated subtree ALSO reads the same
// membership query. For a non-member the query errors (403/404); if a fresh
// observer on remount refetches the errored query, `isLoading` flips back to
// true → spinner → the subtree (and its observer) UNMOUNTS → the query settles →
// spinner clears → subtree REMOUNTS → fresh observer refetches → loop.
//
// The fix (`retryOnMount: false` on useGetOwnOrgMembership) keeps the cached
// error across remounts, so the queryFn runs a bounded number of times and the
// tree stabilizes on the error screen. This test drives the exact mount/unmount
// pattern and asserts the queryFn is not called unboundedly.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { GitHubAPIError } from "@/github-core/errors"

const requestCount = vi.fn()

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({
    request: (path: string) => {
      requestCount(path)
      return Promise.reject(
        new GitHubAPIError({
          status: 403,
          url: `https://api.github.com${path}`,
          message: "Forbidden",
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
    },
  }),
}))

import useGetOwnOrgMembership from "./useGetOwnOrgMembership"

// Mirrors OrgLayout: a full-subtree spinner gate keyed on the membership query's
// isLoading, wrapping a child that reads the SAME membership query.
function Gate({ org }: { org: string }) {
  const { isLoading } = useGetOwnOrgMembership(org)
  if (isLoading) return <div>org-spinner</div>
  return <GatedChild org={org} />
}

function GatedChild({ org }: { org: string }) {
  // The gated subtree also reads membership (as AcceptAssignmentPage does).
  const { isError } = useGetOwnOrgMembership(org)
  return <div>{isError ? "not-a-member" : "child-loading"}</div>
}

afterEach(() => {
  cleanup()
  requestCount.mockClear()
})

describe("useGetOwnOrgMembership — no remount refetch loop for non-members", () => {
  it("settles on the error screen without an unbounded refetch loop", async () => {
    const client = new QueryClient({
      defaultOptions: {
        // Match production intent: a definitive 403 does not retry.
        queries: { retry: false },
      },
    })

    render(
      <QueryClientProvider client={client}>
        <Gate org="acme" />
      </QueryClientProvider>,
    )

    // The tree must settle on the terminal error branch, not spin forever.
    await waitFor(() =>
      expect(screen.queryByText("not-a-member")).not.toBeNull(),
    )

    // Give any latent loop time to manifest.
    await new Promise((r) => setTimeout(r, 100))

    // Without retryOnMount:false the errored query refetches on every remount,
    // driving the loop into dozens/hundreds of requests. With the fix the
    // cached error survives remounts, so the queryFn runs only a handful of
    // times (initial mounts of the two observers + StrictMode doubling).
    expect(requestCount.mock.calls.length).toBeLessThan(6)
    expect(screen.queryByText("org-spinner")).toBeNull()
  })
})
