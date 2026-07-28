// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import type { RepairFeedbackPrResult } from "@/domain/assignments"

const repairFeedbackPullRequest =
  vi.fn<(...args: unknown[]) => Promise<RepairFeedbackPrResult>>()

vi.mock("@/domain/assignments", () => ({
  repairFeedbackPullRequest: (...args: unknown[]) =>
    repairFeedbackPullRequest(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useRepairFeedbackPr } from "./useRepairFeedbackPr"

const ORG = "cs50"
const REPO = "cs50-hw1-alice"
const OPEN_PULLS_KEY = ["github", "open-pulls", ORG, REPO]

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

describe("useRepairFeedbackPr", () => {
  it("invalidates the row's open-pulls read when a PR was created", async () => {
    repairFeedbackPullRequest.mockResolvedValue({ ok: true, created: true })
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useRepairFeedbackPr(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ org: ORG, repo: REPO, mode: "individual" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: OPEN_PULLS_KEY })
  })

  it("does not invalidate when the PR already existed (created: false)", async () => {
    repairFeedbackPullRequest.mockResolvedValue({ ok: true, created: false })
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useRepairFeedbackPr(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ org: ORG, repo: REPO, mode: "individual" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: OPEN_PULLS_KEY })
  })

  it("does not invalidate on an unsupported verdict", async () => {
    repairFeedbackPullRequest.mockResolvedValue({
      ok: false,
      reason: "no-baseline",
      unsupported: true,
    })
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useRepairFeedbackPr(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ org: ORG, repo: REPO, mode: "individual" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toMatchObject({ ok: false })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: OPEN_PULLS_KEY })
  })

  it("passes org/repo/mode through to the domain repair", async () => {
    repairFeedbackPullRequest.mockResolvedValue({ ok: true, created: true })
    const queryClient = freshClient()
    const { result } = renderHook(() => useRepairFeedbackPr(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ org: ORG, repo: REPO, mode: "group" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(repairFeedbackPullRequest).toHaveBeenCalledWith({
      client: expect.anything(),
      org: ORG,
      repo: REPO,
      mode: "group",
    })
  })
})
