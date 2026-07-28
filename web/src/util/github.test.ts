import { describe, expect, it } from "vitest"

import { decodeBase64Utf8 } from "./github"

// Encode a UTF-8 string to base64 the way GitHub's Contents API returns it:
// standard base64, wrapped at `wrap` columns with newlines.
function encodeWrapped(text: string, wrap = 0): string {
  const b64 = new Uint8Array(new TextEncoder().encode(text)).toBase64()
  if (wrap <= 0) return b64
  return (b64.match(new RegExp(`.{1,${wrap}}`, "g")) ?? []).join("\n") + "\n"
}

describe("decodeBase64Utf8", () => {
  it("round-trips an ASCII string", () => {
    expect(decodeBase64Utf8(encodeWrapped("hello world"))).toBe("hello world")
  })

  it("decodes multibyte UTF-8 correctly", () => {
    const text = "café — 日本語 🎓"
    expect(decodeBase64Utf8(encodeWrapped(text))).toBe(text)
  })

  it("tolerates the column-60 newline wrapping GitHub sends", () => {
    const text = "x".repeat(200)
    const wrapped = encodeWrapped(text, 60)
    expect(wrapped).toContain("\n")
    expect(decodeBase64Utf8(wrapped)).toBe(text)
  })
})
