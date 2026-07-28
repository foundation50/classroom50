// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import type { ServiceTokenStatus } from "@/github-core/queries"

const validateServiceToken = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const putRepoSecret = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const putRepoVariable = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock("@/github-core/mutations", () => ({
  validateServiceToken: (...args: unknown[]) => validateServiceToken(...args),
  putRepoSecret: (...args: unknown[]) => putRepoSecret(...args),
  putRepoVariable: (...args: unknown[]) => putRepoVariable(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useSaveServiceToken } from "./useSaveServiceToken"

const ORG = "cs50"
const KEY = githubKeys.serviceToken(ORG)

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  validateServiceToken.mockResolvedValue(undefined)
  putRepoSecret.mockResolvedValue(undefined)
  putRepoVariable.mockResolvedValue(undefined)
})

describe("useSaveServiceToken", () => {
  it("seeds status 'present' under the key the consumer reads (survives #307)", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useSaveServiceToken(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ serviceToken: "ghp_token" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // The wizard derives its finish stage from exactly this key, so a drift in
    // the key or shape would silently reopen #307.
    const seeded = queryClient.getQueryData<ServiceTokenStatus>(KEY)
    expect(seeded?.status).toBe("present")
    expect(seeded?.secretName).toBe("CLASSROOM50_SERVICE_TOKEN")
  })

  it("uses the same key useGetServiceTokenStatus reads, defaulting a missing org to ''", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useSaveServiceToken(undefined), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ serviceToken: "ghp_token" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // Consumer reads githubKeys.serviceToken(org ?? ""); a drift here would seed
    // under a key the wizard never reads and reopen #307.
    expect(
      queryClient.getQueryData<ServiceTokenStatus>(githubKeys.serviceToken(""))
        ?.status,
    ).toBe("present")
  })

  it("records the expiry variable when an expiry window is given", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useSaveServiceToken(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ serviceToken: "ghp_token", expiresInDays: 120 })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(putRepoVariable).toHaveBeenCalledTimes(1)
    const call = putRepoVariable.mock.calls[0]
    // (client, org, repo, name, value) — assert the variable name and an
    // ISO-date value.
    expect(call[3]).toBe("CLASSROOM50_SERVICE_TOKEN_EXPIRES_AT")
    expect(typeof call[4]).toBe("string")
    expect(Number.isNaN(Date.parse(call[4] as string))).toBe(false)
  })

  it("skips the expiry variable when no window is given", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useSaveServiceToken(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ serviceToken: "ghp_token" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(putRepoVariable).not.toHaveBeenCalled()
  })

  it("still succeeds when writing the expiry variable fails (advisory)", async () => {
    putRepoVariable.mockRejectedValueOnce(new Error("no perms"))
    const queryClient = freshClient()
    const { result } = renderHook(() => useSaveServiceToken(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ serviceToken: "ghp_token", expiresInDays: 90 })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(putRepoSecret).toHaveBeenCalledTimes(1)
  })
})
