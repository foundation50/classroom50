// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement, StrictMode } from "react"

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
}
const persistGithubToken = vi.fn<(token: string, scope?: string) => void>()

vi.mock("./storage", () => ({
  getStoredGithubToken: () => storage.token,
  getStoredGithubClientId: () => storage.clientId,
  getStoredGithubScope: () => storage.scope,
  persistGithubToken: (token: string, scope?: string) =>
    persistGithubToken(token, scope),
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
  GitHubAuthProvider,
  useGithubAuth,
  __resetDevAutoLoginForTests,
} from "./useGithubAuth"
import { GitHubUserFetchError } from "./github-user-api"
const FULL_SCOPES = "read:user repo workflow admin:org delete_repo"

function freshClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
}

function wrapper(strict = false) {
  return function Wrapper({ children }: PropsWithChildren) {
    const tree = createElement(
      QueryClientProvider,
      { client: freshClient() },
      createElement(GitHubAuthProvider, null, children),
    )
    return strict ? createElement(StrictMode, null, tree) : tree
  }
}

function setEnv(env: { DEV?: boolean; pat?: string }) {
  vi.stubEnv("DEV", env.DEV ?? true)
  // import.meta.env.VITE_GITHUB_PAT — vi.stubEnv drives import.meta.env in Vitest.
  vi.stubEnv("VITE_GITHUB_PAT", env.pat ?? "")
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetDevAutoLoginForTests()
  storage.token = null
  storage.clientId = ""
  storage.scope = ""
  window.history.replaceState({}, "", "/")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// #6/#7: the dev auto-login effect end-to-end — the mount effect consumes
// import.meta.env, validates, and reaches completeSignIn or logs on rejection.
describe("dev auto-login effect wiring", () => {
  it("auto-signs-in on mount with a valid env PAT (reaches completeSignIn)", async () => {
    setEnv({ DEV: true, pat: "ghp_valid" })
    fetchGithubUserWithScopes.mockResolvedValue({
      user: { login: "octocat" },
      scopes: FULL_SCOPES,
    })
    fetchGithubUser.mockResolvedValue({ login: "octocat" })

    const { result } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })

    await waitFor(() => expect(result.current.token).toBe("ghp_valid"))
    expect(persistGithubToken).toHaveBeenCalledWith("ghp_valid", FULL_SCOPES)
    expect(result.current.screen).toBe("authed")
    expect(fetchGithubUserWithScopes).toHaveBeenCalledWith("ghp_valid")
  })

  it("does NOT sign in and logs a warning when the env PAT is rejected (missing scopes)", async () => {
    setEnv({ DEV: true, pat: "ghp_underscoped" })
    fetchGithubUserWithScopes.mockResolvedValue({
      user: { login: "octocat" },
      scopes: "repo", // missing workflow/admin:org/read:user/delete_repo
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { result } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })

    await waitFor(() =>
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("VITE_GITHUB_PAT auto-login rejected"),
        ),
      ).toBe(true),
    )
    expect(result.current.token).toBeNull()
    expect(persistGithubToken).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("skips auto-login entirely when not a dev build", async () => {
    setEnv({ DEV: false, pat: "ghp_valid" })

    const { result } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })

    await waitFor(() => expect(result.current.status).not.toBe("loading"))
    expect(fetchGithubUserWithScopes).not.toHaveBeenCalled()
    expect(result.current.token).toBeNull()
  })

  it("does not override a stored session with the env PAT", async () => {
    setEnv({ DEV: true, pat: "ghp_valid" })
    storage.token = "stored-token"

    const { result } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })

    await waitFor(() => expect(result.current.token).toBe("stored-token"))
    expect(fetchGithubUserWithScopes).not.toHaveBeenCalled()
  })

  // #3: StrictMode double-invoke must not fire two validations before the async
  // token lands (runDevAutoLoginOnce caches the single module-scoped promise).
  it("fires exactly one validation under StrictMode double-mount", async () => {
    setEnv({ DEV: true, pat: "ghp_valid" })
    fetchGithubUserWithScopes.mockResolvedValue({
      user: { login: "octocat" },
      scopes: FULL_SCOPES,
    })
    fetchGithubUser.mockResolvedValue({ login: "octocat" })

    renderHook(() => useGithubAuth(), { wrapper: wrapper(true) })

    await waitFor(() => expect(fetchGithubUserWithScopes).toHaveBeenCalled())
    // The module-scoped promise guards the second StrictMode pass; only one
    // GET /user validation is dispatched despite the double-invoke.
    expect(fetchGithubUserWithScopes).toHaveBeenCalledTimes(1)
  })

  // Regression: the mount that starts the async validation can be discarded
  // (StrictMode unmount, or a Vite HMR remount) before GET /user resolves, so
  // the resolving instance's completeSignIn is dropped. The dev auto-login must
  // still persist the validated token so the next/surviving mount restores the
  // session — otherwise the app hangs forever on the loading gate even though
  // the token is valid (the real bug this path fixes).
  it("persists the validated token even if the initiating mount unmounts before it resolves", async () => {
    setEnv({ DEV: true, pat: "ghp_valid" })
    let resolveValidation!: (v: { user: unknown; scopes: string }) => void
    fetchGithubUserWithScopes.mockReturnValue(
      new Promise((res) => {
        resolveValidation = res
      }),
    )

    // Mount, then unmount before the validation resolves (mimics StrictMode's
    // discard / an HMR swap mid-flight).
    const { unmount } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })
    await waitFor(() =>
      expect(fetchGithubUserWithScopes).toHaveBeenCalledTimes(1),
    )
    unmount()

    // Validation resolves after the initiating instance is gone.
    resolveValidation({ user: { login: "octocat" }, scopes: FULL_SCOPES })
    await waitFor(() =>
      expect(persistGithubToken).toHaveBeenCalledWith("ghp_valid", FULL_SCOPES),
    )
  })

  // Regression: a transient validation failure (network blip / 5xx / timeout)
  // must NOT be cached as a permanent null — otherwise every later mount in the
  // same page load returns the cached null and the dev is stranded on the login
  // screen until a full reload. A second mount must re-attempt the validation.
  it("re-attempts validation after a transient failure (does not cache the null)", async () => {
    setEnv({ DEV: true, pat: "ghp_valid" })
    // First attempt: transient network error. Second attempt: succeeds.
    fetchGithubUserWithScopes
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({
        user: { login: "octocat" },
        scopes: FULL_SCOPES,
      })
    fetchGithubUser.mockResolvedValue({ login: "octocat" })

    const first = renderHook(() => useGithubAuth(), { wrapper: wrapper() })
    await waitFor(() =>
      expect(fetchGithubUserWithScopes).toHaveBeenCalledTimes(1),
    )
    // The transient failure did not sign in and did not persist a token.
    expect(persistGithubToken).not.toHaveBeenCalled()
    first.unmount()

    // A fresh mount (e.g. an HMR reload) must retry rather than reuse the
    // cached null, and this time it succeeds.
    renderHook(() => useGithubAuth(), { wrapper: wrapper() })
    await waitFor(() =>
      expect(fetchGithubUserWithScopes).toHaveBeenCalledTimes(2),
    )
    await waitFor(() =>
      expect(persistGithubToken).toHaveBeenCalledWith("ghp_valid", FULL_SCOPES),
    )
  })

  // #5: a returning OAuth ?code owns sign-in for that load; the PAT auto-login
  // must stand down so the two paths don't both drive completeSignIn.
  it("skips the env-PAT auto-login when a ?code OAuth callback is present", async () => {
    setEnv({ DEV: true, pat: "ghp_valid" })
    window.history.replaceState({}, "", "/login?code=abc&state=xyz")

    renderHook(() => useGithubAuth(), { wrapper: wrapper() })

    // Give any async validation a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchGithubUserWithScopes).not.toHaveBeenCalled()
  })
})

// #8: the submitPat -> validateAndSignInWithPat extraction preserves behavior:
// blank tokens early-return; each reject branch surfaces via patError; a valid
// token signs in.
describe("submitPat (post-refactor behavior)", () => {
  it("early-returns on a blank token without firing a validation", async () => {
    setEnv({ DEV: false })

    const { result } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })

    result.current.submitPat("   ")
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchGithubUserWithScopes).not.toHaveBeenCalled()
    expect(result.current.patError).toBeNull()
  })

  it("surfaces a fine-grained rejection via patError without signing in", async () => {
    setEnv({ DEV: false })
    fetchGithubUserWithScopes.mockResolvedValue({
      user: { login: "octocat" },
      scopes: null, // fine-grained: unverifiable
    })

    const { result } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })

    result.current.submitPat("github_pat_xxx")
    await waitFor(() => expect(result.current.patError).not.toBeNull())
    // Untranslated t() returns the key, locking the reject branch's message id.
    expect(result.current.patError).toBe("auth.errorPatFineGrained")
    expect(result.current.token).toBeNull()
  })

  it("surfaces a 401 rejection via patError", async () => {
    setEnv({ DEV: false })
    fetchGithubUserWithScopes.mockRejectedValue(new GitHubUserFetchError(401))

    const { result } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })

    result.current.submitPat("ghp_bad")
    await waitFor(() => expect(result.current.patError).not.toBeNull())
    expect(result.current.patError).toBe("auth.errorPatRejected401")
    expect(result.current.token).toBeNull()
  })

  it("signs in on a fully-scoped token", async () => {
    setEnv({ DEV: false })
    fetchGithubUserWithScopes.mockResolvedValue({
      user: { login: "octocat" },
      scopes: FULL_SCOPES,
    })
    fetchGithubUser.mockResolvedValue({ login: "octocat" })

    const { result } = renderHook(() => useGithubAuth(), {
      wrapper: wrapper(),
    })

    result.current.submitPat("ghp_good")
    await waitFor(() => expect(result.current.token).toBe("ghp_good"))
    expect(result.current.screen).toBe("authed")
  })
})
