import { describe, expect, it } from "vitest"
import { classifyMembershipError } from "./MembershipError"
import { GitHubAPIError } from "@/hooks/github/errors"

const rateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const makeError = (args: {
  status: number
  ssoHeader?: string | null
  url?: string
}) =>
  new GitHubAPIError({
    status: args.status,
    url: args.url ?? "/user/memberships/orgs/acme",
    message: "boom",
    body: { message: "boom" },
    rateLimit,
    ssoHeader: args.ssoHeader ?? null,
  })

describe("classifyMembershipError", () => {
  it("routes a 403 + X-GitHub-SSO with a github.com url to ssoWithUrl", () => {
    const info = classifyMembershipError(
      makeError({
        status: 403,
        ssoHeader:
          "required; url=https://github.com/orgs/acme/sso?authorization_request=abc",
      }),
      { org: "acme", username: "ada" },
    )
    expect(info.cause).toBe("ssoWithUrl")
    expect(info.ssoUrl).toBe(
      "https://github.com/orgs/acme/sso?authorization_request=abc",
    )
    expect(info.details.ssoRequired).toBe(true)
  })

  it("routes a url-less partial-results SSO 403 to ssoUrlless (not notAMember)", () => {
    const info = classifyMembershipError(
      makeError({
        status: 403,
        ssoHeader: "partial-results; organizations=21955855,20582480",
      }),
      { org: "acme" },
    )
    expect(info.cause).toBe("ssoUrlless")
    expect(info.ssoUrl).toBeNull()
    expect(info.details.ssoRequired).toBe(true)
  })

  it("routes a 404 to notAMember", () => {
    const info = classifyMembershipError(makeError({ status: 404 }), {
      org: "acme",
    })
    expect(info.cause).toBe("notAMember")
    expect(info.details.httpStatus).toBe(404)
  })

  it("routes a non-SSO 403 to generic", () => {
    const info = classifyMembershipError(makeError({ status: 403 }), {
      org: "acme",
    })
    expect(info.cause).toBe("generic")
  })

  it("routes a 500 to generic", () => {
    const info = classifyMembershipError(makeError({ status: 500 }), {
      org: "acme",
    })
    expect(info.cause).toBe("generic")
  })

  it("routes a non-GitHub error (or null) to generic without diagnostics", () => {
    const info = classifyMembershipError(null, { org: "acme", username: "ada" })
    expect(info.cause).toBe("generic")
    expect(info.details.org).toBe("acme")
    expect(info.details.username).toBe("ada")
    expect(info.details.httpStatus).toBeUndefined()
    expect(info.details.ssoRequired).toBe(false)
  })

  it("never copies the raw sso header verbatim (only the boolean)", () => {
    const info = classifyMembershipError(
      makeError({
        status: 403,
        ssoHeader:
          "required; url=https://github.com/orgs/acme/sso?authorization_request=secret-token",
      }),
      { org: "acme" },
    )
    // Data-minimization: details carry only the boolean, never the raw header.
    expect(JSON.stringify(info.details)).not.toContain("authorization_request")
    expect(JSON.stringify(info.details)).not.toContain("secret-token")
  })
})
