import { describe, expect, it } from "vitest"

import {
  FINE_GRAINED_SIGNIN_PERMISSIONS,
  buildFineGrainedSigninUrl,
} from "./fineGrainedSigninUrl"

describe("buildFineGrainedSigninUrl", () => {
  it("targets the fine-grained token creation endpoint", () => {
    const url = new URL(buildFineGrainedSigninUrl("acme-university"))
    expect(url.origin + url.pathname).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    )
  })

  it("sets the org as the resource owner (target_name)", () => {
    const url = new URL(buildFineGrainedSigninUrl("acme-university"))
    expect(url.searchParams.get("target_name")).toBe("acme-university")
  })

  it("includes every permission from the shared recipe", () => {
    const url = new URL(buildFineGrainedSigninUrl("acme-university"))
    for (const [key, value] of Object.entries(
      FINE_GRAINED_SIGNIN_PERMISSIONS,
    )) {
      expect(url.searchParams.get(key)).toBe(value)
    }
  })

  it("encodes reserved characters so they round-trip", () => {
    // A resource owner is a login (no reserved chars), but the builder must not
    // hand-concatenate — assert URLSearchParams parsing recovers an org with a
    // char that would break a naive query string.
    const url = new URL(buildFineGrainedSigninUrl("a&b org"))
    expect(url.searchParams.get("target_name")).toBe("a&b org")
  })

  it("yields a blank target_name when no org is given", () => {
    const url = new URL(buildFineGrainedSigninUrl())
    expect(url.searchParams.get("target_name")).toBe("")
    // The permissions are still present so the teacher only picks the owner.
    expect(url.searchParams.get("administration")).toBe("write")
  })
})
