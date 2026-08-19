// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

// The scope string that actually reaches GitHub is the whole point of #655:
// a normal sign-in must never request delete_repo, and only an explicitly
// elevated call may. Every other test in this area stops at a mocked
// startWebFlow, so this file is the one that executes validateConfig's ternary.

vi.mock("@/router", () => ({ default: { history: { push: vi.fn() } } }))

const buildGithubAuthorizeUrl = vi.fn<(input: { scope: string }) => string>(
  () => "https://example.test/auth",
)
const requestDeviceCode = vi.fn<
  (input: { scope: string }) => Promise<Record<string, unknown>>
>(async () => ({
  device_code: "dc",
  user_code: "UC-1",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
}))

vi.mock("./github-oauth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-oauth-api")>()
  return {
    ...actual,
    buildGithubAuthorizeUrl: (input: { scope: string }) =>
      buildGithubAuthorizeUrl(input),
    requestDeviceCode: (input: { scope: string }) => requestDeviceCode(input),
  }
})

const saveOAuthSession = vi.fn<(input: { scope: string }) => void>()

vi.mock("./storage", () => ({
  getStoredGithubToken: () => null,
  getStoredGithubClientId: () => "Ov23liTEST",
  getStoredGithubScope: () => "",
  persistGithubToken: vi.fn(),
  persistGithubClientId: vi.fn(),
  clearGithubToken: vi.fn(),
  saveOAuthSession: (input: { scope: string }) => saveOAuthSession(input),
  consumeOAuthSession: () => ({
    verifier: null,
    expectedState: null,
    clientId: null,
    scope: null,
    returnTo: null,
  }),
}))

import { DEFAULT_GITHUB_SCOPE, ELEVATED_GITHUB_SCOPE } from "./constants"
import { GitHubAuthProvider, useGithubAuth } from "./useGithubAuth"

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
  vi.stubEnv("DEV", false)
  // jsdom/happy-dom forbids assigning location.href; swap in a plain object.
  Object.defineProperty(window, "location", {
    value: { origin: "https://classroom50.test", search: "", href: "" },
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe("sign-in scope (#655)", () => {
  it("requests base scopes, without delete_repo, for a normal web sign-in", async () => {
    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await result.current.startWebFlow()

    await waitFor(() => expect(buildGithubAuthorizeUrl).toHaveBeenCalled())
    const { scope } = buildGithubAuthorizeUrl.mock.calls[0]![0]
    expect(scope).toBe(DEFAULT_GITHUB_SCOPE)
    expect(scope).not.toContain("delete_repo")
    // The callback trusts the session scope, so it must match what we requested.
    expect(saveOAuthSession).toHaveBeenCalledWith(
      expect.objectContaining({ scope: DEFAULT_GITHUB_SCOPE }),
    )
  })

  it("adds delete_repo only when the web flow is explicitly elevated", async () => {
    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await result.current.startWebFlow({ elevated: true })

    await waitFor(() => expect(buildGithubAuthorizeUrl).toHaveBeenCalled())
    const { scope } = buildGithubAuthorizeUrl.mock.calls[0]![0]
    expect(scope).toBe(ELEVATED_GITHUB_SCOPE)
    expect(scope).toContain("delete_repo")
  })

  it("requests base scopes for a normal device sign-in", async () => {
    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await result.current.startDeviceFlow()

    await waitFor(() => expect(requestDeviceCode).toHaveBeenCalled())
    const { scope } = requestDeviceCode.mock.calls[0]![0]
    expect(scope).toBe(DEFAULT_GITHUB_SCOPE)
    expect(scope).not.toContain("delete_repo")
  })

  it("adds delete_repo only when the device flow is explicitly elevated", async () => {
    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await result.current.startDeviceFlow({ elevated: true })

    await waitFor(() => expect(requestDeviceCode).toHaveBeenCalled())
    const { scope } = requestDeviceCode.mock.calls[0]![0]
    expect(scope).toBe(ELEVATED_GITHUB_SCOPE)
    expect(scope).toContain("delete_repo")
  })
})
