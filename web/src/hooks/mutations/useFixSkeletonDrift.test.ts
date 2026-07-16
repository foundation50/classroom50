// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"

const ensureSkeletonFiles = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock("@/github-core/mutations", () => ({
  ensureSkeletonFiles: (client: unknown, org: unknown, confirm: unknown) =>
    ensureSkeletonFiles(client, org, confirm),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useFixSkeletonDrift } from "./useFixSkeletonDrift"

const ORG = "acme"

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useFixSkeletonDrift", () => {
  it("seeds the drift cache empty when the fix resolved clean (avoids a stale refetch)", async () => {
    ensureSkeletonFiles.mockResolvedValue({
      status: "complete",
      created: ["workflows/collect-scores.yaml"],
      skippedOverwrite: [],
    })
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const confirm = vi.fn(() => Promise.resolve(true))
    const { result } = renderHook(() => useFixSkeletonDrift(confirm), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate(ORG)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(ensureSkeletonFiles).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      confirm,
    )
    expect(queryClient.getQueryData(githubKeys.skeletonDrift(ORG))).toEqual([])
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("invalidates instead of seeding when the fix skipped a declined overwrite", async () => {
    ensureSkeletonFiles.mockResolvedValue({
      status: "complete",
      created: [],
      skippedOverwrite: ["workflows/collect-scores.yaml"],
    })
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(
      () => useFixSkeletonDrift(() => Promise.resolve(false)),
      { wrapper: wrapperWith(queryClient) },
    )

    result.current.mutate(ORG)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.skeletonDrift(ORG),
    })
    expect(
      queryClient.getQueryData(githubKeys.skeletonDrift(ORG)),
    ).toBeUndefined()
  })

  it("attributes the cache write to the mutate-variable org, not a shared param", async () => {
    ensureSkeletonFiles.mockResolvedValue({
      status: "complete",
      created: [],
      skippedOverwrite: [],
    })
    const queryClient = freshClient()
    const { result } = renderHook(
      () => useFixSkeletonDrift(() => Promise.resolve(true)),
      { wrapper: wrapperWith(queryClient) },
    )

    result.current.mutate("other-org")
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(
      queryClient.getQueryData(githubKeys.skeletonDrift("other-org")),
    ).toEqual([])
    expect(
      queryClient.getQueryData(githubKeys.skeletonDrift(ORG)),
    ).toBeUndefined()
  })
})
