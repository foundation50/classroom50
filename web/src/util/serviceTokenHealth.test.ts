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

  it("is ok when present, not expiring, collect healthy (unknown expiry counts as ok)", () => {
    expect(
      deriveOrgServiceTokenHealth({
        tokenStatus: "present",
        expiry: "unknown",
        lastCollectFailing: false,
      }),
    ).toBe("ok")
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
    ["ok", false],
    ["unknown", false],
  ] as const)("%s -> %s", (health, expected) => {
    expect(needsAttention(health)).toBe(expected)
  })
})
