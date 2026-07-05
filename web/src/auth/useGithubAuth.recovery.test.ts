import { describe, expect, it } from "vitest"

import {
  recoverStrandedExchange,
  shouldExpireOnUserError,
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
