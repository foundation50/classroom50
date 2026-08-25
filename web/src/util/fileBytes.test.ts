import { describe, expect, it } from "vitest"
import { bytesToBase64, decodeTextFile, fileToBase64 } from "./fileBytes"

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

describe("decodeTextFile", () => {
  const fileOf = (bytes: number[] | Uint8Array) =>
    new File([new Uint8Array(bytes)], "roster.csv")

  it("decodes valid UTF-8 without the fallback", async () => {
    const file = fileOf(
      new TextEncoder().encode("Name,Email\nBjørn Ægir,b@x.no\n"),
    )
    expect(await decodeTextFile(file)).toEqual({
      text: "Name,Email\nBjørn Ægir,b@x.no\n",
      fallbackUsed: false,
    })
  })

  it("strips a UTF-8 BOM", async () => {
    const body = new TextEncoder().encode("username\nada\n")
    const file = fileOf(new Uint8Array([0xef, 0xbb, 0xbf, ...body]))
    expect(await decodeTextFile(file)).toEqual({
      text: "username\nada\n",
      fallbackUsed: false,
    })
  })

  // Issue #742: Excel's plain "CSV" export on Windows is Windows-1252, which
  // File.text() would decode to a run of U+FFFD.
  it("decodes a Windows-1252 file via the fallback", async () => {
    // "Bjørn Håkonsen" in Windows-1252 single bytes (ø=0xF8, å=0xE5).
    const name = [
      0x42, 0x6a, 0xf8, 0x72, 0x6e, 0x20, 0x48, 0xe5, 0x6b, 0x6f, 0x6e, 0x73,
      0x65, 0x6e,
    ]
    const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))
    const file = fileOf([
      ...ascii("Name,Email\n"),
      ...name,
      ...ascii(",b@x.no\n"),
    ])
    expect(await decodeTextFile(file)).toEqual({
      text: "Name,Email\nBjørn Håkonsen,b@x.no\n",
      fallbackUsed: true,
    })
  })

  it("decodes UTF-16LE with a BOM", async () => {
    const text = "username\nBjørn\n"
    const bytes = new Uint8Array(2 + text.length * 2)
    bytes[0] = 0xff
    bytes[1] = 0xfe
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      bytes[2 + i * 2] = code & 0xff
      bytes[3 + i * 2] = code >> 8
    }
    expect(await decodeTextFile(fileOf(bytes))).toEqual({
      text,
      fallbackUsed: false,
    })
  })

  it("handles an empty file", async () => {
    expect(await decodeTextFile(fileOf([]))).toEqual({
      text: "",
      fallbackUsed: false,
    })
  })
})
