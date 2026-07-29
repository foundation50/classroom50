import { describe, expect, it } from "vitest"

import {
  deriveOrgServiceTokenHealth,
  needsAttention,
} from "./serviceTokenHealth"

describe("deriveOrgServiceTokenHealth", () => {
  it("reports missing regardless of expiry", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "missing",
        expiry: "ok",
      }),
    ).toBe("missing")
  })

  it("reports unknown when the owner-only read was blocked", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "unknown",
        expiry: "ok",
      }),
    ).toBe("unknown")
  })

  it("reports expired for a present, expired token", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "expired",
      }),
    ).toBe("expired")
  })

  it("warns on a soon expiry", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "expiringSoon",
      }),
    ).toBe("expiringSoon")
  })

  it("reports expiryUntracked (not a false ok) for a present token with no recorded expiry", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "unknown",
      }),
    ).toBe("expiryUntracked")
  })

  it("is ok when present with expiry recorded and not near", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "ok",
      }),
    ).toBe("ok")
  })
})

describe("needsAttention", () => {
  it.each([
    ["expired", true],
    ["missing", true],
    ["expiringSoon", true],
    ["expiryUntracked", true],
    ["ok", false],
    ["unknown", false],
  ] as const)("%s -> %s", (health, expected) => {
    expect(needsAttention(health)).toBe(expected)
  })
})
