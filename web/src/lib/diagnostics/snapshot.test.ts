// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"

import { GitHubAPIError } from "@/hooks/github/errors"
import { clearRecentErrors, recordError } from "./buffer"
import {
  clearObservedContext,
  observeOrg,
  observeResponse,
} from "./observed"
import { buildDiagnostics } from "./snapshot"

afterEach(() => {
  clearRecentErrors()
  clearObservedContext()
})

describe("buildDiagnostics", () => {
  it("includes build identity, user agent, and a generated timestamp", () => {
    const text = buildDiagnostics()
    expect(text).toContain("Classroom 50 diagnostics")
    expect(text).toMatch(/Version: /)
    expect(text).toMatch(/Built: /)
    expect(text).toMatch(/Generated: \d{4}-\d{2}-\d{2}T/)
    expect(text).toContain("User agent:")
  })

  it("reports the granted scopes and any missing scope gap", () => {
    observeResponse({ status: 200, scopes: "read:user" })
    const text = buildDiagnostics()
    expect(text).toContain("OAuth scopes: read:user")
    // read:user alone is missing the required repo/workflow/read:org scopes.
    expect(text).toMatch(/missing: /)
  })

  it("reports scopes unknown when no X-OAuth-Scopes header was seen", () => {
    observeResponse({ status: 200, scopes: null })
    expect(buildDiagnostics()).toContain("OAuth scopes: unknown")
  })

  it("explains why org plan is unknown rather than omitting it", () => {
    const text = buildDiagnostics({ org: "acme" })
    expect(text).toContain("Org: acme")
    expect(text).toContain("plan: unknown (plan not visible — not an org owner?)")
  })

  it("reports a known plan with its category", () => {
    const text = buildDiagnostics({ org: "acme", planName: "team" })
    expect(text).toContain("plan: team (supported)")
  })

  it("falls back to the observed org when none is passed", () => {
    observeOrg("observed-org")
    expect(buildDiagnostics()).toContain("Org: observed-org")
  })

  it("summarizes recent errors with request id and status, never the raw body or SSO header", () => {
    recordError(
      new GitHubAPIError({
        status: 403,
        url: "https://api.github.com/orgs/acme",
        message: "Forbidden",
        body: { secret: "should never leak" },
        rateLimit: {
          limit: null,
          remaining: null,
          used: null,
          reset: null,
          resource: null,
          retryAfter: null,
        },
        ssoHeader:
          "required; url=https://github.com/orgs/acme/sso?authorization_request=SECRET_TOKEN",
        requestId: "ABCD:1234",
      }),
    )

    const text = buildDiagnostics()
    expect(text).toContain("HTTP 403")
    expect(text).toContain("req=ABCD:1234")
    expect(text).toContain("ssoRequired")
    expect(text).not.toContain("should never leak")
    expect(text).not.toContain("authorization_request")
    expect(text).not.toContain("SECRET_TOKEN")
  })

  it("says 'none' when there are no recent errors", () => {
    expect(buildDiagnostics()).toContain("Recent errors: none")
  })
})
