import { describe, expect, it } from "vitest"

import { githubOAuthGrantUrl } from "./constants"

describe("githubOAuthGrantUrl", () => {
  it("deep-links this app's authorization page, where the per-org Grant lives", () => {
    expect(githubOAuthGrantUrl("Ov23liEXAMPLE")).toBe(
      "https://github.com/settings/connections/applications/Ov23liEXAMPLE",
    )
  })

  it("falls back to the authorized-apps list when no client id is injected", () => {
    expect(githubOAuthGrantUrl("")).toBe(
      "https://github.com/settings/connections/applications",
    )
  })
})
