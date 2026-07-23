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
// The fix is a `retryOnMount` predicate on useGetOwnOrgMembership that suppresses
// the remount refetch only for DEFINITIVE errors (401/403/404) — the loop's
// driver — while still refetching transient 5xx/429/network errors on remount so
// the documented self-heal is preserved. These tests cover both halves:
//   1. a definitive 403 settles without an unbounded refetch loop, and
//   2. a transient 500 still refetches on a fresh mount (no permanent pinning).
import { afterEach, describe, expect, it, vi } from "vitest"
import { StrictMode } from "react"
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { GitHubAPIError } from "@/github-core/errors"

const requestCount = vi.fn()
// Per-test HTTP status the mocked membership read rejects with.
let responseStatus = 403

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({
    request: (path: string) => {
      requestCount(path)
      return Promise.reject(
        new GitHubAPIError({
          status: responseStatus,
          url: `https://api.github.com${path}`,
          message: `HTTP ${responseStatus}`,
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
  return <div>{isError ? "settled-error" : "child-loading"}</div>
}

afterEach(() => {
  cleanup()
  requestCount.mockClear()
  responseStatus = 403
})

describe("useGetOwnOrgMembership — remount behavior", () => {
  it("settles a definitive 403 without an unbounded refetch loop", async () => {
    responseStatus = 403
    const client = new QueryClient({
      defaultOptions: {
        // Match production intent: a definitive 403 does not retry.
        queries: { retry: false },
      },
    })

    // StrictMode double-invokes render + mounts each effect twice, reproducing
    // the exact fresh-observer-on-remount condition the fix must survive.
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <Gate org="acme" />
        </QueryClientProvider>
      </StrictMode>,
    )

    // The tree must settle on the terminal error branch, not spin forever.
    await waitFor(() =>
      expect(screen.queryByText("settled-error")).not.toBeNull(),
    )

    // Give any latent loop time to manifest.
    await new Promise((r) => setTimeout(r, 100))

    // Without the retryOnMount suppression the definitive error refetches on
    // every remount, driving the loop into dozens/hundreds of requests. With the
    // fix the cached error survives remounts, so the queryFn runs only a small,
    // bounded number of times (a generous ceiling that a loop would blow past).
    expect(requestCount.mock.calls.length).toBeLessThan(6)
    expect(screen.queryByText("org-spinner")).toBeNull()
  })

  it("still refetches a transient 500 error on a fresh mount (self-heal preserved)", async () => {
    responseStatus = 500
    // Shared cache across mounts so the second mount sees the cached transient
    // error and must decide whether to refetch it. retry:false isolates the
    // remount-refetch decision (retryOnMount) from the in-fetch retry loop.
    const client = new QueryClient({
      defaultOptions: { queries: { retryDelay: 0 } },
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const first = renderHook(() => useGetOwnOrgMembership("acme"), { wrapper })
    // The hook's own retryTransientGitHubError retries a 500 twice; retryDelay:0
    // (above) makes that settle promptly. Allow generous time for it to reach
    // the terminal error before probing the remount behavior.
    await waitFor(() => expect(first.result.current.isError).toBe(true), {
      timeout: 3000,
    })
    const afterFirst = requestCount.mock.calls.length
    first.unmount()

    // Remount a fresh observer against the SAME client (cached 500 present).
    const second = renderHook(() => useGetOwnOrgMembership("acme"), { wrapper })

    // A transient error must NOT be pinned: the fresh mount refetches it, so the
    // request count grows past the first mount's total. (A definitive 403 would
    // stay flat here — that's the behavior the loop test locks in.)
    await waitFor(
      () => expect(requestCount.mock.calls.length).toBeGreaterThan(afterFirst),
      { timeout: 3000 },
    )
    await waitFor(() => expect(second.result.current.isError).toBe(true), {
      timeout: 3000,
    })
  })
})
