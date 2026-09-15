// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

// RFC 8628 has the client keep polling the token endpoint until GitHub answers
// with a verdict. A dropped poll REQUEST (network blip, proxy 5xx) is not a
// verdict, so the flow must ride out a few of them and only give up once they
// look persistent. These tests drive the real polling loop with a sub-second
// interval; every GitHub verdict path (slow_down, access_denied, expired_token)
// is unchanged and covered by the branches below.

vi.mock("@/router", () => ({ default: { history: { push: vi.fn() } } }))

// `interval` is honoured as-is (`data.interval || 5`), so a fractional value
// keeps the loop fast without touching the production sleep.
const POLL_INTERVAL_SECONDS = 0.01

const requestDeviceCode = vi.fn(async () => ({
  device_code: "dc",
  user_code: "UC-1",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: POLL_INTERVAL_SECONDS,
}))

const pollDeviceToken = vi.fn<() => Promise<Record<string, unknown>>>(
  async () => ({ error: "authorization_pending" }),
)

vi.mock("./github-oauth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-oauth-api")>()
  return {
    ...actual,
    requestDeviceCode: () => requestDeviceCode(),
    pollDeviceToken: () => pollDeviceToken(),
  }
})

// completeSignIn prefetches GET /user with the new token; keep it off the wire.
vi.mock("./github-user-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-user-api")>()
  return {
    ...actual,
    fetchGithubUser: vi.fn(async () => ({ id: 1, login: "octocat" })),
  }
})

vi.mock("./storage", () => ({
  getStoredGithubToken: () => null,
  getStoredGithubClientId: () => "Ov23liTEST",
  getStoredGithubScope: () => "",
  getStoredAuthMethod: () => null,
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

import {
  DEVICE_POLL_MAX_CONSECUTIVE_FAILURES,
  GitHubAuthProvider,
  useGithubAuth,
} from "./useGithubAuth"

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

const networkBlip = () => Promise.reject(new TypeError("Failed to fetch"))

beforeEach(() => {
  vi.stubEnv("DEV", false)
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

describe("device flow polling under request failures", () => {
  it("keeps polling through fewer than the limit of consecutive failures and signs in on the next token", async () => {
    pollDeviceToken
      .mockImplementationOnce(networkBlip)
      .mockImplementationOnce(networkBlip)
      .mockImplementationOnce(async () => ({
        access_token: "gho_token",
        scope: "repo",
      }))

    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await result.current.startDeviceFlow()

    await waitFor(() => expect(result.current.screen).toBe("authed"))
    expect(pollDeviceToken).toHaveBeenCalledTimes(3)
    expect(result.current.error).toBeNull()
    expect(result.current.device).toBeNull()
  })

  it("fails the flow once the failures reach the limit", async () => {
    pollDeviceToken.mockImplementation(networkBlip)

    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await result.current.startDeviceFlow()

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(pollDeviceToken).toHaveBeenCalledTimes(
      DEVICE_POLL_MAX_CONSECUTIVE_FAILURES,
    )
    expect(result.current.device).toBeNull()
    expect(result.current.screen).toBe("config")
  })

  it("resets the failure count on any GitHub verdict, so scattered blips never add up", async () => {
    pollDeviceToken
      .mockImplementationOnce(networkBlip)
      .mockImplementationOnce(networkBlip)
      .mockImplementationOnce(async () => ({ error: "authorization_pending" }))
      .mockImplementationOnce(networkBlip)
      .mockImplementationOnce(networkBlip)
      .mockImplementationOnce(async () => ({
        access_token: "gho_token",
        scope: "repo",
      }))

    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await result.current.startDeviceFlow()

    await waitFor(() => expect(result.current.screen).toBe("authed"))
    expect(pollDeviceToken).toHaveBeenCalledTimes(6)
    expect(result.current.error).toBeNull()
  })

  it("still stops at once on an access_denied verdict", async () => {
    pollDeviceToken
      .mockImplementationOnce(networkBlip)
      .mockImplementationOnce(async () => ({ error: "access_denied" }))

    const { result } = renderHook(() => useGithubAuth(), { wrapper })
    await result.current.startDeviceFlow()

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(pollDeviceToken).toHaveBeenCalledTimes(2)
    expect(result.current.screen).toBe("config")
  })
})
