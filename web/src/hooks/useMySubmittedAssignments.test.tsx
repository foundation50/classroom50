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
  extra: Partial<AcceptedAssignmentRepo> = {},
): AcceptedAssignmentRepo => ({
  assignment: {
    slug,
    name: slug,
    mode: "individual",
    autograder: "default",
    ...over,
  } as Assignment,
  repo: `cs101-${slug}-alice`,
  ...extra,
})

const settled = (state: { kind: string }) => state.kind !== "pending"

// Route each repo's reads by name so one client can answer a mixed fan-out:
// `hw1` has real work, `hw2` only the tool's accept-time commit, `hw3` submits
// via a canonical submit/* tag (time in the name), `hw4` has tags but none
// that count, `hw5` a milestone tag (submitted, but the tag list carries no
// time).
const mixedClient = (url: string) => {
  if (url.includes("/tags")) {
    if (url.includes("cs101-hw3-alice"))
      return Promise.resolve([
        { name: "submit/2026-01-01T00-00-00Z-abc1234", commit: { sha: "a" } },
      ])
    if (url.includes("cs101-hw5-alice"))
      return Promise.resolve([{ name: "phase1", commit: { sha: "p" } }])
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
  it("settles each accepted repo per its submission mode, with the newest time where the source carries one", async () => {
    request.mockImplementation(mixedClient)
    const { result } = renderHook(
      () =>
        useMySubmittedAssignments("acme", [
          accepted("hw1"),
          accepted("hw2"),
          accepted("hw3", { submission_mode: "tag" }),
          accepted("hw4", { submission_mode: "tag" }),
          accepted("hw5", {
            submission_mode: "tag",
            submission_tags: ["phase1"],
          }),
        ]),
      { wrapper: wrapper(makeClient()) },
    )
    expect(
      Object.values(result.current).every((s) => s.kind === "pending"),
    ).toBe(true)
    await waitFor(() =>
      expect(Object.values(result.current).every(settled)).toBe(true),
    )
    expect(result.current).toEqual({
      // Push: the newest commit's committer date; the bookkeeping-only repo
      // reads as nothing submitted.
      hw1: { kind: "submitted", latestAt: "2026-06-20T10:00:00Z" },
      hw2: { kind: "none" },
      // Canonical tag: time decoded from its name. Stray tags don't count.
      hw3: { kind: "submitted", latestAt: "2026-01-01T00:00:00Z" },
      hw4: { kind: "none" },
      // Milestone tag: submitted, but no time without a commit read.
      hw5: { kind: "submitted", latestAt: null },
    })
  })

  it("reports a failed read as unknown rather than as nothing submitted, in either mode", async () => {
    request.mockImplementation((url: string) =>
      url.includes("cs101-hw2-alice") || url.includes("cs101-hw4-alice")
        ? Promise.reject(apiError(500))
        : mixedClient(url),
    )
    const { result } = renderHook(
      () =>
        useMySubmittedAssignments("acme", [
          accepted("hw1"),
          accepted("hw2"),
          accepted("hw4", { submission_mode: "tag" }),
        ]),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() =>
      expect(Object.values(result.current).every(settled)).toBe(true),
    )
    expect(result.current.hw1.kind).toBe("submitted")
    expect(result.current.hw2).toEqual({ kind: "unknown" })
    expect(result.current.hw4).toEqual({ kind: "unknown" })
  })

  it("is empty with nothing accepted, issuing no reads", () => {
    const { result } = renderHook(() => useMySubmittedAssignments("acme", []), {
      wrapper: wrapper(makeClient()),
    })
    expect(result.current).toEqual({})
    expect(request).not.toHaveBeenCalled()
  })

  it("keeps the record's identity while the resolved values are unchanged", async () => {
    request.mockImplementation(mixedClient)
    const { result, rerender } = renderHook(
      () => useMySubmittedAssignments("acme", [accepted("hw1")]),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(settled(result.current.hw1)).toBe(true))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it("skips the opening repo read when the caller already knows the default branch", async () => {
    request.mockImplementation(mixedClient)
    const { result } = renderHook(
      () =>
        useMySubmittedAssignments("acme", [
          accepted("hw1", {}, { defaultBranch: "main" }),
        ]),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(settled(result.current.hw1)).toBe(true))
    expect(result.current.hw1.kind).toBe("submitted")
    const urls = request.mock.calls.map(([url]) => String(url))
    expect(urls.some((u) => /\/repos\/[^/]+\/[^/]+$/.test(u))).toBe(false)
    expect(urls).toHaveLength(2) // baseline + commit log
  })

  it("shares the cache entry with the single-repo reader the submission page uses", async () => {
    request.mockImplementation(mixedClient)
    const client = makeClient()
    const list = renderHook(
      () =>
        useMySubmittedAssignments("acme", [
          accepted("hw1", {}, { defaultBranch: "main" }),
        ]),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(settled(list.result.current.hw1)).toBe(true))
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
