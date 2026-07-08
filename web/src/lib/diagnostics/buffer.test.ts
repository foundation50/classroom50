import { afterEach, describe, expect, it } from "vitest"

import { GitHubAPIError } from "@/hooks/github/errors"
import {
  clearRecentErrors,
  readRecentErrors,
  recordError,
  type DiagnosticEntry,
} from "./buffer"

const noRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const githubError = (overrides?: Partial<ConstructorParameters<typeof GitHubAPIError>[0]>) =>
  new GitHubAPIError({
    status: 403,
    url: "https://api.github.com/orgs/acme",
    message: "Forbidden",
    body: { secret: "should never leak" },
    rateLimit: noRateLimit,
    ssoHeader: "required; url=https://github.com/orgs/acme/sso?authorization_request=SECRET_TOKEN",
    acceptedScopes: "repo",
    oauthScopes: "read:user",
    requestId: "ABCD:1234",
    ...overrides,
  })

afterEach(() => clearRecentErrors())

describe("recordError", () => {
  it("keeps only allow-listed derived fields for a GitHubAPIError", () => {
    recordError(githubError())
    const [entry] = readRecentErrors()

    expect(entry.status).toBe(403)
    expect(entry.endpoint).toBe("https://api.github.com/orgs/acme")
    expect(entry.requestId).toBe("ABCD:1234")
    expect(entry.ssoRequired).toBe(true)
    expect(entry.scopeGap).toBe(true)
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("never stores the raw response body or the raw SSO header (redaction)", () => {
    recordError(githubError())
    const serialized = JSON.stringify(readRecentErrors())

    expect(serialized).not.toContain("should never leak")
    expect(serialized).not.toContain("authorization_request")
    expect(serialized).not.toContain("SECRET_TOKEN")
    // The DiagnosticEntry shape has no field that could carry them.
    const [entry] = readRecentErrors() as DiagnosticEntry[]
    expect(entry).not.toHaveProperty("body")
    expect(entry).not.toHaveProperty("ssoHeader")
  })

  it("records name + message for a plain Error, with no GitHub fields", () => {
    recordError(new TypeError("boom"))
    const [entry] = readRecentErrors()

    expect(entry.name).toBe("TypeError")
    expect(entry.message).toBe("boom")
    expect(entry.status).toBeUndefined()
    expect(entry.endpoint).toBeUndefined()
  })

  it("stringifies a non-Error thrown value", () => {
    recordError("just a string")
    const [entry] = readRecentErrors()

    expect(entry.name).toBe("UnknownError")
    expect(entry.message).toBe("just a string")
  })

  it("caps the ring and evicts the oldest entries", () => {
    for (let i = 0; i < 15; i++) recordError(new Error(`e${i}`))
    const recent = readRecentErrors()

    expect(recent).toHaveLength(10)
    expect(recent[0].message).toBe("e5")
    expect(recent[9].message).toBe("e14")
  })

  it("returns a copy so callers cannot mutate the ring", () => {
    recordError(new Error("one"))
    readRecentErrors().push({ timestamp: "x", name: "n", message: "m" })

    expect(readRecentErrors()).toHaveLength(1)
  })
})
