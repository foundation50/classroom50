// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import { useLiveSubmissions } from "./useLiveSubmissions"
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

const submitRelease = (tag: string, when: string) => ({
  id: 1,
  tag_name: tag,
  name: tag,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  created_at: when,
  published_at: when,
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

beforeEach(() => {
  request.mockReset()
})

describe("useLiveSubmissions", () => {
  it("fetches all owners in one batch", async () => {
    request.mockResolvedValue([
      submitRelease("submit/x", "2026-01-01T00:00:00Z"),
    ])
    const owners = Array.from({ length: 5 }, (_, i) => `s${i}`)

    const { result } = renderHook(
      () =>
        useLiveSubmissions({
          ...base,
          repoOwners: owners,
        }),
      { wrapper: wrapper(makeClient()) },
    )

    await waitFor(() => expect(result.current.submissions.length).toBe(5))
    expect(request).toHaveBeenCalledTimes(5)
  })

  it("treats a repo with no submit release as not-submitted, not an error", async () => {
    request.mockResolvedValue([]) // repo exists but no submissions
    const { result } = renderHook(
      () => useLiveSubmissions({ ...base, repoOwners: ["a"] }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.submissions).toEqual([])
    expect(result.current.errorCount).toBe(0)
  })

  it("counts a repo's non-404 failure without dropping the others", async () => {
    request.mockImplementation((url: string) =>
      url.includes("cs101-hw1-bad")
        ? Promise.reject(apiError(500))
        : Promise.resolve([submitRelease("submit/x", "2026-01-01T00:00:00Z")]),
    )
    const { result } = renderHook(
      () => useLiveSubmissions({ ...base, repoOwners: ["good", "bad"] }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.submissions.map((s) => s.owner)).toEqual(["good"])
    expect(result.current.errorCount).toBe(1)
  })

  it("does not fetch when disabled (e.g. empty_repo assignment)", () => {
    const { result } = renderHook(
      () => useLiveSubmissions({ ...base, repoOwners: ["a"], enabled: false }),
      { wrapper: wrapper(makeClient()) },
    )
    expect(request).not.toHaveBeenCalled()
    expect(result.current.submissions).toEqual([])
    // A disabled fan-out has nothing to wait for, so it must not report pending
    // (else the page would hold the "not submitted" list forever).
    expect(result.current.isPending).toBe(false)
  })

  it("reports isPending until the first fan-out resolves", async () => {
    request.mockResolvedValue([
      submitRelease("submit/x", "2026-01-01T00:00:00Z"),
    ])
    const { result } = renderHook(
      () => useLiveSubmissions({ ...base, repoOwners: ["a"] }),
      { wrapper: wrapper(makeClient()) },
    )
    expect(result.current.isPending).toBe(true)
    await waitFor(() => expect(result.current.isPending).toBe(false))
  })

  it("does not fetch when there are no repo owners", () => {
    const { result } = renderHook(
      () => useLiveSubmissions({ ...base, repoOwners: [] }),
      { wrapper: wrapper(makeClient()) },
    )
    expect(request).not.toHaveBeenCalled()
    expect(result.current.submissions).toEqual([])
  })

  it("retries a rate-limited repo read and counts it as submitted, not an error", async () => {
    // First call for the repo is a 429 (retry-after 0 = immediate), second (the
    // retry) succeeds — the shared retryOnRateLimit wrapper should absorb it so
    // it lands as a submission, not an errorCount.
    const rateLimited = new GitHubAPIError({
      status: 429,
      url: "https://api.github.com/x",
      message: "rate limited",
      body: null,
      rateLimit: { ...noRateLimit, retryAfter: 0 },
    })
    let calls = 0
    request.mockImplementation(() => {
      calls++
      if (calls === 1) return Promise.reject(rateLimited)
      return Promise.resolve([
        submitRelease("submit/x", "2026-01-01T00:00:00Z"),
      ])
    })
    const { result } = renderHook(
      () => useLiveSubmissions({ ...base, repoOwners: ["a"] }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.submissions.map((s) => s.owner)).toEqual(["a"])
    expect(result.current.errorCount).toBe(0)
  })

  it("threads the submit-release count onto each live submission", async () => {
    request.mockResolvedValue([
      submitRelease("submit/2026-03-01T00:00:00Z-c", "2026-03-01T00:00:00Z"),
      submitRelease("submit/2026-02-01T00:00:00Z-b", "2026-02-01T00:00:00Z"),
      submitRelease("submit/2026-01-01T00:00:00Z-a", "2026-01-01T00:00:00Z"),
    ])
    const { result } = renderHook(
      () => useLiveSubmissions({ ...base, repoOwners: ["a"] }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.submissions.length).toBe(1))
    expect(result.current.submissions[0].submissionCount).toBe(3)
    // The newest release drives the presence fields.
    expect(result.current.submissions[0].tag).toBe(
      "submit/2026-03-01T00:00:00Z-c",
    )
  })

  it("refetch() re-reads the current page's repos", async () => {
    request.mockResolvedValue([
      submitRelease("submit/x", "2026-01-01T00:00:00Z"),
    ])
    const { result } = renderHook(
      () => useLiveSubmissions({ ...base, repoOwners: ["a", "b"] }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(request).toHaveBeenCalledTimes(2)

    result.current.refetch()
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4))
  })
})
