// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import { orgClassroom50StatusKey } from "@/hooks/useOrgClassroom50Status"
import type { TeardownPlan, TeardownResult } from "@/domain/teardown"

const executeTeardown = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock("@/domain/teardown", async () => {
  const actual =
    await vi.importActual<typeof import("@/domain/teardown")>(
      "@/domain/teardown",
    )
  return {
    ...actual,
    executeTeardown: (...args: unknown[]) => executeTeardown(...args),
  }
})
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useExecuteTeardown } from "./useExecuteTeardown"
import { TeardownRateLimitError } from "@/domain/teardown"

const ORG = "cs50"
const PLAN: TeardownPlan = { org: ORG, repoNames: ["classroom50"], teams: [] }
const TOKEN_KEY = githubKeys.serviceToken(ORG)
const STATUS_KEY = orgClassroom50StatusKey(ORG)

const cleanResult: TeardownResult = {
  deleted: ["classroom50"],
  failed: [],
  teamsDeleted: [],
  teamsFailed: [],
  markerDeleted: true,
}
// Marker retained: a transient repo failure left the org still set up.
const partialResult: TeardownResult = {
  deleted: [],
  failed: ["some-repo"],
  teamsDeleted: [],
  teamsFailed: [],
  markerDeleted: false,
}

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
}

// Seed the two setup-gating caches with the stale "already set up" state that a
// prior setup would have left behind, so eviction is observable.
function seedSetupComplete(queryClient: QueryClient) {
  queryClient.setQueryData(TOKEN_KEY, { status: "present" })
  queryClient.setQueryData(STATUS_KEY, "ready")
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useExecuteTeardown", () => {
  it("forgets the setup-gating caches on a clean run so a re-add restarts the wizard", async () => {
    executeTeardown.mockResolvedValue(cleanResult)
    const queryClient = freshClient()
    seedSetupComplete(queryClient)
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    const { result } = renderHook(() => useExecuteTeardown(PLAN), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // The wizard derives its finish stage from exactly these keys; leaving them
    // "present"/"ready" would jump a re-add straight to "You're all set".
    expect(queryClient.getQueryData(TOKEN_KEY)).toBeUndefined()
    expect(queryClient.getQueryData(STATUS_KEY)).toBeUndefined()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orgs"] })
  })

  it("keeps the gating caches on a partial run (marker retained = org still set up)", async () => {
    executeTeardown.mockResolvedValue(partialResult)
    const queryClient = freshClient()
    seedSetupComplete(queryClient)
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    const { result } = renderHook(() => useExecuteTeardown(PLAN), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // Config repo survives, so evicting would flash the wizard back to step 1.
    expect(queryClient.getQueryData(TOKEN_KEY)).toEqual({ status: "present" })
    expect(queryClient.getQueryData(STATUS_KEY)).toBe("ready")
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orgs"] })
  })

  it("refreshes the org list but keeps the gating caches on a rate-limit failure", async () => {
    executeTeardown.mockRejectedValue(
      new TeardownRateLimitError(["some-repo"], []),
    )
    const queryClient = freshClient()
    seedSetupComplete(queryClient)
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    const { result } = renderHook(() => useExecuteTeardown(PLAN), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate()
    await waitFor(() => expect(result.current.isError).toBe(true))

    // A rate-limit abort retains the marker, so the org is still set up.
    expect(queryClient.getQueryData(TOKEN_KEY)).toEqual({ status: "present" })
    expect(queryClient.getQueryData(STATUS_KEY)).toBe("ready")
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orgs"] })
  })

  it("is a no-op with a null plan", async () => {
    const queryClient = freshClient()
    seedSetupComplete(queryClient)

    const { result } = renderHook(() => useExecuteTeardown(null), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(executeTeardown).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(TOKEN_KEY)).toEqual({ status: "present" })
    expect(queryClient.getQueryData(STATUS_KEY)).toBe("ready")
  })
})
