// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

// Router is imported for the deep-link push effect; stub it so the test doesn't
// pull the generated route tree.
vi.mock("@/router", () => ({
  default: { history: { push: vi.fn() } },
}))

const fetchGithubUserWithScopes =
  vi.fn<(token: string) => Promise<{ user: unknown; scopes: string | null }>>()
const fetchGithubUser = vi.fn<(token: string) => Promise<unknown>>()

vi.mock("./github-user-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-user-api")>()
  return {
    ...actual,
    fetchGithubUserWithScopes: (token: string) =>
      fetchGithubUserWithScopes(token),
    fetchGithubUser: (token: string) => fetchGithubUser(token),
  }
})

const storage = {
  token: null as string | null,
  clientId: "",
  scope: "",
  authMethod: null as "oauth" | "pat" | null,
}

vi.mock("./storage", () => ({
  getStoredGithubToken: () => storage.token,
  getStoredGithubClientId: () => storage.clientId,
  getStoredGithubScope: () => storage.scope,
  getStoredAuthMethod: () => storage.authMethod,
  persistGithubToken: vi.fn(),
  persistGithubClientId: vi.fn(),
  clearGithubToken: vi.fn(),
  saveOAuthSession: vi.fn(),
  consumeOAuthSession: () => ({
    verifier: null,
    expectedState: null,
    clientId: null,
    scope: null,
    returnTo: null,
  }),
}))

import { GitHubAuthProvider, useGithubAuth } from "./useGithubAuth"

const FULL_SCOPES = "read:user repo workflow admin:org delete_repo"

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  return createElement(
    QueryClientProvider,
    { client },
    createElement(GitHubAuthProvider, null, children),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("DEV", false)
  storage.token = null
  storage.clientId = ""
  storage.scope = ""
  storage.authMethod = null
  window.history.replaceState({}, "", "/")
})

// #748: the discriminator for App's /login redirect carry — false on a cold
// load and on a 401 expiry (both carry ?redirect=), true only on signOut(),
// reset once the next session signs in.
describe("signedOutDeliberately", () => {
  it("is false on a cold unauthenticated load (a deep link must carry ?redirect=)", async () => {
    const { result } = renderHook(() => useGithubAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe("unauthenticated"))
    expect(result.current.signedOutDeliberately).toBe(false)
  })

  it("flips true on a deliberate signOut()", async () => {
    storage.token = "stored-token"
    fetchGithubUser.mockResolvedValue({ login: "octocat" })

    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe("authenticated"))

    act(() => result.current.signOut())

    expect(result.current.signedOutDeliberately).toBe(true)
    expect(result.current.sessionExpired).toBe(false)
  })

  it("stays false when a live 401 expires the session (re-auth should return the user)", async () => {
    storage.token = "stored-token"
    fetchGithubUser.mockResolvedValue({ login: "octocat" })

    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe("authenticated"))

    act(() => result.current.expireSession())

    expect(result.current.signedOutDeliberately).toBe(false)
    expect(result.current.sessionExpired).toBe(true)
  })

  it("resets once the next sign-in completes", async () => {
    storage.token = "stored-token"
    fetchGithubUser.mockResolvedValue({ login: "octocat" })
    fetchGithubUserWithScopes.mockResolvedValue({
      user: { login: "octocat" },
      scopes: FULL_SCOPES,
    })

    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe("authenticated"))

    act(() => result.current.signOut())
    expect(result.current.signedOutDeliberately).toBe(true)

    act(() => result.current.submitPat("ghp_next"))
    await waitFor(() => expect(result.current.token).toBe("ghp_next"))
    expect(result.current.signedOutDeliberately).toBe(false)
  })
})
