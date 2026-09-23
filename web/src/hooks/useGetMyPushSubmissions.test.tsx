// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import useGetMyPushSubmissions from "./useGetMyPushSubmissions"
import {
  FEEDBACK_OPEN_COMMIT_MESSAGE,
  shimUpdateCommitMessage,
} from "@/util/commit"
import { apiError, branchClient } from "@/test/branchDetectionClient"

const makeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

beforeEach(() => {
  request.mockReset()
})

describe("useGetMyPushSubmissions", () => {
  // The point of centralizing on submissionCommits: the student's own view
  // must exclude the identical set (baseline + the tool's bookkeeping commits)
  // the teacher fan-out excludes, while keeping real student work — including a
  // student's own `[Classroom 50] Submit` commit.
  it("excludes the baseline and the tool's bookkeeping commits, keeps student work", async () => {
    request.mockImplementation(
      branchClient({
        defaultBranch: "main",
        baselineCommits: [{ sha: "baseline" }],
        branchCommits: [
          { sha: "submit", message: "[Classroom 50] Submit hw1" },
          { sha: "work" },
          { sha: "shim", message: shimUpdateCommitMessage("tag") },
          { sha: "feedback", message: FEEDBACK_OPEN_COMMIT_MESSAGE },
          { sha: "baseline" },
        ],
      }),
    )
    const { result } = renderHook(
      () => useGetMyPushSubmissions("acme", "cs101", "hw1", "alice"),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect((result.current.data ?? []).map((c) => c.sha)).toEqual([
      "submit",
      "work",
    ])
  })

  it("reads a commitless bare repo (409 on the commit reads) as no submissions", async () => {
    // An empty_repo accept the student hasn't pushed to yet: their view must
    // say "nothing submitted", not fail to load.
    request.mockImplementation((url: string) => {
      if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return Promise.resolve({ default_branch: "main" })
      }
      if (url.includes("/commits")) return Promise.reject(apiError(409))
      return Promise.resolve([])
    })
    const { result } = renderHook(
      () => useGetMyPushSubmissions("acme", "cs101", "hw1", "alice"),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.data).toEqual([])
  })

  it("returns empty for a not-accepted repo (no default branch)", async () => {
    request.mockImplementation(branchClient({ defaultBranch: null }))
    const { result } = renderHook(
      () => useGetMyPushSubmissions("acme", "cs101", "hw1", "alice"),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.data).toEqual([])
  })

  it("does not fetch until org and repo resolve", () => {
    renderHook(
      () => useGetMyPushSubmissions(undefined, "cs101", "hw1", "alice"),
      { wrapper: wrapper(makeClient()) },
    )
    expect(request).not.toHaveBeenCalled()
  })

  // No marker commit: the root is the seed of every initialized repo and is
  // excluded by default; only a bare empty_repo (rootIsBaseline false) counts
  // its root commit, which is the student's first push.
  it("treats the root commit as the baseline unless the caller says the repo is bare", async () => {
    const markerless = branchClient({
      defaultBranch: "main",
      baselineCommits: [],
      branchCommits: [{ sha: "work" }, { sha: "seed" }],
    })
    request.mockImplementation(markerless)
    const initialized = renderHook(
      () => useGetMyPushSubmissions("acme", "cs101", "hw1", "alice"),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() =>
      expect(initialized.result.current.isFetching).toBe(false),
    )
    expect((initialized.result.current.data ?? []).map((c) => c.sha)).toEqual([
      "work",
    ])

    const bare = renderHook(
      () =>
        useGetMyPushSubmissions("acme", "cs101", "hw1", "alice", {
          rootIsBaseline: false,
        }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(bare.result.current.isFetching).toBe(false))
    expect((bare.result.current.data ?? []).map((c) => c.sha)).toEqual([
      "work",
      "seed",
    ])
  })
})
