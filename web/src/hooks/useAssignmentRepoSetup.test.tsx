// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import useAssignmentRepoSetup from "./useAssignmentRepoSetup"
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

// Lazy so the rejection is created only when the hook actually calls request;
// an eagerly created rejected promise is flagged as unhandled before the query
// runs.
const rejectWith = (status: number) =>
  request.mockImplementation(() => Promise.reject(apiError(status)))

const wrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  request.mockReset()
})

describe("useAssignmentRepoSetup", () => {
  it("reads the marker path on the repo's default branch", async () => {
    request.mockResolvedValue({ type: "file" })
    const { result } = renderHook(
      () => useAssignmentRepoSetup("acme", "cs101-hw-alice"),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.state).toBe("complete"))
    expect(request).toHaveBeenCalledWith(
      "/repos/acme/cs101-hw-alice/contents/.classroom50.yaml",
    )
  })

  it("reports incomplete on a 404 (the issue #502 shape)", async () => {
    rejectWith(404)
    const { result } = renderHook(
      () => useAssignmentRepoSetup("acme", "cs101-hw-alice"),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.state).toBe("incomplete"))
  })

  it("fails open to unknown on any other error", async () => {
    rejectWith(500)
    const { result } = renderHook(
      () => useAssignmentRepoSetup("acme", "cs101-hw-alice"),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.state).toBe("unknown")
  })

  it("does not probe when disabled or the repo name is unresolved", () => {
    const { result: disabled } = renderHook(
      () =>
        useAssignmentRepoSetup("acme", "cs101-hw-alice", { enabled: false }),
      { wrapper: wrapper() },
    )
    const { result: unnamed } = renderHook(
      () => useAssignmentRepoSetup("acme", ""),
      { wrapper: wrapper() },
    )
    expect(request).not.toHaveBeenCalled()
    expect(disabled.current.state).toBe("unknown")
    expect(disabled.current.isLoading).toBe(false)
    expect(unnamed.current.isLoading).toBe(false)
  })
})
