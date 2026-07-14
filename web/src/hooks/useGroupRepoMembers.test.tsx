// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import { useGroupRepoMemberLogins } from "./useGroupRepoMembers"
import { githubKeys } from "./github/queries"
import type { GitHubUser } from "./github/types"

const user = (login: string): GitHubUser => ({ login }) as GitHubUser

const makeClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

beforeEach(() => {
  request.mockReset()
})

describe("useGroupRepoMemberLogins", () => {
  it("returns the lowercased union of collaborators across all group repos", async () => {
    request.mockImplementation((url: string) =>
      url.includes("cs101-hw1-alice")
        ? Promise.resolve([user("Alice"), user("Bob")])
        : Promise.resolve([user("carol")]),
    )
    const { result } = renderHook(
      () =>
        useGroupRepoMemberLogins("acme", [
          { owner: "alice", repoName: "cs101-hw1-alice" },
          { owner: "dave", repoName: "cs101-hw1-dave" },
        ]),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() =>
      expect([...result.current].sort()).toEqual(["alice", "bob", "carol"]),
    )
  })

  it("primes the shared per-repo collaborators cache the rows/modal read", async () => {
    request.mockResolvedValue([user("alice")])
    const client = makeClient()
    renderHook(
      () =>
        useGroupRepoMemberLogins("acme", [
          { owner: "alice", repoName: "cs101-hw1-alice" },
        ]),
      { wrapper: wrapper(client) },
    )
    await waitFor(() =>
      expect(
        client.getQueryData(
          githubKeys.collaborators("acme", "cs101-hw1-alice"),
        ),
      ).toEqual([user("alice")]),
    )
  })

  it("keeps the union from surviving repos when one repo's read fails", async () => {
    // mapWithConcurrency is all-or-nothing; the hook wraps each read so a single
    // repo's 404/403/429 can't void the whole union (#245 regression guard).
    request.mockImplementation((url: string) =>
      url.includes("cs101-hw1-alice")
        ? Promise.reject(new Error("404"))
        : Promise.resolve([user("carol")]),
    )
    const { result } = renderHook(
      () =>
        useGroupRepoMemberLogins("acme", [
          { owner: "alice", repoName: "cs101-hw1-alice" },
          { owner: "dave", repoName: "cs101-hw1-dave" },
        ]),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect([...result.current].sort()).toEqual(["carol"]))
  })

  it("does not fetch when there are no group repos", () => {
    const { result } = renderHook(() => useGroupRepoMemberLogins("acme", []), {
      wrapper: wrapper(makeClient()),
    })
    expect(request).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })
})
