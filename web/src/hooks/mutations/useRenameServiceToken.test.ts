// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

const putRepoVariable = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock("@/github-core/mutations", () => ({
  putRepoVariable: (...args: unknown[]) => putRepoVariable(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useRenameServiceToken } from "./useRenameServiceToken"

const ORG = "cs50"

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  putRepoVariable.mockResolvedValue(undefined)
})

describe("useRenameServiceToken", () => {
  it("writes only the name variable (trimmed)", async () => {
    const { result } = renderHook(() => useRenameServiceToken(ORG), {
      wrapper: wrapperWith(freshClient()),
    })

    result.current.mutate("  classroom50-token-42-ab12  ")
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(putRepoVariable).toHaveBeenCalledTimes(1)
    const call = putRepoVariable.mock.calls[0]
    // (client, org, repo, name, value)
    expect(call[1]).toBe(ORG)
    expect(call[3]).toBe("CLASSROOM50_SERVICE_TOKEN_NAME")
    expect(call[4]).toBe("classroom50-token-42-ab12")
  })

  it("rejects an empty name without writing", async () => {
    const { result } = renderHook(() => useRenameServiceToken(ORG), {
      wrapper: wrapperWith(freshClient()),
    })

    result.current.mutate("   ")
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(putRepoVariable).not.toHaveBeenCalled()
  })

  it("invalidates this org's service-token status and the org list so the new label reads back", async () => {
    const { githubKeys } = await import("@/github-core/queries")
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useRenameServiceToken(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate("classroom50-token-42-ab12")
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey)
    expect(keys).toContainEqual(githubKeys.serviceToken(ORG))
    expect(keys).toContainEqual(["orgs"])
  })
})
