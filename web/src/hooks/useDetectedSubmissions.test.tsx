// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import { useDetectedSubmissions } from "./useDetectedSubmissions"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: noRateLimit,
  })

const makeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

const base = {
  org: "acme",
  classroom: "cs101",
  assignment: "hw1",
  enabled: true,
}

// A URL router for the branch-mode reads: repo object (default_branch),
// the marker commit list (baseline), and the default-branch commit log.
function branchClient(opts: {
  defaultBranch?: string | null
  baselineCommits?: Array<{ sha: string }>
  branchCommits?: Array<{ sha: string }>
}) {
  return (url: string) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return opts.defaultBranch === null
        ? Promise.reject(apiError(404))
        : Promise.resolve({ default_branch: opts.defaultBranch ?? "main" })
    }
    if (url.includes("path=.classroom50.yaml")) {
      return Promise.resolve(opts.baselineCommits ?? [])
    }
    if (url.includes("/commits?sha=")) {
      return Promise.resolve(opts.branchCommits ?? [])
    }
    return Promise.resolve([])
  }
}

beforeEach(() => {
  request.mockReset()
})

describe("useDetectedSubmissions — branch mode", () => {
  it("counts default-branch commits minus the baseline", async () => {
    request.mockImplementation(
      branchClient({
        defaultBranch: "main",
        baselineCommits: [{ sha: "baseline" }],
        branchCommits: [{ sha: "c2" }, { sha: "c1" }, { sha: "baseline" }],
      }),
    )
    const { result } = renderHook(
      () =>
        useDetectedSubmissions({
          ...base,
          mode: "every-push",
          repoOwners: ["a"],
        }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.detected).toHaveLength(1)
    expect(result.current.detected[0].count).toBe(2)
  })

  it("emits nothing for a not-accepted repo (404 on the repo object)", async () => {
    request.mockImplementation(branchClient({ defaultBranch: null }))
    const { result } = renderHook(
      () =>
        useDetectedSubmissions({
          ...base,
          mode: "every-push",
          repoOwners: ["a"],
        }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.detected).toEqual([])
    // A 404 repo object resolves to null inside getRepo, so it's "not accepted",
    // not an error.
    expect(result.current.errorCount).toBe(0)
  })

  it("counts a transient baseline-read failure as an error (no +1 inflation)", async () => {
    // A 5xx on the baseline (.classroom50.yaml) read must NOT collapse to a
    // null baseline — that would keep the accept commit and over-count by one.
    // It propagates and lands the repo in errorCount instead.
    request.mockImplementation((url: string) => {
      if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return Promise.resolve({ default_branch: "main" })
      }
      if (url.includes("path=.classroom50.yaml")) {
        return Promise.reject(apiError(500))
      }
      if (url.includes("/commits?sha=")) {
        return Promise.resolve([{ sha: "c1" }, { sha: "baseline" }])
      }
      return Promise.resolve([])
    })
    const { result } = renderHook(
      () =>
        useDetectedSubmissions({
          ...base,
          mode: "every-push",
          repoOwners: ["a"],
        }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.detected).toEqual([])
    expect(result.current.errorCount).toBe(1)
  })
})

describe("useDetectedSubmissions — tag mode", () => {
  it("groups glob-matching tags into one submission set", async () => {
    request.mockImplementation((url: string) =>
      url.includes("/tags")
        ? Promise.resolve([
            { name: "v1", commit: { sha: "a" } },
            { name: "v2", commit: { sha: "b" } },
            { name: "other", commit: { sha: "c" } },
          ])
        : Promise.resolve([]),
    )
    const { result } = renderHook(
      () =>
        useDetectedSubmissions({
          ...base,
          mode: "tag",
          submissionTags: ["v*"],
          repoOwners: ["a"],
        }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.detected).toHaveLength(1)
    expect(result.current.detected[0].count).toBe(2)
    expect(result.current.detected[0].entries[0]).toMatchObject({
      kind: "tag-group",
      label: "v*",
    })
  })

  it("counts submit/* tags even with no milestone patterns configured", async () => {
    // The common tag-mode case: no teacher milestones, students push submit/*
    // tags via `gh student submit`. Detection must union the always-on submit/*
    // namespace (mirroring the shim trigger) or it would see nothing.
    request.mockImplementation((url: string) =>
      url.includes("/tags")
        ? Promise.resolve([
            {
              name: "submit/2026-01-01T00-00-00Z-abc1234",
              commit: { sha: "a" },
            },
            {
              name: "submit/2026-01-02T00-00-00Z-def5678",
              commit: { sha: "b" },
            },
            { name: "random", commit: { sha: "c" } },
          ])
        : Promise.resolve([]),
    )
    const { result } = renderHook(
      () =>
        useDetectedSubmissions({
          ...base,
          mode: "tag",
          submissionTags: [],
          repoOwners: ["a"],
        }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.detected).toHaveLength(1)
    // The two submit/* tags group under the submit/* glob; "random" is ignored.
    expect(result.current.detected[0].count).toBe(2)
  })
})

describe("useDetectedSubmissions — fan-out contract", () => {
  it("counts a non-404 failure without dropping the others (tag mode)", async () => {
    request.mockImplementation((url: string) => {
      if (url.includes("cs101-hw1-bad")) return Promise.reject(apiError(500))
      if (url.includes("/tags"))
        return Promise.resolve([{ name: "phase1", commit: { sha: "a" } }])
      return Promise.resolve([])
    })
    const { result } = renderHook(
      () =>
        useDetectedSubmissions({
          ...base,
          mode: "tag",
          submissionTags: ["phase1"],
          repoOwners: ["good", "bad"],
        }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.detected.map((d) => d.owner)).toEqual(["good"])
    expect(result.current.errorCount).toBe(1)
  })

  it("does not fetch when disabled (empty_repo assignment)", () => {
    const { result } = renderHook(
      () =>
        useDetectedSubmissions({
          ...base,
          mode: "every-push",
          repoOwners: ["a"],
          enabled: false,
        }),
      { wrapper: wrapper(makeClient()) },
    )
    expect(request).not.toHaveBeenCalled()
    expect(result.current.detected).toEqual([])
    expect(result.current.isPending).toBe(false)
  })

  it("does not fetch when there are no owners", () => {
    renderHook(
      () =>
        useDetectedSubmissions({
          ...base,
          mode: "every-push",
          repoOwners: [],
        }),
      { wrapper: wrapper(makeClient()) },
    )
    expect(request).not.toHaveBeenCalled()
  })
})
