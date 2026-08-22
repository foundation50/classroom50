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

const makeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

// The same branch-mode read router the teacher hook's test uses: repo object
// (default_branch), the marker commit list (baseline), and the default-branch
// commit log. This hook resolves the repo name itself from
// classroom/assignment/username, so any repo-shaped URL is answered.
function branchClient(opts: {
  defaultBranch?: string | null
  baselineCommits?: Array<{ sha: string }>
  branchCommits?: Array<{ sha: string; message?: string }>
}) {
  return (url: string) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return opts.defaultBranch === null
        ? Promise.resolve(null)
        : Promise.resolve({ default_branch: opts.defaultBranch ?? "main" })
    }
    if (url.includes("path=.classroom50.yaml")) {
      return Promise.resolve(opts.baselineCommits ?? [])
    }
    if (url.includes("/commits?sha=")) {
      return Promise.resolve(
        (opts.branchCommits ?? []).map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message ?? c.sha,
            committer: { date: "2026-06-20T10:00:00Z" },
          },
        })),
      )
    }
    return Promise.resolve([])
  }
}

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
})
