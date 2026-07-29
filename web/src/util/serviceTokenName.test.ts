import { describe, expect, it } from "vitest"

import {
  GITHUB_TOKEN_NAME_MAX,
  randomTokenHash,
  serviceTokenName,
} from "./serviceTokenName"

describe("serviceTokenName", () => {
  it("builds classroom50-token-<org-id>-<hash>", () => {
    expect(serviceTokenName(1234567, "ab12")).toBe(
      "classroom50-token-1234567-ab12",
    )
  })

  it("accepts a string org id", () => {
    expect(serviceTokenName("42", "zzzz")).toBe("classroom50-token-42-zzzz")
  })

  it("stays within GitHub's 40-char cap for realistic ids", () => {
    // A very wide numeric id plus a full-length hash.
    const name = serviceTokenName("999999999999", "abcd")
    expect(name.length).toBeLessThanOrEqual(GITHUB_TOKEN_NAME_MAX)
  })
})

describe("randomTokenHash", () => {
  it("returns a 4-char [a-z0-9] string by default", () => {
    const hash = randomTokenHash()
    expect(hash).toMatch(/^[a-z0-9]{4}$/)
  })

  it("honors a custom length", () => {
    expect(randomTokenHash(8)).toMatch(/^[a-z0-9]{8}$/)
  })

  it("is (almost surely) not constant across calls", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) seen.add(randomTokenHash())
    // 20 draws from 36^4 space collapsing to one value would be astronomically
    // unlikely — this guards against a broken generator returning a constant.
    expect(seen.size).toBeGreaterThan(1)
  })
})
