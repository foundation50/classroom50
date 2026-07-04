import { describe, expect, it } from "vitest"
import {
  emailHash,
  generateInviteToken,
  isValidEmail,
  normalizeEmail,
  rowMatchesEmailHash,
} from "./onboarding"

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com")
  })

  it("does NOT strip +tags or dots (distinct addresses stay distinct)", () => {
    expect(normalizeEmail("a+tag@gmail.com")).toBe("a+tag@gmail.com")
    expect(normalizeEmail("a.b@gmail.com")).toBe("a.b@gmail.com")
  })
})

describe("emailHash", () => {
  it("is deterministic for the same normalized email", async () => {
    const a = await emailHash("rongxinliu.g@gmail.com")
    const b = await emailHash("  RongXinLiu.G@Gmail.com  ")
    expect(a).toBe(b)
  })

  it("returns 16 lowercase hex chars", async () => {
    const h = await emailHash("student@uni.edu")
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })

  it("does not collide on punctuation-distinct emails", async () => {
    const dot = await emailHash("rongxinliu.g@gmail.com")
    const dash = await emailHash("rongxinliu-g@gmail.com")
    expect(dot).not.toBe(dash)
  })
})

describe("isValidEmail", () => {
  it("accepts a typical address", () => {
    expect(isValidEmail("student@university.edu")).toBe(true)
    expect(isValidEmail("  a+tag@gmail.com  ")).toBe(true)
  })

  it("rejects obvious non-emails", () => {
    expect(isValidEmail("")).toBe(false)
    expect(isValidEmail("nope")).toBe(false)
    expect(isValidEmail("a@b")).toBe(false)
    expect(isValidEmail("a @b.com")).toBe(false)
  })
})

describe("generateInviteToken", () => {
  it("generates a 32-char lowercase-hex token", () => {
    expect(generateInviteToken()).toMatch(/^[0-9a-f]{32}$/)
  })

  it("generates distinct tokens", () => {
    expect(generateInviteToken()).not.toBe(generateInviteToken())
  })
})

describe("rowMatchesEmailHash (email fallback)", () => {
  it("accepts a payload email that hashes to the row's email_hash", async () => {
    const email = "victim@uni.edu"
    const hash = await emailHash(email)
    expect(rowMatchesEmailHash({ email_hash: hash }, email, hash)).toBe(true)
  })

  it("rejects a self-report for a DIFFERENT email than the invited row", async () => {
    const invitedHash = await emailHash("victim@uni.edu")
    const attackerHash = await emailHash("attacker@evil.com")
    expect(
      rowMatchesEmailHash(
        { email_hash: invitedHash },
        "attacker@evil.com",
        attackerHash,
      ),
    ).toBe(false)
  })

  it("matches case-insensitively against a row that only has email", async () => {
    const payload = "Victim@Uni.edu"
    expect(
      rowMatchesEmailHash(
        { email: "victim@uni.edu" },
        payload,
        await emailHash(payload),
      ),
    ).toBe(true)
  })

  it("falls through (true) for a github_id row with no email on file", async () => {
    expect(
      rowMatchesEmailHash(
        {},
        "anything@uni.edu",
        await emailHash("anything@uni.edu"),
      ),
    ).toBe(true)
  })
})
