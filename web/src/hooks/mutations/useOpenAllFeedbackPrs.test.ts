// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import type { OpenAllFeedbackPrsSummary } from "@/domain/assignments"

const openAllFeedbackPullRequests =
  vi.fn<(...args: unknown[]) => Promise<OpenAllFeedbackPrsSummary>>()

vi.mock("@/domain/assignments", () => ({
  openAllFeedbackPullRequests: (...args: unknown[]) =>
    openAllFeedbackPullRequests(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useOpenAllFeedbackPrs } from "./useOpenAllFeedbackPrs"

const ORG = "cs50"
const OPEN_PULLS_PREFIX = ["github", "open-pulls"]

const summary = (
  over: Partial<OpenAllFeedbackPrsSummary> = {},
): OpenAllFeedbackPrsSummary => ({
  total: 1,
  created: 1,
  existed: 0,
  unsupported: [],
  blocked: [],
  failed: [],
  results: [],
  ...over,
})

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

describe("useOpenAllFeedbackPrs", () => {
  it("surfaces progress from the batch and invalidates open-pulls when PRs were created", async () => {
    openAllFeedbackPullRequests.mockImplementation(
      async (...args: unknown[]) => {
        const { onProgress } = args[0] as {
          onProgress?: (p: unknown) => void
        }
        onProgress?.({ done: 2, total: 2 })
        return summary({ total: 2, created: 2 })
      },
    )
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useOpenAllFeedbackPrs(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ org: ORG, repos: ["a", "b"], mode: "individual" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.progress).toEqual({ done: 2, total: 2 })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: OPEN_PULLS_PREFIX })
  })

  it("does not invalidate when nothing was created", async () => {
    openAllFeedbackPullRequests.mockResolvedValue(
      summary({ total: 3, created: 0, existed: 3 }),
    )
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useOpenAllFeedbackPrs(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ org: ORG, repos: ["a"], mode: "group" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: OPEN_PULLS_PREFIX })
  })

  it("passes org/repos/mode through to the domain batch", async () => {
    openAllFeedbackPullRequests.mockResolvedValue(summary())
    const queryClient = freshClient()
    const { result } = renderHook(() => useOpenAllFeedbackPrs(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ org: ORG, repos: ["a", "b"], mode: "group" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(openAllFeedbackPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        org: ORG,
        repos: ["a", "b"],
        mode: "group",
        onProgress: expect.any(Function),
      }),
    )
  })

  it("keeps reset referentially stable across renders so a reset-on-open effect can't re-fire mid-run", async () => {
    openAllFeedbackPullRequests.mockResolvedValue(summary())
    const queryClient = freshClient()
    const { result, rerender } = renderHook(() => useOpenAllFeedbackPrs(), {
      wrapper: wrapperWith(queryClient),
    })

    const firstReset = result.current.reset
    rerender()
    expect(result.current.reset).toBe(firstReset)

    // A run's own re-renders (isPending/progress flips) must not mint a new
    // reset either — the modal keys `if (open) reset()` on this identity, and
    // an unstable one wiped the in-flight run.
    result.current.mutate({ org: ORG, repos: ["a"], mode: "individual" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.reset).toBe(firstReset)

    // The stable reset still clears both the mutation and progress.
    result.current.reset()
    await waitFor(() => expect(result.current.isIdle).toBe(true))
    expect(result.current.progress).toBeNull()
  })
})
