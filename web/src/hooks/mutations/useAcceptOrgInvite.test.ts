// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

const acceptAndVerifyOrgMembership = vi.fn(() => Promise.resolve())
const acceptPendingOrgInvite = vi.fn(() => Promise.resolve())

vi.mock("@/domain/users", () => ({
  acceptAndVerifyOrgMembership: () => acceptAndVerifyOrgMembership(),
  acceptPendingOrgInvite: () => acceptPendingOrgInvite(),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/hooks/useGetOrgs", () => ({
  orgMembershipsQueryKey: ["orgs", "memberships"],
}))

import { useAcceptOrgInvite } from "./useAcceptOrgInvite"
import { useAcceptPendingOrgInvite } from "./useAcceptPendingOrgInvite"
import { githubKeys } from "@/github-core/queries"

const ORG = "acme"

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

beforeEach(() => {
  acceptAndVerifyOrgMembership.mockClear()
  acceptPendingOrgInvite.mockClear()
})

describe("useAcceptOrgInvite", () => {
  it("accepts + verifies, then invalidates memberships and orgs on success", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useAcceptOrgInvite(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(acceptAndVerifyOrgMembership).toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["orgs", "memberships"],
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orgs"] })
  })
})

describe("useAcceptPendingOrgInvite", () => {
  it("accepts the pending invite, then invalidates the org membership + orgs keys", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useAcceptPendingOrgInvite(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(acceptPendingOrgInvite).toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.ownOrgMembership(ORG),
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orgs"] })
  })
})
