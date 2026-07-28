import { describe, expect, it } from "vitest"

import { deriveChallenge, generateVerifier, randomBase64Url } from "./pkce"

describe("randomBase64Url", () => {
  it("produces URL-safe base64 with no padding", () => {
    const out = randomBase64Url(32)
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(out).not.toContain("=")
  })

  it("varies between calls", () => {
    expect(generateVerifier()).not.toBe(generateVerifier())
  })
})

describe("deriveChallenge", () => {
  // RFC 7636 Appendix B test vector.
  it("derives the S256 challenge for the spec's verifier", async () => {
    const challenge = await deriveChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    )
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })
})
