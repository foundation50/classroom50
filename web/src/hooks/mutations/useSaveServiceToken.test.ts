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

vi.mock("@/github-core/mutations", () => ({
  validateServiceToken: (...args: unknown[]) => validateServiceToken(...args),
  putRepoSecret: (...args: unknown[]) => putRepoSecret(...args),
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
})

describe("useSaveServiceToken", () => {
  it("seeds status 'present' under the key the consumer reads (survives #307)", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useSaveServiceToken(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate("ghp_token")
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

    result.current.mutate("ghp_token")
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // Consumer reads githubKeys.serviceToken(org ?? ""); a drift here would seed
    // under a key the wizard never reads and reopen #307.
    expect(
      queryClient.getQueryData<ServiceTokenStatus>(githubKeys.serviceToken(""))
        ?.status,
    ).toBe("present")
  })
})
