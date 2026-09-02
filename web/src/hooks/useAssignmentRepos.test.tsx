// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import { useAssignmentRepos } from "./useAssignmentRepos"
import { githubKeys } from "@/github-core/queries"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import type { GitHubRequestOptions } from "@/github-core/client"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const notFound = () =>
  new GitHubAPIError({
    status: 404,
    url: "https://api.github.com/x",
    message: "Not Found",
    body: null,
    rateLimit: noRateLimit,
  })

const LIST = "https://api.github.com/orgs/acme/repos?per_page=100"

// An org of `lastPage` listing pages where only `existing` repos answer a
// direct read; records which of the two shapes each call took.
function serveOrg(opts: { lastPage: number; existing: string[] }) {
  const listed: number[] = []
  const probed: string[] = []
  request.mockImplementation(
    async (path: string, options?: GitHubRequestOptions) => {
      const page = /[?&]page=(\d+)/.exec(path)
      if (page) {
        const n = Number(page[1])
        listed.push(n)
        if (n === 1) {
          options?.onHeaders?.(
            new Headers({
              link: `<${LIST}&page=2>; rel="next", <${LIST}&page=${opts.lastPage}>; rel="last"`,
            }),
          )
        }
        return n === opts.lastPage
          ? opts.existing.map((name) => ({ name, private: true }))
          : [{ name: `filler-${n}`, private: true }]
      }
      const name = decodeURIComponent(path.split("/").pop() ?? "")
      probed.push(name)
      if (opts.existing.includes(name)) return { name, private: true }
      throw notFound()
    },
  )
  return { listed, probed }
}

const makeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

const base = { org: "acme", classroom: "cs101", assignment: "hw1" }

beforeEach(() => {
  request.mockReset()
})

describe("useAssignmentRepos", () => {
  it("reads a small roster's repos directly instead of walking the org", async () => {
    const { listed, probed } = serveOrg({
      lastPage: 20,
      existing: ["cs101-hw1-alice"],
    })
    const { result } = renderHook(
      () => useAssignmentRepos({ ...base, logins: ["Alice", "bob"] }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(listed).toEqual([1])
    expect(probed.sort()).toEqual(["cs101-hw1-alice", "cs101-hw1-bob"])
    expect(result.current.data?.map((r) => r.name)).toEqual([
      "filler-1",
      "cs101-hw1-alice",
    ])
  })

  it("walks the whole org when the logins are not derivable", async () => {
    const { listed, probed } = serveOrg({
      lastPage: 3,
      existing: ["cs101-hw1-group-1"],
    })
    const { result } = renderHook(
      () => useAssignmentRepos({ ...base, logins: undefined }),
      { wrapper: wrapper(makeClient()) },
    )
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(listed.sort()).toEqual([1, 2, 3])
    expect(probed).toEqual([])
    expect(result.current.data?.map((r) => r.name)).toContain(
      "cs101-hw1-group-1",
    )
  })

  it("does nothing while disabled", async () => {
    serveOrg({ lastPage: 2, existing: [] })
    const { result } = renderHook(
      () => useAssignmentRepos({ ...base, logins: ["alice"], enabled: false }),
      { wrapper: wrapper(makeClient()) },
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(request).not.toHaveBeenCalled()
    expect(result.current.isPending).toBe(true)
  })

  it("is invalidated by the org repo list key", async () => {
    const { listed } = serveOrg({ lastPage: 20, existing: [] })
    const client = makeClient()
    const { result } = renderHook(
      () => useAssignmentRepos({ ...base, logins: ["alice"] }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(listed).toEqual([1])
    await client.invalidateQueries({ queryKey: githubKeys.orgRepos("acme") })
    await waitFor(() => expect(listed).toEqual([1, 1]))
  })
})
