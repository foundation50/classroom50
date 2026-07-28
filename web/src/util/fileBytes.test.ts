import { describe, expect, it } from "vitest"
import { bytesToBase64, fileToBase64 } from "./fileBytes"

describe("bytesToBase64", () => {
  it("encodes bytes to standard base64 (matches btoa for ASCII)", () => {
    const bytes = new TextEncoder().encode("hello world")
    expect(bytesToBase64(bytes)).toBe(btoa("hello world"))
  })

  it("round-trips binary bytes (0x00-0xff) without corruption", () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    const b64 = bytesToBase64(bytes)
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    expect(Array.from(back)).toEqual(Array.from(bytes))
  })

  it("handles an empty buffer", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("")
  })

  it("does not overflow the call stack on a large buffer (chunked)", () => {
    // > one 0x8000 chunk; a naive fromCharCode(...bytes) would risk overflow.
    const bytes = new Uint8Array(200_000).fill(65)
    const b64 = bytesToBase64(bytes)
    expect(atob(b64).length).toBe(200_000)
  })
})

describe("fileToBase64", () => {
  it("reads a File's bytes as base64", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "x.bin")
    const b64 = await fileToBase64(file)
    expect(
      Array.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
    ).toEqual([1, 2, 3, 4])
  })
})
