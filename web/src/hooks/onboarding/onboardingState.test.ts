import { describe, expect, it } from "vitest"
import {
  deriveOnboardingState,
  type OnboardingStateInput,
} from "./onboardingState"

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
    // A pending invite exists; the accept/verify mutation is (about to be) in
    // flight. Never fall through to notInvited here.
    expect(deriveOnboardingState(base)).toBe("loading")
  })

  it("is notInvited without a membership record", () => {
    expect(
      deriveOnboardingState({
        ...base,
        loadingMembership: false,
        hasMembership: false,
      }),
    ).toBe("notInvited")
  })

  it("does NOT wait past a resolved read when there is no membership", () => {
    expect(
      deriveOnboardingState({
        ...base,
        loadingMembership: false,
        hasMembership: false,
      }),
    ).toBe("notInvited")
  })

  it("is active when membership is verified active", () => {
    expect(deriveOnboardingState({ ...base, active: true })).toBe("active")
  })

  it("prefers active over a still-loading read once verified", () => {
    expect(
      deriveOnboardingState({
        ...base,
        loadingMembership: true,
        active: true,
      }),
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
