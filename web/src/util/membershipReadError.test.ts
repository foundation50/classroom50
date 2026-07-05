import { describe, expect, it } from "vitest"

import { isMembershipReadError } from "./membershipReadError"
import { GitHubAPIError } from "@/hooks/github/errors"

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/user/memberships/orgs/cs50",
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
    ssoHeader: null,
  })

describe("isMembershipReadError (/onboard 404 -> notInvited boundary)", () => {
  it("treats a definitive 404 as NOT a read error (never invited)", () => {
    // Regression: getPendingOrgInvite's 404 once set membershipReadError,
    // routing a never-invited student to the error screen instead of notInvited.
    // A 404 means "no membership record".
    expect(isMembershipReadError(apiError(404))).toBe(false)
  })

  it("treats 403 / SSO-gated / transient as a real read error", () => {
    expect(isMembershipReadError(apiError(403))).toBe(true)
    expect(isMembershipReadError(apiError(401))).toBe(true)
    expect(isMembershipReadError(apiError(500))).toBe(true)
  })

  it("treats a non-GitHub error as a read error", () => {
    expect(isMembershipReadError(new Error("network down"))).toBe(true)
  })

  it("is not a read error when there is no error", () => {
    expect(isMembershipReadError(null)).toBe(false)
    expect(isMembershipReadError(undefined)).toBe(false)
  })
})
