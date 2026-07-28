import { describe, expect, it } from "vitest"

import { bytesToHex } from "./hex"

describe("bytesToHex", () => {
  it("is empty for an empty array", () => {
    expect(bytesToHex(new Uint8Array(0))).toBe("")
  })

  it("encodes a known vector as lowercase hex", () => {
    expect(bytesToHex(new Uint8Array([0xca, 0xfe, 0xd0, 0x0d]))).toBe(
      "cafed00d",
    )
  })

  it("zero-pads each byte to two digits", () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f]))).toBe("000f")
  })
})
