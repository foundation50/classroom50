// @vitest-environment happy-dom
// Regression: the summaries query wasn't keyed on the membership list it derives
// from, so a just-granted org stayed hidden until a second refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { GitHubAPIError } from "@/github-core/errors"

let activeLogins: string[] = []
const requests: string[] = []

const membership = (login: string) => ({
  state: "active",
  role: "admin",
  organization: {
    login,
    id: login.length,
    avatar_url: "",
    html_url: "",
    description: "",
  },
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({
    request: (path: string) => {
      requests.push(path)
      if (path.startsWith("/user/memberships/orgs")) {
        return Promise.resolve(activeLogins.map(membership))
      }
      // No config repo yet -> needs_setup for an active admin, and no Pages
      // probe (that path is non-admin only), so nothing leaves the mock.
      return Promise.reject(
        new GitHubAPIError({
          status: 404,
          url: `https://api.github.com${path}`,
          message: "HTTP 404",
          body: null,
          rateLimit: {} as never,
        }),
      )
    },
  }),
}))

import useGetOrgs from "./useGetOrgs"

const renderOrgs = (client: QueryClient) =>
  renderHook(() => useGetOrgs(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })

const logins = (data: ReturnType<typeof useGetOrgs>["data"]) =>
  (data ?? []).map((summary) => summary.org.login)

beforeEach(() => {
  activeLogins = ["alpha"]
  requests.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("useGetOrgs", () => {
  it("surfaces a newly granted org on the first invalidation", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { result } = renderOrgs(client)

    await waitFor(() => expect(logins(result.current.data)).toEqual(["alpha"]))

    // The grant happened on GitHub; the return trip invalidates once.
    activeLogins = ["alpha", "zeta"]
    await client.invalidateQueries({ queryKey: ["orgs"] })

    await waitFor(() =>
      expect(logins(result.current.data)).toEqual(["alpha", "zeta"]),
    )
  })

  it("keeps showing the current list while a refresh is in flight", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const seen: (string | undefined)[] = []
    const { result } = renderHook(
      () => {
        const orgs = useGetOrgs()
        seen.push(
          orgs.data === undefined ? undefined : logins(orgs.data).join(),
        )
        return orgs
      },
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    )

    await waitFor(() => expect(logins(result.current.data)).toEqual(["alpha"]))
    seen.length = 0

    activeLogins = ["alpha", "zeta"]
    await client.invalidateQueries({ queryKey: ["orgs"] })
    await waitFor(() =>
      expect(logins(result.current.data)).toEqual(["alpha", "zeta"]),
    )

    // A refresh must not blank `data`, or the page flashes its full-screen
    // spinner mid-refresh.
    expect(seen).not.toContain(undefined)
    expect(seen).not.toContain("")
  })

  it("probes each org's config repo once per refresh", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { result } = renderOrgs(client)
    await waitFor(() => expect(logins(result.current.data)).toEqual(["alpha"]))

    requests.length = 0
    activeLogins = ["alpha", "zeta"]
    await client.invalidateQueries({ queryKey: ["orgs"] })
    await waitFor(() =>
      expect(logins(result.current.data)).toEqual(["alpha", "zeta"]),
    )

    // Keying the summaries query on the membership list made the ["orgs"]
    // prefix refetch the OLD key first, against the pre-refresh list — running
    // the whole per-org fan-out twice and discarding the first pass.
    expect(
      requests.filter((path) => path.startsWith("/repos/alpha/")),
    ).toHaveLength(1)
    expect(
      requests.filter((path) => path.startsWith("/user/memberships/orgs")),
    ).toHaveLength(1)
  })
})
