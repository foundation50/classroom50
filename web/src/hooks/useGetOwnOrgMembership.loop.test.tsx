// @vitest-environment happy-dom
// Regression for the infinite accept-spinner loop.
//
// OrgLayout gates its whole subtree behind a spinner while the membership query
// loads, and the gated subtree reads that same query. For a non-member the query
// errors; if a fresh observer refetches the errored query on remount, isLoading
// flips back to true -> spinner -> subtree unmounts -> settles -> remounts ->
// refetches -> loop. The retryOnMount predicate suppresses the remount refetch
// for DEFINITIVE errors (the loop driver) but keeps it for transient ones (self-
// heal). These two tests lock in both halves.
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
// HTTP status the mocked membership read rejects with (per-test).
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
          rateLimit: {} as never,
        }),
      )
    },
  }),
}))

import useGetOwnOrgMembership from "./useGetOwnOrgMembership"

// Mirrors OrgLayout: a spinner gate keyed on the membership query's isLoading,
// wrapping a child that reads the SAME query (as AcceptAssignmentPage does).
function Gate({ org }: { org: string }) {
  const { isLoading } = useGetOwnOrgMembership(org)
  if (isLoading) return <div>org-spinner</div>
  return <GatedChild org={org} />
}

function GatedChild({ org }: { org: string }) {
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
      defaultOptions: { queries: { retry: false } },
    })

    // StrictMode double-mounts, reproducing the fresh-observer-on-remount case.
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <Gate org="acme" />
        </QueryClientProvider>
      </StrictMode>,
    )

    await waitFor(() =>
      expect(screen.queryByText("settled-error")).not.toBeNull(),
    )
    await new Promise((r) => setTimeout(r, 100)) // let any latent loop manifest

    // A loop would blow past this ceiling; the cached error keeps it bounded.
    expect(requestCount.mock.calls.length).toBeLessThan(6)
    expect(screen.queryByText("org-spinner")).toBeNull()
  })

  it("still refetches a transient 500 on a fresh mount (self-heal preserved)", async () => {
    responseStatus = 500
    // Shared cache so the remount sees the cached error; retryDelay:0 settles the
    // hook's own transient retry promptly.
    const client = new QueryClient({
      defaultOptions: { queries: { retryDelay: 0 } },
    })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const first = renderHook(() => useGetOwnOrgMembership("acme"), { wrapper })
    await waitFor(() => expect(first.result.current.isError).toBe(true), {
      timeout: 3000,
    })
    const afterFirst = requestCount.mock.calls.length
    first.unmount()

    // Fresh observer, same client: a transient error must refetch (not stay
    // pinned as a definitive one would).
    const second = renderHook(() => useGetOwnOrgMembership("acme"), { wrapper })
    await waitFor(
      () => expect(requestCount.mock.calls.length).toBeGreaterThan(afterFirst),
      { timeout: 3000 },
    )
    await waitFor(() => expect(second.result.current.isError).toBe(true), {
      timeout: 3000,
    })
  })
})
