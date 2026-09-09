// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

const cancelOrgInvitation = vi.fn<
  (
    client: unknown,
    input: { org: string; invitationId: number },
  ) => Promise<{
    cancelled: boolean
  }>
>()
const invalidateInviteQueries = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  cancelOrgInvitation: (client: unknown, input: never) =>
    cancelOrgInvitation(client, input),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/github-core/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/github-core/queries")>()
  return {
    ...actual,
    invalidateInviteQueries: (queryClient: unknown, org: unknown) =>
      invalidateInviteQueries(queryClient, org),
  }
})

import { useDismissFailedInvitations } from "./useDismissFailedInvitations"
import { GitHubAPIError } from "@/github-core/errors"

const wrapperWith = (queryClient: QueryClient) =>
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useDismissFailedInvitations", () => {
  it("buckets each id (dismissed / already gone / failed) and never aborts the batch", async () => {
    cancelOrgInvitation
      .mockResolvedValueOnce({ cancelled: true })
      .mockResolvedValueOnce({ cancelled: false })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ cancelled: true })
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const { result } = renderHook(() => useDismissFailedInvitations("acme"), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate([1, 2, 3, 4])
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual({
      dismissed: 2,
      alreadyGone: 1,
      failed: [{ invitationId: 3, message: "boom" }],
      deferred: [],
    })
    expect(cancelOrgInvitation).toHaveBeenCalledTimes(4)
    expect(cancelOrgInvitation.mock.calls[2]?.[1]).toEqual({
      org: "acme",
      invitationId: 3,
    })
    // The failed list is refetched regardless of partial failure.
    expect(invalidateInviteQueries).toHaveBeenCalledWith(queryClient, "acme")
  })

  it("stops at a rate limit and defers the id it hit plus every id after it", async () => {
    cancelOrgInvitation
      .mockResolvedValueOnce({ cancelled: true })
      .mockRejectedValueOnce(
        new GitHubAPIError({
          status: 429,
          url: "/orgs/acme/invitations/2",
          message: "secondary rate limit",
          body: null,
          rateLimit: {
            limit: null,
            remaining: null,
            used: null,
            reset: null,
            resource: null,
            retryAfter: 60,
          },
        }),
      )
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const { result } = renderHook(() => useDismissFailedInvitations("acme"), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate([1, 2, 3, 4])
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual({
      dismissed: 1,
      alreadyGone: 0,
      failed: [],
      deferred: [2, 3, 4],
    })
    // Hammering a throttled endpoint only extends the window.
    expect(cancelOrgInvitation).toHaveBeenCalledTimes(2)
    expect(invalidateInviteQueries).toHaveBeenCalledWith(queryClient, "acme")
  })
})
