import { describe, expect, it } from "vitest"

import { archivePath, assertSafeProxyBase, proxyUrl } from "./workerProxy"

describe("archivePath", () => {
  it("builds the zipball path without a ref", () => {
    expect(archivePath("o", "r")).toBe("/repos/o/r/zipball")
  })

  it("appends the ref when provided", () => {
    expect(archivePath("o", "r", "main")).toBe("/repos/o/r/zipball/main")
  })

  it("encodes each ref segment but preserves the slash", () => {
    expect(archivePath("o", "r", "feature/a b")).toBe(
      "/repos/o/r/zipball/feature/a%20b",
    )
  })

  it("percent-encodes owner and repo", () => {
    expect(archivePath("a b", "c/d")).toBe("/repos/a%20b/c%2Fd/zipball")
  })
})

describe("proxyUrl", () => {
  it("joins base and path", () => {
    expect(proxyUrl("https://host", "/web/token")).toBe(
      "https://host/web/token",
    )
  })

  it("strips a trailing slash on the base", () => {
    expect(proxyUrl("https://host/", "/web/token")).toBe(
      "https://host/web/token",
    )
  })
})

describe("assertSafeProxyBase", () => {
  it("throws for a non-https, non-localhost origin", () => {
    expect(() => assertSafeProxyBase("http://evil.example")).toThrow(/https/i)
  })

  it("allows an https origin", () => {
    expect(() => assertSafeProxyBase("https://host.example")).not.toThrow()
  })

  it.each([
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ])("allows the http localhost origin %s", (base) => {
    expect(() => assertSafeProxyBase(base)).not.toThrow()
  })
})
