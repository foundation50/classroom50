// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import {
  useMySubmittedAssignments,
  type AcceptedAssignmentRepo,
} from "./useMySubmittedAssignments"
import useGetMyPushSubmissions from "./useGetMyPushSubmissions"
import { branchClient, apiError } from "@/test/branchDetectionClient"
import { FEEDBACK_OPEN_COMMIT_MESSAGE } from "@/util/commit"
import type { Assignment } from "@/types/classroom"

const makeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

const accepted = (
  slug: string,
  over: Partial<Assignment> = {},
): AcceptedAssignmentRepo => ({
  assignment: {
    slug,
    name: slug,
    mode: "individual",
    autograder: "default",
    ...over,
  } as Assignment,
  repo: `cs101-${slug}-alice`,
})

// Route each repo's reads by name so one client can answer a mixed fan-out:
// `hw1` has real work, `hw2` only the tool's accept-time commit, `hw3` submits
// via a tag, `hw4` has tags but none that count.
const mixedClient = (url: string) => {
  if (url.includes("/tags")) {
    if (url.includes("cs101-hw3-alice"))
      return Promise.resolve([
        { name: "submit/2026-01-01T00-00-00Z-abc1234", commit: { sha: "a" } },
      ])
    return Promise.resolve([{ name: "random", commit: { sha: "c" } }])
  }
  if (url.includes("cs101-hw1-alice"))
    return branchClient({
      baselineCommits: [{ sha: "baseline" }],
      branchCommits: [{ sha: "work" }, { sha: "baseline" }],
    })(url)
  return branchClient({
    baselineCommits: [{ sha: "baseline" }],
    branchCommits: [
      { sha: "feedback", message: FEEDBACK_OPEN_COMMIT_MESSAGE },
      { sha: "baseline" },
    ],
  })(url)
}

beforeEach(() => {
  request.mockReset()
})

describe("useMySubmittedAssignments", () => {
  it("marks submitted per the assignment's submission mode, ignoring bookkeeping commits and stray tags", async () => {
    request.mockImplementation(mixedClient)
    const { result } = renderHook(
      () =>
        useMySubmittedAssignments("acme", [
          accepted("hw1"),
          accepted("hw2"),
          accepted("hw3", { submission_mode: "tag" }),
          accepted("hw4", { submission_mode: "tag" }),
        ]),
      { wrapper: wrapper(makeClient()) },
    )
    expect(result.current.isPending).toBe(true)
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect([...result.current.submittedSlugs].toSorted()).toEqual([
      "hw1",
      "hw3",
    ])
  })

  it("settles a repo whose read fails as not submitted, without holding the rest", async () => {
    request.mockImplementation((url: string) =>
      url.includes("cs101-hw2-alice")
        ? Promise.reject(apiError(500))
        : mixedClient(url),
    )
    const { result } = renderHook(
      () =>
        useMySubmittedAssignments("acme", [accepted("hw1"), accepted("hw2")]),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect([...result.current.submittedSlugs]).toEqual(["hw1"])
  })

  it("is settled and empty with nothing accepted, issuing no reads", () => {
    const { result } = renderHook(() => useMySubmittedAssignments("acme", []), {
      wrapper: wrapper(makeClient()),
    })
    expect(result.current.isPending).toBe(false)
    expect(result.current.submittedSlugs.size).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })

  it("keeps the set's identity while the resolved values are unchanged", async () => {
    request.mockImplementation(mixedClient)
    const { result, rerender } = renderHook(
      () => useMySubmittedAssignments("acme", [accepted("hw1")]),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isPending).toBe(false))
    const first = result.current.submittedSlugs
    rerender()
    expect(result.current.submittedSlugs).toBe(first)
  })

  it("shares the cache entry with the single-repo reader the submission page uses", async () => {
    request.mockImplementation(mixedClient)
    const client = makeClient()
    const list = renderHook(
      () => useMySubmittedAssignments("acme", [accepted("hw1")]),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(list.result.current.isPending).toBe(false))
    const reads = request.mock.calls.length

    // Opening the row: the page's reader finds the list's result already cached.
    const page = renderHook(
      () => useGetMyPushSubmissions("acme", "cs101", "hw1", "alice"),
      { wrapper: wrapper(client) },
    )
    expect(page.result.current.data?.map((c) => c.sha)).toEqual(["work"])
    expect(request.mock.calls.length).toBe(reads)
  })
})
