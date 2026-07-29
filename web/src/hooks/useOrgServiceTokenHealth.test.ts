// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import type { ServiceTokenStatus } from "@/github-core/queries"

const getServiceTokenStatus =
  vi.fn<(...args: unknown[]) => Promise<ServiceTokenStatus>>()

// Keep the real classify/derive/keys; only the network read is mocked so we can
// drive each org's status deterministically.
vi.mock("@/github-core/queries", async () => {
  const actual = await vi.importActual<typeof import("@/github-core/queries")>(
    "@/github-core/queries",
  )
  return {
    ...actual,
    getServiceTokenStatus: (...args: unknown[]) =>
      getServiceTokenStatus(...args),
  }
})
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useOrgServiceTokenHealth } from "./useOrgServiceTokenHealth"

const present = (over: Partial<ServiceTokenStatus> = {}): ServiceTokenStatus =>
  ({
    status: "present",
    secretName: "CLASSROOM50_SERVICE_TOKEN",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    message: "",
    ...over,
  }) as ServiceTokenStatus

function wrapper(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useOrgServiceTokenHealth", () => {
  it("derives each org's verdict from its own status read", async () => {
    // orgA: present, healthy, recorded far-future expiry -> ok
    // orgB: present, expired -> expired
    getServiceTokenStatus.mockImplementation((_client: unknown, org: unknown) =>
      Promise.resolve(
        org === "orgA"
          ? present({ expiresAt: "2027-01-01T00:00:00Z" })
          : present({ expiresAt: "2020-01-01T00:00:00Z" }),
      ),
    )

    const { result } = renderHook(
      () => useOrgServiceTokenHealth(["orgA", "orgB"], true),
      { wrapper: wrapper(freshClient()) },
    )

    await waitFor(() => expect(result.current.byOrg.orgA?.health).toBe("ok"))
    expect(result.current.byOrg.orgB?.health).toBe("expired")
  })

  it("resolves an owner-blocked (unknown) status to health 'unknown', never a false 'missing'", async () => {
    getServiceTokenStatus.mockResolvedValue({
      status: "unknown",
      secretName: "CLASSROOM50_SERVICE_TOKEN",
      reason: "permission_denied",
      message: "",
    } as ServiceTokenStatus)

    const { result } = renderHook(
      () => useOrgServiceTokenHealth(["orgA"], true),
      { wrapper: wrapper(freshClient()) },
    )

    await waitFor(() =>
      expect(result.current.byOrg.orgA?.health).toBe("unknown"),
    )
  })

  it("reports expiryUntracked for a present token with no recorded expiry (not a false ok)", async () => {
    getServiceTokenStatus.mockResolvedValue(present())

    const { result } = renderHook(
      () => useOrgServiceTokenHealth(["orgA"], true),
      { wrapper: wrapper(freshClient()) },
    )

    await waitFor(() =>
      expect(result.current.byOrg.orgA?.health).toBe("expiryUntracked"),
    )
  })

  it("is gated off when disabled", () => {
    getServiceTokenStatus.mockResolvedValue(present())

    renderHook(() => useOrgServiceTokenHealth(["orgA"], false), {
      wrapper: wrapper(freshClient()),
    })

    expect(getServiceTokenStatus).not.toHaveBeenCalled()
  })
})
