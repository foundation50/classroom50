import { describe, expect, it } from "vitest"

import {
  deriveOnboardingState,
  type OnboardingStateInput,
} from "./onboardingState"
import { isMembershipReadError } from "./membershipReadError"
import { GitHubAPIError } from "@/github-core/errors"

const base: OnboardingStateInput = {
  loadingMembership: false,
  membershipReadError: false,
  hasMembership: true,
  acceptError: false,
  active: false,
}

describe("deriveOnboardingState", () => {
  it("is loading while the initial membership read is resolving", () => {
    expect(deriveOnboardingState({ ...base, loadingMembership: true })).toBe(
      "loading",
    )
  })

  it("is loading once a membership exists but is not yet active", () => {
    // A pending invite exists; accept/verify is (about to be) in flight. Never
    // fall through to notInvited here.
    expect(deriveOnboardingState(base)).toBe("loading")
  })

  it("is notInvited without a membership record", () => {
    expect(deriveOnboardingState({ ...base, hasMembership: false })).toBe(
      "notInvited",
    )
  })

  it("is active when membership is verified active", () => {
    expect(deriveOnboardingState({ ...base, active: true })).toBe("active")
  })

  it("prefers active over a still-loading read once verified", () => {
    expect(
      deriveOnboardingState({ ...base, loadingMembership: true, active: true }),
    ).toBe("active")
  })

  it("is error when the initial membership read failed", () => {
    expect(deriveOnboardingState({ ...base, membershipReadError: true })).toBe(
      "error",
    )
  })

  it("is error when the accept/verify mutation failed", () => {
    expect(deriveOnboardingState({ ...base, acceptError: true })).toBe("error")
  })

  it("prefers error over active when both are set", () => {
    // A read error takes precedence so a stale 'active' can't mask a failure.
    expect(
      deriveOnboardingState({
        ...base,
        membershipReadError: true,
        active: true,
      }),
    ).toBe("error")
  })
})

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

describe("404 -> notInvited boundary (end-to-end through the precedence)", () => {
  it("a 404 read feeds hasMembership:false -> notInvited", () => {
    // The live page maps a 404 to membershipReadError:false + hasMembership:false;
    // fold that through precedence to prove the calm screen is reached (a 404
    // must not route to the error screen).
    const state = deriveOnboardingState({
      loadingMembership: false,
      membershipReadError: isMembershipReadError(apiError(404)),
      hasMembership: false,
      acceptError: false,
      active: false,
    })
    expect(state).toBe("notInvited")
  })

  it("a 403/SSO read feeds membershipReadError:true -> error", () => {
    const state = deriveOnboardingState({
      loadingMembership: false,
      membershipReadError: isMembershipReadError(apiError(403)),
      hasMembership: false,
      acceptError: false,
      active: false,
    })
    expect(state).toBe("error")
  })
})
