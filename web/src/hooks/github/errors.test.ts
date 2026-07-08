import { describe, expect, it } from "vitest"

import {
  GitHubAPIError,
  isDefinitiveGitHubStatus,
  parseSsoAuthorizationUrl,
  retryTransientGitHubError,
} from "./errors"

const apiError = (status: number, ssoHeader?: string | null) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
    ssoHeader,
  })

describe("isDefinitiveGitHubStatus", () => {
  it("treats 401 / 403 / 404 as definitive (no retry can change them)", () => {
    expect(isDefinitiveGitHubStatus(401)).toBe(true)
    expect(isDefinitiveGitHubStatus(403)).toBe(true)
    expect(isDefinitiveGitHubStatus(404)).toBe(true)
  })

  it("treats transient statuses (5xx / 429) as non-definitive", () => {
    expect(isDefinitiveGitHubStatus(429)).toBe(false)
    expect(isDefinitiveGitHubStatus(500)).toBe(false)
    expect(isDefinitiveGitHubStatus(502)).toBe(false)
    expect(isDefinitiveGitHubStatus(200)).toBe(false)
  })
})

describe("retryTransientGitHubError", () => {
  it("does not retry a definitive 401 / 403 / 404", () => {
    expect(retryTransientGitHubError(0, apiError(401))).toBe(false)
    expect(retryTransientGitHubError(0, apiError(404))).toBe(false)
    expect(retryTransientGitHubError(0, apiError(403))).toBe(false)
  })

  it("retries transient failures up to a bounded count", () => {
    expect(retryTransientGitHubError(0, apiError(500))).toBe(true)
    expect(retryTransientGitHubError(1, apiError(500))).toBe(true)
    expect(retryTransientGitHubError(2, apiError(500))).toBe(false)
  })

  it("retries non-GitHubAPIError (network) failures within the bound", () => {
    expect(retryTransientGitHubError(0, new Error("network"))).toBe(true)
    expect(retryTransientGitHubError(2, new Error("network"))).toBe(false)
  })
})

describe("SAML SSO detection", () => {
  const orgSsoUrl =
    "https://github.com/orgs/acme/sso?authorization_request=ABC123"
  const entSsoUrl =
    "https://github.com/enterprises/acme-inc/sso?authorization_request=ABC123"

  it("isSsoRequired requires a 403 carrying the X-GitHub-SSO header", () => {
    expect(apiError(403, `required; url=${orgSsoUrl}`).isSsoRequired).toBe(true)
    expect(apiError(403, null).isSsoRequired).toBe(false)
    expect(apiError(403).isSsoRequired).toBe(false)
  })

  it("isSsoRequired is false when the header rides a non-403 status", () => {
    // GitHub only emits X-GitHub-SSO on a 403; a header echoed onto a dead-token
    // 401 or a transient 5xx/429 (e.g. proxy-copied) must NOT read as an SSO
    // gate, or it would mask a re-auth / outage as "authorize SSO".
    const header = `required; url=${orgSsoUrl}`
    expect(apiError(401, header).isSsoRequired).toBe(false)
    expect(apiError(500, header).isSsoRequired).toBe(false)
    expect(apiError(429, header).isSsoRequired).toBe(false)
  })

  it("extracts the authorization URL from a `required; url=…` header", () => {
    expect(parseSsoAuthorizationUrl(`required; url=${orgSsoUrl}`)).toBe(
      orgSsoUrl,
    )
    expect(parseSsoAuthorizationUrl(`required; url=${entSsoUrl}`)).toBe(
      entSsoUrl,
    )
    expect(
      apiError(403, `required; url=${entSsoUrl}`).ssoAuthorizationUrl,
    ).toBe(entSsoUrl)
  })

  it("returns null for the multi-org `partial-results` shape (no URL)", () => {
    const header = "partial-results; organizations=21955855,20582480"
    expect(parseSsoAuthorizationUrl(header)).toBeNull()
    expect(apiError(403, header).isSsoRequired).toBe(true)
    expect(apiError(403, header).ssoAuthorizationUrl).toBeNull()
  })

  it("rejects a non-github.com URL (defensive against a spoofed redirect)", () => {
    expect(
      parseSsoAuthorizationUrl("required; url=https://evil.example.com/sso"),
    ).toBeNull()
  })

  it("rejects github.com spoofs that shift the real host (userinfo / subdomain)", () => {
    // The `hostname === "github.com"` guard is the security-relevant sentinel;
    // these are the classic ways a naive substring/`includes` check would be
    // fooled. `new URL()` puts `github.com` in the userinfo (host = evil.com) for
    // the `@` form, and the trailing-domain form has host github.com.evil.com.
    expect(
      parseSsoAuthorizationUrl("required; url=https://github.com@evil.com/sso"),
    ).toBeNull()
    expect(
      parseSsoAuthorizationUrl("required; url=https://github.com.evil.com/sso"),
    ).toBeNull()
  })

  it("rejects non-https schemes even when the host is github.com", () => {
    // Script schemes parse to an empty host (already rejected), but the explicit
    // https: allowlist also blocks any benign non-http scheme and makes the
    // intent durable against a future refactor of the host check.
    expect(
      parseSsoAuthorizationUrl("required; url=javascript:alert(1)"),
    ).toBeNull()
    expect(
      parseSsoAuthorizationUrl(
        "required; url=data:text/html,<script>x</script>",
      ),
    ).toBeNull()
    expect(
      parseSsoAuthorizationUrl("required; url=http://github.com/orgs/acme/sso"),
    ).toBeNull()
    expect(
      parseSsoAuthorizationUrl("required; url=ftp://github.com/x"),
    ).toBeNull()
  })

  it("returns null for absent / malformed headers", () => {
    expect(parseSsoAuthorizationUrl(null)).toBeNull()
    expect(parseSsoAuthorizationUrl(undefined)).toBeNull()
    expect(parseSsoAuthorizationUrl("required; url=not-a-url")).toBeNull()
  })
})

describe("isScopeGap", () => {
  const scopeError = (args: {
    status?: number
    accepted?: string | null
    granted?: string | null
  }) =>
    new GitHubAPIError({
      status: args.status ?? 403,
      url: "https://api.github.com/x",
      message: "Forbidden",
      body: null,
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: null,
      },
      acceptedScopes: args.accepted ?? null,
      oauthScopes: args.granted ?? null,
    })

  it("is true when the token holds none of the endpoint's accepted scopes", () => {
    expect(
      scopeError({ accepted: "repo, read:org", granted: "read:user" })
        .isScopeGap,
    ).toBe(true)
  })

  it("is false when the token holds an accepted scope (an org restriction, not a gap)", () => {
    expect(
      scopeError({ accepted: "repo", granted: "repo, read:org, workflow" })
        .isScopeGap,
    ).toBe(false)
  })

  it("is false when the token holds exactly one of several accepted scopes (any-one-of satisfies)", () => {
    // Pins the required.some() 'any one accepted scope satisfies' semantics: the
    // endpoint accepts repo OR read:org, the token holds only read:org -> no gap.
    expect(
      scopeError({ accepted: "repo, read:org", granted: "read:org" })
        .isScopeGap,
    ).toBe(false)
  })

  it("is false when either scope header is absent (cannot prove a gap — fail closed)", () => {
    expect(scopeError({ accepted: "repo", granted: null }).isScopeGap).toBe(
      false,
    )
    expect(scopeError({ accepted: null, granted: "repo" }).isScopeGap).toBe(
      false,
    )
  })

  it("is false when the endpoint requires no scope (empty accepted set)", () => {
    expect(scopeError({ accepted: "", granted: "" }).isScopeGap).toBe(false)
  })

  it("is false on non-403 statuses even with a scope mismatch", () => {
    expect(
      scopeError({ status: 404, accepted: "repo", granted: "read:user" })
        .isScopeGap,
    ).toBe(false)
  })
})

describe("requestId", () => {
  const withRequestId = (requestId?: string | null) =>
    new GitHubAPIError({
      status: 500,
      url: "https://api.github.com/x",
      message: "Server error",
      body: null,
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: null,
      },
      requestId,
    })

  it("captures the X-GitHub-Request-Id when present", () => {
    expect(withRequestId("ABCD:1234:5678").requestId).toBe("ABCD:1234:5678")
  })

  it("defaults to null when the header is absent", () => {
    expect(withRequestId().requestId).toBeNull()
    expect(withRequestId(null).requestId).toBeNull()
  })

  it("does not disturb the existing predicates", () => {
    const error = apiError(403, "required; url=https://github.com/orgs/a/sso")
    expect(error.requestId).toBeNull()
    expect(error.isSsoRequired).toBe(true)
  })
})
