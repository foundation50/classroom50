import { describe, expect, it } from "vitest"

import {
  deriveOrgServiceTokenHealth,
  isCollectRunFailing,
  needsAttention,
} from "./serviceTokenHealth"

describe("deriveOrgServiceTokenHealth", () => {
  it("reports missing regardless of expiry/collect", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "missing",
        expiry: "ok",
        lastCollectFailing: false,
      }),
    ).toBe("missing")
  })

  it("reports unknown when the owner-only read was blocked", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "unknown",
        expiry: "ok",
        lastCollectFailing: true,
      }),
    ).toBe("unknown")
  })

  it("ranks an expired token above a failing collect", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "expired",
        lastCollectFailing: true,
      }),
    ).toBe("expired")
  })

  it("surfaces a failing collect on a present, non-expired token", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "ok",
        lastCollectFailing: true,
      }),
    ).toBe("collectFailing")
  })

  it("warns on a soon expiry when collect is healthy", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "expiringSoon",
        lastCollectFailing: false,
      }),
    ).toBe("expiringSoon")
  })

  it("reports expiryUntracked (not a false ok) for a present token with no recorded expiry", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "unknown",
        lastCollectFailing: false,
      }),
    ).toBe("expiryUntracked")
  })

  it("reports expiryUntracked (not a false ok) when the collect-run read was inconclusive", () => {
    // An errored run read must never certify a card healthy — it degrades to
    // expiryUntracked, never "ok".
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "ok",
        lastCollectFailing: "unknown",
      }),
    ).toBe("expiryUntracked")
  })

  it("is ok only when present, expiry recorded and not near, collect confirmed healthy", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "ok",
        lastCollectFailing: false,
      }),
    ).toBe("ok")
  })

  it("ranks a real expiry above an inconclusive collect read", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "expired",
        lastCollectFailing: "unknown",
      }),
    ).toBe("expired")
  })
})

describe("isCollectRunFailing", () => {
  it.each([
    ["failure", true],
    ["timed_out", true],
    ["success", false],
    ["cancelled", false],
    ["skipped", false],
    [null, false],
  ])("conclusion %s -> %s", (conclusion, expected) => {
    expect(isCollectRunFailing(conclusion)).toBe(expected)
  })
})

describe("needsAttention", () => {
  it.each([
    ["expired", true],
    ["missing", true],
    ["expiringSoon", true],
    ["collectFailing", true],
    ["expiryUntracked", true],
    ["ok", false],
    ["unknown", false],
  ] as const)("%s -> %s", (health, expected) => {
    expect(needsAttention(health)).toBe(expected)
  })
})
