import { describe, expect, it } from "vitest"

import {
  classifyPatResult,
  recoverStrandedExchange,
  resolveAuthStatus,
  shouldExpireOnUserError,
  type AuthStatusInput,
} from "./useGithubAuth"
import { GitHubUserFetchError } from "./github-user-api"

// The PR's headline invariant: a revoked token (401) tears the session down on
// cold reload, but a rate-limit (403) or transient/network error must NOT wipe
// a valid token. shouldExpireOnUserError is the gate that enforces it.
describe("shouldExpireOnUserError", () => {
  it("expires on a 401 (revoked/expired token)", () => {
    expect(shouldExpireOnUserError(new GitHubUserFetchError(401))).toBe(true)
  })

  it("does NOT expire on a 403 (rate-limit must not sign a valid user out)", () => {
    expect(shouldExpireOnUserError(new GitHubUserFetchError(403))).toBe(false)
  })

  it("does NOT expire on a 5xx (transient blip)", () => {
    expect(shouldExpireOnUserError(new GitHubUserFetchError(500))).toBe(false)
  })

  it("does NOT expire on a non-GitHubUserFetchError (e.g. a network error)", () => {
    expect(shouldExpireOnUserError(new Error("failed to fetch"))).toBe(false)
  })

  it("does NOT expire when there is no error", () => {
    expect(shouldExpireOnUserError(undefined)).toBe(false)
    expect(shouldExpireOnUserError(null)).toBe(false)
  })
})

// Recovery for the stranded "exchanging" screen (#oauth-hang): a fresh reload
// or a bfcache Back with no ?code must reset "exchanging" -> "config" so the
// card stops spinning, while every other screen is left untouched.
describe("recoverStrandedExchange", () => {
  it("resets a stranded 'exchanging' screen to 'config'", () => {
    expect(recoverStrandedExchange("exchanging")).toBe("config")
  })

  it("leaves every other screen unchanged", () => {
    expect(recoverStrandedExchange("config")).toBe("config")
    expect(recoverStrandedExchange("device-prompt")).toBe("device-prompt")
    expect(recoverStrandedExchange("authed")).toBe("authed")
  })
})

// The PAT entry gate: submitPat routes a validated token's X-OAuth-Scopes
// header through classifyPatResult before deciding sign-in vs error. A null
// header (fine-grained PAT) is blocked, an under-scoped classic token is
// rejected with the missing list, and a fully-scoped token signs in.
describe("classifyPatResult", () => {
  it("blocks a fine-grained token (null header -> unverifiable)", () => {
    expect(classifyPatResult(null)).toEqual({ kind: "fine-grained" })
  })

  it("rejects a classic token missing required scopes, listing them", () => {
    const result = classifyPatResult("repo, workflow")
    expect(result.kind).toBe("missing")
    if (result.kind === "missing") {
      // read:org is implied by admin:org, so it should not be reported once
      // admin:org is present, but here neither admin:org nor read:user/delete_repo
      // is granted.
      expect(result.missing).toContain("admin:org")
      expect(result.missing).toContain("read:user")
      expect(result.missing).toContain("delete_repo")
    }
  })

  it("treats an empty-scope classic token (empty string, not null) as missing every scope, not fine-grained", () => {
    const result = classifyPatResult("")
    expect(result.kind).toBe("missing")
    if (result.kind === "missing") {
      expect(result.missing.length).toBeGreaterThan(0)
    }
  })

  it("signs in a fully-scoped classic token, carrying the scope string forward", () => {
    // admin:org implies read:org, so the granted set need not list it explicitly.
    const granted = "read:user repo workflow admin:org delete_repo"
    expect(classifyPatResult(granted)).toEqual({ kind: "ok", scopes: granted })
  })

  it("accepts a comma+space delimited header the same as a space-delimited one", () => {
    const granted = "read:user, repo, workflow, admin:org, delete_repo"
    expect(classifyPatResult(granted)).toEqual({ kind: "ok", scopes: granted })
  })
})

// The auth-status verdict for the router guard. Two headline invariants (#185):
//   - An offline cold reload with a stored token but no cached user HOLDS at
//     "loading" (session preserved) rather than bouncing to /login.
//   - An already-validated session (cached user) stays "authenticated" while
//     offline, so the app stays mounted and the OfflineBanner shows — a blip
//     must not collapse a working session to a spinner.
describe("resolveAuthStatus", () => {
  const authed: AuthStatusInput = {
    hasLoadedStoredAuth: true,
    hasToken: true,
    isOnline: true,
    userQueryPending: false,
    userQueryErrored: false,
    hasUser: true,
  }

  it("is 'loading' until stored auth has been read", () => {
    expect(resolveAuthStatus({ ...authed, hasLoadedStoredAuth: false })).toBe(
      "loading",
    )
  })

  it("is 'unauthenticated' with no token (even offline)", () => {
    expect(
      resolveAuthStatus({ ...authed, hasToken: false, isOnline: false }),
    ).toBe("unauthenticated")
  })

  it("STAYS 'authenticated' when offline with a cached user (keep the app mounted, show the banner)", () => {
    expect(
      resolveAuthStatus({
        ...authed,
        isOnline: false,
        userQueryErrored: true,
      }),
    ).toBe("authenticated")
  })

  it("HOLDS at 'loading' when offline with a token but no cached user yet (cold reload — don't bounce to /login)", () => {
    expect(
      resolveAuthStatus({
        ...authed,
        isOnline: false,
        hasUser: false,
        userQueryPending: true,
      }),
    ).toBe("loading")
  })

  it("also HOLDS at 'loading' when offline with no user and the paused query errored", () => {
    expect(
      resolveAuthStatus({
        ...authed,
        isOnline: false,
        hasUser: false,
        userQueryErrored: true,
      }),
    ).toBe("loading")
  })

  it("is 'loading' while the user query is pending (online, first validation)", () => {
    expect(
      resolveAuthStatus({ ...authed, hasUser: false, userQueryPending: true }),
    ).toBe("loading")
  })

  it("is 'unauthenticated' when online with a token but the first validation errored (e.g. a definitive 401 upstream)", () => {
    expect(
      resolveAuthStatus({ ...authed, hasUser: false, userQueryErrored: true }),
    ).toBe("unauthenticated")
  })

  it("is 'authenticated' when online with a token and a resolved user", () => {
    expect(resolveAuthStatus(authed)).toBe("authenticated")
  })
})
